/**
 * Provider rate limits (src/agent/rate-limit.ts): a per-minute 429 makes a
 * background run wait and continue instead of failing; a daily quota fails
 * with a plain message. Driven through the real runSubagent loop with a
 * faux engine whose first answer is Gemini's free-tier 429.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { isDailyQuota, learnRequestLimit, pacedStream, parseRequestLimit, parseRetryDelayMs, rateLimitDelayMs, rateLimitedUntil, requestBudget, requestSlotDelayMs, waitForRequestSlot } from "../src/agent/rate-limit.ts";
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

it("learns a model's requests-per-minute limit from a 429 that names it, and nothing else", () => {
	assert.equal(parseRequestLimit(GEMINI_429("42")), 15);
	assert.equal(parseRequestLimit('"quotaId":"GenerateRequestsPerMinutePerProjectPerModel-FreeTier","quotaValue":"10"'), 10);
	assert.equal(parseRequestLimit(GEMINI_429("42", "GenerateRequestsPerDayPerProjectPerModel-FreeTier")), null, "a daily quota is not a pace");
	assert.equal(parseRequestLimit("Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 250000"), null, "a token budget is not a request budget");
	assert.equal(parseRequestLimit("429 Too Many Requests"), null);
});

it("keeps headroom for the learner: background work gets a smaller share of the budget", () => {
	assert.equal(requestBudget(15, false), 14);
	assert.equal(requestBudget(15, true), 12);
	assert.equal(requestBudget(10, true), 7);
	assert.equal(requestBudget(2, false), 1);
	assert.equal(requestBudget(2, true), 1);
	assert.equal(requestBudget(1, true), 1);
});

it("a model that never refused is never slowed; once it names a limit, requests wait for a slot", async () => {
	const key = "google/pacing-test";
	await waitForRequestSlot(key, true, undefined);
	await waitForRequestSlot(key, true, undefined);
	assert.equal(requestSlotDelayMs(key, true), 0, "no limit learned yet: no wait");
	learnRequestLimit(key, GEMINI_429("1").replace("limit: 15", "limit: 4"));
	const bgWait = requestSlotDelayMs(key, true);
	assert.ok(bgWait > 55_000 && bgWait <= 61_000, `background waits for the oldest request to leave the minute (${bgWait})`);
	assert.equal(requestSlotDelayMs(key, false), 0, "the learner's turn still has a slot");
	learnRequestLimit(key, GEMINI_429("1").replace("limit: 15", "limit: 30"));
	assert.ok(requestSlotDelayMs(key, true) > 0, "a later, looser figure never raises a learned limit");

	const controller = new AbortController();
	const waiting = waitForRequestSlot(key, true, controller.signal);
	setTimeout(() => controller.abort(), 20);
	await assert.rejects(waiting, { name: "AbortError" });
});

it("pacedStream learns from a refused request and ends an aborted wait without sending anything", async () => {
	const faux = createFauxCore({});
	faux.setResponses([() => fauxAssistantMessage("", { stopReason: "error", errorMessage: GEMINI_429("1").replace("limit: 15", "limit: 1") })]);
	const key = "google/paced-stream-test";
	let sent = 0;
	const inner = ((...args: Parameters<typeof faux.streamSimple>) => { sent++; return faux.streamSimple(...args); }) as typeof faux.streamSimple;
	const stream = pacedStream(key, () => true, inner);
	const first = await stream(faux.getModel(), { messages: [] }, {}).result();
	assert.equal(first.stopReason, "error");
	assert.equal(sent, 1);
	assert.ok(requestSlotDelayMs(key, true) > 0, "the limit named in the 429 now paces this model");

	const controller = new AbortController();
	const pending = stream(faux.getModel(), { messages: [] }, { signal: controller.signal });
	setTimeout(() => controller.abort(), 20);
	const second = await pending.result();
	assert.equal(second.stopReason, "aborted");
	assert.equal(sent, 1, "the waiting request never reached the provider");
});
