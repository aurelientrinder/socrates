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
 *   - any topic, tested again in a review session: a multiple-choice
 *     review answer grades like a quiz, a free-recall answer by its
 *     marking (recall-review.ts — how many key points came back);
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
import type { GraphChain, GraphNode } from "./contracts.ts";
import type { QuestionAnswerData } from "./question-core.ts";
import { isRecallMarkData, RECALL_REVIEW_TOOL } from "./recall-review.ts";

/** Minimal reasoning-chain projection consumed by FIRe propagation. */
export type ChainLink = Pick<GraphChain, "premises" | "conclusion">;

/** FSRS grades. Easy (4) is deliberately never produced. */
export type RecallGrade = 1 | 2 | 3;
export const GRADE_AGAIN: RecallGrade = 1;
export const GRADE_HARD: RecallGrade = 2;
export const GRADE_GOOD: RecallGrade = 3;

export type TopicKind = "plan" | "proposition" | "card";

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
	/** The stated confidence of a quiz answer (absent on practice, and on
	 *  "I don't know"). Never touches the schedule beyond quizGrade's
	 *  shaky line; the weak-spot report reads it for overconfidence. */
	confidence?: number;
	/** The quiz question as posed (absent on practice): what a weak-spot
	 *  drill aims its fresh question at. */
	question?: string;
}

