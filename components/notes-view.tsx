"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { NOTES_ACCEPT, NotesImportErrors, useNotesImport } from "@/components/notes-import.tsx";
import { useActivity } from "@/components/activity-dock";

/** Transport-only mirror of src/store/notes.ts NoteMeta. */
export interface SavedNote {
	id: string;
	name: string;
	kind: "pdf" | "text";
	importedAt: string;
	bytes: number;
	pages?: number;
	emptyPages?: number[];
}

/**
 * THE NOTES PAGE: every file the learner imported, kept by the app (the
 * notes library, data/notes). Import more, open the original, read the
 * text the app pulled out of it, run it through the map again, or remove
 * the saved copy. The tutor searches the same files (the `notes` tool).
 */
export function NotesView() {
	const [notes, setNotes] = useState<SavedNote[] | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const refreshActivity = useActivity().refresh;

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/notes");
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setNotes(((await res.json()) as { notes: SavedNote[] }).notes);
			setLoadError(null);
		} catch (err) {
			setLoadError(`Couldn't load your notes (${err instanceof Error ? err.message : String(err)}).`);
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	// The import POST waits for the whole extraction; the file itself is
	// saved first, so the list can show it while the map is still filling.
	const notesImport = useNotesImport({
		onStart: () => {
			refreshActivity();
			setTimeout(() => {
				refreshActivity();
				void load();
			}, 1500);
		},
		onFinish: () => void load(),
	});

	return (
		<div data-testid="notes-view" className="h-full overflow-y-auto">
			<input
				ref={fileInputRef}
				type="file"
				multiple
				accept={NOTES_ACCEPT}
				className="hidden"
				onChange={(e) => {
					notesImport.onImportFiles(e.target.files);
					e.target.value = "";
				}}
			/>
			<div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-10">
				<header className="flex flex-col gap-2">
					<h1 className="text-xs uppercase tracking-widest text-muted-foreground/70">Notes</h1>
					<div className="flex items-center justify-between gap-4">
						<p className="text-lg">{headline(notes)}</p>
						<Button
							data-testid="notes-import"
							size="sm"
							disabled={notesImport.importing}
							onClick={() => fileInputRef.current?.click()}
						>
							{notesImport.importing ? "Importing…" : "Import notes…"}
						</Button>
					</div>
					<p className="text-sm text-muted-foreground">
						PDFs, .txt and .md files. The app keeps a copy of each file, adds its ideas to your map, and the tutor can
						check what your notes actually say during a session. Scanned pages have no text: the tutor can still read
						them, but they don&apos;t reach the map.
					</p>
					<NotesImportErrors errors={notesImport.errors} warnings={notesImport.warnings} />
				</header>

				{loadError && <p role="alert" className="text-sm text-red-400">{loadError}</p>}
				{notes && notes.length > 0 && (
					<ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
						{notes.map((note) => (
							<NoteRow key={note.id} note={note} onChanged={load} />
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

function headline(notes: SavedNote[] | null): string {
	if (notes === null) return "Loading your notes…";
	if (notes.length === 0) return "No saved notes yet.";
	return `${notes.length} saved ${notes.length === 1 ? "file" : "files"}.`;
}

function NoteRow({ note, onChanged }: { note: SavedNote; onChanged: () => Promise<void> }) {
	const [text, setText] = useState<string | null>(null);
	const [showText, setShowText] = useState(false);
	const [busy, setBusy] = useState<null | "reimport" | "delete">(null);
	const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
	const scannedAll = note.pages !== undefined && note.emptyPages?.length === note.pages;

	const toggleText = async () => {
		if (showText) return setShowText(false);
		setShowText(true);
		if (text !== null) return;
		try {
			const res = await fetch(`/api/notes/${note.id}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setText(((await res.json()) as { text: string }).text);
		} catch (err) {
			setMessage({ tone: "error", text: `Couldn't load the text (${err instanceof Error ? err.message : String(err)}).` });
			setShowText(false);
		}
	};

	const open = async () => {
		setMessage(null);
		if (window.lh?.openNote) {
			const result = await window.lh.openNote(note.id);
			if (!result.ok) setMessage({ tone: "error", text: result.error ?? "Couldn't open the file." });
			return;
		}
		window.open(`/api/notes/${note.id}/file`, "_blank", "noopener");
	};

	const reimport = async () => {
		setBusy("reimport");
		setMessage(null);
		try {
			const res = await fetch(`/api/notes/${note.id}/reimport`, { method: "POST" });
			const body = (await res.json()) as { ok?: boolean; error?: string; stats?: { nodes: number } };
			setMessage(body.ok
				? { tone: "ok", text: `Added to your map again (${body.stats?.nodes ?? 0} ideas found).` }
				: { tone: "error", text: body.error ?? `Re-import failed (HTTP ${res.status}).` });
		} catch (err) {
			setMessage({ tone: "error", text: `Re-import failed (${err instanceof Error ? err.message : String(err)}).` });
		} finally {
			setBusy(null);
		}
	};

	const remove = async () => {
		if (!window.confirm(`Remove "${note.name}" from your saved notes? What you've already learned from it stays in your map.`)) return;
		setBusy("delete");
		try {
			const res = await fetch(`/api/notes/${note.id}`, { method: "DELETE" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			await onChanged();
		} catch (err) {
			setMessage({ tone: "error", text: `Couldn't remove it (${err instanceof Error ? err.message : String(err)}).` });
			setBusy(null);
		}
	};

	return (
		<li data-testid="note-row" className="flex flex-col gap-2 px-3 py-2">
			<div className="flex items-center gap-3">
				<div className="min-w-0 flex-1">
					<p className="truncate text-sm">{note.name}</p>
					<p className="truncate text-xs text-muted-foreground">{details(note)}</p>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Button size="xs" variant="ghost" onClick={() => void open()}>Open</Button>
					<Button size="xs" variant="ghost" onClick={() => void toggleText()}>{showText ? "Hide text" : "Text"}</Button>
					<Button size="xs" variant="ghost" disabled={busy !== null || scannedAll} onClick={() => void reimport()}>
						{busy === "reimport" ? "Importing…" : "Re-import"}
					</Button>
					<Button size="xs" variant="ghost" disabled={busy !== null} onClick={() => void remove()}>
						{busy === "delete" ? "Removing…" : "Remove"}
					</Button>
				</div>
			</div>
			{message && (
				<p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-xs text-red-400" : "text-xs text-emerald-500"}>
					{message.text}
				</p>
			)}
			{showText && (
				<pre data-testid="note-text" className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 text-xs">
					{text ?? "Loading…"}
				</pre>
			)}
		</li>
	);
}

function details(note: SavedNote): string {
	const parts = [note.kind === "pdf" ? `PDF · ${note.pages} ${note.pages === 1 ? "page" : "pages"}` : "Text"];
	if (note.emptyPages?.length) {
		parts.push(note.emptyPages.length === note.pages ? "scanned, no text" : `${note.emptyPages.length} scanned ${note.emptyPages.length === 1 ? "page" : "pages"}`);
	}
	parts.push(`imported ${new Date(note.importedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`);
	return parts.join(" · ");
}
