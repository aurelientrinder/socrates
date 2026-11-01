"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronRightIcon, FileTextIcon, LayersIcon, SearchIcon } from "lucide-react";
import type { LensClass } from "@/src/core";
import { Button } from "@/components/ui/button";
import { MoreMenu } from "@/components/more-menu";
import { useClasses } from "@/components/use-class-colors";
import { cn } from "@/lib/utils";
import { NOTES_ACCEPT, NotesImportErrors, useNotesImport } from "@/components/notes-import.tsx";
import { useActivity } from "@/components/activity-dock";
import { SectionHeading } from "@/components/page-header";
import { NoteFlashcards } from "@/components/note-flashcards";

/** Fired when notes were saved from elsewhere on the page (a course's folder import). */
export const NOTES_CHANGED_EVENT = "lh:notes-changed";

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
 * text the app pulled out of it, run it through the map again, make
 * flashcards from it (note-flashcards.tsx), or remove the saved copy. The tutor searches the same files (the `notes` tool).
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
		// Course folders (components/courses-view.tsx) save notes too.
		window.addEventListener(NOTES_CHANGED_EVENT, load);
		return () => window.removeEventListener(NOTES_CHANGED_EVENT, load);
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

	const classes = useClasses();
	const [query, setQuery] = useState("");
	const [classKey, setClassKey] = useState<string | null>(null);
	const classOf = useCallback((id: string) => classes.find((c) => c.sessions.includes(id)) ?? null, [classes]);
	const shown = useMemo(() => {
		if (!notes) return null;
		const q = query.trim().toLowerCase();
		return notes.filter((n) => (!classKey || classOf(n.id)?.key === classKey) && (!q || n.name.toLowerCase().includes(q)));
	}, [notes, query, classKey, classOf]);
	const usedClasses = classes.filter((c) => notes?.some((n) => c.sessions.includes(n.id)));

	return (
		<section data-testid="notes-view" aria-labelledby="notes-heading" className="flex flex-col gap-4">
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
			<header className="flex items-end justify-between gap-4">
				<div className="min-w-0">
					<SectionHeading className="flex items-baseline gap-2">
						<span id="notes-heading">All notes</span>
						<span className="text-sm font-normal text-muted-foreground">{headline(notes)}</span>
					</SectionHeading>
					<p className="mt-1 text-sm text-muted-foreground">Every file you imported. The tutor reads them during sessions; their ideas are on your map.</p>
				</div>
				<Button data-testid="notes-import" size="sm" variant="outline" disabled={notesImport.importing} onClick={() => fileInputRef.current?.click()}>
					{notesImport.importing ? "Importing…" : "Import notes…"}
				</Button>
			</header>
			<NotesImportErrors errors={notesImport.errors} warnings={notesImport.warnings} />

			{notes && notes.length > 0 && (
				<div className="flex flex-wrap items-center gap-2">
					<label className="relative flex items-center">
						<span className="sr-only">Search notes</span>
						<SearchIcon className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search notes"
							className="h-8 w-48 rounded-lg border bg-surface pl-8 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
						/>
					</label>
					{usedClasses.length > 0 && <ClassChips classes={usedClasses} value={classKey} onChange={setClassKey} />}
				</div>
			)}

			{loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
			{notes && notes.length === 0 && (
				<p className="rounded-2xl border border-dashed px-5 py-6 text-center text-sm text-muted-foreground">
					No notes yet. Import PDFs, .txt or .md files, or add them to a class above.
				</p>
			)}
			{shown && shown.length === 0 && notes && notes.length > 0 && <p className="text-sm text-muted-foreground">No notes match.</p>}
			{shown && shown.length > 0 && (
				<ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-surface">
					{shown.map((note) => (
						<NoteRow key={note.id} note={note} cls={classOf(note.id)} onChanged={load} />
					))}
				</ul>
			)}
		</section>
	);
}

/** "All classes" + one chip per class, coloured like the calendar. */
export function ClassChips({ classes, value, onChange }: { classes: LensClass[]; value: string | null; onChange: (key: string | null) => void }) {
	const chip = (active: boolean) =>
		cn("flex h-8 items-center gap-1.5 rounded-full px-3 text-sm transition-colors", active ? "bg-foreground font-medium text-background" : "bg-accent/70 text-muted-foreground hover:text-foreground");
	return (
		<div role="group" aria-label="Filter by class" className="flex flex-wrap gap-1.5">
			<button type="button" aria-pressed={value === null} onClick={() => onChange(null)} className={chip(value === null)}>
				All classes
			</button>
			{classes.map((c) => (
				<button key={c.key} type="button" aria-pressed={value === c.key} onClick={() => onChange(value === c.key ? null : c.key)} className={cn(`cal-c${c.color}`, chip(value === c.key))}>
					<span className="size-2 rounded-full" style={{ background: "var(--bar)" }} />
					{c.label}
				</button>
			))}
		</div>
	);
}

