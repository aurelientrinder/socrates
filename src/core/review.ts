/**
 * REVIEW SESSIONS (spaced repetition): the part of the memory model that
 * ACTS on the schedule. The retention fold (retention.ts) says which
 * topics are due; a review session is a short kind:"review" chat where
 * the review agent asks ONE graded retrieval question per due topic.
 * Each answer carries the topic's key (QuestionAnswerData.topicId,
 * stamped server-side from the call), so the retention fold reads it as
 * the next review of that topic — the loop closes with no new storage.
 *
 * The session's queue rides the record as message[0], a review-context
 * marker (the graph-context precedent): the model reads the topic list
 * as injected session context, the transcript renders a small card, and
 * the review tool validates every call against it.
 *
 * Pure and browser-safe: the server picks and persists, this shapes.
 */

import type { LhMarkerMessage, LhMessage } from "./native-messages.ts";
import { newMessageId } from "./native-messages.ts";
import type { QuestionAnswerData } from "./question-core.ts";
import { isRecallMarkData, RECALL_MARK_TOOL, RECALL_REVIEW_TOOL, type ReviewFormat } from "./recall-review.ts";

/** The review agent's multiple-choice tool (a QUESTION_TOOLS entry). Its
 *  free-recall twin is RECALL_REVIEW_TOOL (recall-review.ts). */
export const REVIEW_TOOL = "review";

/** Both posing tools: one question per topic, whichever format. */
const POSE_TOOLS: readonly string[] = [REVIEW_TOOL, RECALL_REVIEW_TOOL];

/** Topics per session: about five minutes of questions. A backlog after
 *  a break never turns into a wall — the learner can start another
 *  round, but one round is always short. */
export const REVIEW_SESSION_SIZE = 5;

/** What the queue reads off the retention fold's per-topic state (a
 *  structural slice of TopicRetention, so this module needs nothing
 *  else from the fold). */
export interface ReviewCandidate {
	key: string;
	kind: "plan" | "proposition";
	title: string;
	chatId?: string;
	chatTitle?: string;
	/** Estimated recall probability today, 0-1. */
	retention: number;
	/** Epoch ms when retention falls under the target. */
	dueAt: number;
	due: boolean;
}

/** One topic of a session's queue, as the agent and the card see it. */
export interface ReviewTopic {
	/** The retention topic key — the review tool's `topicId`. */
	key: string;
	title: string;
	/** What the topic covers (plan node summary / proposition statement):
	 *  the material the agent writes its question from. */
	summary?: string;
	/** The session the topic was learned in, for the card's context. */
	sourceTitle?: string;
	/** Retention when the session started, 0-1 (the card's bar). */
	retention: number;
	/** The question format this session uses for the topic. Absent on
	 *  sessions from before free recall: multiple choice. */
	format?: ReviewFormat;
	/** What the learner was taught on the topic (recall topics): the
	 *  material a free-recall answer is marked against, and nothing else. */
	source?: string;
}

/** A topic's format (old queues carry none: multiple choice). */
export function topicFormat(topic: Pick<ReviewTopic, "format">): ReviewFormat {
	return topic.format === "recall" ? "recall" : "choice";
}

/** What the start panel needs: how much is due, and what today held. */
export interface ReviewStatus {
	/** Topics due right now (the whole backlog). */
	due: number;
	/** Topics one session takes (min(due, REVIEW_SESSION_SIZE)). */
	nextSession: number;
	/** Review answers given today (local day). */
	reviewedToday: number;
}

/** The session's queue: due topics only, weakest first (lowest
 *  retention, then most overdue), capped at `limit`. */
export function pickReviewTopics<T extends ReviewCandidate>(
	candidates: readonly T[],
	limit: number = REVIEW_SESSION_SIZE,
): T[] {
	return candidates
		.filter((c) => c.due)
		.sort((a, b) => a.retention - b.retention || a.dueAt - b.dueAt || a.key.localeCompare(b.key))
		.slice(0, Math.max(0, limit));
}

/** The review-context marker (message[0] of a review session). The
 *  bracketed preamble marks it honestly as injected session context —
 *  custom markers reach the model in the user channel. */