/** A shaky ancestor premise flagged on a dependent conclusion (blast radius). */
export interface ShakyPremise {
	key: string;
	title: string;
	retention: number;
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
	/** Upward FIRe implicit credits applied from passing encompassing conclusions. */
	implicitCredits?: number;
	/** Tracked ancestor premises that lapsed, were shaky, or are overdue. */
	shakyPremises?: ShakyPremise[];
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

/** Conservative FIRe upward credit decay per hop (0.5 at 1 hop, 0.25 at 2 hops). */
export const FIRE_CREDIT_DECAY = 0.5;
/** Maximum chain depth for FIRe upward credit and downward blast radius. */
export const FIRE_MAX_DEPTH = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── FSRS-6 ─────────────────────────────────────────────────────────────────

/** 21-parameter FSRS-6 weight vector. */
export type FsrsWeights = readonly number[];
export const FSRS_WEIGHT_COUNT = 21;

/** FSRS-6 default weights (open-spaced-repetition, fsrs-6). */
export const FSRS_WEIGHTS: readonly [
	number, number, number, number, number, number, number,
	number, number, number, number, number, number, number,
	number, number, number, number, number, number, number,
] = [
	0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194,
	0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
	1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
] as const;

export interface MemoryState {
	stability: number;
	difficulty: number;
}

const clampD = (d: number): number => Math.min(10, Math.max(1, d));

function decayAndFactor(w: FsrsWeights): { decay: number; factor: number } {
	const decay = -Math.max(0.01, w[20] ?? FSRS_WEIGHTS[20]);
	return { decay, factor: 0.9 ** (1 / decay) - 1 };
}

/** Predicted recall after `elapsedDays` at stability `stability`. */
export function retrievability(elapsedDays: number, stability: number, w: FsrsWeights = FSRS_WEIGHTS): number {
	const { decay, factor } = decayAndFactor(w);
	return (1 + (factor * Math.max(0, elapsedDays)) / stability) ** decay;
}

/** Days from the last review until recall falls to `target`. */
export function intervalDays(stability: number, target = TARGET_RETENTION, w: FsrsWeights = FSRS_WEIGHTS): number {
	const { decay, factor } = decayAndFactor(w);
	return (stability / factor) * (target ** (1 / decay) - 1);
}

const initDifficulty = (g: 1 | 2 | 3 | 4, w: FsrsWeights = FSRS_WEIGHTS): number =>
	clampD(w[4]! - Math.exp(w[5]! * (g - 1)) + 1);

/** The first review of a topic. */
export function initialState(grade: RecallGrade, w: FsrsWeights = FSRS_WEIGHTS): MemoryState {
	return { stability: Math.max(0.01, w[grade - 1]!), difficulty: initDifficulty(grade, w) };
}

/** One later review, `elapsedDays` after the previous one (FSRS-6: same-day
 *  short-term stability for elapsedDays < 1, long-term stability for >= 1). */
export function nextState(
	state: MemoryState,
	grade: RecallGrade,
	elapsedDays: number,
	w: FsrsWeights = FSRS_WEIGHTS,
): MemoryState {
	const { stability: s, difficulty: d } = state;
	let stability: number;
	if (elapsedDays < 1) {
		const inc = Math.exp(w[17]! * (grade - 3 + w[18]!)) * s ** -w[19]!;
		const mult = grade >= GRADE_GOOD ? Math.max(1, inc) : inc;
		stability = grade === GRADE_AGAIN ? Math.min(s, s * mult) : s * mult;
	} else {
		const r = retrievability(elapsedDays, s, w);
		stability =
			grade === GRADE_AGAIN
				? Math.min(s, w[11]! * d ** -w[12]! * ((s + 1) ** w[13]! - 1) * Math.exp(w[14]! * (1 - r)))
				: s *
					(1 +
						Math.exp(w[8]!) *
							(11 - d) *
							s ** -w[9]! *
							(Math.exp(w[10]! * (1 - r)) - 1) *
							(grade === GRADE_HARD ? w[15]! : 1));
	}
	const deltaD = -w[6]! * (grade - 3);
	const damped = d + (deltaD * (10 - d)) / 9;
	const difficulty = clampD(w[7]! * initDifficulty(4, w) + (1 - w[7]!) * damped);
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

		const r = m as { role?: string; toolCallId?: string; toolName?: string; details?: unknown; isError?: boolean };

		// Free-recall review: the marking grades the topic (the grade is
		// computed from the marks, never chosen — recall-review.ts), and
		// "I don't know" grades it on the answer alone.
		if (r.role === "toolResult" && r.isError !== true && isRecallMarkData(r.details)) {
			const marked = parseTopicKey(r.details.topicId);
			const at = Date.parse(r.details.markedAt);
			if (marked && !Number.isNaN(at)) {
				out.push({ ...base, ...marked, title: marked.topicId, at, grade: r.details.grade, review: true });
			}
			continue;
		}
		if (r.role === "toolResult" && r.toolName === RECALL_REVIEW_TOOL) {
			const d = r.details as Partial<QuestionAnswerData> | undefined;
			const recalled = parseTopicKey(d?.topicId);
			const at = typeof d?.answeredAt === "string" ? Date.parse(d.answeredAt) : NaN;
			if (recalled && d?.dontKnow === true && d.dismissed !== true && !Number.isNaN(at)) {
				out.push({ ...base, ...recalled, title: recalled.topicId, at, grade: GRADE_AGAIN, review: true });
			}
			continue;
		}

		// Teaching: a graded quiz answer on a plan node, posed as a check.
		if (r.role !== "toolResult" || !isGradedQuiz(r.details)) continue;
		const at = Date.parse(r.details.answeredAt);
		if (Number.isNaN(at)) continue;

		// A review answer names its topic key outright (any session kind).
		const confidence = {
			...(!r.details.dontKnow && typeof r.details.confidence === "number" ? { confidence: r.details.confidence } : {}),
			...(typeof r.details.questionText === "string" && r.details.questionText ? { question: r.details.questionText } : {}),
		};
		const reviewed = parseTopicKey((r.details as { topicId?: unknown }).topicId);
		if (reviewed) {
			out.push({ ...base, ...reviewed, title: reviewed.topicId, at, grade: quizGrade(r.details), review: true, ...confidence });
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
			...confidence,
		});
	}
	return out;
}

/** A topic key ("plan:<chatId>:<nodeId>" | "prop:<graphNodeId>" | "card:<noteId>:<cardId>")
 *  split into its parts; null when it is not one. */
export function parseTopicKey(key: unknown): Pick<RecallEvent, "topicKey" | "kind" | "topicId"> | null {
	if (typeof key !== "string") return null;
	const plan = /^plan:[^:]+:(.+)$/.exec(key);
	if (plan) return { topicKey: key, kind: "plan", topicId: plan[1]! };
	const prop = /^prop:(.+)$/.exec(key);
	if (prop) return { topicKey: key, kind: "proposition", topicId: prop[1]! };
	const card = /^card:[^:]+:(.+)$/.exec(key);
	if (card) return { topicKey: key, kind: "card", topicId: card[1]! };
	return null;
}

