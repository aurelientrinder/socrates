import { deleteFlashcard, editFlashcard, FlashcardError } from "@/src/server";

type Params = { params: Promise<{ noteId: string; cardId: string }> };

/** PATCH /api/flashcards/[noteId]/cards/[cardId] — fix a card's wording
 *  ({front?, back?}); its review history stays. */
export async function PATCH(req: Request, { params }: Params) {
	const { noteId, cardId } = await params;
	let body: { front?: unknown; back?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const change = {
		...(typeof body.front === "string" ? { front: body.front } : {}),
		...(typeof body.back === "string" ? { back: body.back } : {}),
	};
	try {
		if (!editFlashcard(noteId, cardId, change)) return Response.json({ error: "Card not found." }, { status: 404 });
	} catch (err) {
		if (err instanceof FlashcardError) return Response.json({ error: err.message }, { status: 422 });
		throw err;
	}
	return Response.json({ ok: true });
}

/** DELETE /api/flashcards/[noteId]/cards/[cardId] — drop a wrong or useless card. */
export async function DELETE(_req: Request, { params }: Params) {
	const { noteId, cardId } = await params;
	if (!deleteFlashcard(noteId, cardId)) return Response.json({ error: "Card not found." }, { status: 404 });
	return Response.json({ ok: true });
}
