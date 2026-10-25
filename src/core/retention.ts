/**
 * RETENTION (knowledge decay + the review schedule): every topic the
 * learner has been tested on gets a memory model, updated ONLY from what
 * actually happened when recall was tested — never from how sure the
 * learner felt. Confidence can lower a grade (right but unsure reads as
 * shaky) but never raise one, and no event ever grades "easy": the model
 * leans pessimistic on purpose, because overestimating what is known is
 * exactly the failure it exists to catch.
 *
 * Topics:
 *   - a teaching session's PLAN NODE, tested by teach-phase quiz CHECKS
 *     (predictions are posed before the teaching, so a miss there is not
 *     forgetting; probe quizzes carry no node and are not counted);
 *   - a graph PROPOSITION, tested by practice problems that target it
 *     (the conclude outcome is the grade).
 *
 * The memory model is FSRS-4.5 with its published default weights: each
 * topic carries a stability S (days until recall probability falls to
 * 90%) and a difficulty D. A successful review grows S; a lapse collapses
 * it. Retention now is R(t) = (1 + F·t/S)^C, and a topic is due once R
 * drops under the target.
 *
 * Pure and browser-safe: the server reads the records, this folds them.
 */

import type { ChatRecord } from "./contracts/chat.ts";
import type { GraphNode } from "./contracts.ts";
import type { QuestionAnswerData } from "./question-core.ts";

/** FSRS grades. Easy (4) is deliberately never produced. */
export type RecallGrade = 1 | 2 | 3;
export const GRADE_AGAIN: RecallGrade = 1;
export const GRADE_HARD: RecallGrade = 2;
export const GRADE_GOOD: RecallGrade = 3;

export type TopicKind = "plan" | "proposition";

/** One tested recall, lifted out of its session. */
export interface RecallEvent {
	topicKey: string;
	kind: TopicKind;
	/** Plan node slug or graph node id. */
	topicId: string;
	/** The node title / proposition name when known (else the id). */
	title: string;
	chatId: string;
	chatTitle: string;
	/** Epoch ms. */
	at: number;
	grade: RecallGrade;
	/** A dedicated review of a topic first tested elsewhere: it schedules
	 *  the topic but never renames it or moves its home session. */
	review?: boolean;
}

export interface TopicRetention {
	key: string;
	kind: TopicKind;
	title: string;
	/** The session to go back to: the plan's session, or the latest practice on the proposition. */
	chatId: string;
	chatTitle: string;
	/** Tested answers, and the sittings they fold into (one review each). */
	answers: number;
	reviews: number;
	lapses: number;
	lastReviewedAt: number;
	lastGrade: RecallGrade;
	/** Days until predicted recall falls to TARGET_RETENTION. */
	stability: number;
	difficulty: number;
	/** Predicted probability of recall right now, 0-1. */
	retention: number;
	dueAt: number;
	due: boolean;
}

export interface RetentionReport {
	now: number;
	/** Due now, weakest first. */
	due: TopicRetention[];
	/** Falling due within UPCOMING_DAYS, soonest first. */
	upcoming: TopicRetention[];
	/** Every tracked topic, weakest first. */
	topics: TopicRetention[];
}

/** Below this predicted recall a topic is due. */
export const TARGET_RETENTION = 0.9;
/** Right answers given under this confidence grade as shaky (Hard). */
export const SHAKY_CONFIDENCE = 50;
/** Answers on one topic closer than this fold into one sitting. */
export const SITTING_GAP_MS = 6 * 60 * 60 * 1000;
export const UPCOMING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── FSRS-4.5 ───────────────────────────────────────────────────────────────

/** FSRS-4.5 default weights (open-spaced-repetition, fsrs4anki 4.5). */
export const FSRS_WEIGHTS = [
	0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246,
	1.587, 0.2272, 2.8755,
] as const;
const W = FSRS_WEIGHTS;
const DECAY = -0.5;
const FACTOR = 19 / 81; // 0.9 ** (1 / DECAY) - 1: makes R(S) = 0.9

export interface MemoryState {
	stability: number;
	difficulty: number;
}

const clampD = (d: number): number => Math.min(10, Math.max(1, d));

/** Predicted recall after `elapsedDays` at stability `stability`. */
export function retrievability(elapsedDays: number, stability: number): number {
	return (1 + (FACTOR * Math.max(0, elapsedDays)) / stability) ** DECAY;
}

/** Days from the last review until recall falls to `target`. */
export function intervalDays(stability: number, target = TARGET_RETENTION): number {
	return (stability / FACTOR) * (target ** (1 / DECAY) - 1);
}

const initDifficulty = (g: RecallGrade): number => clampD(W[4] - (g - 3) * W[5]);

/** The first review of a topic. */
export function initialState(grade: RecallGrade): MemoryState {
	return { stability: W[grade - 1]!, difficulty: initDifficulty(grade) };
}

