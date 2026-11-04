// POST /api/chats/[id]/aside — a question for the tutor while a quiz
// question waits (2026-11-04). Answered at once by a one-shot call; the
// open question is untouched. 409 → no open question / a turn is running,
// and the client sends the message the ordinary way.
import { handleAside, parseAsideInput } from "@/src/server";

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const body = (await request.json().catch(() => null)) as { input?: unknown } | null;
	const input = parseAsideInput(body?.input);
	if (typeof input === "string") return Response.json({ error: input }, { status: 400 });
	return handleAside(id, input);
}
