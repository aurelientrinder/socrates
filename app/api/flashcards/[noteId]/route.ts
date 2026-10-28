import { deleteFlashcardDeck, flashcardDeck, flashcardRun, FlashcardError, startFlashcards } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ noteId: string }> };

/** GET /api/flashcards/[noteId] — the note's deck (every card with its
 *  schedule; null before the first run) and its current or last run. */
export async function GET(_req: Request, { params }: Params) {
	const { noteId } = await params;
	return Response.json({ deck: flashcardDeck(noteId), run: flashcardRun(noteId) });
}

/** POST /api/flashcards/[noteId] — make cards from the saved note (a
 *  background run; poll GET for progress). */
export async function POST(_req: Request, { params }: Params) {
	const { noteId } = await params;
	try {
		return Response.json({ run: startFlashcards(noteId) }, { status: 202 });
	} catch (err) {
		if (err instanceof FlashcardError) return Response.json({ error: err.message }, { status: 422 });
		return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
	}
}

/** DELETE /api/flashcards/[noteId] — remove the deck and its history. */
export async function DELETE(_req: Request, { params }: Params) {
	const { noteId } = await params;
	if (!deleteFlashcardDeck(noteId)) return Response.json({ error: "No cards for this note." }, { status: 404 });
	return Response.json({ ok: true });
}