/** One later review, `elapsedDays` after the previous one. */
export function nextState(state: MemoryState, grade: RecallGrade, elapsedDays: number): MemoryState {
	const { stability: s, difficulty: d } = state;
	const r = retrievability(elapsedDays, s);
	const stability =
		grade === GRADE_AGAIN
			? Math.min(s, W[11] * d ** -W[12] * ((s + 1) ** W[13] - 1) * Math.exp(W[14] * (1 - r)))
			: s *
				(1 +
					Math.exp(W[8]) *
						(11 - d) *
						s ** -W[9] *
						(Math.exp(W[10] * (1 - r)) - 1) *
						(grade === GRADE_HARD ? W[15] : 1));
	const shifted = d - W[6] * (grade - 3);
	const difficulty = clampD(W[7] * initDifficulty(GRADE_GOOD) + (1 - W[7]) * shifted);
	return { stability: Math.max(0.01, stability), difficulty };
}

// ─── lifting events out of records ──────────────────────────────────────────

/** The grade of one graded quiz answer: what happened, never how it felt. */
export function quizGrade(answer: Pick<QuestionAnswerData, "correct" | "dontKnow" | "confidence">): RecallGrade {
	if (answer.dontKnow || answer.correct !== true) return GRADE_AGAIN;
	if (typeof answer.confidence === "number" && answer.confidence < SHAKY_CONFIDENCE) return GRADE_HARD;
	return GRADE_GOOD;
}

/** The grade of a concluded practice problem; null when it tested nothing. */
export function practiceGrade(outcome: unknown): RecallGrade | null {
	switch (outcome) {
		case "solved":
			return GRADE_GOOD;
		case "solvedWithHints":
			return GRADE_HARD;
		case "movedOn":
		case "surrendered":
			return GRADE_AGAIN;
		default:
			return null; // dismissed, or unrecognized
	}
}

interface CallBlock {
	type?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
}

function callBlocks(m: unknown): CallBlock[] {
	if ((m as { role?: string }).role !== "assistant") return [];
	const content = (m as { content?: unknown }).content;
	return Array.isArray(content) ? (content as CallBlock[]).filter((b) => b?.type === "toolCall") : [];
}

function isGradedQuiz(details: unknown): details is QuestionAnswerData {
	if (!details || typeof details !== "object") return false;
	const d = details as Partial<QuestionAnswerData>;
	return d.kind === "quiz" && d.dismissed !== true && typeof d.answeredAt === "string";
}

/** Every tested recall in one record, in transcript order. `propositionName`
 *  resolves practice targets to their graph names. */
export function recallEvents(
	record: Pick<ChatRecord, "id" | "title" | "messages" | "tree">,
	propositionName: (id: string) => string | undefined = () => undefined,
): RecallEvent[] {
	const out: RecallEvent[] = [];
	const titles = new Map((record.tree?.nodes ?? []).map((n) => [n.id, n.title]));
	const calls = new Map<string, CallBlock>();
	const okResults = new Set<string>();
	for (const m of record.messages) {
		for (const b of callBlocks(m)) if (b.id) calls.set(b.id, b);
		const r = m as { role?: string; toolCallId?: string; isError?: boolean };
		if (r.role === "toolResult" && r.toolCallId && r.isError !== true) okResults.add(r.toolCallId);
	}
	const base = { chatId: record.id, chatTitle: record.title };

	let problemTargets: string[] = [];
	for (const m of record.messages) {
		// Practice: a problem call names its targets; its conclude grades them.
		for (const b of callBlocks(m)) {
			if (b.name === "problem" && b.id && okResults.has(b.id)) {
				const target = (b.arguments as { target?: unknown } | undefined)?.target;
				problemTargets = Array.isArray(target) ? target.filter((t): t is string => typeof t === "string") : [];
			} else if (b.name === "conclude" && b.id && okResults.has(b.id)) {
				const grade = practiceGrade((b.arguments as { outcome?: unknown } | undefined)?.outcome);
				const at = (m as { timestamp?: number }).timestamp;
				if (grade !== null && typeof at === "number") {
					for (const id of new Set(problemTargets)) {
						out.push({ ...base, topicKey: `prop:${id}`, kind: "proposition", topicId: id, title: propositionName(id) ?? id, at, grade });
					}
				}
				problemTargets = [];
			}
		}

		// Teaching: a graded quiz answer on a plan node, posed as a check.
		const r = m as { role?: string; toolCallId?: string; details?: unknown };
		if (r.role !== "toolResult" || !isGradedQuiz(r.details)) continue;
		const at = Date.parse(r.details.answeredAt);
		if (Number.isNaN(at)) continue;

		// A review answer names its topic key outright (any session kind).
		const reviewed = parseTopicKey((r.details as { topicId?: unknown }).topicId);
		if (reviewed) {
			out.push({ ...base, ...reviewed, title: reviewed.topicId, at, grade: quizGrade(r.details), review: true });
			continue;
		}

		const call = r.toolCallId ? calls.get(r.toolCallId) : undefined;
		const args = (call?.arguments ?? {}) as { nodeId?: unknown; type?: unknown };
		if (call?.name !== "quiz" || typeof args.nodeId !== "string" || args.nodeId === "") continue;
		if (typeof args.type === "string" && args.type.includes("predict")) continue;
		out.push({
			...base,
			topicKey: `plan:${record.id}:${args.nodeId}`,
			kind: "plan",
			topicId: args.nodeId,
			title: titles.get(args.nodeId) ?? args.nodeId,
			at,
			grade: quizGrade(r.details),
		});
	}
	return out;
}

