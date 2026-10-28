/**
 * Dictation (dictation-options wave, 2026-10-26; Gemini only since the
 * Deepgram engine was removed).
 *
 * One BATCH engine behind the mic button, riding the user's existing
 * GEMINI_API_KEY (the free AI Studio tier works): the renderer records the
 * run's linear16 frames and, at stop, POSTs them to /api/stt/transcribe,
 * which asks Gemini for a verbatim transcript. The text lands once, at stop
 * (deferred — owner round 2, 2026-09-17).
 *
 * Dictation is live iff the Gemini key is present. Language:
 * agent.dictation.language is an ISO-639-1 code from DICTATION_LANGUAGES;
 * absent = automatic (Gemini's own detection).
 *
 * Pure types + data only (browser-safe).
 */

export type DictationEngineId = "gemini";

/** The engine and the key it needs. */
export const DICTATION_ENGINES: ReadonlyArray<{ id: DictationEngineId; envVar: string; label: string }> = [
	{ id: "gemini", envVar: "GEMINI_API_KEY", label: "Gemini" },
];

/** The pickable languages. */
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
 *  engine to drive and the language (null = automatic). */
export interface DictationSession {
	engine: DictationEngineId;
	language: string | null;
}

/** Why dictation is (un)available — the settings row's reason line. */
export interface DictationStatus {
	available: boolean;
	engine: DictationEngineId | null;
	reason: string;
}

/** The longest run: ~4 minutes of 16kHz linear16 is ~7.7MB
 *  of PCM — under Gemini's 20MB inline-request ceiling once base64'd, and
 *  under the 10MB body the API proxy buffers. The renderer stops the run
 *  itself when it reaches this (the transcript is kept). */
export const BATCH_DICTATION_MAX_SECONDS = 240;
