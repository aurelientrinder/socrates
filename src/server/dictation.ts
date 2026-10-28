/**
 * The dictation engine's server composition (dictation-options wave,
 * 2026-10-26): engine resolution (core/dictation.ts has the rules) + the
 * Gemini batch transcriber behind POST /api/stt/transcribe.
 *
 * The transcriber takes an injected fetch so tests never touch the network.
 */

import {
	dictationLanguageLabel,
	type DictationStatus,
} from "../core/dictation.ts";
import { keyValue } from "./keys.ts";
import { geminiErrorMessage, geminiToolModel } from "./search.ts";
import { effectiveSettings } from "./stores.ts";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The capture format the renderer's worklet produces (pcm-capture.js). */
export const DICTATION_SAMPLE_RATE = 16000;

/** Resolve the dictation state PURELY from the live Gemini key (testable):
 *  present = live, absent = honestly unavailable. */
export function resolveDictationEngineFor(geminiKey: string | undefined): DictationStatus & { key: string | null } {
	if (geminiKey) return { available: true, engine: "gemini", reason: "dictation engine: gemini", key: geminiKey };
	return { available: false, engine: null, reason: "no dictation engine — set a Gemini (Google) model key", key: null };
}

/** The live engine + its key + the language pin (null = automatic). Read
 *  fresh per call — a key or setting saved mid-session applies to the
 *  next run. */
export function resolveDictation(): DictationStatus & { key: string | null; language: string | null } {
	const prefs = effectiveSettings().agent.dictation ?? {};
	return { ...resolveDictationEngineFor(keyValue("GEMINI_API_KEY")), language: prefs.language ?? null };
}

/** The honest status (no key) — the settings row's reason line. */
export function dictationStatus(): DictationStatus {
	const { available, engine, reason } = resolveDictation();
	return { available, engine, reason };
}

/** Wrap raw linear16 mono PCM in a 44-byte RIFF/WAVE header — the
 *  container Gemini's audio input documents (audio/wav). */
export function pcmToWav(pcm: Uint8Array, sampleRate: number = DICTATION_SAMPLE_RATE): Uint8Array {
	const out = new Uint8Array(44 + pcm.byteLength);
	const view = new DataView(out.buffer);
	const ascii = (offset: number, text: string) => {
		for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
	};
	ascii(0, "RIFF");
	view.setUint32(4, 36 + pcm.byteLength, true);
	ascii(8, "WAVE");
	ascii(12, "fmt ");
	view.setUint32(16, 16, true); // fmt chunk size
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	ascii(36, "data");
	view.setUint32(40, pcm.byteLength, true);
	out.set(pcm, 44);
	return out;
}

/** The transcription instruction. Verbatim, no commentary — the text goes
 *  straight into the learner's answer field. */
export function transcribePrompt(language: string | null): string {
	const label = dictationLanguageLabel(language);
	return [
		`Transcribe this recording verbatim${label ? `; the speaker talks ${label}` : ""}.`,
		"Add normal punctuation and capitalization. Do not translate, summarize, or answer anything said.",
		"Output only the transcript text — no preamble, labels, timestamps, or quotes.",
		"If there is no speech, output nothing.",
	].join(" ");
}

/** Gemini batch transcription: POST …/models/{model}:generateContent with
 *  the WAV inline (base64) next to the instruction. Throws a readable
 *  Error on failure (the route maps it to a 502 the dictation bar shows). */
export async function geminiTranscribe(
	apiKey: string,
	pcm: Uint8Array,
	language: string | null,
	fetchFn: FetchLike = fetch,
): Promise<string> {
	const wav = pcmToWav(pcm);
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiToolModel()}:generateContent`;
	const resp = await fetchFn(url, {
		method: "POST",
		headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
		body: JSON.stringify({
			contents: [
				{
					role: "user",
					parts: [
						{ text: transcribePrompt(language) },
						{ inline_data: { mime_type: "audio/wav", data: Buffer.from(wav).toString("base64") } },
					],
				},
			],
			generationConfig: { temperature: 0 },
		}),
		signal: AbortSignal.timeout(90_000),
	});
	if (!resp.ok) throw new Error(await geminiErrorMessage(resp, "transcription"));
	const data = (await resp.json()) as {
		candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
	};
	const parts = data.candidates?.[0]?.content?.parts ?? [];
	return parts
		.filter((p) => !p.thought && typeof p.text === "string")
		.map((p) => p.text)
		.join("")
		.trim();
}
