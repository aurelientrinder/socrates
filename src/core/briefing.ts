/**
 * THE DAILY BRIEFING (calendar + to-do + retention → what to study first).
 *
 * Pure and browser-safe: the server fetches calendar events and to-do
 * tasks, reads the retention report (core/retention.ts) and the confident
 * misses (core/calibration.ts), and this module ranks. The ranking is plain
 * code on purpose — the same inputs always give the same order, and tests
 * pin it. A model only writes the short note around the result.
 *
 * Doctrine (the learner struggles with motivation, time and overconfidence):
 * - at most MAX_ITEMS items inside a daily minute budget — a short list you
 *   finish beats a long one you ignore;
 * - what matters is recall ON THE EXAM DAY (retentionAt projects it), not
 *   today's number;
 * - a confident miss in a session boosts its topics; a topic that "feels
 *   solid" but has not been tested for CHECK_STALE_DAYS before an exam gets
 *   a quick check instead of being skipped;
 * - an exam with nothing studied for it is the loudest line.
 */

import { TARGET_RETENTION, retentionAt, type TopicRetention } from "./retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead the briefing looks. */
export const HORIZON_DAYS = 14;
export const MAX_ITEMS = 3;
export const DEFAULT_BUDGET_MINUTES = 45;
export const BUDGET_CHOICES = [15, 30, 45, 60, 90] as const;
/** The briefing day starts at this local hour (before it, yesterday's stands). */
export const BRIEFING_HOUR = 5;
/** Before an exam, a topic untested this long gets a quick check. */
export const CHECK_STALE_DAYS = 14;
/** Confident misses newer than this boost their session's topics. */
export const CONFIDENT_MISS_DAYS = 21;
/** Topics listed per review item (the rest ride along unnamed). */
const TOPICS_PER_ITEM = 3;

export const ITEM_MINUTES = { review: 15, check: 10, learn: 25 } as const;

export type EventKind = "exam" | "deadline" | "class" | "other";

/** One upcoming thing with a date: a calendar event or a to-do task. */
export interface StudyEvent {
	id: string;
	title: string;
	/** Epoch ms. */
	start: number;
	end: number;
	allDay: boolean;
	source: "calendar" | "todo";
	/** Set by classifyEvent when absent. */
	kind?: EventKind;
	/** Calendar link / task link, when the provider gives one. */
	url?: string;
}

/** A session the learner can link to a course (chat summary subset). */
export interface SessionRef {
	id: string;
	title: string;
}

/** Course key → the sessions the learner linked to it (courses.json). */
export type CourseLinks = Record<string, { label: string; chatIds: string[] }>;

// ─── Event kind and course ───────────────────────────────────────────────────

// English + French: the learner studies in both.
const EXAM_RE = /\b(exams?|examens?|midterms?|mid-terms?|finals?|partiels?|quiz(?:zes)?|tests?|contr[oô]les?|interros?|interrogations?|oral)\b/i;
const DEADLINE_RE = /\b(due|deadlines?|submissions?|submit|rendus?|[àa] rendre|remise|projects?|projets?|assignments?|devoirs?|homework|dm|report|rapport)\b/i;
const CLASS_RE = /\b(lectures?|class(?:es)?|cours|courses?|td|tp|tutorials?|tutorats?|seminars?|s[ée]minaires?|labs?|amphi|cm|recitations?)\b/i;

/** Keyword classification; exam beats deadline beats class. */
export function classifyEvent(title: string, source: StudyEvent["source"] = "calendar"): EventKind {
	if (EXAM_RE.test(title)) return "exam";
	if (DEADLINE_RE.test(title)) return "deadline";
	if (CLASS_RE.test(title)) return "class";
	// A dated to-do with no other cue is still something due.
	return source === "todo" ? "deadline" : "other";
}

const KIND_WORDS = new RegExp(`${EXAM_RE.source}|${DEADLINE_RE.source}|${CLASS_RE.source}`, "gi");
const COURSE_CODE_RE = /\b([A-Z]{2,5})\s?-?(\d{2,4}[A-Z]?)\b/;