export function newReviewContextMessage(topics: readonly ReviewTopic[]): LhMarkerMessage {
	const lines = [
		"[Session context] — a spaced-repetition review: these topics are due, weakest first.",
		"Ask exactly one review question per topic, in this order, in the format each one names (topicId — title: what it covers):",
	];
	for (const t of topics) {
		const recall = topicFormat(t) === "recall";
		lines.push(
			`- [${t.key}] ${t.title}${t.summary ? `: ${t.summary}` : ""} — ${recall ? "EXPLAIN FROM MEMORY (review_recall)" : "multiple choice (review)"}`,
		);
		if (recall && t.source) {
			lines.push("  Source material — what he was taught; the only ground for key points and marks:");
			lines.push(...t.source.split("\n").map((l) => `  > ${l}`));
		}
	}
	return {
		id: newMessageId(),
		role: "custom",
		customType: "review-context",
		content: lines.join("\n"),
		display: true,
		details: { topics },
		timestamp: Date.now(),
	};
}

/** The queue a review record carries (empty when there is no marker). */
export function reviewTopicsOf(messages: readonly LhMessage[]): ReviewTopic[] {
	for (const m of messages) {
		if ((m as { role?: string }).role !== "custom") continue;
		const marker = m as LhMarkerMessage;
		if (marker.customType !== "review-context") continue;
		const topics = (marker.details as { topics?: unknown } | null)?.topics;
		return Array.isArray(topics) ? (topics as ReviewTopic[]) : [];
	}
	return [];
}

/** Every review question POSED in the record (answered or not), in
 *  order: topic key + call id. A failed (error-result) call never posed
 *  anything, so it does not count. */
export function reviewCallsOf(
	messages: readonly LhMessage[],
): { toolCallId: string; topicId: string; tool: string; input: unknown }[] {
	const failed = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult" && (m as { isError?: boolean }).isError) {
			failed.add((m as { toolCallId: string }).toolCallId);
		}
	}
	const out: { toolCallId: string; topicId: string; tool: string; input: unknown }[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; name?: string; id?: string; arguments?: unknown }>) {
			if (block.type !== "toolCall" || !POSE_TOOLS.includes(block.name ?? "") || !block.id || failed.has(block.id)) continue;
			const topicId = (block.arguments as { topicId?: unknown } | null)?.topicId;
			if (typeof topicId === "string") out.push({ toolCallId: block.id, topicId, tool: block.name!, input: block.arguments });
		}
	}
	return out;
}

/** One topic's outcome in this session. */
export type ReviewOutcome = "recalled" | "shaky" | "missed" | "skipped";

export interface ReviewTally {
	total: number;
	/** Topics with an answer (any outcome, skips included). */
	done: number;
	recalled: number;
	shaky: number;
	missed: number;
	skipped: number;
	/** Per topic key, the first answer's outcome. */
	outcomes: Record<string, ReviewOutcome>;
}

/** Right but at or under this stated confidence reads as shaky — the
 *  same line the retention fold draws (a lucky or fragile recall). */
export const SHAKY_CONFIDENCE_BELOW = 50;

function outcomeOf(answer: QuestionAnswerData): ReviewOutcome | undefined {
	if (answer.dismissed) return "skipped";
	// A free-recall answer waits for its marking — only "I don't
	// remember" settles on the answer alone.
	if (answer.kind === "explain") return answer.dontKnow ? "missed" : undefined;
	if (answer.dontKnow || answer.correct !== true) return "missed";
	return typeof answer.confidence === "number" && answer.confidence < SHAKY_CONFIDENCE_BELOW ? "shaky" : "recalled";
}

/** The session's progress over its queue — what the header and the
 *  closing line read. */
export function reviewTally(messages: readonly LhMessage[]): ReviewTally {
	const topics = reviewTopicsOf(messages);
	const outcomes: Record<string, ReviewOutcome> = {};
	for (const r of reviewResults(messages)) {
		if (!outcomes[r.topicId]) outcomes[r.topicId] = r.outcome;
	}
	const values = Object.values(outcomes);
	const count = (o: ReviewOutcome) => values.filter((v) => v === o).length;
	return {
		total: topics.length,
		done: topics.filter((t) => outcomes[t.key] !== undefined).length,
		recalled: count("recalled"),
		shaky: count("shaky"),
		missed: count("missed"),
		skipped: count("skipped"),
		outcomes,
	};
}

/** Every settled review in the record, in order: the topic, how it went,
 *  and when (a multiple-choice answer, a free-recall "I don't remember"
 *  or skip, or a free-recall marking). An answered but unmarked recall
 *  is not settled yet. */