/** First-line names of graph nodes (the first line defines a node's name). */
export function propositionNames(lines: readonly Pick<GraphNode, "id" | "name">[]): Map<string, string> {
	const names = new Map<string, string>();
	for (const line of lines) if (!names.has(line.id) && line.name) names.set(line.id, line.name);
	return names;
}

// ─── unifying plan nodes with canonical graph propositions ──────────────────

/**
 * Attribute assistant message IDs to each plan node in a session transcript,
 * mirroring `planNodeTeaching` (recall-review.ts): the prose turns leading up
 * to a `quiz` or `explain` call tagged with `nodeId`, plus that call's own
 * message. Used to join session plan nodes with extracted GraphNodes via their
 * message-granular provenance — zero LLM calls, works retroactively.
 */
export function planNodeMessageIds(messages: readonly unknown[]): Record<string, string[]> {
	const byNode = new Map<string, Set<string>>();
	let pending: string[] = [];
	for (const m of messages) {
		const msg = m as { role?: string; id?: unknown; content?: unknown };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const msgId = typeof msg.id === "string" && msg.id ? msg.id : null;
		for (const block of msg.content as { type?: string; text?: string; name?: string; arguments?: unknown }[]) {
			if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
				if (msgId) pending.push(msgId);
				continue;
			}
			if (block?.type !== "toolCall" || (block.name !== "quiz" && block.name !== "explain")) continue;
			const nodeId = (block.arguments as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof nodeId === "string" && nodeId) {
				let set = byNode.get(nodeId);
				if (!set) {
					set = new Set<string>();
					byNode.set(nodeId, set);
				}
				for (const id of pending) set.add(id);
				if (msgId) set.add(msgId);
			}
			pending = [];
		}
	}
	const out: Record<string, string[]> = {};
	for (const [nodeId, ids] of byNode) out[nodeId] = [...ids];
	return out;
}

/**
 * Resolve `plan:<chatId>:<nodeId>` recall events (including later review
 * events targeting that plan key) onto canonical `prop:<graphNodeId>` events
 * whenever the plan node's messages share provenance with extracted graph
 * propositions. Unextracted or unmapped plan nodes stay `plan:*` as fallback.
 */
export function resolvePlanToPropositions(
	events: readonly RecallEvent[],
	planMessagesByChat: ReadonlyMap<string, Readonly<Record<string, readonly string[]>>>,
	nodes: readonly Pick<GraphNode, "id" | "name" | "provenance">[],
): RecallEvent[] {
	if (nodes.length === 0 || planMessagesByChat.size === 0) return [...events];
	const byProvenance = new Map<string, { id: string; name: string }[]>();
	for (const node of nodes) {
		for (const p of node.provenance) {
			if (!p.chatId || !p.messageId) continue;
			const k = `${p.chatId}\0${p.messageId}`;
			let list = byProvenance.get(k);
			if (!list) {
				list = [];
				byProvenance.set(k, list);
			}
			if (!list.some((n) => n.id === node.id)) list.push({ id: node.id, name: node.name });
		}
	}
	if (byProvenance.size === 0) return [...events];

	const out: RecallEvent[] = [];
	for (const e of events) {
		if (e.kind !== "plan") {
			out.push(e);
			continue;
		}
		const m = /^plan:([^:]+):(.+)$/.exec(e.topicKey);
		const homeChatId = m?.[1];
		const planNodeId = m?.[2];
		const msgIds = homeChatId && planNodeId ? planMessagesByChat.get(homeChatId)?.[planNodeId] : undefined;
		if (!msgIds || msgIds.length === 0) {
			out.push(e);
			continue;
		}
		const matched = new Map<string, string>();
		for (const msgId of msgIds) {
			const hits = byProvenance.get(`${homeChatId}\0${msgId}`);
			if (!hits) continue;
			for (const hit of hits) {
				if (!matched.has(hit.id)) matched.set(hit.id, hit.name);
			}
		}
		if (matched.size === 0) {
			out.push(e);
			continue;
		}
		for (const [propId, propName] of matched) {
			out.push({
				...e,
				topicKey: `prop:${propId}`,
				kind: "proposition",
				topicId: propId,
				title: propName || propId,
			});
		}
	}
	return out;
}

