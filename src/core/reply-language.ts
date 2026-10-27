/**
 * THE TUTOR'S LANGUAGE (2026-10-27): which language the tutor writes to
 * the learner in. Absent = automatic — the tutor answers in the language
 * the learner writes in, the behaviour before this setting existed. A
 * chosen language adds one line to the conversation agents' system prompt.
 * Same language list as dictation. Pure, browser-safe.
 */

import { DICTATION_LANGUAGES, dictationLanguageLabel, isDictationLanguage } from "./dictation.ts";

export const REPLY_LANGUAGES = DICTATION_LANGUAGES;

export function isReplyLanguage(value: unknown): value is string {
	return isDictationLanguage(value);
}

export function replyLanguageLabel(code: string | null | undefined): string | null {
	return dictationLanguageLabel(code);
}

/** The system-prompt line for a chosen language, or null (automatic). */
export function replyLanguageInstruction(code: string | null | undefined): string | null {
	const label = replyLanguageLabel(code);
	if (!label) return null;
	return (
		`LANGUAGE: always write to the learner in ${label}: explanations, questions, answer options, hints and feedback alike, ` +
		`even when the course material, their notes or their own messages are in another language. ` +
		`Keep established technical terms and names as they are usually written in ${label}.`
	);
}
