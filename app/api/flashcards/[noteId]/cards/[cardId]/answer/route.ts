import { answerFlashcard } from "@/src/server";
import { isCardVerdict } from "@/src/core";

/** POST /api/flashcards/[noteId]/cards/[cardId]/answer — record one answer
 *  ({verdict: "missed" | "partly" | "gotIt" | "dontKnow"}); returns the
 *  card with its new schedule. */
export async function POST(req: Request, { params }: { params: Promise<{ noteId: string; cardId: string }> }) {
	const { noteId, cardId } = await params;
	let body: { verdict?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	if (!isCardVerdict(body.verdict)) return Response.json({ error: "Unknown verdict." }, { status: 400 });
	const card = answerFlashcard(noteId, cardId, body.verdict);
	if (!card) return Response.json({ error: "Card not found." }, { status: 404 });
	return Response.json({ card });
}
