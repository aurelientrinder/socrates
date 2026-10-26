import { notesLibrary } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/notes — every saved notes file (the Notes page's list). */
export async function GET() {
	return Response.json({ notes: notesLibrary.list() });
}
