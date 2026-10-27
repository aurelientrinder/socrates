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

/** The review agent's one quizzing tool (a QUESTION_TOOLS entry). */
export const REVIEW_TOOL = "review";

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
	/** A drill's topic: questions on it the learner recently got wrong,
	 *  so the new question aims at the same gap (never repeats them). */
	missed?: string[];
}

/** A due-topics review (the schedule's), or a weak-spot drill (the
 *  learner's pick from the weak-spot report, due or not). Both are
 *  kind:"review" sessions with the same tool and the same fold. */
export type ReviewMode = "review" | "drill";

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
export function newReviewContextMessage(topics: readonly ReviewTopic[], mode: ReviewMode = "review"): LhMarkerMessage {
	const lines = [
		mode === "drill"
			? "[Session context] — a weak-spot drill: the learner picked these topics to drill (answered wrong while feeling sure, or only just recalled). Worst first."
			: "[Session context] — a spaced-repetition review: these topics are due, weakest first.",
		"Ask exactly one review question per topic, in this order (topicId — title: what it covers):",
		...topics.map(
			(t) =>
				`- [${t.key}] ${t.title}${t.summary ? `: ${t.summary}` : ""}` +
				(t.missed?.length ? ` (recently missed: ${t.missed.map((q) => JSON.stringify(q)).join("; ")})` : ""),
		),
	];
	return {
		id: newMessageId(),
		role: "custom",
		customType: "review-context",
		content: lines.join("\n"),
		display: true,
		details: mode === "drill" ? { topics, mode } : { topics },
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
export function reviewCallsOf(messages: readonly LhMessage[]): { toolCallId: string; topicId: string }[] {
	const failed = new Set<string>();
	for (const m of messages) {
		if ((m as { role?: string }).role === "toolResult" && (m as { isError?: boolean }).isError) {
			failed.add((m as { toolCallId: string }).toolCallId);
		}
	}
	const out: { toolCallId: string; topicId: string }[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; name?: string; id?: string; arguments?: unknown }>) {
			if (block.type !== "toolCall" || block.name !== REVIEW_TOOL || !block.id || failed.has(block.id)) continue;
			const topicId = (block.arguments as { topicId?: unknown } | null)?.topicId;
			if (typeof topicId === "string") out.push({ toolCallId: block.id, topicId });
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

function outcomeOf(answer: QuestionAnswerData): ReviewOutcome {
	if (answer.dismissed) return "skipped";
	if (answer.dontKnow || answer.correct !== true) return "missed";
	return typeof answer.confidence === "number" && answer.confidence < SHAKY_CONFIDENCE_BELOW ? "shaky" : "recalled";
}

/** The session's progress over its queue — what the header and the
 *  closing line read. */
export function reviewTally(messages: readonly LhMessage[]): ReviewTally {
	const topics = reviewTopicsOf(messages);
	const callTopic = new Map(reviewCallsOf(messages).map((c) => [c.toolCallId, c.topicId]));
	const outcomes: Record<string, ReviewOutcome> = {};
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as { toolCallId: string; toolName?: string; details?: unknown };
		if (result.toolName !== REVIEW_TOOL) continue;
		const topicId = callTopic.get(result.toolCallId);
		if (!topicId || outcomes[topicId] || !result.details) continue;
		outcomes[topicId] = outcomeOf(result.details as QuestionAnswerData);
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

/** The review tool's call-boundary check: the topic must be on this
 *  session's queue and not already asked. Empty = the call may pose. */
export function reviewTopicProblems(messages: readonly LhMessage[], topicId: string): string[] {
	const topics = reviewTopicsOf(messages);
	if (!topics.some((t) => t.key === topicId)) {
		const keys = topics.map((t) => `"${t.key}"`).join(", ");
		return [
			topics.length === 0
				? "This session has no review queue — there is nothing to review."
				: `topicId "${topicId}" is not on this session's review queue. Valid topicIds: ${keys}. Copy one exactly.`,
		];
	}
	if (reviewCallsOf(messages).some((c) => c.topicId === topicId)) {
		const left = topics.filter((t) => !reviewCallsOf(messages).some((c) => c.topicId === t.key)).map((t) => `"${t.key}"`);
		return [
			`topic "${topicId}" was already reviewed this session — one question per topic. ` +
				(left.length > 0 ? `Remaining: ${left.join(", ")}.` : "Every topic is done — close the session in prose."),
		];
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
