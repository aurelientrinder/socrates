import { listSheets, SheetError, startSheet } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/cheatsheets — every cheat sheet, newest first (the Library list). */
export async function GET() {
	return Response.json({ sheets: listSheets() });
}

/** POST /api/cheatsheets {scope, focus, noteIds} — start writing a cheat
 *  sheet in the background. 503 when no model can run it. */
export async function POST(req: Request) {
	let body: Record<string, unknown>;
	try {
		body = (await req.json()) as Record<string, unknown>;
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	try {
		return Response.json(startSheet(body));
	} catch (err) {
		if (err instanceof SheetError) return Response.json(err.body ?? { error: err.message }, { status: err.status });
		throw err;
	}
}
