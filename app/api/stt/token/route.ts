/**
 * The dictation run's start: which engine and which language.
 *
 * Gemini is a batch engine — no token; the renderer records and POSTs the
 * audio to /api/stt/transcribe at stop. The key stays server-side.
 *
 * 503 = no engine keyed (the renderer's keyless line keys on it).
 */
import type { DictationSession } from "@/src/core";
import { resolveDictation } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const { engine, key, language, reason } = resolveDictation();
	if (!engine || !key) return Response.json({ message: reason }, { status: 503 });
	return Response.json({ engine, language } satisfies DictationSession);
}