// ─── the fold + FIRe propagation ────────────────────────────────────────────

/** One sitting's grade: a wrong final answer is a lapse; any wobble on the
 *  way (a miss, an unsure right) caps it at Hard. */
function sittingGrade(grades: RecallGrade[]): RecallGrade {
	if (grades.at(-1) === GRADE_AGAIN) return GRADE_AGAIN;
	return grades.some((g) => g !== GRADE_GOOD) ? GRADE_HARD : GRADE_GOOD;
}

export interface Sitting {
	at: number;
	grade: RecallGrade;
}

interface ImplicitCredit {
	at: number;
	weight: number;
}

export function extractSittings(sorted: readonly RecallEvent[]): Sitting[] {
	const raw: { at: number; grades: RecallGrade[] }[] = [];
	for (const e of sorted) {
		const last = raw.at(-1);
		if (last && e.at - last.at < SITTING_GAP_MS) {
			last.at = e.at;
			last.grades.push(e.grade);
		} else raw.push({ at: e.at, grades: [e.grade] });
	}
	return raw.map((s) => ({ at: s.at, grade: sittingGrade(s.grades) }));
}

function coalesceCredits(credits: readonly ImplicitCredit[]): ImplicitCredit[] {
	if (credits.length === 0) return [];
	const sorted = [...credits].sort((a, b) => a.at - b.at);
	const out: ImplicitCredit[] = [];
	for (const c of sorted) {
		const last = out.at(-1);
		if (last && c.at - last.at < SITTING_GAP_MS) {
			last.at = c.at;
			last.weight = Math.max(last.weight, c.weight);
		} else out.push({ at: c.at, weight: c.weight });
	}
	return out;
}

/** Cycle-safe BFS of ancestor premise depths per conclusion node id. */
function buildAncestorMap(chains: readonly ChainLink[], maxDepth: number): Map<string, Map<string, number>> {
	const direct = new Map<string, Set<string>>();
	for (const c of chains) {
		if (!c.conclusion) continue;
		let set = direct.get(c.conclusion);
		if (!set) {
			set = new Set<string>();
			direct.set(c.conclusion, set);
		}
		for (const p of c.premises) {
			if (p && p !== c.conclusion) set.add(p);
		}
	}
	const out = new Map<string, Map<string, number>>();
	for (const root of direct.keys()) {
		const depths = new Map<string, number>();
		const queue: [string, number][] = [];
		for (const p of direct.get(root)!) {
			depths.set(p, 1);
			queue.push([p, 1]);
		}
		while (queue.length > 0) {
			const [cur, d] = queue.shift()!;
			if (d >= maxDepth) continue;
			const nexts = direct.get(cur);
			if (!nexts) continue;
			for (const p of nexts) {
				if (p === root || depths.has(p)) continue;
				depths.set(p, d + 1);
				queue.push([p, d + 1]);
			}
		}
		if (depths.size > 0) out.set(root, depths);
	}
	return out;
}

export function topicRetention(
	events: readonly RecallEvent[],
	now: number,
	credits: readonly ImplicitCredit[] = [],
	weights: FsrsWeights = FSRS_WEIGHTS,
): TopicRetention {
	const sorted = [...events].sort((a, b) => a.at - b.at);
	const sittings = extractSittings(sorted);
	const mergedCredits = coalesceCredits(credits);

	type Step = { kind: "direct"; at: number; grade: RecallGrade } | { kind: "credit"; at: number; weight: number };
	const timeline: Step[] = [
		...sittings.map((s): Step => ({ kind: "direct", at: s.at, grade: s.grade })),
		...mergedCredits.map((c): Step => ({ kind: "credit", at: c.at, weight: c.weight })),
	].sort((a, b) => a.at - b.at || (a.kind === "direct" ? -1 : b.kind === "direct" ? 1 : 0));

	let state: MemoryState | null = null;
	let prevAt = 0;
	let lapses = 0;
	let lastGrade: RecallGrade = GRADE_GOOD;
	let implicitCredits = 0;

	for (const step of timeline) {
		if (step.kind === "direct") {
			state = state === null ? initialState(step.grade, weights) : nextState(state, step.grade, (step.at - prevAt) / DAY_MS, weights);
			if (step.grade === GRADE_AGAIN) lapses++;
			prevAt = step.at;
			lastGrade = step.grade;
		} else if (state !== null && step.at > prevAt) {
			// Conservative FIRe: grow stability fractionally toward a Good review
			// without advancing lastReviewedAt or softening difficulty/lapses.
			const next = nextState(state, GRADE_GOOD, (step.at - prevAt) / DAY_MS, weights);
			if (next.stability > state.stability) {
				state = {
					stability: state.stability + step.weight * (next.stability - state.stability),
					difficulty: state.difficulty,
				};
				implicitCredits++;
			}
		}
	}
	const final = state!;
	const latest = sorted.at(-1)!;
	const home = sorted.filter((e) => !e.review).at(-1) ?? latest;
	const dueAt = prevAt + intervalDays(final.stability, TARGET_RETENTION, weights) * DAY_MS;
	const retention = retrievability((now - prevAt) / DAY_MS, final.stability, weights);
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
		...(implicitCredits > 0 ? { implicitCredits } : {}),
	};
}

