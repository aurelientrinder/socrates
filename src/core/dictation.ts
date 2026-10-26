/**
 * The dictation engines (dictation-options wave, 2026-10-26).
 *
 * Two engines behind one mic button:
 *  - deepgram: the original streaming engine — the renderer opens
 *    Deepgram's WebSocket directly with a minted token (components/
 *    dictation.tsx's file header has the full story).
 *  - gemini: a BATCH engine riding the user's existing GEMINI_API_KEY
 *    (the free AI Studio tier works) — the renderer records the run's
 *    linear16 frames and, at stop, POSTs them to /api/stt/transcribe,
 *    which asks Gemini for a verbatim transcript. Dictation was already
 *    DEFERRED (text lands once, at stop — owner round 2, 2026-09-17), so
 *    a batch engine feels the same: only the stop spinner lasts longer.
 *
 * Resolution mirrors the search engines (core/search.ts): an engine is
 * live iff its key is present; agent.dictation.engine only pins a
 * preference (Deepgram first when both are keyed — it is the low-latency
 * one); a pinned engine without its key is honestly unavailable.
 *
 * Language: agent.dictation.language is an ISO-639-1 code from
 * DICTATION_LANGUAGES; absent = automatic (Deepgram's multilingual mode,
 * Gemini's own detection).
 *
 * Pure types + data only (browser-safe).
 */

export type DictationEngineId = "deepgram" | "gemini";

/** Preference order (no pin, several keys → the first keyed engine). */
export const DICTATION_ENGINES: ReadonlyArray<{ id: DictationEngineId; envVar: string; label: string }> = [
	{ id: "deepgram", envVar: "DEEPGRAM_API_KEY", label: "Deepgram" },
	{ id: "gemini", envVar: "GEMINI_API_KEY", label: "Gemini" },
];

export function isDictationEngineId(value: unknown): value is DictationEngineId {
	return DICTATION_ENGINES.some((e) => e.id === value);
}

/** The pickable languages. Deepgram nova-3 transcribes each of these
 *  monolingually and all of them in its `multi` mode (the automatic one). */
export const DICTATION_LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
	{ code: "en", label: "English" },
	{ code: "fr", label: "French" },
	{ code: "de", label: "German" },
	{ code: "es", label: "Spanish" },
	{ code: "it", label: "Italian" },
	{ code: "pt", label: "Portuguese" },
	{ code: "nl", label: "Dutch" },
];

export function isDictationLanguage(value: unknown): value is string {
	return DICTATION_LANGUAGES.some((l) => l.code === value);
}

export function dictationLanguageLabel(code: string | null | undefined): string | null {
	return DICTATION_LANGUAGES.find((l) => l.code === code)?.label ?? null;
}

/** What /api/stt/token hands the renderer at the start of a run: which
 *  engine to drive, the language (null = automatic), and — Deepgram only —
 *  the short-lived socket token. */
export interface DictationSession {
	engine: DictationEngineId;
	language: string | null;
	token?: string;
}

/** Why dictation is (un)available — the settings row's reason line. */
export interface DictationStatus {
	available: boolean;
	engine: DictationEngineId | null;
	reason: string;
}

/** The longest batch run (Gemini): ~4 minutes of 16kHz linear16 is ~7.7MB
 *  of PCM — under Gemini's 20MB inline-request ceiling once base64'd, and
 *  under the 10MB body the API proxy buffers. The renderer stops the run
 *  itself when it reaches this (the transcript is kept). */
export const BATCH_DICTATION_MAX_SECONDS = 240;
