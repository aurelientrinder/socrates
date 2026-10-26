import { extraction, notesLibrary } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/notes/[id]/reimport — run the saved text through extraction
 *  again (after a failed or partial import, or a model change). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const note = notesLibrary.get(id);
	const text = note ? notesLibrary.text(id) : null;
	if (!note || text === null) return Response.json({ error: "Note not found." }, { status: 404 });
	if (note.pages !== undefined && note.emptyPages?.length === note.pages) {
		return Response.json({ ok: false, error: "This PDF has no text (it looks scanned), so there is nothing to add to your map." }, { status: 422 });
	}
	try {
		const stats = await extraction.importNotes({ filePath: note.name, text });
		return Response.json({ ok: true, stats });
	} catch (err) {
		return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
}
