import { startReviewSession } from "@/src/server";

/** Open a spaced-repetition review session on the current queue (the
 *  weakest due topics, capped per session). 409 when nothing is due —
 *  the button only shows when something is, so this is the race. */
export async function POST() {
	const session = startReviewSession();
	if (!session) return Response.json({ error: "Nothing is due for review." }, { status: 409 });
	return Response.json(session);
}
