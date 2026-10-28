import { cancelFlashcards } from "@/src/server";

/** POST /api/flashcards/[noteId]/cancel — stop a running card run. */
export async function POST(_req: Request, { params }: { params: Promise<{ noteId: string }> }) {
	const { noteId } = await params;
	return Response.json({ ok: cancelFlashcards(noteId) });
}
