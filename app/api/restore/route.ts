import { listSnapshots, restoreExport, restoreSnapshot, RestoreError } from "@/src/server";

export const dynamic = "force-dynamic";

/** GET /api/restore — the snapshots a restore can use, newest first. */
export async function GET() {
	return Response.json({ snapshots: listSnapshots() });
}

/** POST /api/restore { snapshot } or { bundle } — replace the learner's data
 *  with a snapshot or with the contents of an export file. A copy of the
 *  current data is kept first (reported as safetyCopy). */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => null)) as { snapshot?: unknown; bundle?: unknown } | null;
	if (!body || (body.snapshot === undefined && body.bundle === undefined)) {
		return Response.json({ error: "Body must be { snapshot } or { bundle }." }, { status: 400 });
	}
	try {
		const result = body.bundle !== undefined ? restoreExport(body.bundle) : restoreSnapshot(body.snapshot);
		return Response.json({ ok: true, ...result });
	} catch (err) {
		if (err instanceof RestoreError) return Response.json({ error: err.message }, { status: err.status });
		return Response.json({ error: err instanceof Error ? err.message : "Restore failed." }, { status: 500 });
	}
}
