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
 */

import { emit } from "../core/events.ts";

/** Without a delay in the error, wait this long (the per-minute window). */
const DEFAULT_DELAY_MS = 30_000;
/** A delay past this is not a per-minute limit: fail instead of hanging. */
const MAX_DELAY_MS = 5 * 60_000;
/** A little past the provider's own estimate, so the retry lands after it. */
const MARGIN_MS = 1_500;
/** Retries per run before giving up (each one waits out a full window). */
export const MAX_RATE_LIMIT_RETRIES = 8;

interface RateLimitGlobal {
	__lhRateLimit?: { cooldownUntil: number; waiting: WeakMap<AbortSignal, number> };
}

function state() {
	const g = globalThis as typeof globalThis & RateLimitGlobal;
	return (g.__lhRateLimit ??= { cooldownUntil: 0, waiting: new WeakMap() });
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