function headline(notes: SavedNote[] | null): string {
	if (notes === null) return "";
	if (notes.length === 0) return "none yet";
	return String(notes.length);
}

/** "Analyse › Chapitre 1.pdf" → the file part, when the class says the rest. */
function fileName(name: string, cls: LensClass | null): string {
	const parts = name.split(" › ");
	return cls && parts.length > 1 && parts[0]!.toLowerCase() === cls.label.toLowerCase() ? parts.slice(1).join(" › ") : name;
}

function NoteRow({ note, cls, onChanged }: { note: SavedNote; cls: LensClass | null; onChanged: () => Promise<void> }) {
	const [text, setText] = useState<string | null>(null);
	const [open, setOpen] = useState<null | "text" | "cards">(null);
	const [busy, setBusy] = useState<null | "reimport" | "delete">(null);
	const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
	const scannedAll = note.pages !== undefined && note.emptyPages?.length === note.pages;

	const showText = async () => {
		if (open === "text") return setOpen(null);
		setOpen("text");
		if (text !== null) return;
		try {
			const res = await fetch(`/api/notes/${note.id}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setText(((await res.json()) as { text: string }).text);
		} catch (err) {
			setMessage({ tone: "error", text: `Couldn't load the text (${err instanceof Error ? err.message : String(err)}).` });
			setOpen(null);
		}
	};

	const openFile = async () => {
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
		<li data-testid="note-row" className="flex flex-col">
			<div className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/30">
				<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
					<FileTextIcon className="size-4" />
				</span>
				<button type="button" onClick={() => void openFile()} className="min-w-0 flex-1 text-left" title="Open the file">
					<p className="truncate text-[15px]">{fileName(note.name, cls)}</p>
					<p className="truncate text-xs text-muted-foreground">{details(note)}</p>
				</button>
				{cls && (
					<span className={cn(`cal-c${cls.color}`, "hidden shrink-0 items-center gap-1.5 rounded-full bg-accent/70 px-2.5 py-0.5 text-xs text-muted-foreground sm:flex")}>
						<span className="size-1.5 rounded-full" style={{ background: "var(--bar)" }} />
						{cls.label}
					</span>
				)}
				<Button size="xs" variant="ghost" disabled={scannedAll} onClick={() => setOpen(open === "cards" ? null : "cards")} aria-expanded={open === "cards"}>
					<LayersIcon className="size-3.5" />
					Flashcards
				</Button>
				<MoreMenu
					label={`More for ${note.name}`}
					items={[
						{ label: "Open the file", onSelect: () => void openFile() },
						{ label: open === "text" ? "Hide the text" : "Show the text", onSelect: () => void showText() },
						{ label: busy === "reimport" ? "Re-importing…" : "Add to my map again", onSelect: () => void reimport(), disabled: busy !== null || scannedAll },
						{ label: "Remove", onSelect: () => void remove(), danger: true, divider: true, disabled: busy !== null },
					]}
				/>
			</div>
			{message && (
				<p role={message.tone === "error" ? "alert" : "status"} className={cn("px-4 pb-2 pl-15 text-xs", message.tone === "error" ? "text-destructive" : "text-good-ink")}>
					{message.text}
				</p>
			)}
			{open === "cards" && (
				<div className="px-4 pb-3 pl-15">
					<NoteFlashcards noteId={note.id} disabled={scannedAll} />
				</div>
			)}
			{open === "text" && (
				<div className="px-4 pb-3 pl-15">
					<button type="button" onClick={() => setOpen(null)} className="mb-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
						<ChevronRightIcon className="size-3 rotate-90" />
						Text
					</button>
					<pre data-testid="note-text" className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 text-xs">
						{text ?? "Loading…"}
					</pre>
				</div>
			)}
		</li>
	);
}

function details(note: SavedNote): string {
	const parts = [note.kind === "pdf" ? `PDF · ${note.pages} ${note.pages === 1 ? "page" : "pages"}` : "Text"];
	if (note.emptyPages?.length) {
		parts.push(note.emptyPages.length === note.pages ? "scanned, no text" : `${note.emptyPages.length} scanned ${note.emptyPages.length === 1 ? "page" : "pages"}`);
	}
	parts.push(new Date(note.importedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }));
	return parts.join(" · ");
}
