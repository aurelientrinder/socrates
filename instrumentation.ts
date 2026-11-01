/**
 * Server start hook (Next's instrumentation register, called once per server).
 * The watched notes folder (src/server/notes-folder.ts) starts here, so a
 * class set to automatic picks up new notes even when the Library page is
 * never opened. Deferred and never awaited: it must not slow the first page.
 */
export function register() {
	if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NODE_ENV === "test") return;
	const timer = setTimeout(() => {
		import("./src/server/notes-folder.ts")
			.then((m) => m.ensureNotesFolder())
			.catch((err) => console.error("[notes-folder] could not start:", err));
	}, 4_000);
	timer.unref?.();
}
