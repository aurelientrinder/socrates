/**
 * THE REVIEW TOOLS (spaced-repetition review sessions): the review
 * agent's entire registry. `review` is a client-graded multiple-choice
 * question —
 * the shared quiz authoring contract (quizInputBase, quizInputProblems)
 * plus `topicId`, the retention topic the question tests. The call
 * boundary validates the topic against the session's review-context
 * queue (one question per topic); the answer persists with the topicId
 * stamped from these arguments (input-events.ts withReviewTopic), which
 * is how the result reaches the memory model.
 *
 * `review_recall` + `review_mark` are the free-recall pair (core/
 * recall-review.ts): an explain-from-memory prompt whose key points are
 * committed and source-quoted before he answers, then a marking checked
 * against his words and the source, which computes the grade.
 *
 * Mechanics-only description (the doctrine ruling): what to pass and
 * what happens. What a good review question IS lives in
 * prompts/review/.
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { quizInputBase, quizInputProblems, type QuestionAnswerData } from "../../core/question-core.ts";
import { reviewTopicProblems, reviewTopicsOf, REVIEW_TOOL, unmarkedRecallOf } from "../../core/review.ts";
import {
	buildRecallMark,
	recallMarkForModel,
	recallMarkInputObject,
	recallMarkProblems,
	recallReviewInputObject,
	recallReviewProblems,
	RECALL_MARK_TOOL,
	RECALL_REVIEW_TOOL,
	type KeyPoint,
} from "../../core/recall-review.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { invalidInputResult, questionResult } from "../tool-execute.ts";
import { prepareQuestionArguments, quizExampleBody } from "../tools.ts";
import { healToolRecord } from "./heal.ts";

export interface ReviewToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[] } | null };
}

/** TURN-SCOPED GATE STATE (the practice gate's lesson, the BKT incident
 *  2026-10-05): the record freezes at the turn's write-ahead, so a
 *  mid-turn review_mark → next pose pair cannot see each other through
 *  the store. The gate seeds ONCE per turn from the record (the agent is
 *  built per request) and the marking flips it. */
export interface ReviewGate {
	/** The free-recall answer still waiting for its marking, if any. */
	unmarked: ReturnType<typeof unmarkedRecallOf>;
}

export function createReviewGate(ctx: ReviewToolContext): ReviewGate {
	const record = ctx.chatStore.getChat(ctx.chatId);
	return { unmarked: record ? unmarkedRecallOf(record.messages) : null };
}

/** A pose waits while a free-recall answer is unmarked: the marking is
 *  the grade, and an unmarked answer never reaches the memory model. */
function unmarkedProblem(gate: ReviewGate): string[] {
	return gate.unmarked
		? [`his free-recall answer on "${gate.unmarked.topicId}" is not marked yet — call ${RECALL_MARK_TOOL} on it first.`]
		: [];
}

/** topicId LEADS the property order (the 2026-10-09 drop-order ruling:
 *  fields generated first get dropped least). */
export const reviewInputObject = Type.Object({
	topicId: Type.String({
		description:
			"REQUIRED — the topic this question tests: one topicId from the session context's [topicId] list marked " +
			"multiple choice, copied exactly. Validated at call time; each topic takes exactly one question per session.",
	}),
	...quizInputBase.properties,
});

export type ReviewToolInput = Static<typeof reviewInputObject>;

const description =
	"Ask ONE graded multiple-choice review question about one due topic, then end your turn. Options-only (single- or " +
	"multi-select) plus an automatic 'I don't know' choice; the learner states his confidence, the card grades " +
	"his pick, reveals the correct answer and shows your explanation. His answer is recorded against `topicId` " +
	"and reschedules that topic: right pushes its next review later, wrong or 'I don't know' brings it back sooner." +
	"\nExample arguments — copy the escaping exactly: inside JSON strings a LaTeX backslash is \\\\ and a newline is \\n.\n```json\n" +
	JSON.stringify({ topicId: "prop:chain-rule", ...quizExampleBody }, null, 2) +
	"\n``` The example's topicId is illustrative — copy an exact one from the session context.";

/** The posed record the boundary checks read: the stored record is the
 *  right truth for poses — a posed question ENDS the turn, so every
 *  earlier pose is already persisted when the next one runs. */
function storedMessages(ctx: ReviewToolContext): LhMessage[] {
	return ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
}

