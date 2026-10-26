/**
 * THE DAILY BRIEFING service: gathers calendar events, dated to-do tasks,
 * per-topic retention and confident misses, runs the pure planner
 * (core/briefing.ts), asks the cheap model for a short note, and keeps one
 * briefing per day on disk so reopening the app shows the same one.
 *
 * Nothing here writes to Google Calendar or Todoist on its own: the two
 * write paths (addItemToTodo, blockItemTime) run only from a click.
 *
 * Files (data dir): briefing/<YYYY-MM-DD>.json (one per day),
 * briefing/courses.json (course → linked sessions, the learner's
 * confirmations), briefing/prefs.json (daily minute budget).
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import {
	BUDGET_CHOICES,
	CONFIDENT_MISS_DAYS,
	DEFAULT_BUDGET_MINUTES,
	HORIZON_DAYS,
	briefingDay,
	fallbackNote,
	findFreeSlot,
	planBriefing,
	startPrompt,
	whenLabel,
	type BriefingItem,
	type BriefingPlan,
	type CourseLinks,
	type StudyEvent,
} from "../core/briefing.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { piEngineForSpec } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import { calibrationAcrossSessions, listChats, retentionAcrossSessions } from "./chats.ts";
import { stores } from "./stores.ts";
import { createStudyBlock, googleCalendarStatus, listCalendarEvents, type GoogleCalendarStatus } from "./integrations/google-calendar.ts";
import { TASK_PROVIDERS } from "./integrations/todoist.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOTE_TIMEOUT_MS = 45_000;
const DIR = path.join(PATHS.data, "briefing");
const COURSES_FILE = path.join(DIR, "courses.json");
const PREFS_FILE = path.join(DIR, "prefs.json");

export interface SourceState {
	connected: boolean;
	/** Events or tasks read for this briefing. */
	count: number;
	error?: string;
}

export interface Briefing {
	plan: BriefingPlan;
	note: string;
	noteSource: "model" | "fallback";
	sources: { calendar: SourceState; todo: SourceState & { provider: string } };
	/** The events the plan saw (kept for free-slot finding on "Block time"). */
	events: StudyEvent[];
	/** Item id → where it was pushed, so the buttons show it is done. */
	pushed: Record<string, { todo?: string; calendar?: string }>;
}

export interface BriefingPrefs {
	budgetMinutes: number;
}

