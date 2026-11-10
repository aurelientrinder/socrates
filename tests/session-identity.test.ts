import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, normalizeContext, type Model, type SimpleStreamOptions } from "../src/llm/index.ts";
import { APP_IDENTITY, piEngineForSpec, type PiEngine } from "../src/agent/models.ts";
import { createProberAgent, createTeacherAgent, createPracticeAgent, type AgentBuildOptions } from "../src/agent/teacher-agent.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";
import { healToolRecord } from "../src/agent/tools/heal.ts";
import metadata from "../package.json" with { type: "json" };

const factories = [
	(opts: AgentBuildOptions) => createProberAgent({ chatId: opts.chatId, searchAvailable: () => false } as never, opts),
	(opts: AgentBuildOptions) => createTeacherAgent(undefined, opts),
	(opts: AgentBuildOptions) => createPracticeAgent({} as never, opts),
];

function recordingEngine() {
	const faux = createFauxCore({});
	faux.setResponses([fauxAssistantMessage([fauxToolCall("again", {}, { id: "call_0" })], { stopReason: "toolUse" }), { ...fauxAssistantMessage([fauxText("done")]), durationMs: 42 }]);
	const requests: SimpleStreamOptions[] = [];
	const engine: PiEngine = { model: faux.getModel(), streamFn: (model, context, options) => {
		requests.push(options ?? {});
		return faux.streamSimple(model, context, options);
	} };
	return { engine, requests };
}
const again = { name: "again", label: "again", description: "Continue", parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }) };

// Whole-process replacement isolates native auth/profile discovery; fetch never
// delegates. No real credentials, .env, OAuth accounts, or model inference.
async function closed<T>(run: () => Promise<T>): Promise<T> {
	const env = process.env;
	const fetch = globalThis.fetch;
	process.env = { NODE_ENV: "test", HOME: "/nonexistent/session-identity", GEMINI_API_KEY: "dummy-router" };
	globalThis.fetch = async () => { throw new Error("CLOSED: unexpected fetch"); };
	try { return await run(); } finally { process.env = env; globalThis.fetch = fetch; }
}

describe("native app and conversation identity", { concurrency: false }, () => {
	it("shares one deeply frozen metadata-derived identity, without mutable conversation state", () => {
		assert.deepEqual(APP_IDENTITY, { userAgent: { custom: `learnharness/${metadata.version}` }, attribution: { name: metadata.name, url: metadata.homepage } });
		for (const value of [APP_IDENTITY, APP_IDENTITY.userAgent, APP_IDENTITY.attribution]) assert.ok(Object.isFrozen(value));
		assert.ok(!Object.hasOwn(APP_IDENTITY, "sessionId"));
	});

	it("reconstructed prober/teacher/practice Agents reuse the exact chat id across tool rounds", async () => {
		for (const chatId of ["chat_exact_native_123", "chat_independent_456"]) {
			for (const factory of factories) {
				const { engine, requests } = recordingEngine();
				const agent = factory({ engine, chatId, tools: { again } });
				assert.equal(agent.identity, APP_IDENTITY);
				assert.equal(agent.sessionId, chatId);
				await agent.prompt("offline");
				assert.equal(requests.length, 2);
				for (const options of requests) {
					assert.equal(options.sessionId, chatId);
					assert.deepEqual(options.identity, APP_IDENTITY);
					assert.ok(options.signal instanceof AbortSignal);
					assert.equal(options.apiKey, undefined);
				}
			}
		}
	});

	it("separate extractor/auditor/compaction invocations own distinct stable unsaved conversations", async () => {
		const ids = new Set<unknown>();
		// Compaction uses the shared runner with the researcher role.
		for (const role of ["extractor", "auditor", "researcher"] as const) {
			const { engine, requests } = recordingEngine();
			let usage = 0;
			const result = await runSubagent([again], { role, engine, chatId: "chat_shared_debug_only", systemPrompt: "offline", prompt: "offline", maxTurns: 3, onUsage: () => usage++ });
			assert.equal(requests.length, 2);
			assert.equal(usage, 2);
			const id = requests[0]!.sessionId;
			assert.match(id ?? "", /^[0-9a-f-]{36}$/);
			assert.notEqual(id, "chat_shared_debug_only");
			assert.ok(!ids.has(id));
			ids.add(id);
			for (const options of requests) { assert.equal(options.sessionId, id); assert.deepEqual(options.identity, APP_IDENTITY); }
			assert.ok(result.newMessages.some((m) => m.role === "toolResult" && typeof m.durationMs === "number"), "new native tool duration fields are preserved");
			assert.ok(result.newMessages.some((m) => m.role === "assistant" && typeof m.durationMs === "number"), "new native assistant duration fields are preserved");
		}
	});

	it("complete Gemini foreground serialization hits the Gemini endpoint with the app user agent and key", async () => closed(async () => {
		const engine = piEngineForSpec({ provider: "google", id: "gemini-3.8-flash", thinkingLevel: "off" });
		const requests: Request[] = [];
		globalThis.fetch = async (input, init) => { const request = new Request(input, init); requests.push(request); await request.text(); return new Response('{"error":{"message":"closed fixture"}}', { status: 400, headers: { "content-type": "application/json" } }); };
		for (const factory of factories) await factory({ engine, chatId: "chat_wire_exact", tools: {} }).prompt("offline");
		assert.equal(requests.length, 3);
		for (const request of requests) {
			assert.equal(new URL(request.url).origin, "https://generativelanguage.googleapis.com");
			assert.match(new URL(request.url).pathname, /\/v1beta\/models\/gemini-3\.8-flash:streamGenerateContent$/);
			assert.match(request.headers.get("user-agent") ?? "", new RegExp(`learnharness/${metadata.version.replaceAll(".", "\\.")}`));
			assert.equal(request.headers.get("x-goog-api-key"), "dummy-router");
		}
	}));
});
