import { notesLibrary } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/notes/[id] — one saved note with its plain text. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const note = notesLibrary.get(id);
	const text = note ? notesLibrary.text(id) : null;
	if (!note || text === null) return Response.json({ error: "Note not found." }, { status: 404 });
	return Response.json({ note, text });
}

/** DELETE /api/notes/[id] — remove the saved copy. What the map already
 *  learned from it stays (graph nodes are deleted from the graph view). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!notesLibrary.remove(id)) return Response.json({ error: "Note not found." }, { status: 404 });
	return Response.json({ ok: true });
}
