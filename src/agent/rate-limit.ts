/**
 * Provider rate limits (2026-10-26): free API tiers (Gemini's: 15 requests
 * a minute per model) answer a burst of background calls with HTTP 429 and
 * a retry delay. A notes import fans out into many extractor + auditor
 * calls, so it hit that wall and failed outright.
 *
 * This module turns a per-minute 429 into a WAIT: runSubagent (pi-run.ts)
 * asks rateLimitDelayMs whether an error is retryable, records a
 * process-wide cooldown (every background call waits it out, so the three
 * parallel permits don't each burn a request into the same wall), and
 * retries the turn. Per-day quotas are not retryable: waiting minutes
 * won't help, so they fail with a plain message instead.
 *
 * Waits are registered against the caller's AbortSignal, so the activity
 * feed can show a run as paused (extraction.ts extractionStatuses).
 *
 * PACING (2026-10-27): waiting after a 429 still spends a refused request
 * and a full minute per wall, and a long PDF hit the wall again and again.
 * So the first per-minute 429 that names its limit ("limit: 15") teaches
 * the app that model's budget, and from then on every request to it goes
 * through pacedStream (models.ts): at most that many requests in any
 * rolling minute, minus a little headroom. Background work keeps a few
 * requests per minute free, so the tutor still answers promptly while a
 * notes import runs. A model that never refused is never slowed down.
 */

import type { Api, AssistantMessage, AssistantMessageEvent, Model, StreamFunction } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { emit } from "../core/events.ts";
import { markUnadmittedUsage } from "./subscription-request-cycle.ts";

/** Without a delay in the error, wait this long (the per-minute window). */
const DEFAULT_DELAY_MS = 30_000;
/** A delay past this is not a per-minute limit: fail instead of hanging. */
const MAX_DELAY_MS = 5 * 60_000;
/** A little past the provider's own estimate, so the retry lands after it. */
const MARGIN_MS = 1_500;
/** Retries per run before giving up (each one waits out a full window). */
export const MAX_RATE_LIMIT_RETRIES = 8;

/** The rolling window a per-minute limit counts over, plus a margin for
 *  clock skew between us and the provider. */
const WINDOW_MS = 61_000;

interface RateLimitState {
	cooldownUntil: number;
	waiting: WeakMap<AbortSignal, number>;
	/** Learned requests-per-minute limits, by "provider/model". */
	limits: Map<string, number>;
	/** Send times in the last window, by "provider/model". */
	sent: Map<string, number[]>;
}

interface RateLimitGlobal {
	__lhRateLimit?: RateLimitState;
}

function state(): RateLimitState {
	const g = globalThis as typeof globalThis & RateLimitGlobal;
	const s = (g.__lhRateLimit ??= { cooldownUntil: 0, waiting: new WeakMap(), limits: new Map(), sent: new Map() });
	// A dev hot reload keeps the global from an older shape.
	s.limits ??= new Map();
	s.sent ??= new Map();
	return s;
}

export function isRateLimitError(message: string): boolean {
	return /\b429\b|RESOURCE_EXHAUSTED|Too Many Requests|rate[ -]?limit|quota exceeded/i.test(message);
}

/** A daily (or longer) quota: retrying within minutes cannot succeed. */
export function isDailyQuota(message: string): boolean {
	return /PerDay|per day|daily/i.test(message);
}

/** How long the provider asks us to wait, if it says ("retry in 42.2s",
 *  "retryDelay": "42s", "Retry-After: 42"). */
export function parseRetryDelayMs(message: string): number | null {
	const m =
		/retry in ([\d.]+)\s*s/i.exec(message) ??
		/retryDelay\\?"?\s*:\s*\\?"([\d.]+)s/i.exec(message) ??
		/retry-after:?\s*([\d.]+)/i.exec(message);
	if (!m) return null;
	const seconds = Number(m[1]);
	return Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : null;
}

/** The wait before retrying this error, or null when it is not a
 *  retryable (per-minute) rate limit. */
export function rateLimitDelayMs(message: string): number | null {
	if (!isRateLimitError(message) || isDailyQuota(message)) return null;
	const delay = parseRetryDelayMs(message) ?? DEFAULT_DELAY_MS;
	return delay > MAX_DELAY_MS ? null : delay + MARGIN_MS;
}

/** The requests-per-minute limit a 429 names, or null when it names none
 *  (or the quota is per day, or counts tokens rather than requests). */
export function parseRequestLimit(message: string): number | null {
	if (isDailyQuota(message)) return null;
	const m =
		/metric:\s*\S*requests\S*,\s*limit:\s*(\d+)/i.exec(message) ??
		/RequestsPerMinute[^]*?quotaValue\\?"?\s*:\s*\\?"?(\d+)/i.exec(message);
	const limit = m ? Number(m[1]) : NaN;
	return Number.isInteger(limit) && limit > 0 ? limit : null;
}

/** Remember a model's per-minute request limit from its 429. */
export function learnRequestLimit(modelKey: string, message: string): void {
	const limit = parseRequestLimit(message);
	if (limit === null) return;
	const limits = state().limits;
	const known = limits.get(modelKey);
	if (known === undefined || limit < known) {
		limits.set(modelKey, limit);
		console.info(`[rate-limit] ${modelKey}: pacing to the provider's ${limit} requests per minute from now on`);
	}
}

