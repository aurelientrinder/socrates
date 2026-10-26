/**
 * THE REVIEW TOOL (spaced-repetition review sessions): the review
 * agent's entire registry. A client-graded multiple-choice question —
 * the shared quiz authoring contract (quizInputBase, quizInputProblems)
 * plus `topicId`, the retention topic the question tests. The call
 * boundary validates the topic against the session's review-context
 * queue (one question per topic); the answer persists with the topicId
 * stamped from these arguments (input-events.ts withReviewTopic), which
 * is how the result reaches the memory model.
 *
 * Mechanics-only description (the doctrine ruling): what to pass and
 * what happens. What a good review question IS lives in
 * prompts/review/.
 */

import { Type, type Static } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { quizInputBase, quizInputProblems } from "../../core/question-core.ts";
import { reviewTopicProblems, REVIEW_TOOL } from "../../core/review.ts";
import type { LhMessage } from "../../core/native-messages.ts";
import { invalidInputResult, questionResult } from "../tool-execute.ts";
import { prepareQuestionArguments, quizExampleBody } from "../tools.ts";
import { healToolRecord } from "./heal.ts";

export interface ReviewToolContext {
	chatId: string;
	chatStore: { getChat(id: string): { messages: LhMessage[] } | null };
}

/** topicId LEADS the property order (the 2026-10-09 drop-order ruling:
 *  fields generated first get dropped least). */
export const reviewInputObject = Type.Object({
	topicId: Type.String({
		description:
			"REQUIRED — the topic this question tests: one topicId from the session context's [topicId] list, copied " +
			"exactly. Validated at call time; each topic takes exactly one question per session.",
	}),
	...quizInputBase.properties,
});

export type ReviewToolInput = Static<typeof reviewInputObject>;

const description =
	"Ask ONE graded review question about one due topic, then end your turn. Options-only (single- or " +
	"multi-select) plus an automatic 'I don't know' choice; the learner states his confidence, the card grades " +
	"his pick, reveals the correct answer and shows your explanation. His answer is recorded against `topicId` " +
	"and reschedules that topic: right pushes its next review later, wrong or 'I don't know' brings it back sooner." +
	"\nExample arguments — copy the escaping exactly: inside JSON strings a LaTeX backslash is \\\\ and a newline is \\n.\n```json\n" +
	JSON.stringify({ topicId: "prop:chain-rule", ...quizExampleBody }, null, 2) +
	"\n``` The example's topicId is illustrative — copy an exact one from the session context.";

export function reviewTool(ctx: ReviewToolContext): AgentTool<typeof reviewInputObject> {
	return {
		name: REVIEW_TOOL,
		label: REVIEW_TOOL,
		description,
		parameters: reviewInputObject,
		prepareArguments: prepareQuestionArguments,
		executionMode: "sequential",
		execute: async (_toolCallId, input) => {
			// The stored record is the right truth here: a posed review
			// question ENDS the turn, so every earlier pose is already
			// persisted when this one runs.
			const messages = ctx.chatStore.getChat(ctx.chatId)?.messages ?? [];
			const problems = [...quizInputProblems(input), ...reviewTopicProblems(messages, input.topicId)];
			if (problems.length > 0) return invalidInputResult(REVIEW_TOOL, problems);
			return questionResult();
		},
	};
}

/** The review agent's registry (healed, like every registry). */
export function reviewTools(ctx: ReviewToolContext): Record<string, AgentTool<any>> {
	return healToolRecord({ [REVIEW_TOOL]: reviewTool(ctx) });
}
