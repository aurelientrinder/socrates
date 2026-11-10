/**
 * The Gemini layer (src/llm): transcript → Gemini contents, the catalog, and
 * live model discovery. No network: fetch is stubbed where the SDK is hit.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { calculateCost, clampThinkingLevel, getModel, getSupportedThinkingLevels, listModels, type AssistantMessage, type Message, type Usage } from "../src/llm/index.ts";
import { normalizeContext } from "../src/llm/index.ts";
import { setDiscoveredModels } from "../src/llm/catalog.ts";
import { convertMessages, convertTools, fillGeminiThoughtSignatures, GEMINI_SKIP_SIGNATURE, streamSimpleGemini } from "../src/llm/gemini.ts";
import { modelFromListing, refreshDiscoveredModels } from "../src/llm/discovery.ts";
import { Type } from "typebox";

const FLASH = getModel("google", "gemini-3.8-flash")!;
const usage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const assistant = (content: AssistantMessage["content"], extra: Partial<AssistantMessage> = {}): AssistantMessage => ({
	role: "assistant", content, api: "google-generative-ai", provider: "google", model: "gemini-3.8-flash", usage: usage(), stopReason: "stop", timestamp: 1, ...extra,
});
const ctx = (messages: Message[]) => normalizeContext({ systemPrompt: "be brief", messages });

afterEach(() => setDiscoveredModels([]));

describe("the Gemini catalog", () => {
	it("lists Gemini 4 Argon and no Claude or other provider", () => {
		const ids = listModels().map((m) => m.id);
		assert.ok(ids.includes("gemini-4-argon"));
		assert.ok(listModels().every((m) => m.provider === "google" && m.id.startsWith("gemini-")));
		assert.equal(getModel("anthropic", "claude-haiku-5-5"), undefined);
	});

	it("does not invent Gemini 4 Carbon: it stays absent until Google lists it for the key", () => {
		assert.equal(getModel("google", "gemini-4-carbon"), undefined);
	});

	it("thinking truth for 3.8 Flash: low|medium|high, off clamps up", () => {
		assert.deepEqual(getSupportedThinkingLevels(FLASH), ["low", "medium", "high"]);
		assert.equal(clampThinkingLevel(FLASH, "off"), "low");
		assert.equal(clampThinkingLevel(FLASH, "max"), "high");
	});

	it("prices tokens per million, with the long-context tier", () => {
		const u = { ...usage(), input: 1_000_000, output: 1_000_000 };
		assert.ok(Math.abs(calculateCost(FLASH, u).total - 4.5) < 1e-9);
		const pro = getModel("google", "gemini-2.5-pro")!;
		const long = { ...usage(), input: 300_000, output: 0 };
		assert.ok(Math.abs(calculateCost(pro, long).total - 0.75) < 1e-9, "over 200k input bills the higher tier");
	});
});

describe("transcript → Gemini contents", () => {
	it("replays a tool round with ids, the signature, and one merged function-response turn", () => {
		const sig = Buffer.from("real-signature").toString("base64");
		const contents = convertMessages(FLASH, ctx([
			{ role: "user", content: "hi", timestamp: 1 },
			assistant([
				{ type: "toolCall", id: "call_a", name: "quiz", arguments: { q: 1 }, thoughtSignature: sig },
				{ type: "toolCall", id: "call_b", name: "ask", arguments: {} },
			], { stopReason: "toolUse" }),
			{ role: "toolResult", toolCallId: "call_a", toolName: "quiz", content: [{ type: "text", text: "A" }], isError: false, timestamp: 2 },
			{ role: "toolResult", toolCallId: "call_b", toolName: "ask", content: [{ type: "text", text: "B" }], isError: true, timestamp: 3 },
		]));
		assert.equal(contents.length, 3);
		const model = contents[1]!.parts!;
		assert.deepEqual(model[0]!.functionCall, { name: "quiz", args: { q: 1 }, id: "call_a" });
		assert.equal(model[0]!.thoughtSignature, sig);
		assert.equal(model[1]!.thoughtSignature, undefined);
		const responses = contents[2]!.parts!;
		assert.equal(contents[2]!.role, "user");
		assert.deepEqual(responses.map((p) => p.functionResponse?.response), [{ output: "A" }, { error: "B" }]);
	});

	it("drops thinking and signatures that came from another model", () => {
		const contents = convertMessages(FLASH, ctx([
			{ role: "user", content: "hi", timestamp: 1 },
			assistant([{ type: "thinking", thinking: "secret", thinkingSignature: "AAAA" }, { type: "text", text: "answer" }], { model: "gemini-2.5-pro" }),
		]));
		assert.deepEqual(contents[1]!.parts, [{ text: "answer" }]);
	});

	it("answers an orphaned tool call with a synthetic error result and skips errored turns", () => {
		const contents = convertMessages(FLASH, ctx([
			{ role: "user", content: "hi", timestamp: 1 },
			assistant([{ type: "toolCall", id: "call_x", name: "quiz", arguments: {} }], { stopReason: "toolUse" }),
			{ role: "user", content: "again", timestamp: 2 },
			assistant([{ type: "text", text: "half" }], { stopReason: "error" }),
		]));
		assert.equal(contents.length, 4, "user, call, synthetic result, user (the errored turn is gone)");
		assert.deepEqual(contents[2]!.parts![0]!.functionResponse?.response, { error: "No result provided" });
	});

	it("declares tools with their JSON schema", () => {
		const tools = convertTools([{ name: "quiz", description: "ask", parameters: Type.Object({ q: Type.String() }) }]);
		assert.equal(tools![0]!.functionDeclarations[0]!.name, "quiz");
		assert.deepEqual((tools![0]!.functionDeclarations[0]!.parametersJsonSchema as { required: string[] }).required, ["q"]);
	});

	it("fills the documented dummy signature on replayed calls that lack one", () => {
		const payload = { contents: [{ role: "model", parts: [{ functionCall: { name: "x" } }, { functionCall: { name: "y" }, thoughtSignature: "real" }] }] };
		fillGeminiThoughtSignatures(payload);
		assert.equal(payload.contents[0]!.parts[0]!.thoughtSignature, GEMINI_SKIP_SIGNATURE);
		assert.equal(payload.contents[0]!.parts[1]!.thoughtSignature, "real");
	});
});

describe("streaming through the official SDK", () => {
	it("maps a streamed reply (thinking, text, tool call, usage) to assistant events", async () => {
		const real = globalThis.fetch;
		const chunks = [
			{ candidates: [{ content: { role: "model", parts: [{ text: "pondering", thought: true }] } }] },
			{ candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] } }] },
			{ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "quiz", args: { q: "x" } }, thoughtSignature: "c2ln" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 100, thoughtsTokenCount: 50, totalTokenCount: 1150 }, responseId: "r1" },
		];
		let url = "";
		globalThis.fetch = async (input) => {
			url = String(input instanceof Request ? input.url : input);
			return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
		};
		try {
			const result = await streamSimpleGemini(FLASH, ctx([{ role: "user", content: "hi", timestamp: 1 }]), { apiKey: "test-key-not-real", reasoning: "low" }).result();
			assert.match(url, /gemini-3\.8-flash:streamGenerateContent/);
			assert.equal(result.stopReason, "toolUse");
			assert.deepEqual(result.content.map((b) => b.type), ["thinking", "text", "toolCall"]);
			const call = result.content[2]!;
			assert.ok(call.type === "toolCall" && call.name === "quiz" && call.thoughtSignature === "c2ln");
			assert.equal(result.responseId, "r1");
			assert.equal(result.usage.input, 1000);
			assert.equal(result.usage.output, 150);
			assert.equal(result.usage.reasoning, 50);
			assert.ok(result.usage.cost.total > 0);
		} finally {
			globalThis.fetch = real;
		}
	});

	it("reports a missing key as an error message, never a throw", async () => {
		const saved = { g: process.env.GEMINI_API_KEY, k: process.env.GOOGLE_API_KEY };
		delete process.env.GEMINI_API_KEY;
		delete process.env.GOOGLE_API_KEY;
		try {
			const result = await streamSimpleGemini(FLASH, ctx([{ role: "user", content: "hi", timestamp: 1 }]), {}).result();
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage ?? "", /No Gemini API key/);
		} finally {
			if (saved.g !== undefined) process.env.GEMINI_API_KEY = saved.g;
			if (saved.k !== undefined) process.env.GOOGLE_API_KEY = saved.k;
		}
	});

	it("surfaces an HTTP error body as the message (the rate-limit pacer reads it)", async () => {
		const real = globalThis.fetch;
		globalThis.fetch = async () => new Response(JSON.stringify({ error: { code: 429, message: "Quota exceeded: limit: 15", status: "RESOURCE_EXHAUSTED" } }), { status: 429, headers: { "content-type": "application/json" } });
		try {
			const result = await streamSimpleGemini(FLASH, ctx([{ role: "user", content: "hi", timestamp: 1 }]), { apiKey: "test-key-not-real" }).result();
			assert.equal(result.stopReason, "error");
			assert.match(result.errorMessage ?? "", /Quota exceeded/);
		} finally {
			globalThis.fetch = real;
		}
	});
});

describe("live model discovery", () => {
	it("projects only Gemini chat models", () => {
		assert.equal(modelFromListing({ name: "models/text-embedding-004" }), null);
		assert.equal(modelFromListing({ name: "models/gemini-3.1-flash-image-preview", supportedActions: ["generateContent"] }), null);
		assert.equal(modelFromListing({ name: "models/gemini-9-x", supportedActions: ["embedContent"] }), null);
		const m = modelFromListing({ name: "models/gemini-4-carbon", displayName: "Gemini 4 Carbon", inputTokenLimit: 1_000_000, outputTokenLimit: 64_000, supportedActions: ["generateContent"], thinking: true })!;
		assert.equal(m.id, "gemini-4-carbon");
		assert.equal(m.name, "Gemini 4 Carbon");
		assert.deepEqual(getSupportedThinkingLevels(m), ["low", "medium", "high"]);
	});

	it("adds a model Google lists for the key (Carbon appears once it is granted) and keeps the baked ones", async () => {
		const real = globalThis.fetch;
		const savedKey = process.env.GEMINI_API_KEY;
		process.env.GEMINI_API_KEY = "test-key-not-real-1";
		globalThis.fetch = async () => new Response(JSON.stringify({ models: [
			{ name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] },
			{ name: "models/gemini-4-carbon", displayName: "Gemini 4 Carbon", inputTokenLimit: 1048576, outputTokenLimit: 65536, supportedGenerationMethods: ["generateContent", "countTokens"] },
			{ name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
		] }), { headers: { "content-type": "application/json" } });
		try {
			assert.equal(getModel("google", "gemini-4-carbon"), undefined);
			await refreshDiscoveredModels(true);
			const carbon = getModel("google", "gemini-4-carbon");
			assert.ok(carbon, "listed for this key → selectable");
			assert.equal(carbon!.name, "Gemini 4 Carbon");
			assert.equal(getModel("google", "gemini-3.8-flash")!.cost.input, 0.75, "baked metadata wins for known models");
			assert.equal(getModel("google", "text-embedding-004"), undefined);
		} finally {
			globalThis.fetch = real;
			if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
			else process.env.GEMINI_API_KEY = savedKey;
		}
	});

	it("a failed listing keeps the baked catalog", async () => {
		const real = globalThis.fetch;
		const savedKey = process.env.GEMINI_API_KEY;
		process.env.GEMINI_API_KEY = "test-key-not-real-2";
		globalThis.fetch = async () => { throw new Error("offline"); };
		try {
			await refreshDiscoveredModels(true);
			assert.ok(getModel("google", "gemini-3.8-flash"));
		} finally {
			globalThis.fetch = real;
			if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
			else process.env.GEMINI_API_KEY = savedKey;
		}
	});
});