/**
 * The course an event belongs to, as a stable key + a display label.
 * "MATH201 Lecture 7: Eigenvalues" → math201; "Linear Algebra - Exam" →
 * "linear algebra". Empty key when nothing course-like is left.
 */
export function courseOf(title: string): { key: string; label: string } {
	const code = COURSE_CODE_RE.exec(title);
	if (code) return { key: `${code[1]}${code[2]}`.toLowerCase(), label: `${code[1]}${code[2]}` };
	const head = title.split(/[:|(\[]/)[0] ?? title;
	const label = head
		.replace(KIND_WORDS, " ")
		.replace(/#?\d+/g, " ")
		.replace(/[-–—_/,.]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return { key: label.toLowerCase(), label };
}

// ─── Matching ────────────────────────────────────────────────────────────────

const STOPWORDS = new Set(
	"the and for with from into about your this that what when how les des une pour avec dans sur par aux est intro introduction chapter chapitre part partie session review revision week semaine".split(" "),
);

/** Meaningful lowercase tokens (≥ 3 chars, no stopwords, crude plural strip). */
export function tokens(text: string): Set<string> {
	const out = new Set<string>();
	for (const raw of text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/)) {
		if (raw.length < 3 || STOPWORDS.has(raw) || /^\d+$/.test(raw)) continue;
		out.add(raw.length > 4 && raw.endsWith("s") ? raw.slice(0, -1) : raw);
	}
	return out;
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
	for (const t of a) if (b.has(t)) return true;
	return false;
}

/** Sessions whose title shares a meaningful word with the course label —
 *  the suggestion shown until the learner confirms a link. */
export function suggestSessions(courseLabel: string, sessions: readonly SessionRef[]): string[] {
	const want = tokens(courseLabel);
	if (want.size === 0) return [];
	return sessions.filter((s) => overlaps(want, tokens(s.title))).map((s) => s.id);
}

/**
 * The topics an event is about. Linked course sessions count whole; without
 * a confirmed link, topics match on shared words with the event title (and
 * the suggested sessions count whole).
 */
export function topicsForEvent(
	event: StudyEvent,
	topics: readonly TopicRetention[],
	links: CourseLinks,
	sessions: readonly SessionRef[],
): { topics: TopicRetention[]; course: { key: string; label: string }; linked: boolean; chatIds: string[] } {
	const course = courseOf(event.title);
	const link = course.key ? links[course.key] : undefined;
	const chatIds = link ? link.chatIds : course.key ? suggestSessions(course.label, sessions) : [];
	const chatSet = new Set(chatIds);
	const words = tokens(event.title);
	const matched = topics.filter(
		(t) => chatSet.has(t.chatId) || (!link && words.size > 0 && overlaps(words, tokens(`${t.title} ${t.chatTitle}`))),
	);
	return { topics: matched, course, linked: link !== undefined, chatIds };
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

export type ItemAction = "review" | "check" | "learn";

export interface BriefingItem {
	id: string;
	action: ItemAction;
	/** Short imperative headline, e.g. "Review Eigenvalues, Diagonalization". */
	title: string;
	/** One-line why, from the numbers. */
	reason: string;
	minutes: number;
	score: number;
	/** The session to go back to (review/check), when there is one. */
	chatId?: string;
	chatTitle?: string;
	topicKeys: string[];
	topicTitles: string[];
	/** The event that makes this urgent, when there is one. */
	eventId?: string;
	eventTitle?: string;
	eventStart?: number;
}

export interface UpcomingEntry {
	event: StudyEvent;
	kind: EventKind;
	course: { key: string; label: string };
	linked: boolean;
	chatIds: string[];
	topicCount: number;
	/** Mean projected recall of the linked topics at the event, 0-1; null when none. */
	readiness: number | null;
}

export interface ClassEntry {
	event: StudyEvent;
	course: { key: string; label: string };
	chatIds: string[];
}

export interface BriefingPlan {
	/** The briefing day, local YYYY-MM-DD. */
	day: string;
	generatedAt: number;
	budgetMinutes: number;
	items: BriefingItem[];
	upcoming: UpcomingEntry[];
	todayClasses: ClassEntry[];
	/** Tracked topics in the retention report (0 = nothing tested yet). */
	trackedTopics: number;
}

export interface BriefingInput {
	now: number;
	events: readonly StudyEvent[];
	topics: readonly TopicRetention[];
	sessions: readonly SessionRef[];
	links: CourseLinks;
	/** Sessions with a recent wrong answer given at ≥ 70% confidence. */
	confidentMissChats: ReadonlySet<string>;
	budgetMinutes?: number;
}

/** The local calendar day a moment belongs to, shifted so the day starts at BRIEFING_HOUR. */
export function briefingDay(now: number): string {
	const d = new Date(now - BRIEFING_HOUR * 60 * 60 * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "today", "tomorrow", "in 4 days", "Mon 3 Nov" past a week. */
export function whenLabel(at: number, now: number): string {
	const startOfDay = (t: number) => {
		const d = new Date(t);
		d.setHours(0, 0, 0, 0);
		return d.getTime();
	};
	const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
	if (days <= 0) return "today";
	if (days === 1) return "tomorrow";
	if (days < 7) return `in ${days} days`;
	return new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** 1 today, 0.5 in 3 days, ~0.18 in two weeks. */
function urgency(daysAway: number): number {
	return 1 / (1 + Math.max(0, daysAway) / 3);
}

interface Candidate extends BriefingItem {
	/** Grouping key so one session is not listed twice. */
	group: string;
}

/** The deterministic plan: rank, then fill the minute budget, capped at MAX_ITEMS. */
export function planBriefing(input: BriefingInput): BriefingPlan {
	const { now, topics, sessions, links, confidentMissChats } = input;
	const budget = input.budgetMinutes ?? DEFAULT_BUDGET_MINUTES;
	const horizon = now + HORIZON_DAYS * DAY_MS;
	const events = input.events
		.filter((e) => e.end >= now && e.start <= horizon)
		.map((e) => ({ ...e, kind: e.kind ?? classifyEvent(e.title, e.source) }))
		.sort((a, b) => a.start - b.start);

	// Per topic: the strongest reason any upcoming exam/deadline gives it.
	const best = new Map<string, { score: number; event: StudyEvent; projected: number; stale: boolean }>();
	const upcoming: UpcomingEntry[] = [];
	const candidates: Candidate[] = [];

	for (const event of events) {
		if (event.kind !== "exam" && event.kind !== "deadline") continue;
		const match = topicsForEvent(event, topics, links, sessions);
		const at = Math.max(event.start, now);
		const daysAway = (at - now) / DAY_MS;
		const projections = match.topics.map((t) => retentionAt(t, at));
		upcoming.push({
			event,
			kind: event.kind,
			course: match.course,
			linked: match.linked,
			chatIds: match.chatIds,
			topicCount: match.topics.length,
			readiness: projections.length > 0 ? projections.reduce((a, b) => a + b, 0) / projections.length : null,
		});
		const weight = event.kind === "exam" ? 1 : 0.8;
		if (match.topics.length === 0 && match.chatIds.length === 0) {
			// Nothing studied for it in Socrates: the loudest line before an exam.
			candidates.push({
				id: `learn:${event.id}`,
				group: `learn:${event.id}`,
				action: "learn",
				title: `Start on ${match.course.label || event.title}`,
				reason: `${event.title} is ${whenLabel(event.start, now)} and nothing has been studied for it here yet.`,
				minutes: ITEM_MINUTES.learn,
				score: weight * urgency(daysAway) * 1.5,
				topicKeys: [],
				topicTitles: [],
				eventId: event.id,
				eventTitle: event.title,
				eventStart: event.start,
			});
			continue;
		}
		match.topics.forEach((t, i) => {
			const projected = projections[i]!;
			const gap = Math.max(0, TARGET_RETENTION - projected) / TARGET_RETENTION;
			const stale = projected >= TARGET_RETENTION && now - t.lastReviewedAt > CHECK_STALE_DAYS * DAY_MS && daysAway <= 7;
			const boost = confidentMissChats.has(t.chatId) ? 0.3 : 0;
			const score = weight * urgency(daysAway) * (stale ? 0.4 : 0.2 + 2 * gap) + boost;
			if (gap === 0 && !stale && boost === 0) return; // will still be solid on the day
			const prev = best.get(t.key);
			if (!prev || score > prev.score) best.set(t.key, { score, event, projected, stale });
		});
	}

	// Topics due regardless of any event (the decay thread's due list).
	for (const t of topics) {
		if (best.has(t.key) || !t.due) continue;
		const boost = confidentMissChats.has(t.chatId) ? 0.3 : 0;
		candidates.push({
			id: `due:${t.key}`,
			group: `chat:${t.chatId}:due`,
			action: "review",
			title: `Review ${t.title}`,
			reason: `Recall has dropped to ${pct(t.retention)}.`,
			minutes: ITEM_MINUTES.review,
			score: 0.25 * (TARGET_RETENTION - t.retention) + boost,
			chatId: t.chatId,
			chatTitle: t.chatTitle,
			topicKeys: [t.key],
			topicTitles: [t.title],
		});
	}

	// Event-linked topics, grouped per session and event so one item covers a few topics.
	const groups = new Map<string, { topics: TopicRetention[]; score: number; event: StudyEvent; stale: boolean; worst: number }>();
	for (const t of topics) {
		const b = best.get(t.key);
		if (!b) continue;
		const key = `chat:${t.chatId}:${b.event.id}:${b.stale ? "check" : "review"}`;
		const g = groups.get(key) ?? { topics: [], score: 0, event: b.event, stale: b.stale, worst: 1 };
		g.topics.push(t);
		g.score = Math.max(g.score, b.score);
		g.worst = Math.min(g.worst, b.projected);
		groups.set(key, g);
	}
	for (const [key, g] of groups) {
		g.topics.sort((a, b) => retentionAt(a, g.event.start) - retentionAt(b, g.event.start));
		const named = g.topics.slice(0, TOPICS_PER_ITEM).map((t) => t.title);
		const more = g.topics.length - named.length;
		const first = g.topics[0]!;
		const when = `${g.event.title} is ${whenLabel(g.event.start, now)}`;
		const miss = confidentMissChats.has(first.chatId) ? " You recently missed a question here while feeling sure." : "";
		candidates.push({
			id: key,
			group: key,
			action: g.stale ? "check" : "review",
			title: `${g.stale ? "Quick check" : "Review"}: ${named.join(", ")}${more > 0 ? ` +${more}` : ""}`,
			reason: g.stale
				? `${when}. Not tested for over ${CHECK_STALE_DAYS} days, so a short check before trusting it.${miss}`
				: `${when}. Recall on the day would be about ${pct(g.worst)} without a review.${miss}`,
			minutes: g.stale ? ITEM_MINUTES.check : ITEM_MINUTES.review,
			score: g.score,
			chatId: first.chatId,
			chatTitle: first.chatTitle,
			topicKeys: g.topics.map((t) => t.key),
			topicTitles: g.topics.map((t) => t.title),
			eventId: g.event.id,
			eventTitle: g.event.title,
			eventStart: g.event.start,
		});
	}

	// Fill the budget, best first; the first item always fits so a tight budget still gets one.
	candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	const items: BriefingItem[] = [];
	const seen = new Set<string>();
	let used = 0;
	for (const c of candidates) {
		if (items.length >= MAX_ITEMS) break;
		if (seen.has(c.group)) continue;
		if (items.length > 0 && used + c.minutes > budget) continue;
		seen.add(c.group);
		used += c.minutes;
		const { group: _group, ...item } = c;
		items.push({ ...item, score: Math.round(c.score * 1000) / 1000 });
	}

	const todayEnd = new Date(now);
	todayEnd.setHours(23, 59, 59, 999);
	const todayClasses: ClassEntry[] = events
		.filter((e) => e.kind === "class" && e.start <= todayEnd.getTime() && e.end >= now)
		.map((event) => {
			const course = courseOf(event.title);
			const link = course.key ? links[course.key] : undefined;
			return { event, course, chatIds: link ? link.chatIds : suggestSessions(course.label, sessions) };
		});

	return {
		day: briefingDay(now),
		generatedAt: now,
		budgetMinutes: budget,
		items,
		upcoming,
		todayClasses,
		trackedTopics: topics.length,
	};
}

/** The plain-words fallback when no model is configured (or it fails). */
export function fallbackNote(plan: BriefingPlan): string {
	const exam = plan.upcoming.find((u) => u.kind === "exam");
	if (plan.items.length === 0) {
		return plan.upcoming.length === 0
			? "Nothing due and no exams or deadlines in the next two weeks. A good day to learn something new."
			: "Everything linked to your upcoming exams and deadlines should still be solid on the day. Keep it that way with a short session.";
	}
	const total = plan.items.reduce((a, i) => a + i.minutes, 0);
	return `${plan.items.length} thing${plan.items.length === 1 ? "" : "s"} today, about ${total} minutes in all.${exam ? ` Next exam: ${exam.event.title}, ${whenLabel(exam.event.start, plan.generatedAt)}.` : ""} Start with the first one.`;
}

/** The prompt text for a Start button: a fresh session seeded with the item. */
export function startPrompt(item: BriefingItem): string {
	const forEvent = item.eventTitle ? ` I have ${item.eventTitle} ${whenLabel(item.eventStart ?? Date.now(), Date.now())}.` : "";
	switch (item.action) {
		case "learn":
			return `Teach me the essentials for ${item.eventTitle ?? item.title}.${forEvent} Start by asking what I already know.`;
		case "check":
			return `Quick check, about 10 minutes: quiz me on ${item.topicTitles.join(", ")} before I trust that I know it.${forEvent}`;
		default:
			return `Review session, about 15 minutes: quiz me on ${item.topicTitles.join(", ")} and reteach whatever I miss.${forEvent}`;
	}
}

/** The prompt for Today's "Only 5 minutes" (2026-10-27): the first plan
 *  step cut down to one tiny session for a low-motivation day — a few
 *  questions from memory, or one idea and one check, then stop. */
export function quickPrompt(item: BriefingItem): string {
	const forEvent = item.eventTitle ? ` I have ${item.eventTitle} ${whenLabel(item.eventStart ?? Date.now(), Date.now())}.` : "";
	if (item.action === "learn") {
		return `I only have 5 minutes: teach me the single most important idea for ${item.eventTitle ?? item.title}, then ask me one question to check it, and stop there.${forEvent}`;
	}
	return `I only have 5 minutes: ask me two or three quick questions on ${item.topicTitles.join(", ")}, from memory, then tell me how I did and stop there.${forEvent}`;
}

/** Waking hours a study block may be placed in (local). */
export const BLOCK_DAY_START_HOUR = 8;
export const BLOCK_DAY_END_HOUR = 21;

/**
 * The first free slot of `minutes` from now (rounded up to the next quarter
 * hour), inside waking hours, over the next `days` days and never past
 * `before` — busy time is every timed calendar event (all-day ones don't
 * block). Null when the calendar has no gap.
 */
export function findFreeSlot(
	events: readonly Pick<StudyEvent, "start" | "end" | "allDay" | "source">[],
	now: number,
	minutes: number,
	opts: { before?: number; days?: number } = {},
): number | null {
	const quarter = 15 * 60_000;
	const length = minutes * 60_000;
	const busy = events
		.filter((e) => e.source === "calendar" && !e.allDay && e.end > now)
		.map((e) => [e.start, e.end] as const)
		.sort((a, b) => a[0] - b[0]);
	const limit = Math.min(opts.before ?? Infinity, now + (opts.days ?? 2) * DAY_MS);
	let t = Math.ceil(now / quarter) * quarter;
	while (t + length <= limit) {
		const d = new Date(t);
		const dayStart = new Date(d).setHours(BLOCK_DAY_START_HOUR, 0, 0, 0);
		const dayEnd = new Date(d).setHours(BLOCK_DAY_END_HOUR, 0, 0, 0);
		if (t < dayStart) {
			t = dayStart;
			continue;
		}
		if (t + length > dayEnd) {
			const next = new Date(d);
			next.setDate(next.getDate() + 1);
			t = next.setHours(BLOCK_DAY_START_HOUR, 0, 0, 0);
			continue;
		}
		const clash = busy.find(([s, e]) => s < t + length && e > t);
		if (!clash) return t;
		t = Math.ceil(clash[1] / quarter) * quarter;
	}
	return null;
}
