import { startReviewSession, startTopicsSession } from "@/src/server";

/** Open a spaced-repetition review session on the current queue (the
 *  weakest due topics, capped per session). 409 when nothing is due —
 *  the button only shows when something is, so this is the race.
 *  With `{ keys, title?, limit? }` (a study-plan step from Today), the
 *  session reviews those topics instead, due or not; 409 when none of
 *  them is tracked any more. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { keys?: unknown; title?: unknown; limit?: unknown };
	const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : null;
	if (keys) {
		const title = typeof body.title === "string" ? body.title : undefined;
		const limit = typeof body.limit === "number" && body.limit >= 1 ? Math.floor(body.limit) : undefined;
		const session = startTopicsSession(keys, title, limit);
		if (!session) return Response.json({ error: "None of those topics is tracked any more." }, { status: 409 });
		return Response.json(session);
	}
	const session = startReviewSession();
	if (!session) return Response.json({ error: "Nothing is due for review." }, { status: 409 });
	return Response.json(session);
}
