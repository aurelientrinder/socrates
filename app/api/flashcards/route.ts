import { flashcardDeckSummaries, flashcardQueue } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/flashcards[?deck=<noteId>] — every deck's counts, and the next
 *  round of cards (across all decks, or the one deck). */
export async function GET(req: Request) {
	const deck = new URL(req.url).searchParams.get("deck") ?? undefined;
	return Response.json({ decks: flashcardDeckSummaries(), queue: flashcardQueue({ noteId: deck }) });
}
