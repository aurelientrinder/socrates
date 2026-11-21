import { getChat, stores } from "@/src/server";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });
	const body = (await req.json().catch(() => null)) as { nodeId?: unknown; note?: unknown } | null;
	if (typeof body?.nodeId !== "string" || body.nodeId.trim() === "") {
		return Response.json({ error: "nodeId must be a non-empty string" }, { status: 400 });
	}
	if (typeof body.note !== "string") {
		return Response.json({ error: "note must be a string" }, { status: 400 });
	}
	const sectionNotes = stores.chatStore.saveSectionNote?.(id, body.nodeId.trim(), body.note) ?? {};
	return Response.json({ sectionNotes });
}