export function reviewTool(ctx: ReviewToolContext, gate: ReviewGate = createReviewGate(ctx)): AgentTool<typeof reviewInputObject> {
	return {
		name: REVIEW_TOOL,
		label: REVIEW_TOOL,
		description,
		parameters: reviewInputObject,
		prepareArguments: prepareQuestionArguments,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const messages = storedMessages(ctx);
			const problems = [
				...unmarkedProblem(gate),
				...quizInputProblems(input),
				...reviewTopicProblems(messages, input.topicId, REVIEW_TOOL),
			];
			if (problems.length > 0) return invalidInputResult(REVIEW_TOOL, problems);
			return questionResult();
		},
	};
}

// ─── free recall: the pose ──────────────────────────────────────────────────

const recallDescription =
	"Ask him to EXPLAIN one due topic FROM MEMORY, in his own words — no options — then end your turn. Commit the " +
	"key points a complete answer covers BEFORE he sees the prompt, each quoting the topic's source material in " +
	"the session context (checked at call time; a point the source does not state is rejected). He answers in free " +
	"text with his confidence, or says he doesn't remember; the key points are revealed to him once he has answered. " +
	`Then mark his answer with ${RECALL_MARK_TOOL} — the marking grades the topic. ` +
	"Only for topics the session context marks EXPLAIN FROM MEMORY.";

export function recallReviewTool(
	ctx: ReviewToolContext,
	gate: ReviewGate = createReviewGate(ctx),
): AgentTool<typeof recallReviewInputObject> {
	return {
		name: RECALL_REVIEW_TOOL,
		label: RECALL_REVIEW_TOOL,
		description: recallDescription,
		parameters: recallReviewInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const messages = storedMessages(ctx);
			const topicProblems = reviewTopicProblems(messages, input.topicId, RECALL_REVIEW_TOOL);
			const source = reviewTopicsOf(messages).find((t) => t.key === input.topicId)?.source;
			const problems = [
				...unmarkedProblem(gate),
				...topicProblems,
				...(topicProblems.length === 0 ? recallReviewProblems(input, source) : []),
			];
			if (problems.length > 0) return invalidInputResult(RECALL_REVIEW_TOOL, problems);
			return questionResult();
		},
	};
}

// ─── free recall: the marking ───────────────────────────────────────────────

const markDescription =
	"Mark his free-recall answer against the key points you committed: one mark per key point, in order — covered " +
	"(quote where he says it), partial (quote the blurred part), or missed. List any claim of his that the source " +
	"material contradicts under `errors`, quoting his words and the source. Quotes are checked at call time against " +
	"his answer and the source. The grade is computed from your marks — you do not choose it — and the result tells " +
	"you the outcome. The card shows him every key point with your marks; keep your reply short.";

export function recallMarkTool(
	ctx: ReviewToolContext,
	gate: ReviewGate = createReviewGate(ctx),
): AgentTool<typeof recallMarkInputObject> {
	return {
		name: RECALL_MARK_TOOL,
		label: RECALL_MARK_TOOL,
		description: markDescription,
		parameters: recallMarkInputObject,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			const pending = gate.unmarked;
			if (!pending) {
				return invalidInputResult(RECALL_MARK_TOOL, [
					`there is no free-recall answer waiting to be marked — ${RECALL_MARK_TOOL} follows his answer to a ${RECALL_REVIEW_TOOL} question.`,
				]);
			}
			if (input.topicId !== pending.topicId) {
				return invalidInputResult(RECALL_MARK_TOOL, [
					`the answer waiting to be marked is on "${pending.topicId}", not "${input.topicId}".`,
				]);
			}
			const topic = reviewTopicsOf(storedMessages(ctx)).find((t) => t.key === pending.topicId);
			const keyPoints = ((pending.input as { keyPoints?: unknown } | null)?.keyPoints ?? []) as KeyPoint[];
			const answer: QuestionAnswerData = pending.answer;
			const problems = recallMarkProblems(input, keyPoints, answer.text ?? "", topic?.source ?? "");
			if (problems.length > 0) return invalidInputResult(RECALL_MARK_TOOL, problems);
			const mark = buildRecallMark({
				mark: input,
				keyPoints,
				confidence: answer.confidence,
				sourceTitle: topic?.sourceTitle,
			});
			gate.unmarked = null;
			return { content: [{ type: "text", text: JSON.stringify(recallMarkForModel(mark)) }], details: mark };
		},
	};
}

/** The review agent's registry (healed, like every registry): one gate
 *  per turn, shared by every tool — the intra-turn truth. */
export function reviewTools(ctx: ReviewToolContext): Record<string, AgentTool<any>> {
	const gate = createReviewGate(ctx);
	return healToolRecord({
		[REVIEW_TOOL]: reviewTool(ctx, gate),
		[RECALL_REVIEW_TOOL]: recallReviewTool(ctx, gate),
		[RECALL_MARK_TOOL]: recallMarkTool(ctx, gate),
	});
}
