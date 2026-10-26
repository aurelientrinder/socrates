/**
 * POST /api/stt/transcribe — the batch dictation engine (Gemini,
 * 2026-10-26). Body: the run's raw linear16 16kHz mono PCM
 * (application/octet-stream), exactly what pcm-capture.js produced.
 * Answers {text}. The key and the language pin are read server-side.
 */
import { BATCH_DICTATION_MAX_SECONDS } from "@/src/core";
import { DICTATION_SAMPLE_RATE, geminiTranscribe, resolveDictation } from "@/src/server";

export const dynamic = "force-dynamic";

/** A little headroom over the renderer's own cap (it stops the run there). */
const MAX_BYTES = (BATCH_DICTATION_MAX_SECONDS + 10) * DICTATION_SAMPLE_RATE * 2;

export async function POST(request: Request) {
	const { engine, key, language, reason } = resolveDictation();
	if (!engine || !key) return Response.json({ message: reason }, { status: 503 });
	if (engine !== "gemini") {
		return Response.json({ message: `${engine} dictation streams — it has no batch transcription` }, { status: 409 });
	}
	const pcm = new Uint8Array(await request.arrayBuffer());
	if (pcm.byteLength === 0) return Response.json({ text: "" });
	if (pcm.byteLength > MAX_BYTES) {
		return Response.json({ message: "Recording too long to transcribe in one go" }, { status: 413 });
	}
	try {
		return Response.json({ text: await geminiTranscribe(key, pcm, language) });
	} catch (e) {
		return Response.json({ message: e instanceof Error ? e.message : "Gemini unreachable" }, { status: 502 });
	}
}
