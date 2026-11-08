/**
 * Live reMarkable capture (2026-11-08): window choice, the data-URL →
 * PNG bridge, and the one-page handwriting read against a STUB fetch
 * (never the network).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildAnswer, compactAnswerForModel, isAnswerSketch, looksLikeRemarkable, newAnswerResult, parseChatInput, pickCaptureWindow, sortCaptureWindows, type AnswerSketch, type QuestionData } from "../src/core/index.ts";
import { readSketch, sketchPrompt } from "../src/server/handwriting.ts";
import { answerForModel } from "../src/server/sketch.ts";

const win = (id: string, name: string) => ({ id, name });

describe("pickCaptureWindow", () => {
	it("pre-selects the only reMarkable-looking window", () => {
		const w = [win("1", "Chrome"), win("2", "reMarkable"), win("3", "Notepad")];
		assert.equal(pickCaptureWindow(w, null)?.id, "2");
	});

	it("prefers the remembered title, even when several look like reMarkable", () => {
		const w = [win("1", "reMarkable"), win("2", "reMarkable Screen Share — Paper Pure")];
		assert.equal(pickCaptureWindow(w, "reMarkable Screen Share — Paper Pure")?.id, "2");
	});

	it("asks the learner when it cannot tell", () => {
		assert.equal(pickCaptureWindow([win("1", "reMarkable"), win("2", "reMarkable 2")], null), null);
		assert.equal(pickCaptureWindow([win("1", "Chrome")], null), null);
		assert.equal(pickCaptureWindow([win("1", "Chrome")], "gone"), null);
	});

	it("never offers Socrates' own window", () => {
		assert.equal(pickCaptureWindow([win("1", "Socrates")], "Socrates"), null);
	});
});

describe("sortCaptureWindows / looksLikeRemarkable", () => {
	it("lists reMarkable windows first", () => {
		assert.ok(looksLikeRemarkable("REMARKABLE"));
		assert.deepEqual(sortCaptureWindows([win("1", "Zed"), win("2", "reMarkable"), win("3", "Atom")]).map((w) => w.id), ["2", "3", "1"]);
	});
});

describe("readSketch", () => {
	const answer = (text: string): typeof fetch =>
		(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ pages: [{ page: 1, text }] }) }] } }] }))) as unknown as typeof fetch;

	it("returns the page's text and sends one image with the sketch prompt", async () => {
		let body: { contents: Array<{ parts: Array<{ text?: string; inline_data?: unknown }> }> } | undefined;
		const fetchFn = (async (_url: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return answer("x = 3 because 2x = 6")(_url);
		}) as unknown as typeof fetch;
		const text = await readSketch(Uint8Array.from([1, 2, 3]), { apiKey: "k", fetchFn });
		assert.equal(text, "x = 3 because 2x = 6");
		const parts = body!.contents[0]!.parts;
		assert.equal(parts.filter((p) => p.inline_data).length, 1);
		assert.match(parts[0]!.text ?? "", /captured live from their tablet/);
	});

	it("an empty page is an empty string, not an error", async () => {
		assert.equal(await readSketch(Uint8Array.from([1]), { apiKey: "k", fetchFn: answer("") }), "");
	});

	it("the prompt asks for exactly one page", () => {
		assert.match(sketchPrompt(), /one page/);
	});
});

describe("the question card carries the button", () => {
	it("mounts RemarkableCapture in the answer box's bottom row", async () => {
		// v0.15.0 shipped with the import and handler but without this line.
		const { readFileSync } = await import("node:fs");
		const source = readFileSync(new URL("../components/question-dock.tsx", import.meta.url), "utf8");
		assert.match(source, /<RemarkableCapture\b[^>]*onSketch=\{setSketch\}/);
	});
});

const SKETCH: AnswerSketch = { mimeType: "image/jpeg", data: Buffer.from([1, 2, 3, 4]).toString("base64"), thumb: Buffer.from([9, 9]).toString("base64") };
const QD = { kind: "quiz", question: "Q?", mode: "single-select", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], correctAnswer: "a" } as unknown as QuestionData;

describe("a handwritten page on an answer", () => {
	it("isAnswerSketch accepts a small base64 JPEG/PNG with a thumbnail and refuses the rest", () => {
		assert.ok(isAnswerSketch(SKETCH));
		assert.ok(isAnswerSketch({ mimeType: "image/png", thumb: "AAAA" }), "thumbnail-only is a valid stored record");
		assert.ok(!isAnswerSketch({ ...SKETCH, mimeType: "image/svg+xml" }));
		assert.ok(!isAnswerSketch({ ...SKETCH, data: "not base64!" }));
		assert.ok(!isAnswerSketch({ ...SKETCH, thumb: "" }));
		assert.ok(!isAnswerSketch({ ...SKETCH, data: "A".repeat(2_500_001) }));
		assert.ok(!isAnswerSketch("x"));
	});

	it("rides buildAnswer, and the model is told the page is attached", () => {
		const answer = buildAnswer(QD, { values: ["a"], thinking: "because", sketch: SKETCH }, "quiz");
		assert.deepEqual(answer.sketch, SKETCH);
		assert.match(String(compactAnswerForModel(answer).handwrittenWorking), /attached as an image/);
		assert.equal(compactAnswerForModel(buildAnswer(QD, { values: ["a"] }, "quiz")).handwrittenWorking, undefined);
	});

	it("the tool result carries the page as an image block and persists only the thumbnail", () => {
		const answer = buildAnswer(QD, { values: ["a"], sketch: SKETCH }, "quiz");
		const result = newAnswerResult("call-1", "quiz", answer);
		const image = result.content.find((b) => b.type === "image") as { data: string; mimeType: string } | undefined;
		assert.equal(image?.data, SKETCH.data);
		assert.equal(image?.mimeType, "image/jpeg");
		const details = result.details as { sketch?: AnswerSketch };
		assert.equal(details.sketch?.data, undefined, "the page is never stored twice");
		assert.equal(details.sketch?.thumb, SKETCH.thumb);
		assert.equal(newAnswerResult("c", "quiz", buildAnswer(QD, { values: ["a"] }, "quiz")).content.length, 1, "no sketch, no image block");
	});

	it("an answer input with a malformed sketch is refused", () => {
		const base = { type: "answer", toolCallId: "c1" };
		assert.ok(parseChatInput({ ...base, answer: { ...buildAnswer(QD, { values: ["a"] }, "quiz"), sketch: SKETCH } }));
		assert.throws(() => parseChatInput({ ...base, answer: { ...buildAnswer(QD, { values: ["a"] }, "quiz"), sketch: { mimeType: "text/html", thumb: "AAAA" } } }), /sketch/);
	});
});

describe("answerForModel (vision or not)", () => {
	const answer = buildAnswer(QD, { values: ["a"], thinking: "my idea", sketch: SKETCH }, "quiz");
	const reader = (text: string): typeof fetch =>
		(async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ pages: [{ page: 1, text }] }) }] } }] }))) as unknown as typeof fetch;

	it("a model that sees images gets the page as is", async () => {
		assert.equal(await answerForModel(answer, { acceptsImages: true }), answer);
	});

	it("a text-only model gets the page read into its thinking, and no image", async () => {
		const out = await answerForModel(answer, { acceptsImages: false, apiKey: "k", fetchFn: reader("2x = 6") });
		assert.match(out.thinking ?? "", /my idea[\s\S]*2x = 6/);
		assert.equal(out.sketch?.data, undefined);
		assert.equal(out.sketch?.thumb, SKETCH.thumb, "the transcript keeps the thumbnail");
	});

	it("with no Gemini key it says so instead of silently dropping the page", async () => {
		const out = await answerForModel(answer, { acceptsImages: false, apiKey: null });
		assert.match(out.thinking ?? "", /cannot see images/);
		assert.equal(out.sketch?.data, undefined);
	});

	it("a failed read is reported in the thinking, never thrown", async () => {
		const failing = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
		const out = await answerForModel(answer, { acceptsImages: false, apiKey: "k", fetchFn: failing });
		assert.match(out.thinking ?? "", /could not be read/);
	});
});
