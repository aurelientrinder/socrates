import { markStepStarted } from "@/src/server";

export const dynamic = "force-dynamic";

/** A plan step was started: { id, chatId }. Today ticks it off once that
 *  session has had its time. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { id?: unknown; chatId?: unknown };
	if (typeof body.id !== "string" || typeof body.chatId !== "string") {
		return Response.json({ error: "Body must be { id, chatId }" }, { status: 400 });
	}
	markStepStarted(body.id, body.chatId);
	return Response.json({ ok: true });
}
