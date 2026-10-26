import fs from "node:fs";
import { notesLibrary } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/notes/[id]/file — the saved original, shown inline. The
 *  browser build opens it in a tab; the desktop app opens the file in
 *  the system's default app instead (electron "lh:notes:open"). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const note = notesLibrary.get(id);
	const file = notesLibrary.originalPath(id);
	if (!note || !file) return Response.json({ error: "Note not found." }, { status: 404 });
	return new Response(fs.readFileSync(file), {
		headers: {
			"Content-Type": note.kind === "pdf" ? "application/pdf" : "text/plain; charset=utf-8",
			"Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(note.name)}`,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}
