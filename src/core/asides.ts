/**
 * ASIDES (2026-11-04): questions the learner asks the tutor while a quiz
 * question is still waiting for its answer. The question stays open — its
 * call must remain the record's dangling tail — so the exchange lives in
 * the record's parallel `asides` log, not in `messages`. When the question
 * is finally answered (or skipped), its result carries a short digest of
 * the side conversation so the tutor's next turn knows it happened.
 *
 * Pure: no node deps, client-safe.
 */
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ChatAside } from "./contracts.ts";
import type { LhMessage } from "./native-messages.ts";

/** Longest aside the learner can send (characters). */
export const ASIDE_MAX_CHARS = 4000;

/** The asides asked while this question call was the open one, oldest first. */
export function asidesForQuestion(asides: readonly ChatAside[] | undefined, toolCallId: string): ChatAside[] {
	return (asides ?? []).filter((a) => a.questionCallId === toolCallId);
}

/** The digest the answered question's result carries for the tutor. */
export function asideDigest(asides: readonly ChatAside[]): string {
	const lines = asides.map((a) => `Learner: ${a.text}\nYou: ${a.reply}`);
	return `[While this question was open, the learner asked you about it and you answered in a side conversation. The question itself stayed theirs to answer; the answer above was given after this exchange.]\n${lines.join("\n\n")}`;
}

/** Add the side-conversation digest to a question's answer result (a second
 *  text block — the first stays the canonical answer JSON). No asides for
 *  this call → the result passes through untouched. */
export function withAsideDigest<T extends LhMessage & ToolResultMessage>(
	result: T,
	asides: readonly ChatAside[] | undefined,
): T {
	const mine = asidesForQuestion(asides, result.toolCallId);
	if (mine.length === 0) return result;
	return { ...result, content: [...result.content, { type: "text", text: asideDigest(mine) }] };
}

/** The side-conversation call's system prompt. The tutor answers like a
 *  tutor in a side conversation: it never gives away the open question. */
export const ASIDE_SYSTEM_PROMPT =
	"You are the learner's tutor, in the middle of a tutoring session. A quiz question you posed is still waiting on the learner's screen, unanswered. They have stopped to ask you something. Answer it directly, warmly and concisely, in the language they write in, using Markdown and LaTeX ($...$) where it helps. You may clarify anything you wrote earlier and explain the concepts around the open question. Do NOT reveal or confirm which answer to the open question is correct, and do not answer it for them; if they ask, say you'd rather they try it first and offer a hint instead. Do not pose a new quiz question; the open one is still theirs to answer. You have no tools in this conversation.";

/** The user message for one aside call: the session so far, the open
 *  question, the earlier side exchanges, and the new question. */
export function buildAsidePrompt(input: {
	transcript: string;
	openQuestion: string;
	earlier: readonly ChatAside[];
	text: string;
}): string {
	const earlier =
		input.earlier.length === 0
			? ""
			: `\n\nSIDE CONVERSATION SO FAR:\n${input.earlier.map((a) => `[LEARNER] ${a.text}\n[TUTOR] ${a.reply}`).join("\n\n")}`;
	return `THE SESSION SO FAR:\n${input.transcript}\n\nTHE QUESTION STILL WAITING FOR THE LEARNER'S ANSWER:\n${input.openQuestion}${earlier}\n\nTHE LEARNER NOW ASKS:\n${input.text}`;
}
