import { SyncError, configureSyncFolder, runFolderSync, syncStatus } from "@/src/server";

export const dynamic = "force-dynamic";

/** Sync status: configured folder, deviceId, lastSyncedAt, lastStats. */
export async function GET() {
	return Response.json(syncStatus());
}

/** Save (or clear) the local sync folder path (iCloud, Dropbox, Syncthing, etc.). */
export async function PUT(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { folder?: unknown };
	const folder = typeof body.folder === "string" ? body.folder : null;
	try {
		return Response.json(configureSyncFolder(folder));
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : "Could not save sync folder." }, { status: 400 });
	}
}

/** Run an authenticated two-way encrypted sync with the learner's passphrase. */
export async function POST(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { passphrase?: unknown; folder?: unknown };
	const passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
	const folder = typeof body.folder === "string" && body.folder.trim() ? body.folder : undefined;
	try {
		return Response.json(runFolderSync(passphrase, { folder }));
	} catch (err) {
		const status = err instanceof SyncError ? 400 : 500;
		return Response.json({ error: err instanceof Error ? err.message : "Sync failed." }, { status });
	}
}