/** How many requests a caller may send in one window: one under the
 *  limit for the learner's own turns, and a few more held back from
 *  background work so the tutor is never queued behind an import. */
export function requestBudget(limit: number, background: boolean): number {
	const foreground = Math.max(1, limit - 1);
	return background ? Math.max(1, foreground - Math.max(1, Math.round(limit * 0.15))) : foreground;
}

/** Milliseconds until this model may take another request (0 = now). */
export function requestSlotDelayMs(modelKey: string, background: boolean, now = Date.now()): number {
	const s = state();
	const recent = (s.sent.get(modelKey) ?? []).filter((t) => t > now - WINDOW_MS);
	s.sent.set(modelKey, recent);
	const limit = s.limits.get(modelKey);
	if (limit === undefined) return 0;
	const budget = requestBudget(limit, background);
	if (recent.length < budget) return 0;
	// The slot frees when the request that filled the budget leaves the window.
	return recent[recent.length - budget]! + WINDOW_MS - now;
}

/** Wait for a request slot on this model, then claim it. Abort-aware;
 *  the wait shows as paused like a cooldown does. */
export async function waitForRequestSlot(modelKey: string, background: boolean, signal: AbortSignal | undefined): Promise<void> {
	const s = state();
	for (;;) {
		signal?.throwIfAborted();
		const ms = requestSlotDelayMs(modelKey, background);
		if (ms <= 0) {
			s.sent.get(modelKey)!.push(Date.now());
			return;
		}
		if (signal) s.waiting.set(signal, Date.now() + ms);
		emit("activity-changed", {});
		try {
			await sleep(ms, signal);
		} finally {
			if (signal) s.waiting.delete(signal);
			emit("activity-changed", {});
		}
	}
}

/** Wrap a stream function so every request waits for its model's slot,
 *  and a 429 that names a limit teaches it. The caller's stream starts
 *  only once a slot is free; an abort while waiting ends the stream as
 *  aborted with nothing sent (and nothing billed). */
export function pacedStream<TApi extends Api>(modelKey: string, background: () => boolean, inner: StreamFunction<TApi>): StreamFunction<TApi> {
	return (model, context, options) => {
		const signal = options?.signal;
		const output = new AssistantMessageEventStream();
		void (async () => {
			try {
				await waitForRequestSlot(modelKey, background(), signal);
			} catch {
				const aborted = notSent(model, "aborted");
				output.push({ type: "error", reason: "aborted", error: aborted });
				output.end();
				return;
			}
			try {
				for await (const event of inner(model, context, options)) {
					if (event.type === "error" && event.error.errorMessage && isRateLimitError(event.error.errorMessage)) {
						learnRequestLimit(modelKey, event.error.errorMessage);
					}
					output.push(event);
				}
			} catch (err) {
				const failed = { ...notSent(model, "error"), errorMessage: err instanceof Error ? err.message : String(err) };
				output.push({ type: "error", reason: "error", error: failed } satisfies AssistantMessageEvent);
			} finally {
				output.end();
			}
		})();
		return output;
	};
}

/** The terminal message of a request that never reached the provider. */
function notSent(model: Model<Api>, stopReason: "aborted" | "error"): AssistantMessage {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	markUnadmittedUsage(usage);
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason, timestamp: Date.now(), usage };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			const err = new Error("aborted while waiting out a rate limit");
			err.name = "AbortError";
			reject(err);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Start (or extend) the process-wide cooldown. */
export function noteRateLimit(delayMs: number): void {
	const s = state();
	s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + delayMs);
}

/** When this caller's run is waiting out a rate limit: the time it resumes. */
export function rateLimitedUntil(signal: AbortSignal | undefined): number | null {
	if (!signal) return null;
	const until = state().waiting.get(signal);
	return until !== undefined && until > Date.now() ? until : null;
}

/** True while the process-wide cooldown runs (callers skip the await
 *  otherwise, so a run with no limit in sight starts in the same tick). */
export function rateLimitCooling(): boolean {
	return state().cooldownUntil > Date.now();
}

/** Wait out the cooldown, if one is running. Abort-aware. */
export async function waitForRateLimit(signal: AbortSignal | undefined): Promise<void> {
	const s = state();
	const ms = s.cooldownUntil - Date.now();
	if (ms <= 0) return;
	if (signal) s.waiting.set(signal, s.cooldownUntil);
	emit("activity-changed", {});
	try {
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(resolve, ms);
			signal?.addEventListener(
				"abort",
				() => {
					clearTimeout(timer);
					const err = new Error("aborted while waiting out a rate limit");
					err.name = "AbortError";
					reject(err);
				},
				{ once: true },
			);
		});
	} finally {
		if (signal) s.waiting.delete(signal);
		emit("activity-changed", {});
	}
}

/** The error a run ends with when the limit never let it through. */
export function rateLimitFailure(message: string): Error {
	const model = /model:\s*([\w.-]+)/.exec(message)?.[1];
	const which = model ? ` for ${model}` : "";
	return new Error(
		isDailyQuota(message)
			? `The model provider's daily quota${which} is used up, so this stopped. It resets tomorrow; until then, switch the background model in Settings or add billing to your API key.`
			: `The model provider kept refusing requests${which} because of its rate limit (too many requests per minute), even after waiting. Try again in a few minutes.`,
	);
}
