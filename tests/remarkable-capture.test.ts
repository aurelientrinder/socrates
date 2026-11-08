/**
 * Live reMarkable capture (2026-11-08): window choice, the data-URL →
 * PNG bridge, and the one-page handwriting read against a STUB fetch
 * (never the network).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksLikeRemarkable, pickCaptureWindow, pngFromDataUrl, sortCaptureWindows } from "../src/core/index.ts";
import { readSketch, sketchPrompt } from "../src/server/handwriting.ts";

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

describe("pngFromDataUrl", () => {
	it("decodes a PNG data URL and refuses anything else", () => {
		const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		const url = "data:image/png;base64," + Buffer.from(bytes).toString("base64");
		assert.deepEqual([...pngFromDataUrl(url)!], [...bytes]);
		assert.equal(pngFromDataUrl("data:image/jpeg;base64,AAAA"), null);
		assert.equal(pngFromDataUrl("https://example.com/x.png"), null);
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
