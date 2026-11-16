import { deleteSheet, getSheet } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/cheatsheets/[id] — the sheet, its marks read from today's answers. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	const sheet = getSheet(id);
	if (!sheet) return Response.json({ error: "Cheat sheet not found." }, { status: 404 });
	return Response.json(sheet);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!deleteSheet(id)) return Response.json({ error: "Cheat sheet not found." }, { status: 404 });
	return Response.json({ ok: true });
}
