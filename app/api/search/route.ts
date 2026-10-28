/**
 * GET /api/search — the search engines' status (search wave, 2026-09-20):
 * the honest availability signal the settings UI explains from (the
 * gray-out affordance) and any client surface can read.
 *
 * { available, engine, reason } — never a key, never a secret: `engine` is
 * Gemini when live, and `reason` is the one-line state explanation
 * ("set a Gemini (Google) model key").
 */

import { searchStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(searchStatus());
}
