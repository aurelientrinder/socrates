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
 *
 * The day-by-day plan up to each exam (and the prep before tough classes)
 * lives in core/study-plan.ts; today's list is its first day.
 */

import { retentionAt, type TopicRetention } from "./retention.ts";
import { GROUP_SRC, LAB_SRC, LECTURE_SRC, OTHER_CLASS_SRC, TUTORIAL_SRC, CLASS_RE, sessionTypeOf, type SessionType } from "./session-type.ts";

export { sessionTypeOf, type SessionType };
import {
	EXAM_HORIZON_DAYS,
	WEEK_DAYS,
	planChanges,
	planStudy,
	whenLabel,
	type PlanClass,
	type PlanSnapshot,
	type PlanTarget,
	type StudyPlan,
} from "./study-plan.ts";

export { CHECK_STALE_DAYS, ITEM_MINUTES, MAX_ITEMS, whenLabel } from "./study-plan.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead the briefing looks for deadlines (exams: EXAM_HORIZON_DAYS). */
export const HORIZON_DAYS = 14;
export const DEFAULT_BUDGET_MINUTES = 45;
export const BUDGET_CHOICES = [15, 30, 45, 60, 90] as const;
/** The briefing day starts at this local hour (before it, yesterday's stands). */
export const BRIEFING_HOUR = 5;
/** Confident misses newer than this boost their session's topics. */
export const CONFIDENT_MISS_DAYS = 21;

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

/**
 * A course group (courses.json, keyed by the courseOf key it was made
 * from): the sessions the learner linked to it and the notes they put in
 * it. `chatIds` absent = sessions not confirmed yet (title matching still
 * runs); `aliases` are other course keys whose events belong to it (a
 * calendar class added to a group made by hand).
 */
export interface CourseGroup {
	label: string;
	chatIds?: string[];
	noteIds?: string[];
	aliases?: string[];
	/** ISO time the group was made (absent on links saved before groups). */
	createdAt?: string;
}

/** Course key → its group (courses.json). */
export type CourseLinks = Record<string, CourseGroup>;

/** What a group's notes bring, resolved server-side: the tracked topics
 *  learned from them (prop: keys) and the files themselves. */
export interface CourseMaterial {
	topicKeys: string[];
	notes: { id: string; name: string }[];
}

/** The group an event's course key belongs to: its own, or one listing it as an alias. */
export function courseGroupFor(links: CourseLinks, courseKey: string): { key: string; group: CourseGroup } | null {
	if (!courseKey) return null;
	const own = links[courseKey];
	if (own) return { key: courseKey, group: own };
	for (const [key, group] of Object.entries(links)) if (group.aliases?.includes(courseKey)) return { key, group };
	return null;
}

// ─── Event kind and course ───────────────────────────────────────────────────

// English + French: the learner studies in both.
const EXAM_RE = /\b(exams?|examens?|midterms?|mid-terms?|finals?|partiels?|quiz(?:zes)?|tests?|contr[oô]les?|interros?|interrogations?|oral)\b/i;
const DEADLINE_RE = /\b(due|deadlines?|submissions?|submit|rendus?|[àa] rendre|remise|projects?|projets?|assignments?|devoirs?|homework|dm|report|rapport)\b/i;

/** Keyword classification; exam beats deadline beats class. */
export function classifyEvent(title: string, source: StudyEvent["source"] = "calendar"): EventKind {
	if (EXAM_RE.test(title)) return "exam";
	if (DEADLINE_RE.test(title)) return "deadline";
	if (CLASS_RE.test(title)) return "class";
	// A dated to-do with no other cue is still something due.
	return source === "todo" ? "deadline" : "other";
}

const KIND_WORDS = new RegExp(
	`${EXAM_RE.source}|${DEADLINE_RE.source}|\\b(?:${LECTURE_SRC}|${TUTORIAL_SRC}|${LAB_SRC}|${OTHER_CLASS_SRC}|${GROUP_SRC})\\b`,
	"gi",
);
const COURSE_CODE_RE = /\b([A-Z]{2,5})\s?-?(\d{2,4}[A-Z]?)\b/;

/** A title with its meeting type and group words taken out ("TD2 Analyse - groupe B" → "Analyse"). */
function withoutSessionWords(title: string): string {
	return title.replace(new RegExp(`\\b(?:${LECTURE_SRC}|${TUTORIAL_SRC}|${LAB_SRC}|${GROUP_SRC})\\b`, "gi"), " ");
}

