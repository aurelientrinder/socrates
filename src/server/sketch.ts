/**
 * The learner's handwritten page and the tutor's eyes (2026-11-08).
 *
 * A sketch from the live reMarkable capture rides the answer as an image the
 * tutor reads directly. A model that cannot take images would only ever see
 * a "(image omitted)" placeholder, so for those models the page is read into
 * text (the Gemini handwriting reader) and joined into "Your thinking"
 * instead, with an honest note when that is not possible.
 */

import type { AnswerSketch, QuestionAnswerData } from "../core/question-core.ts";
import { handwritingKey, readSketch } from "./handwriting.ts";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SketchOptions {
	/** Does the conversation model accept images? */
	acceptsImages: boolean;
	/** Test seam. */
	fetchFn?: FetchLike;
	apiKey?: string | null;
}

function joinThinking(current: string | undefined, add: string): string {
	return current?.trim() ? `${current.trim()}\n\n${add}` : add;
}

/** The answer, ready for a model that can or cannot see the page. */
export async function answerForModel(answer: QuestionAnswerData, opts: SketchOptions): Promise<QuestionAnswerData> {
	const sketch: AnswerSketch | undefined = answer.sketch;
	if (!sketch?.data) return answer;
	if (opts.acceptsImages) return answer;
	const { sketch: _page, ...rest } = answer;
	const keep = { ...rest, sketch: { mimeType: sketch.mimeType, thumb: sketch.thumb } };
	const apiKey = opts.apiKey === undefined ? handwritingKey() : opts.apiKey;
	if (!apiKey) {
		return { ...keep, thinking: joinThinking(rest.thinking, "(The learner attached a handwritten page, but this model cannot see images and no Gemini key is set to read it.)") };
	}
	try {
		const text = await readSketch(Uint8Array.from(Buffer.from(sketch.data, "base64")), { apiKey, fetchFn: opts.fetchFn });
		return { ...keep, thinking: joinThinking(rest.thinking, text ? `(Read from the learner's handwritten page:)\n${text}` : "(The learner attached a handwritten page, but no writing could be read on it.)") };
	} catch (e) {
		return { ...keep, thinking: joinThinking(rest.thinking, `(The learner attached a handwritten page, but it could not be read: ${e instanceof Error ? e.message : "unknown error"})`) };
	}
}
