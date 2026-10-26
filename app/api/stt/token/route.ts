/**
 * The dictation run's start: which engine, which language, and — for the
 * streaming Deepgram engine — a short-lived socket token.
 *
 * Deepgram (POST-less BYOK mint): the renderer never holds the real key.
 * The key lives server-side only (auth.json → process.env in the desktop
 * app; .env.local in dev — same seam as OPENROUTER_API_KEY). Mint a
 * short-lived access token (TTL 300s — a run can outlast the 30s
 * default), the renderer opens its WebSocket to Deepgram with it, and
 * audio flows renderer → Deepgram directly, never through this server.
 * The token is only checked at the WebSocket handshake, so long dictation
 * sessions survive the TTL fine (Deepgram docs).
 *
 * NOTE: the key needs ≥ Member permission in the Deepgram console to call
 * /auth/grant (their docs, token-based auth FAQ) — plain read/transcribe
 * keys return FORBIDDEN here.
 *
 * Gemini (2026-10-26): a batch engine — no token; the renderer records
 * and POSTs the audio to /api/stt/transcribe at stop.
 *
 * 503 = no engine keyed (the renderer's keyless line keys on it).
 */
import type { DictationSession } from "@/src/core";
import { resolveDictation } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const { engine, key, language, reason } = resolveDictation();
	if (!engine || !key) return Response.json({ message: reason }, { status: 503 });
	if (engine === "gemini") return Response.json({ engine, language } satisfies DictationSession);

	try {
		const res = await fetch("https://api.deepgram.com/v1/auth/grant", {
			method: "POST",
			headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ ttl_seconds: 300 }),
		});
		if (!res.ok) {
			const detail = await res.text();
			return Response.json(
				{ message: `Deepgram token grant failed (${res.status}): ${detail.slice(0, 200)}` },
				{ status: 502 },
			);
		}
		const data = (await res.json()) as { access_token?: string };
		if (!data.access_token) {
			return Response.json({ message: "Deepgram grant returned no token" }, { status: 502 });
		}
		return Response.json({ engine, language, token: data.access_token } satisfies DictationSession);
	} catch {
		return Response.json({ message: "Deepgram unreachable" }, { status: 502 });
	}
}
