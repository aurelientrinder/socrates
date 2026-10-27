import { startDrillSession } from "@/src/server";

/** Open a weak-spot drill: a review session on the asked weak spots
 *  (body `{ keys: string[] }`), or on the worst few when no keys are
 *  given. 409 when none of them is a weak spot any more (the race with
 *  a session that fixed them since the page loaded). */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { keys?: unknown };
	const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : undefined;
	const session = startDrillSession(keys);
	if (!session) return Response.json({ error: "Those topics are not weak spots any more." }, { status: 409 });
	return Response.json(session);
}
