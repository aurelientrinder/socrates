import {
	ensureNotesFolder,
	includeFile,
	keepEdits,
	NotesFolderError,
	previewFolder,
	requestProcessing,
	resumeNotesFolder,
	scanNotesFolder,
	notesFolderState,
	updateFolder,
} from "@/src/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/notes-folder/<action>:
 *   preview  { root }                          — the subfolders the set-up window lists
 *   folder   { name, course?, mode?, include?, watch?, exclude? } — change one class folder
 *   process  { keys } | { folder, all: true }, retry?, edited? — queue files
 *   keep     { key }                           — keep a notebook's edited pages as they were
 *   include  { key }                           — list a skipped file
 *   resume   {}                                — try again now after a daily-limit pause
 *   rescan   {}                                — look at the folder now
 */
export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
	const { action } = await ctx.params;
	const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
	ensureNotesFolder();
	const key = typeof body.key === "string" ? body.key : "";
	try {
		switch (action) {
			case "preview":
				return Response.json(previewFolder(body.root));
			case "folder":
				if (typeof body.name !== "string") throw new NotesFolderError("Missing folder.");
				return Response.json(await updateFolder(body.name, body as Parameters<typeof updateFolder>[1]));
			case "process":
				return Response.json(await requestProcessing(body));
			case "keep":
				return Response.json(await keepEdits(key));
			case "include":
				return Response.json(await includeFile(key));
			case "resume":
				return Response.json(resumeNotesFolder());
			case "rescan":
				await scanNotesFolder();
				return Response.json(notesFolderState());
			default:
				return Response.json({ error: "Unknown action." }, { status: 404 });
		}
	} catch (err) {
		if (err instanceof NotesFolderError) return Response.json({ error: err.message }, { status: err.status });
		throw err;
	}
}