/** Predicted recall of a topic at any moment (e.g. an exam day), assuming
 *  no review in between. */
export function retentionAt(
	topic: Pick<TopicRetention, "lastReviewedAt" | "stability">,
	at: number,
	weights: FsrsWeights = FSRS_WEIGHTS,
): number {
	return retrievability((at - topic.lastReviewedAt) / DAY_MS, topic.stability, weights);
}

function isShakyFoundation(t: Pick<TopicRetention, "lastGrade" | "due">): boolean {
	return t.lastGrade === GRADE_AGAIN || t.lastGrade === GRADE_HARD || t.due;
}

export function retentionReport(
	events: readonly RecallEvent[],
	now: number,
	chains: readonly ChainLink[] = [],
	weights: FsrsWeights = FSRS_WEIGHTS,
): RetentionReport {
	const byTopic = new Map<string, RecallEvent[]>();
	for (const e of events) byTopic.set(e.topicKey, [...(byTopic.get(e.topicKey) ?? []), e]);

	const ancestorsByNode = chains.length > 0 ? buildAncestorMap(chains, FIRE_MAX_DEPTH) : new Map<string, Map<string, number>>();
	const creditsByTopic = new Map<string, ImplicitCredit[]>();

	if (ancestorsByNode.size > 0) {
		for (const [key, xs] of byTopic) {
			if (!key.startsWith("prop:")) continue;
			const conclusionId = key.slice(5);
			const ancestors = ancestorsByNode.get(conclusionId);
			if (!ancestors) continue;
			const sorted = [...xs].sort((a, b) => a.at - b.at);
			for (const s of extractSittings(sorted)) {
				if (s.grade !== GRADE_GOOD) continue;
				for (const [premiseId, depth] of ancestors) {
					const premKey = `prop:${premiseId}`;
					if (!byTopic.has(premKey)) continue;
					const weight = FIRE_CREDIT_DECAY ** depth;
					creditsByTopic.set(premKey, [...(creditsByTopic.get(premKey) ?? []), { at: s.at, weight }]);
				}
			}
		}
	}

	const rawTopics = [...byTopic.entries()].map(([key, xs]) => topicRetention(xs, now, creditsByTopic.get(key) ?? [], weights));

	// Downward blast radius: flag tracked conclusions whose tracked ancestor
	// premises lapsed, were shaky, or are overdue (without mutating C's own S).
	let topics = rawTopics;
	if (ancestorsByNode.size > 0) {
		const byKey = new Map(rawTopics.map((t) => [t.key, t]));
		topics = rawTopics.map((t) => {
			if (t.kind !== "proposition" || !t.key.startsWith("prop:")) return t;
			const ancestors = ancestorsByNode.get(t.key.slice(5));
			if (!ancestors) return t;
			const shaky: ShakyPremise[] = [];
			for (const premiseId of ancestors.keys()) {
				const prem = byKey.get(`prop:${premiseId}`);
				if (prem && isShakyFoundation(prem)) {
					shaky.push({ key: prem.key, title: prem.title, retention: prem.retention });
				}
			}
			if (shaky.length === 0) return t;
			shaky.sort((a, b) => a.retention - b.retention || a.key.localeCompare(b.key));
			return { ...t, shakyPremises: shaky };
		});
	}

	topics.sort((a, b) => a.retention - b.retention || a.dueAt - b.dueAt);
	return {
		now,
		due: topics.filter((t) => t.due),
		upcoming: topics.filter((t) => !t.due && t.dueAt <= now + UPCOMING_DAYS * DAY_MS).sort((a, b) => a.dueAt - b.dueAt),
		topics,
	};
}

