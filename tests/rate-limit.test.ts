/**
 * Provider rate limits (src/agent/rate-limit.ts): a per-minute 429 makes a
 * background run wait and continue instead of failing; a daily quota fails
 * with a plain message. Driven through the real runSubagent loop with a
 * faux engine whose first answer is Gemini's free-tier 429.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { isDailyQuota, parseRetryDelayMs, rateLimitDelayMs, rateLimitedUntil } from "../src/agent/rate-limit.ts";
import { runSubagent } from "../src/agent/subagents/pi-run.ts";

// Gemini's own wording (a real free-tier refusal, trimmed).
const GEMINI_429 = (retry: string, quotaId = "GenerateRequestsPerMinutePerProjectPerModel-FreeTier") =>
	`{"error":{"code":429,"message":"You exceeded your current quota.\\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 15, model: gemini-3.5-flash-lite\\nPlease retry in ${retry}s.","status":"RESOURCE_EXHAUSTED","details":[{"quotaId":"${quotaId}"},{"retryDelay":"${retry}s"}]}}`;

it("reads the provider's retry delay and tells per-minute limits from daily quotas", () => {
	assert.equal(parseRetryDelayMs(GEMINI_429("42.230081708")), 42231);
	assert.equal(parseRetryDelayMs('"retryDelay": "17s"'), 17000);
	assert.equal(rateLimitDelayMs(GEMINI_429("42")), 43500);
	assert.equal(rateLimitDelayMs("429 Too Many Requests"), 31500, "no delay given: one per-minute window");
	assert.equal(isDailyQuota(GEMINI_429("42", "GenerateRequestsPerDayPerProjectPerModel-FreeTier")), true);
	assert.equal(rateLimitDelayMs(GEMINI_429("42", "GenerateRequestsPerDayPerProjectPerModel-FreeTier")), null);
	assert.equal(rateLimitDelayMs(GEMINI_429("900")), null, "a 15-minute wait is not a per-minute limit");
	assert.equal(rateLimitDelayMs("400 invalid argument"), null);
});

it("a run refused with a 429 waits it out, shows as paused, and continues to its answer", async () => {
	const faux = createFauxCore({});
	faux.setResponses([
		() => fauxAssistantMessage("", { stopReason: "error", errorMessage: GEMINI_429("0.05") }),
		() => fauxAssistantMessage("the brief"),
	]);
	const controller = new AbortController();
	const started = Date.now();
	let pausedSeen = false;
	const probe = setInterval(() => { if (rateLimitedUntil(controller.signal)) pausedSeen = true; }, 20);
	try {
		const { text } = await runSubagent([], {
			role: "researcher",
			engine: { model: faux.getModel(), streamFn: faux.streamSimple } as never,
			systemPrompt: "s",
			prompt: "p",
			maxTurns: 1,
			abortSignal: controller.signal,
		});
		assert.equal(text, "the brief");
	} finally {
		clearInterval(probe);
	}
	assert.ok(Date.now() - started >= 1500, "waited the provider's delay (plus margin)");
	assert.equal(pausedSeen, true);
	assert.equal(rateLimitedUntil(controller.signal), null);
});

it("a daily quota fails at once with a message a learner can act on", async () => {
	const faux = createFauxCore({});
	faux.setResponses([
		() => fauxAssistantMessage("", { stopReason: "error", errorMessage: GEMINI_429("42", "GenerateRequestsPerDayPerProjectPerModel-FreeTier") }),
	]);
	await assert.rejects(
		runSubagent([], { role: "researcher", engine: { model: faux.getModel(), streamFn: faux.streamSimple } as never, systemPrompt: "s", prompt: "p", maxTurns: 1 }),
		/daily quota for gemini-3\.5-flash-lite is used up/,
	);
});
