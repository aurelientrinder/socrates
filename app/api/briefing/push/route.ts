import { addItemToTodo, blockItemTime } from "@/src/server";

export const dynamic = "force-dynamic";

/** Push one briefing item out, only ever from a click:
 *  { id, target: "todo" } adds a task; { id, target: "calendar" } blocks time. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { id?: unknown; target?: unknown };
	if (typeof body.id !== "string" || (body.target !== "todo" && body.target !== "calendar")) {
		return Response.json({ error: 'Body must be { id, target: "todo" | "calendar" }' }, { status: 400 });
	}
	try {
		const result = body.target === "todo" ? await addItemToTodo(body.id) : await blockItemTime(body.id);
		return Response.json(result);
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Push failed." }, { status: 502 });
	}
}