/**
 * Stably reorder a review/drill queue so tracked ancestor premises always
 * precede their dependent conclusions (preserving original priority order
 * among unrelated items, and breaking graph cycles gracefully).
 */
export function orderPrerequisitesFirst<T extends { key: string }>(
	items: readonly T[],
	chains: readonly ChainLink[],
): T[] {
	if (items.length <= 1 || chains.length === 0) return [...items];
	const propIndex = new Map<string, number>();
	for (const [i, item] of items.entries()) {
		if (item.key.startsWith("prop:")) propIndex.set(item.key.slice(5), i);
	}
	if (propIndex.size <= 1) return [...items];

	const ancestorsByNode = buildAncestorMap(chains, Math.max(FIRE_MAX_DEPTH, items.length));
	const inDegree = new Array<number>(items.length).fill(0);
	const dependents: number[][] = Array.from({ length: items.length }, () => []);

	for (const [nodeId, idx] of propIndex) {
		const ancestors = ancestorsByNode.get(nodeId);
		if (!ancestors) continue;
		for (const ancId of ancestors.keys()) {
			const ancIdx = propIndex.get(ancId);
			if (ancIdx === undefined || ancIdx === idx) continue;
			dependents[ancIdx]!.push(idx);
			inDegree[idx]!++;
		}
	}

	const picked = new Array<boolean>(items.length).fill(false);
	const out: T[] = [];
	while (out.length < items.length) {
		let next = -1;
		for (let i = 0; i < items.length; i++) {
			if (!picked[i] && inDegree[i] === 0) {
				next = i;
				break;
			}
		}
		// Cycle fallback: pick earliest remaining by original priority.
		if (next === -1) {
			for (let i = 0; i < items.length; i++) {
				if (!picked[i]) {
					next = i;
					break;
				}
			}
		}
		picked[next] = true;
		out.push(items[next]!);
		for (const dep of dependents[next]!) inDegree[dep]!--;
	}
	return out;
}

/**
 * Root-cause drill routing: when drilling conclusions that have broken or
 * shaky tracked premises (`shakyPremises`), automatically pull those weakest
 * premises from `pool` ahead of them (respecting `limit`) and order
 * prerequisites before conclusions.
 */
export function withPrerequisiteRepairs<T extends Pick<TopicRetention, "key" | "shakyPremises">>(
	picked: readonly T[],
	pool: readonly T[],
	chains: readonly ChainLink[],
	limit: number,
): T[] {
	const cap = Math.max(0, limit);
	if (picked.length === 0 || cap === 0) return [];
	const poolByKey = new Map(pool.map((t) => [t.key, t]));
	const pickedKeys = new Set(picked.map((t) => t.key));
	const pulled: T[] = [];
	const pulledKeys = new Set<string>();

	for (const item of picked) {
		for (const prem of item.shakyPremises ?? []) {
			if (pickedKeys.has(prem.key) || pulledKeys.has(prem.key)) continue;
			const found = poolByKey.get(prem.key);
			if (!found) continue;
			pulledKeys.add(prem.key);
			pulled.push(found);
		}
	}

	if (pulled.length === 0) return orderPrerequisitesFirst(picked.slice(0, cap), chains);
	// Reserve room so pulled premises lead without completely crowding out the
	// first target when cap >= 2.
	const maxPulled = cap === 1 ? 1 : Math.min(pulled.length, cap - 1);
	const combined = [...pulled.slice(0, maxPulled), ...picked].slice(0, cap);
	return orderPrerequisitesFirst(combined, chains);
}

/** "in 3 days", "2 days ago", "today": the view's relative dates. */
export function relativeDays(at: number, now: number): string {
	const days = Math.round((at - now) / DAY_MS);
	if (days === 0) return "today";
	if (days === 1) return "tomorrow";
	if (days === -1) return "yesterday";
	return days > 0 ? `in ${days} days` : `${-days} days ago`;
}
