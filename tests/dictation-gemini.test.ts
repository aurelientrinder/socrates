/**
 * Dictation + search options (2026-10-26): engine resolution for
 * dictation, the Gemini batch transcriber and the Gemini search-grounding
 * adapter against STUB fetches (never the network), the WAV header, the
 * settings parse/sanitize, and the renderer's Deepgram URL.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { geminiTranscribe, pcmToWav, resolveDictationEngineFor, transcribePrompt } from "../src/server/dictation.ts";
import { geminiSearchProvider, resolveSearchEngineFor } from "../src/server/search.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { deepgramUrl } from "../components/dictation.tsx";
import { composeDictation } from "../components/settings/agent-section.tsx";

describe("resolveDictationEngineFor", () => {
	it("no keys: honestly unavailable", () => {
		const out = resolveDictationEngineFor(undefined, {});
		assert.ok(!out.available);
		assert.match(out.reason, /Gemini/);
	});

	it("a Gemini key alone is enough", () => {
		const out = resolveDictationEngineFor(undefined, { gemini: "g-key" });
		assert.equal(out.engine, "gemini");
		assert.equal(out.key, "g-key");
	});

	it("both keys, no pin: Deepgram first (the streaming engine)", () => {
		assert.equal(resolveDictationEngineFor(undefined, { deepgram: "d", gemini: "g" }).engine, "deepgram");
	});

	it("a pin wins, and never falls back to the other engine", () => {
		assert.equal(resolveDictationEngineFor("gemini", { deepgram: "d", gemini: "g" }).engine, "gemini");
		const out = resolveDictationEngineFor("deepgram", { gemini: "g" });
		assert.ok(!out.available);
		assert.match(out.reason, /DEEPGRAM_API_KEY/);
	});
});

describe("search: Gemini is the last-resort engine", () => {
	it("auto-activates when it is the only key", () => {
		assert.equal(resolveSearchEngineFor(undefined, { gemini: "g" }).engine, "gemini");
	});
	it("never shadows a dedicated search key", () => {
		assert.equal(resolveSearchEngineFor(undefined, { brave: "b", gemini: "g" }).engine, "brave");
	});
	it("a missing pinned key names its var", () => {
		assert.match(resolveSearchEngineFor("gemini", {}).reason, /GEMINI_API_KEY/);
	});
});

describe("pcmToWav", () => {
	it("writes a 44-byte PCM mono 16kHz header in front of the samples", () => {
		const wav = pcmToWav(new Uint8Array([1, 2, 3, 4]));
		const view = new DataView(wav.buffer);
		assert.equal(wav.byteLength, 48);
		assert.equal(String.fromCharCode(...wav.slice(0, 4)), "RIFF");
		assert.equal(String.fromCharCode(...wav.slice(8, 12)), "WAVE");
		assert.equal(view.getUint16(22, true), 1); // mono
		assert.equal(view.getUint32(24, true), 16000);
		assert.equal(view.getUint32(40, true), 4);
		assert.deepEqual([...wav.slice(44)], [1, 2, 3, 4]);
	});
});

describe("geminiTranscribe", () => {
	it("sends the WAV inline with the instruction and returns the text parts", async () => {
		const text = await geminiTranscribe("g-key", new Uint8Array(8), "fr", async (url, init) => {
			assert.match(url, /generativelanguage\.googleapis\.com\/v1beta\/models\/.+:generateContent$/);
			assert.equal((init.headers as Record<string, string>)["x-goog-api-key"], "g-key");
			const body = JSON.parse(init.body as string);
			const [prompt, audio] = body.contents[0].parts;
			assert.match(prompt.text, /French/);
			assert.equal(audio.inline_data.mime_type, "audio/wav");
			assert.equal(Buffer.from(audio.inline_data.data, "base64").byteLength, 52);
			return Response.json({
				candidates: [{ content: { parts: [{ text: "thinking", thought: true }, { text: " Bonjour à tous. " }] } }],
			});
		});
		assert.equal(text, "Bonjour à tous.");
	});

	it("names the free-tier quota on 429", async () => {
		await assert.rejects(
			geminiTranscribe("g", new Uint8Array(2), null, async () =>
				Response.json({ error: { message: "Resource exhausted" } }, { status: 429 }),
			),
			/quota reached.*Resource exhausted/,
		);
	});

	it("automatic language: no language in the prompt", () => {
		assert.doesNotMatch(transcribePrompt(null), /speaker talks/);
	});
});

describe("geminiSearchProvider (grounding metadata → hits)", () => {
	it("maps grounding chunks + supports, resolving the redirect links", async () => {
		const provider = geminiSearchProvider("g-key", async (url, init) => {
			if (init.method === "HEAD") {
				assert.equal(init.redirect, "manual");
				const real = url.endsWith("/a") ? "https://example.com/page-a" : null;
				return new Response(null, { status: real ? 302 : 500, headers: real ? { location: real } : {} });
			}
			const body = JSON.parse(init.body as string);
			assert.deepEqual(body.tools, [{ google_search: {} }]);
			assert.match(body.contents[0].parts[0].text, /photosynthesis/);
			return Response.json({
				candidates: [
					{
						groundingMetadata: {
							groundingChunks: [
								{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/a", title: "example.com" } },
								{ web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/b", title: "other.org" } },
								{ web: { title: "no uri — dropped" } },
							],
							groundingSupports: [
								{ segment: { text: "Plants make sugar." }, groundingChunkIndices: [0, 1] },
								{ segment: { text: "Light is\nneeded." }, groundingChunkIndices: [1] },
							],
						},
					},
				],
			});
		});
		const hits = await provider.search("photosynthesis", 5);
		assert.deepEqual(hits, [
			{ title: "example.com", url: "https://example.com/page-a", snippet: "Plants make sugar." },
			{
				title: "other.org",
				url: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/b",
				snippet: "Plants make sugar. Light is needed.",
			},
		]);
	});

	it("respects count", async () => {
		const provider = geminiSearchProvider("g", async (_url, init) =>
			init.method === "HEAD"
				? new Response(null, { status: 500 })
				: Response.json({
						candidates: [
							{
								groundingMetadata: {
									groundingChunks: [{ web: { uri: "https://a" } }, { web: { uri: "https://b" } }],
								},
							},
						],
					}),
		);
		assert.equal((await provider.search("q", 1)).length, 1);
	});
});

describe("settings: dictation + gemini search", () => {
	it("the write side accepts valid prefs and rejects unknown ones", () => {
		const ok = parseAgentSettingsBody({ dictation: { engine: "gemini", language: "fr" }, search: { engine: "gemini" } });
		assert.ok(ok.ok);
		if (ok.ok) {
			assert.deepEqual(ok.settings.dictation, { engine: "gemini", language: "fr" });
			assert.deepEqual(ok.settings.search, { engine: "gemini" });
		}
		assert.ok(!parseAgentSettingsBody({ dictation: { engine: "whisper" } }).ok);
		assert.ok(!parseAgentSettingsBody({ dictation: { language: "klingon" } }).ok);
	});

	it("the read side drops unknown values", () => {
		const out = sanitizeUserSettings({ version: 1, agent: { dictation: { engine: "x", language: "fr" } } });
		assert.deepEqual(out?.agent?.dictation, { language: "fr" });
	});

	it("composeDictation sets and clears one field at a time", () => {
		const a = composeDictation(undefined, "language", "fr");
		assert.deepEqual(a.dictation, { language: "fr" });
		const b = composeDictation(a, "engine", "gemini");
		assert.deepEqual(b.dictation, { language: "fr", engine: "gemini" });
		assert.deepEqual(composeDictation(b, "engine", null).dictation, { language: "fr" });
		assert.equal(composeDictation(a, "language", null).dictation, undefined);
	});
});

describe("deepgramUrl", () => {
	it("pins the language, or uses nova-3's multilingual mode", () => {
		assert.match(deepgramUrl("fr"), /[?&]language=fr(&|$)/);
		assert.match(deepgramUrl(null), /[?&]language=multi(&|$)/);
		assert.match(deepgramUrl(null), /model=nova-3/);
	});
});
