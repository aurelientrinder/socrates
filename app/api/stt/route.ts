/**
 * GET /api/stt — the dictation engines' status (2026-10-26): the settings
 * row's reason line. { available, engine, reason } — never a key.
 */

import { dictationStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(dictationStatus());
}