/**
 * The course an event belongs to, as a stable key + a display label.
 * "MATH201 Lecture 7: Eigenvalues" → math201; "Linear Algebra - Exam" →
 * "linear algebra"; "CM Analyse", "TD2 Analyse (groupe B)" and "Analyse - TP"
 * are all "analyse". Empty key when nothing course-like is left.
 */
export function courseOf(title: string): { key: string; label: string } {
	const bare = withoutSessionWords(title);
	const code = COURSE_CODE_RE.exec(bare);
	if (code) return { key: `${code[1]}${code[2]}`.toLowerCase(), label: `${code[1]}${code[2]}` };
	// Empty brackets are what "(TD)" leaves; the subtitle after ":" or "(" is dropped.
	const tidy = bare.replace(/[(\[]\s*[)\]]/g, " ").replace(/^[\s:|\-–—_/,.&+]+/, "");
	const head = tidy.split(/[:|(\[]/)[0] ?? tidy;
	const label = head
		.replace(KIND_WORDS, " ")
		.replace(/#?\d+/g, " ")
		.replace(/[-–—_/,.&+]+/g, " ")
		.replace(/\s+/g, " ")
		// "Cours de thermodynamique", "TD d'analyse": the course is what follows.
		.replace(/^(?:de l['’]\s*|de la\s+|du\s+|des\s+|de\s+|d['’]\s*|l['’]\s*)(?=\S)/i, (_m) => "\u0000")
		.replace(/^\u0000(.)/, (_m, c: string) => c.toUpperCase())
		.trim();
	return { key: label.toLowerCase(), label };
}

/**
 * Group keys made before CM, TD and TP were one course ("td analyse",
 * "cm analyse") folded into the key they now belong to, merging their notes
 * and sessions. A key that is nothing but meeting words, or that no longer
 * reads as a course, stays as it is.
 */
export function foldSessionKeys(links: CourseLinks): CourseLinks {
	const out: CourseLinks = {};
	const owner = (key: string) => {
		const folded = withoutSessionWords(key).replace(/[-–—_/,.&+]+/g, " ").replace(/\s+/g, " ").trim();
		return folded && folded !== key ? folded : key;
	};
	for (const [key, group] of Object.entries(links)) {
		const at = owner(key);
		const into = out[at];
		if (!into) {
			out[at] = at === key ? group : { ...group, aliases: [...new Set([...(group.aliases ?? []), key])] };
			continue;
		}
		const union = (a?: string[], b?: string[]) => (a || b ? [...new Set([...(a ?? []), ...(b ?? [])])] : undefined);
		const chatIds = union(into.chatIds, group.chatIds);
		const noteIds = union(into.noteIds, group.noteIds);
		const aliases = union(into.aliases, [...(group.aliases ?? []), ...(at === key ? [] : [key])]);
		out[at] = {
			...into,
			...(chatIds ? { chatIds } : {}),
			...(noteIds ? { noteIds } : {}),
			...(aliases ? { aliases } : {}),
		};
	}
	return out;
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
 * confirmed sessions, topics match on shared words with the event title (and
 * the suggested sessions count whole). Topics learned from the course
 * group's notes count too, and the notes come along for the session prompts.
 */
export function topicsForEvent(
	event: StudyEvent,
	topics: readonly TopicRetention[],
	links: CourseLinks,
	sessions: readonly SessionRef[],
	material: Readonly<Record<string, CourseMaterial>> = {},
): {
	topics: TopicRetention[];
	course: { key: string; label: string };
	linked: boolean;
	chatIds: string[];
	notes: { id: string; name: string }[];
} {
	const raw = courseOf(event.title);
	const found = courseGroupFor(links, raw.key);
	// A group's key and (renamed) label win, so every event of it reads the same.
	const course = found ? { key: found.key, label: found.group.label } : raw;
	const confirmed = found?.group.chatIds;
	const chatIds = confirmed ?? (raw.key ? suggestSessions(raw.label, sessions) : []);
	const chatSet = new Set(chatIds);
	const fromNotes = new Set(found ? (material[found.key]?.topicKeys ?? []) : []);
	const words = tokens(event.title);
	const matched = topics.filter(
		(t) =>
			chatSet.has(t.chatId) ||
			fromNotes.has(t.key) ||
			(!confirmed && words.size > 0 && overlaps(words, tokens(`${t.title} ${t.chatTitle}`))),
	);
	const notes = found ? (material[found.key]?.notes ?? []) : [];
	return { topics: matched, course, linked: confirmed !== undefined, chatIds, notes };
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

/** "rehearse" is an exam-style run before an exam; "prep" a short review before a tough class. */
export type ItemAction = "review" | "check" | "learn" | "rehearse" | "prep";

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
	/** The course group's notes, when the event's course has some: the
	 *  session prompt points the tutor at them, a rehearsal can be a mock
	 *  exam written from them. */
	noteIds?: string[];
	noteNames?: string[];
	/** For a prep before a class: how it meets (lecture, tutorial or lab). */
	session?: SessionType;
}

export interface UpcomingEntry {
	event: StudyEvent;
	kind: EventKind;
	course: { key: string; label: string };
	linked: boolean;
	chatIds: string[];
	topicCount: number;
	/** Files in the course group (0 when none or no group). */
	noteCount?: number;
	/** Mean projected recall of the linked topics at the event, 0-1; null when none. */
	readiness: number | null;
}

export interface ClassEntry {
	event: StudyEvent;
	course: { key: string; label: string };
	chatIds: string[];
	/** The course group's notes (empty when none). */
	notes?: { id: string; name: string }[];
	/** How this class meets (CM / TD / TP), when its title says. */
	session?: SessionType | null;
}

export interface BriefingPlan {
	/** The briefing day, local YYYY-MM-DD. */
	day: string;
	generatedAt: number;
	budgetMinutes: number;
	/** Today's list: the study plan's first day. */
	items: BriefingItem[];
	upcoming: UpcomingEntry[];
	todayClasses: ClassEntry[];
	/** Tracked topics in the retention report (0 = nothing tested yet). */
	trackedTopics: number;
	/** The day-by-day plan up to each exam (absent on briefings saved before it existed). */
	study?: StudyPlan;
	/** How the plan changed since the last one, in plain words. */
	changes?: string[];
}

export interface BriefingInput {
	now: number;
	events: readonly StudyEvent[];
	topics: readonly TopicRetention[];
	sessions: readonly SessionRef[];
	links: CourseLinks;
	/** Group key → what its notes bring (topics learned from them, the files). */
	material?: Readonly<Record<string, CourseMaterial>>;
	/** Sessions with a recent wrong answer given at ≥ 70% confidence. */
	confidentMissChats: ReadonlySet<string>;
	budgetMinutes?: number;
	/** The last saved plan from an earlier day, to say what changed. */
	previous?: PlanSnapshot | null;
}

/** The local calendar day a moment belongs to, shifted so the day starts at BRIEFING_HOUR. */
export function briefingDay(now: number): string {
	const d = new Date(now - BRIEFING_HOUR * 60 * 60 * 1000);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The deterministic plan: match exams, deadlines and this week's classes to
 * topics, hand them to the study planner (core/study-plan.ts), and take its
 * first day as today's list.
 */
export function planBriefing(input: BriefingInput): BriefingPlan {
	const { now, topics, sessions, links, confidentMissChats } = input;
	const material = input.material ?? {};
	const budget = input.budgetMinutes ?? DEFAULT_BUDGET_MINUTES;
	const reach = (kind: EventKind) => now + (kind === "exam" ? EXAM_HORIZON_DAYS : kind === "class" ? WEEK_DAYS : HORIZON_DAYS) * DAY_MS;
	const events = input.events
		.map((e) => ({ ...e, kind: e.kind ?? classifyEvent(e.title, e.source) }))
		.filter((e) => e.end >= now && e.start <= reach(e.kind))
		.sort((a, b) => a.start - b.start);

	const upcoming: UpcomingEntry[] = [];
	const targets: PlanTarget[] = [];
	const classes: PlanClass[] = [];
	for (const event of events) {
		if (event.kind === "class") {
			const match = topicsForEvent(event, topics, links, sessions, material);
			classes.push({ event, course: match.course, topics: match.topics, chatIds: match.chatIds, notes: match.notes });
			continue;
		}
		if (event.kind !== "exam" && event.kind !== "deadline") continue;
		const match = topicsForEvent(event, topics, links, sessions, material);
		const at = Math.max(event.start, now);
		const projections = match.topics.map((t) => retentionAt(t, at));
		upcoming.push({
			event,
			kind: event.kind,
			course: match.course,
			linked: match.linked,
			chatIds: match.chatIds,
			topicCount: match.topics.length,
			noteCount: match.notes.length,
			readiness: projections.length > 0 ? projections.reduce((a, b) => a + b, 0) / projections.length : null,
		});
		targets.push({
			event,
			kind: event.kind,
			label: match.course.label || event.title,
			topics: match.topics,
			chatIds: match.chatIds,
			notes: match.notes,
		});
	}

	const study = planStudy({ now, budgetMinutes: budget, targets, classes, topics, confidentMissChats });

	const todayEnd = new Date(now);
	todayEnd.setHours(23, 59, 59, 999);
	const todayClasses: ClassEntry[] = classes
		.filter((c) => c.event.start <= todayEnd.getTime())
		.map(({ event, course, chatIds, notes }) => ({ event, course, chatIds, notes: notes ?? [], session: sessionTypeOf(event.title) }));

	return {
		day: briefingDay(now),
		generatedAt: now,
		budgetMinutes: budget,
		items: study.days[0]?.items ?? [],
		upcoming,
		todayClasses,
		trackedTopics: topics.length,
		study,
		changes: planChanges(input.previous, study, topics, now),
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
	const change = plan.changes?.[0] ? ` ${plan.changes[0]}` : "";
	return `${plan.items.length} thing${plan.items.length === 1 ? "" : "s"} today, about ${total} minutes in all.${exam ? ` Next exam: ${exam.event.title}, ${whenLabel(exam.event.start, plan.generatedAt)}.` : ""}${change} Start with the first one.`;
}

/** Course files named in a prompt (the rest: "and N more"). */
const PROMPT_NOTES = 4;

/** The sentence that points the tutor at a course group's files. */
export function courseNotesLine(names: readonly string[] | undefined): string {
	if (!names || names.length === 0) return "";
	const shown = names.slice(0, PROMPT_NOTES).map((n) => `"${n}"`).join(", ");
	const more = names.length > PROMPT_NOTES ? ` and ${names.length - PROMPT_NOTES} more` : "";
	return ` My course notes for this are saved in the app: ${shown}${more}. Work from them and stick to what they say.`;
}

/** What a prep asks for depends on how the class meets: recall before a lecture, method before an exercise class, procedure before a lab. */
const PREP_OPENING: Record<SessionType, (event: string) => string> = {
	lecture: (e) => `Before my lecture (${e})`,
	tutorial: (e) => `Before my tutorial (${e})`,
	lab: (e) => `Before my lab (${e})`,
};
const PREP_TASK: Record<SessionType, (topics: string) => string> = {
	lecture: (t) => `quiz me on ${t}, the parts of this course I keep getting wrong, and reteach whatever I miss.`,
	tutorial: (t) => `give me one or two short exercises on ${t}, like the ones a tutorial sets, check my method step by step, and reteach whatever I get wrong.`,
	lab: (t) => `ask me the theory behind the lab on ${t}: the formulas, the units, what I will measure and why, and reteach whatever I miss.`,
};

/** The prompt text for a Start button: a fresh session seeded with the item. */
export function startPrompt(item: BriefingItem): string {
	return basePrompt(item) + courseNotesLine(item.noteNames);
}

function basePrompt(item: BriefingItem): string {
	const forEvent = item.eventTitle ? ` I have ${item.eventTitle} ${whenLabel(item.eventStart ?? Date.now(), Date.now())}.` : "";
	switch (item.action) {
		case "learn":
			return `Teach me the essentials for ${item.eventTitle ?? item.title}.${forEvent} Start by asking what I already know.`;
		case "check":
			return item.topicTitles.length > 0
				? `Quick check, about 10 minutes: quiz me on ${item.topicTitles.join(", ")} before I trust that I know it.${forEvent}`
				: `Quick check, about 10 minutes: find out what I really know of ${item.eventTitle ?? item.title} with a few questions, before anything else.${forEvent}`;
		case "rehearse":
			return `Exam rehearsal, about 30 minutes, on ${item.topicTitles.join(", ")}.${forEvent} Give me one or two exam-style problems: a scenario with several questions that build on it, not multiple choice. No hints while I work. Keep the scenario's data fixed throughout, then grade each answer against it at the end and tell me what to review.`;
		case "prep":
			return `${PREP_OPENING[item.session ?? "lecture"](item.eventTitle ?? "today")}, about 10 minutes: ${PREP_TASK[item.session ?? "lecture"](item.topicTitles.join(", "))}`;
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
		return `I only have 5 minutes: teach me the single most important idea for ${item.eventTitle ?? item.title}, then ask me one question to check it, and stop there.${forEvent}${courseNotesLine(item.noteNames)}`;
	}
	const on = item.topicTitles.length > 0 ? item.topicTitles.join(", ") : (item.eventTitle ?? item.title);
	return `I only have 5 minutes: ask me two or three quick questions on ${on}, from memory, then tell me how I did and stop there.${forEvent}`;
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
