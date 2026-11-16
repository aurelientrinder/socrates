import { retrySheet, SheetError } from "@/src/server";

export const dynamic = "force-dynamic";

/** POST /api/cheatsheets/[id]/retry — write the sheet again after a failure. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	try {
		return Response.json(retrySheet(id));
	} catch (err) {
		if (err instanceof SheetError) return Response.json(err.body ?? { error: err.message }, { status: err.status });
		throw err;
	}
}