/** A topic key ("plan:<chatId>:<nodeId>" | "prop:<graphNodeId>") split
 *  into its parts; null when it is not one. */
export function parseTopicKey(key: unknown): Pick<RecallEvent, "topicKey" | "kind" | "topicId"> | null {
	if (typeof key !== "string") return null;
	const plan = /^plan:[^:]+:(.+)$/.exec(key);
	if (plan) return { topicKey: key, kind: "plan", topicId: plan[1]! };
	const prop = /^prop:(.+)$/.exec(key);
	if (prop) return { topicKey: key, kind: "proposition", topicId: prop[1]! };
	return null;
}

/** First-line names of graph nodes (the first line defines a node's name). */
export function propositionNames(lines: readonly Pick<GraphNode, "id" | "name">[]): Map<string, string> {
	const names = new Map<string, string>();
	for (const line of lines) if (!names.has(line.id) && line.name) names.set(line.id, line.name);
	return names;
}

// ─── the fold ───────────────────────────────────────────────────────────────

/** One sitting's grade: a wrong final answer is a lapse; any wobble on the
 *  way (a miss, an unsure right) caps it at Hard. */
function sittingGrade(grades: RecallGrade[]): RecallGrade {
	if (grades.at(-1) === GRADE_AGAIN) return GRADE_AGAIN;
	return grades.some((g) => g !== GRADE_GOOD) ? GRADE_HARD : GRADE_GOOD;
}

export function topicRetention(events: readonly RecallEvent[], now: number): TopicRetention {
	const sorted = [...events].sort((a, b) => a.at - b.at);
	const sittings: { at: number; grades: RecallGrade[] }[] = [];
	for (const e of sorted) {
		const last = sittings.at(-1);
		if (last && e.at - last.at < SITTING_GAP_MS) {
			last.at = e.at;
			last.grades.push(e.grade);
		} else sittings.push({ at: e.at, grades: [e.grade] });
	}

	let state: MemoryState | null = null;
	let prevAt = 0;
	let lapses = 0;
	let lastGrade: RecallGrade = GRADE_GOOD;
	for (const s of sittings) {
		const grade = sittingGrade(s.grades);
		state = state === null ? initialState(grade) : nextState(state, grade, (s.at - prevAt) / DAY_MS);
		if (grade === GRADE_AGAIN) lapses++;
		prevAt = s.at;
		lastGrade = grade;
	}
	const final = state!;
	const latest = sorted.at(-1)!;
	const home = sorted.filter((e) => !e.review).at(-1) ?? latest;
	const dueAt = prevAt + intervalDays(final.stability) * DAY_MS;
	const retention = retrievability((now - prevAt) / DAY_MS, final.stability);
	return {
		key: latest.topicKey,
		kind: latest.kind,
		title: home.title,
		chatId: home.chatId,
		chatTitle: home.chatTitle,
		answers: sorted.length,
		reviews: sittings.length,
		lapses,
		lastReviewedAt: prevAt,
		lastGrade,
		stability: final.stability,
		difficulty: final.difficulty,
		retention,
		dueAt,
		due: dueAt <= now,
	};
}

/** Predicted recall of a topic at any moment (e.g. an exam day), assuming
 *  no review in between. */
export function retentionAt(topic: Pick<TopicRetention, "lastReviewedAt" | "stability">, at: number): number {
	return retrievability((at - topic.lastReviewedAt) / DAY_MS, topic.stability);
}

export function retentionReport(events: readonly RecallEvent[], now: number): RetentionReport {
	const byTopic = new Map<string, RecallEvent[]>();
	for (const e of events) byTopic.set(e.topicKey, [...(byTopic.get(e.topicKey) ?? []), e]);
	const topics = [...byTopic.values()]
		.map((xs) => topicRetention(xs, now))
		.sort((a, b) => a.retention - b.retention || a.dueAt - b.dueAt);
	return {
		now,
		due: topics.filter((t) => t.due),
		upcoming: topics.filter((t) => !t.due && t.dueAt <= now + UPCOMING_DAYS * DAY_MS).sort((a, b) => a.dueAt - b.dueAt),
		topics,
	};
}

/** "in 3 days", "2 days ago", "today": the view's relative dates. */
export function relativeDays(at: number, now: number): string {
	const days = Math.round((at - now) / DAY_MS);
	if (days === 0) return "today";
	if (days === 1) return "tomorrow";
	if (days === -1) return "yesterday";
	return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
