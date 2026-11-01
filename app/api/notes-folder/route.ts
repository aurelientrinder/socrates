import { ensureNotesFolder, NotesFolderError, notesFolderState, setUpFolder, stopWatching, type FolderChoice } from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * The watched notes folder (src/server/notes-folder.ts).
 *   GET    — the folder, each class folder's files and their status
 *   PUT    — save the set-up window: { root, folders: { name: FolderChoice } }
 *   DELETE — stop watching (what was read stays known: nothing is read twice later)
 */
export async function GET() {
	ensureNotesFolder();
	return Response.json(notesFolderState());
}

export async function PUT(req: Request) {
	const body = (await req.json().catch(() => ({}))) as { root?: unknown; folders?: Record<string, FolderChoice> };
	try {
		return Response.json(await setUpFolder({ root: body.root, folders: body.folders ?? {} }));
	} catch (err) {
		if (err instanceof NotesFolderError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}

export async function DELETE() {
	return Response.json(stopWatching());
}