// ─── Small JSON files ───────────────────────────────────────────────────────

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return null;
	}
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`);
	fs.renameSync(tmp, file);
}

const dayFile = (day: string) => path.join(DIR, `${day}.json`);

export function readCourseLinks(): CourseLinks {
	const raw = readJson<CourseLinks>(COURSES_FILE);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: CourseLinks = {};
	for (const [key, v] of Object.entries(raw)) {
		if (v && typeof v.label === "string" && Array.isArray(v.chatIds)) {
			out[key] = { label: v.label, chatIds: v.chatIds.filter((id): id is string => typeof id === "string") };
		}
	}
	return out;
}

/** Confirm which sessions belong to a course (empty list = "none of them"). */
export function setCourseLink(key: string, label: string, chatIds: string[]): CourseLinks {
	const links = readCourseLinks();
	links[key] = { label, chatIds: [...new Set(chatIds)] };
	writeJson(COURSES_FILE, links);
	return links;
}

export function readBriefingPrefs(): BriefingPrefs {
	const raw = readJson<Partial<BriefingPrefs>>(PREFS_FILE);
	const budget = raw?.budgetMinutes;
	return {
		budgetMinutes: typeof budget === "number" && (BUDGET_CHOICES as readonly number[]).includes(budget) ? budget : DEFAULT_BUDGET_MINUTES,
	};
}

export function writeBriefingPrefs(prefs: BriefingPrefs): BriefingPrefs | null {
	if (!(BUDGET_CHOICES as readonly number[]).includes(prefs.budgetMinutes)) return null;
	writeJson(PREFS_FILE, { budgetMinutes: prefs.budgetMinutes });
	return prefs;
}

// ─── The note ───────────────────────────────────────────────────────────────

const NOTE_SYSTEM = `You write the two-to-four sentence opening of a student's daily study briefing.
The ranked plan below was computed from their calendar and from measured recall (quiz results, not feelings). Do not reorder it or add items.
Rules: plain, warm, direct; no hype, no emoji, no lists. Name the single most important thing and why, using the numbers given.
Never tell the student they know something; if a topic only "feels" solid, say a quick check will confirm it.
If an exam has nothing studied for it, say so plainly. Mention the total time so it feels doable. Answer with the paragraph only.`;

function noteInput(plan: BriefingPlan): string {
	const items = plan.items.map((i, n) => `${n + 1}. [${i.action}, ${i.minutes} min] ${i.title}. Why: ${i.reason}`);
	const upcoming = plan.upcoming
		.slice(0, 6)
		.map((u) => `- ${u.event.title} (${u.kind}, ${whenLabel(u.event.start, plan.generatedAt)}): ${u.readiness === null ? "no studied topics linked" : `projected recall on the day ${Math.round(u.readiness * 100)}%`}`);
	return [
		`Today: ${new Date(plan.generatedAt).toDateString()}. Daily budget: ${plan.budgetMinutes} minutes.`,
		`Plan:\n${items.length > 0 ? items.join("\n") : "(nothing urgent)"}`,
		`Next two weeks:\n${upcoming.length > 0 ? upcoming.join("\n") : "(no exams or deadlines found)"}`,
		`Classes today: ${plan.todayClasses.map((c) => c.event.title).join(", ") || "none"}.`,
	].join("\n\n");
}

async function writeNote(plan: BriefingPlan): Promise<{ note: string; source: "model" | "fallback" }> {
	const spec = resolveRoleSpec("extractor", stores.settingsStore.readSettings());
	if (!spec) return { note: fallbackNote(plan), source: "fallback" };
	try {
		const abort = AbortSignal.timeout(NOTE_TIMEOUT_MS);
		const result = await runSubagent([], {
			role: "extractor",
			engine: piEngineForSpec(spec),
			systemPrompt: NOTE_SYSTEM,
			prompt: noteInput(plan),
			maxTurns: 1,
			abortSignal: abort,
		});
		const text = result.text.trim();
		return text ? { note: text, source: "model" } : { note: fallbackNote(plan), source: "fallback" };
	} catch {
		return { note: fallbackNote(plan), source: "fallback" };
	}
}

// ─── Generate / read ────────────────────────────────────────────────────────

const errorText = (err: unknown) => (err instanceof Error ? err.message : "Unknown error.");

const IN_FLIGHT = Symbol.for("lh.briefingInFlight");
function inFlight(): { current?: Promise<Briefing> } {
	const g = globalThis as Record<symbol, { current?: Promise<Briefing> } | undefined>;
	if (!g[IN_FLIGHT]) g[IN_FLIGHT] = {};
	return g[IN_FLIGHT];
}

async function generate(now: number): Promise<Briefing> {
	const from = now - 60 * 60 * 1000;
	const to = now + HORIZON_DAYS * DAY_MS;
	const google: GoogleCalendarStatus = googleCalendarStatus();
	const events: StudyEvent[] = [];
	const calendar: SourceState = { connected: google.connected, count: 0 };
	if (google.connected) {
		try {
			const got = await listCalendarEvents(from, to);
			events.push(...got);
			calendar.count = got.length;
		} catch (err) {
			calendar.error = errorText(err);
			calendar.connected = googleCalendarStatus().connected;
		}
	}
	const provider = TASK_PROVIDERS[0]!;
	const todo: Briefing["sources"]["todo"] = { provider: provider.label, connected: provider.configured(), count: 0 };
	if (todo.connected) {
		try {
			const got = await provider.listDatedTasks(now, to);
			events.push(...got);
			todo.count = got.length;
		} catch (err) {
			todo.error = errorText(err);
		}
	}

	const retention = retentionAcrossSessions(now);
	const missFloor = now - CONFIDENT_MISS_DAYS * DAY_MS;
	const confidentMissChats = new Set(
		calibrationAcrossSessions()
			.confidentMisses.filter((m) => Date.parse(m.answeredAt) >= missFloor)
			.map((m) => m.chatId),
	);
	const plan = planBriefing({
		now,
		events,
		topics: retention.topics,
		sessions: listChats().map((c) => ({ id: c.id, title: c.title })),
		links: readCourseLinks(),
		confidentMissChats,
		budgetMinutes: readBriefingPrefs().budgetMinutes,
	});
	const { note, source } = await writeNote(plan);
	const briefing: Briefing = { plan, note, noteSource: source, sources: { calendar, todo }, events, pushed: {} };
	writeJson(dayFile(plan.day), briefing);
	return briefing;
}

/** Today's briefing: the saved one, or a fresh one the first time each day
 *  (after BRIEFING_HOUR). `refresh` regenerates (keeping pushed marks). */
export async function getBriefing(opts: { refresh?: boolean; now?: number } = {}): Promise<Briefing> {
	const now = opts.now ?? Date.now();
	const day = briefingDay(now);
	const saved = readJson<Briefing>(dayFile(day));
	if (saved && !opts.refresh) return saved;
	const slot = inFlight();
	if (!slot.current) {
		slot.current = generate(now)
			.then((b) => {
				if (saved?.pushed && Object.keys(saved.pushed).length > 0) {
					b.pushed = saved.pushed;
					writeJson(dayFile(day), b);
				}
				return b;
			})
			.finally(() => {
				slot.current = undefined;
			});
	}
	return slot.current;
}

/** The saved briefing for today without generating (the page's first paint). */
export function savedBriefing(now: number = Date.now()): Briefing | null {
	return readJson<Briefing>(dayFile(briefingDay(now)));
}

function findItem(id: string): { briefing: Briefing; item: BriefingItem } {
	const briefing = savedBriefing();
	const item = briefing?.plan.items.find((i) => i.id === id);
	if (!briefing || !item) throw new Error("That briefing item is gone. Refresh the briefing.");
	return { briefing, item };
}

function markPushed(briefing: Briefing, id: string, patch: { todo?: string; calendar?: string }): void {
	briefing.pushed = { ...briefing.pushed, [id]: { ...briefing.pushed?.[id], ...patch } };
	writeJson(dayFile(briefing.plan.day), briefing);
}

/** "Add to to-do": one Todoist task due today with the session prompt. */
export async function addItemToTodo(id: string): Promise<{ url?: string }> {
	const { briefing, item } = findItem(id);
	const provider = TASK_PROVIDERS[0]!;
	const result = await provider.addTask({
		content: `${item.title} (${item.minutes} min, Socrates)`,
		description: `${item.reason}\n\nIn Socrates: ${startPrompt(item)}`,
		dueString: "today",
	});
	markPushed(briefing, id, { todo: result.url ?? "added" });
	return result;
}

/** "Block time": a calendar event in the first free slot, before the exam when there is one. */
export async function blockItemTime(id: string, now: number = Date.now()): Promise<{ url?: string; start: number }> {
	const { briefing, item } = findItem(id);
	const start = findFreeSlot(briefing.events, now, item.minutes, { before: item.eventStart, days: 3 });
	if (start === null) throw new Error("No free slot found in your calendar before then.");
	const result = await createStudyBlock({
		title: `Study: ${item.title}`,
		description: `${item.reason}\n\nPlanned by Socrates.`,
		start,
		minutes: item.minutes,
	});
	// The block is busy time now: a second click must not land on top of it.
	briefing.events.push({ id: `block:${id}`, title: `Study: ${item.title}`, start, end: start + item.minutes * 60_000, allDay: false, source: "calendar" });
	markPushed(briefing, id, { calendar: result.url ?? "added" });
	return { ...result, start };
}
