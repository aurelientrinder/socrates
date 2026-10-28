/**
 * GET /api/export — every session, the knowledge map, flashcards, mock
 * exams, course links and settings as one JSON download (no API keys, no
 * notes originals). The file is the data folder's own JSON, keyed by path.
 */
import { exportData } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const bundle = exportData();
	const stamp = bundle.exportedAt.slice(0, 10);
	return new Response(JSON.stringify(bundle), {
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Content-Disposition": `attachment; filename="socrates-export-${stamp}.json"`,
			"Cache-Control": "no-store",
		},
	});
}