export function reviewResults(messages: readonly LhMessage[]): { topicId: string; outcome: ReviewOutcome; at: number }[] {
	const callTopic = new Map(reviewCallsOf(messages).map((c) => [c.toolCallId, c.topicId]));
	const out: { topicId: string; outcome: ReviewOutcome; at: number }[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as { toolCallId: string; toolName?: string; details?: unknown; isError?: boolean };
		if (result.toolName === RECALL_MARK_TOOL) {
			if (result.isError || !isRecallMarkData(result.details)) continue;
			const mark = result.details;
			out.push({
				topicId: mark.topicId,
				outcome: mark.grade === 3 ? "recalled" : mark.grade === 2 ? "shaky" : "missed",
				at: Date.parse(mark.markedAt),
			});
			continue;
		}
		if (!POSE_TOOLS.includes(result.toolName ?? "")) continue;
		const topicId = callTopic.get(result.toolCallId);
		if (!topicId || !result.details) continue;
		const answer = result.details as QuestionAnswerData;
		const outcome = outcomeOf(answer);
		if (outcome) out.push({ topicId, outcome, at: Date.parse(answer.answeredAt) });
	}
	return out;
}

/** The free-recall answer still waiting for its marking (the latest
 *  answered review_recall with no review_mark after it); null when none.
 *  Dismissed and "I don't remember" answers need no marking. */
export function unmarkedRecallOf(
	messages: readonly LhMessage[],
): { toolCallId: string; topicId: string; input: unknown; answer: QuestionAnswerData } | null {
	const marked = new Set(reviewResults(messages).map((r) => r.topicId));
	const recallCalls = reviewCallsOf(messages).filter((c) => c.tool === RECALL_REVIEW_TOOL);
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as { toolCallId: string; toolName?: string; details?: unknown };
		if (result.toolName !== RECALL_REVIEW_TOOL || !result.details) continue;
		const call = recallCalls.find((c) => c.toolCallId === result.toolCallId);
		if (!call || marked.has(call.topicId)) continue;
		const answer = result.details as QuestionAnswerData;
		if (answer.dismissed || answer.dontKnow) continue;
		return { toolCallId: call.toolCallId, topicId: call.topicId, input: call.input, answer };
	}
	return null;
}

/** The posing tools' call-boundary check: the topic must be on this
 *  session's queue, posed in its own format, and not already asked.
 *  Empty = the call may pose. */
export function reviewTopicProblems(messages: readonly LhMessage[], topicId: string, tool: string = REVIEW_TOOL): string[] {
	const topics = reviewTopicsOf(messages);
	const topic = topics.find((t) => t.key === topicId);
	if (!topic) {
		const keys = topics.map((t) => `"${t.key}"`).join(", ");
		return [
			topics.length === 0
				? "This session has no review queue — there is nothing to review."
				: `topicId "${topicId}" is not on this session's review queue. Valid topicIds: ${keys}. Copy one exactly.`,
		];
	}
	const asked = reviewCallsOf(messages);
	if (asked.some((c) => c.topicId === topicId)) {
		const left = topics.filter((t) => !asked.some((c) => c.topicId === t.key)).map((t) => `"${t.key}"`);
		return [
			`topic "${topicId}" was already reviewed this session — one question per topic. ` +
				(left.length > 0 ? `Remaining: ${left.join(", ")}.` : "Every topic is done — close the session in prose."),
		];
	}
	const format = topicFormat(topic);
	if (format === "recall" && tool !== RECALL_REVIEW_TOOL) {
		return [`topic "${topicId}" is an explain-from-memory topic — pose it with ${RECALL_REVIEW_TOOL}, not ${tool}.`];
	}
	if (format === "choice" && tool !== REVIEW_TOOL) {
		return [`topic "${topicId}" is a multiple-choice topic — pose it with ${REVIEW_TOOL}, not ${tool}.`];
	}
	return [];
}

// ─── the daily reminder (opt-in, per device) ────────────────────────────────

/** The device-local keys the reminder keeps (localStorage). */
export const REVIEW_REMINDER_KEY = "lh:review-reminder";
export const REVIEW_REMINDED_DAY_KEY = "lh:review-reminded-day";

/** The local calendar day of an instant, "YYYY-MM-DD". */
export function localDay(at: number): string {
	const d = new Date(at);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** At most one reminder a day, only when opted in and something is due. */
export function shouldRemind(input: { enabled: boolean; due: number; remindedDay: string | null; today: string }): boolean {
	return input.enabled && input.due > 0 && input.remindedDay !== input.today;
}

/** The reminder's text. */
export function reminderText(due: number): { title: string; body: string } {
	const session = Math.min(due, REVIEW_SESSION_SIZE);
	return {
		title: `${due} ${due === 1 ? "topic is" : "topics are"} due for review`,
		body: `A ${session}-question review takes about ${session} ${session === 1 ? "minute" : "minutes"}.`,
	};
}
