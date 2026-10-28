/**
 * Dictation + search on the Gemini key (2026-10-26): engine resolution for
 * dictation, the Gemini transcriber and the Gemini search-grounding
 * adapter against STUB fetches (never the network), the WAV header, and
 * the settings parse/sanitize (stale engine pins from retired engines
 * included).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { geminiTranscribe, pcmToWav, resolveDictationEngineFor, transcribePrompt } from "../src/server/dictation.ts";
import { geminiSearchProvider } from "../src/server/search.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { sanitizeUserSettings } from "../src/core/settings.ts";
import { composeDictation } from "../components/settings/agent-section.tsx";

describe("resolveDictationEngineFor", () => {
	it("no key: honestly unavailable", () => {
		const out = resolveDictationEngineFor(undefined);
		assert.ok(!out.available);
		assert.match(out.reason, /Gemini/);
	});

	it("a Gemini key alone is enough", () => {
		const out = resolveDictationEngineFor("g-key");
		assert.equal(out.engine, "gemini");
		assert.equal(out.key, "g-key");
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

describe("settings: dictation language", () => {
	it("the write side accepts a valid language and rejects unknown ones", () => {
		const ok = parseAgentSettingsBody({ dictation: { language: "fr" } });
		assert.ok(ok.ok);
		if (ok.ok) assert.deepEqual(ok.settings.dictation, { language: "fr" });
		assert.ok(!parseAgentSettingsBody({ dictation: { language: "klingon" } }).ok);
	});

	it("the write side ignores a stale engine pin and a stale search pin", () => {
		const out = parseAgentSettingsBody({ dictation: { engine: "deepgram", language: "fr" }, search: { engine: "tavily" } });
		assert.ok(out.ok);
		if (out.ok) {
			assert.deepEqual(out.settings.dictation, { language: "fr" });
			assert.equal((out.settings as Record<string, unknown>).search, undefined);
		}
	});

	it("the read side drops retired engine pins", () => {
		const out = sanitizeUserSettings({
			version: 1,
			agent: { dictation: { engine: "deepgram", language: "fr" }, search: { engine: "brave" } },
		});
		assert.deepEqual(out?.agent?.dictation, { language: "fr" });
		assert.equal((out?.agent as Record<string, unknown> | undefined)?.search, undefined);
	});

	it("composeDictation sets and clears the language", () => {
		const a = composeDictation(undefined, "language", "fr");
		assert.deepEqual(a.dictation, { language: "fr" });
		assert.equal(composeDictation(a, "language", null).dictation, undefined);
	});
});
