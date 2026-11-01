"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarIcon, CheckIcon, FileTextIcon, PlusIcon, XIcon } from "lucide-react";
import { colorsFor, courseNotesLine, folderNoteName, isNotesFile, type CourseSuggestion } from "@/src/core";
import { FolderBar, FolderInbox, UnlinkedFolderCard, useNotesFolder, type FolderAct, type FolderView } from "@/components/notes-folder";
import { MoreMenu } from "@/components/more-menu";
import { MAX_NOTE_BYTES, NOTES_ACCEPT, NotesImportErrors, postNotesImport } from "@/components/notes-import.tsx";
import { startDraftSession } from "@/components/new-session";
import { SectionHeading } from "@/components/page-header";
import { useStartDialog } from "@/components/start-dialog";
import { useActivity } from "@/components/activity-dock";
import { NOTES_CHANGED_EVENT } from "@/components/notes-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/** Transport-only mirror of src/server/courses.ts CourseView. */
export interface CourseData {
	key: string;
	label: string;
	notes: { id: string; name: string; kind: "pdf" | "text"; pages?: number }[];
	chatIds?: string[];
	aliases: string[];
	next: { title: string; start: number; kind: string } | null;
}

interface CoursesPayload {
	courses: CourseData[];
	suggestions: CourseSuggestion[];
}

interface SavedNote {
	id: string;
	name: string;
}

/** Files per import request: progress shows between batches, one bad file cannot sink a folder. */
const BATCH = 4;

/**
 * Files of a dropped or picked folder that the notes import takes, each
 * named by its path inside the folder ("Analyse › Chapitre 1.pdf") so two
 * courses' same-named files stay two notes. Hidden files and other types
 * are left out and counted.
 */
export function folderFiles(picked: readonly File[]): { files: File[]; skipped: number } {
	const files: File[] = [];
	let skipped = 0;
	for (const file of picked) {
		const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
		if (!isNotesFile(path)) {
			skipped++;
			continue;
		}
		files.push(new File([file], folderNoteName(path), { type: file.type, lastModified: file.lastModified }));
	}
	return { files, skipped };
}

async function api(url: string, method: string, body?: unknown): Promise<CoursesPayload> {
	const res = await fetch(url, {
		method,
		...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = (await res.json().catch(() => ({}))) as Partial<CoursesPayload> & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
	return { courses: data.courses ?? [], suggestions: data.suggestions ?? [] };
}

const when = (ms: number) =>
	new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

/** "Analyse › Chapitre 1.pdf" inside the Analyse card reads "Chapitre 1.pdf". */
export function shortNoteName(name: string, label: string): string {
	const parts = name.split(" › ");
	return parts.length > 1 && parts[0]!.toLowerCase() === label.toLowerCase() ? parts.slice(1).join(" › ") : name;
}

/** Notes shown on a card before "+N more". */
const NOTES_SHOWN = 6;

/**
 * CLASSES (Library, redesign 2026-11-01): one card per class, the hub for
 * everything of that class: its next class in the calendar, the files its
 * watched folder is bringing in (components/notes-folder.tsx), its notes,
 * and what to do with them (study, mock exam). Notes also come in by
 * dropping a folder on a card, picking files, or from notes already saved.
 * The calendar suggests the classes not made yet (plain rules over the
 * event titles; you confirm, rename or dismiss each).
 */
export function CoursesView() {
	const [data, setData] = useState<CoursesPayload | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");
	const nf = useNotesFolder();

	const load = useCallback(async () => {
		try {
			setData(await api("/api/courses", "GET"));
			setError(null);
		} catch (err) {
			setError(`Couldn't load your classes (${err instanceof Error ? err.message : String(err)}).`);
		}
	}, []);
	useEffect(() => {
		void load();
		window.addEventListener(NOTES_CHANGED_EVENT, load);
		return () => window.removeEventListener(NOTES_CHANGED_EVENT, load);
	}, [load]);

	const run = async (job: () => Promise<CoursesPayload>) => {
		try {
			setData(await job());
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const create = (label: string, key?: string) =>
		run(async () => {
			const next = await api("/api/courses", "POST", { label, ...(key ? { key } : {}) });
			setCreating(false);
			setName("");
			return next;
		});

	const courses = data?.courses ?? [];
	const suggestions = data?.suggestions ?? [];
	const colors = useMemo(() => colorsFor(courses.map((c) => c.key)), [courses]);
	const unlinked = nf.unlinked(new Set(courses.map((c) => c.key)));

	return (
		<section data-testid="courses-view" aria-labelledby="courses-heading" className="flex flex-col gap-4">
			<header className="flex items-end justify-between gap-4">
				<div className="min-w-0">
					<SectionHeading className="flex items-baseline gap-2">
						<span id="courses-heading">Classes</span>
						<span className="text-sm font-normal text-muted-foreground">{data === null ? "" : courses.length || "none yet"}</span>
					</SectionHeading>
					<p className="mt-1 text-sm text-muted-foreground">Each class gathers its notes, its folder and its sessions. The study plan uses them before each class.</p>
				</div>
				<Button size="sm" variant="outline" data-testid="course-new" onClick={() => setCreating((v) => !v)}>
					<PlusIcon className="size-3.5" />
					New class
				</Button>
			</header>
			{creating && (
				<form
					className="flex max-w-md items-center gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						if (name.trim()) void create(name);
					}}
				>
					<Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Class name, e.g. Linear algebra" data-testid="course-name" />
					<Button type="submit" size="sm" disabled={!name.trim()}>
						Create
					</Button>
					<Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
						Cancel
					</Button>
				</form>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}

			<FolderBar nf={nf} />

			{suggestions.length > 0 && (
				<div data-testid="course-suggestions" className="flex flex-col rounded-2xl border border-border/70 bg-surface px-5 py-3">
					<div className="flex items-center gap-2 pb-1">
						<CalendarIcon className="size-4 text-muted-foreground" />
						<h3 className="text-sm font-semibold">From your calendar</h3>
						<span className="text-xs text-muted-foreground">These look like classes. Add the ones you want.</span>
					</div>
					<ul className="flex flex-col divide-y divide-border/60">
						{suggestions.slice(0, 12).map((s) => (
							<SuggestionRow key={s.key} s={s} onAdd={(label) => void create(label, s.key)} onDismiss={() => void run(() => api("/api/courses/dismiss", "POST", { key: s.key }))} />
						))}
					</ul>
				</div>
			)}

			{data !== null && courses.length === 0 && unlinked.length === 0 && suggestions.length === 0 && (
				<p className="rounded-2xl border border-dashed px-5 py-6 text-center text-sm text-muted-foreground">
					No classes yet. Make one, or watch your notes folder and each subfolder becomes a class.
				</p>
			)}

			{(courses.length > 0 || unlinked.length > 0) && (
				<ul className="flex flex-col gap-3">
					{courses.map((c) => (
						<CourseCard
							key={c.key}
							course={c}
							color={colors.get(c.key) ?? 0}
							folder={nf.folderFor(c.key)}
							act={nf.act}
							others={courses.filter((o) => o.key !== c.key)}
							onChanged={load}
							run={run}
						/>
					))}
					{unlinked.map((f) => (
						<UnlinkedFolderCard key={f.name} folder={f} act={nf.act} />
					))}
				</ul>
			)}
		</section>
	);
}

function SuggestionRow({ s, onAdd, onDismiss }: { s: CourseSuggestion; onAdd: (label: string) => void; onDismiss: () => void }) {
	const [label, setLabel] = useState(s.label);
	return (
		<li data-testid="course-suggestion" className="flex flex-wrap items-center gap-3 py-2">
			<div className="min-w-0 flex-1">
				<Input value={label} onChange={(e) => setLabel(e.target.value)} aria-label={`Name for ${s.label}`} className="h-8 max-w-xs text-sm" />
				<p className="mt-1 truncate text-xs text-muted-foreground">
					{s.reason}
					{s.nextStart ? ` · next ${when(s.nextStart)}` : ""} · e.g. {s.examples.join(", ")}
				</p>
			</div>
			<Button size="sm" disabled={!label.trim()} onClick={() => onAdd(label)}>
				<CheckIcon className="size-3.5" />
				Add
			</Button>
			<Button size="sm" variant="ghost" onClick={onDismiss}>
				Not a class
			</Button>
		</li>
	);
}

function CourseCard({
	course,
	color,
	folder,
	act,
	others,
	onChanged,
	run,
}: {
	course: CourseData;
	color: number;
	folder: FolderView | null;
	act: FolderAct;
	others: CourseData[];
	onChanged: () => Promise<void>;
	run: (job: () => Promise<CoursesPayload>) => Promise<void>;
}) {
	const router = useRouter();
	const { open: openStart } = useStartDialog();
	const refreshActivity = useActivity().refresh;
	const folderInput = useRef<HTMLInputElement>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const [progress, setProgress] = useState<string | null>(null);
	const [errors, setErrors] = useState<string[]>([]);
	const [warnings, setWarnings] = useState<string[]>([]);
	const [picking, setPicking] = useState(false);
	const [existing, setExisting] = useState<SavedNote[]>([]);
	const [chosen, setChosen] = useState<string[]>([]);
	const [renaming, setRenaming] = useState(false);
	const [merging, setMerging] = useState(false);
	const [label, setLabel] = useState(course.label);
	const [dragging, setDragging] = useState(false);
	const [allNotes, setAllNotes] = useState(false);
	const importing = progress !== null;

	const importFiles = async (picked: File[], fromFolder: boolean) => {
		if (importing) return;
		const { files: named, skipped } = fromFolder ? folderFiles(picked) : { files: picked, skipped: 0 };
		const tooBig = named.filter((f) => f.size > MAX_NOTE_BYTES);
		const files = named.filter((f) => f.size <= MAX_NOTE_BYTES);
		const problems = tooBig.map((f) => `${f.name}: over the 50 MB limit. Split the PDF into smaller parts and import those.`);
		const notes: string[] = [];
		if (skipped > 0) notes.push(`${skipped} ${skipped === 1 ? "file" : "files"} skipped (only PDF, .txt and .md are imported).`);
		setErrors(problems);
		setWarnings(notes);
		if (files.length === 0) {
			if (named.length === 0 && picked.length > 0) setErrors([...problems, "No PDF, .txt or .md files found there."]);
			return;
		}
		let done = 0;
		try {
			for (let i = 0; i < files.length; i += BATCH) {
				const batch = files.slice(i, i + BATCH);
				setProgress(`Importing ${Math.min(done + 1, files.length)}–${done + batch.length} of ${files.length}…`);
				refreshActivity();
				try {
					const results = await postNotesImport(batch, course.key);
					for (const r of results) {
						if (!r.ok) problems.push(`${r.filePath}: ${r.error}`);
						else if (r.warning) notes.push(`${r.filePath}: ${r.warning}`);
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					for (const f of batch) problems.push(`${f.name}: ${message}`);
				}
				done += batch.length;
				setErrors([...problems]);
				setWarnings([...notes]);
				await onChanged();
				window.dispatchEvent(new Event(NOTES_CHANGED_EVENT));
			}
		} finally {
			setProgress(null);
			refreshActivity();
		}
	};

	const openPicker = async () => {
		setPicking(true);
		setChosen([]);
		try {
			const res = await fetch("/api/notes");
			const body = (await res.json()) as { notes: SavedNote[] };
			const have = new Set(course.notes.map((n) => n.id));
			setExisting(body.notes.filter((n) => !have.has(n.id)));
		} catch {
			setExisting([]);
		}
	};

	const patch = (body: unknown) => run(() => api(`/api/courses/${encodeURIComponent(course.key)}`, "PATCH", body));

	const startSession = async () => {
		const text = `Teach me ${course.label}`;
		const first = `Teach me ${course.label}, starting from what I already know.${courseNotesLine(course.notes.map((n) => n.name))}`;
		const target = await startDraftSession(text, fetch, undefined, undefined, first);
		if (target) router.push(target);
	};

	const mergeInto = async (key: string) => {
		const target = others.find((o) => o.key === key);
		if (!target) return;
		setMerging(false);
		if (!window.confirm(`Merge "${course.label}" into "${target.label}"? Their notes and sessions are combined, and the calendar files both under "${target.label}".`)) return;
		try {
			await api("/api/courses/merge", "POST", { from: course.key, into: key });
			await onChanged();
		} catch (err) {
			window.alert(err instanceof Error ? err.message : String(err));
		}
	};

	const remove = () => {
		if (!window.confirm(`Delete the class "${course.label}"? Its notes stay in your Library and your sessions are kept.`)) return;
		void run(() => api(`/api/courses/${encodeURIComponent(course.key)}`, "DELETE"));
	};

	const openNote = async (id: string) => {
		if (window.lh?.openNote) {
			const result = await window.lh.openNote(id);
			if (!result.ok) setErrors([result.error ?? "Couldn't open the file."]);
			return;
		}
		window.open(`/api/notes/${id}/file`, "_blank", "noopener");
	};

	const sessions = course.chatIds?.length ?? 0;
	const meta = [
		course.next ? `Next: ${course.next.title}, ${when(course.next.start)}` : "Not in your calendar",
		course.notes.length > 0 ? `${course.notes.length} ${course.notes.length === 1 ? "note" : "notes"}` : null,
		sessions > 0 ? `${sessions} ${sessions === 1 ? "session" : "sessions"}` : null,
	].filter(Boolean);
	const shownNotes = allNotes ? course.notes : course.notes.slice(0, NOTES_SHOWN);

	return (
		<li
			data-testid="course-card"
			onDragOver={(e) => {
				if (e.dataTransfer.types.includes("Files")) {
					e.preventDefault();
					setDragging(true);
				}
			}}
			onDragLeave={() => setDragging(false)}
			onDrop={(e) => {
				e.preventDefault();
				setDragging(false);
				void dropped(e.dataTransfer).then((files) => importFiles(files.files, files.fromFolder));
			}}
			className={cn(
				`cal-c${color}`,
				"relative flex flex-col rounded-2xl border bg-surface transition-colors",
				dragging ? "border-primary bg-accent/40" : "border-border/70",
			)}
		>
			<input
				ref={folderInput}
				type="file"
				className="hidden"
				multiple
				// @ts-expect-error non-standard but supported by Chromium (Electron): pick a whole folder
				webkitdirectory=""
				onChange={(e) => {
					void importFiles(Array.from(e.target.files ?? []), true);
					e.target.value = "";
				}}
			/>
			<input
				ref={fileInput}
				type="file"
				className="hidden"
				multiple
				accept={NOTES_ACCEPT}
				onChange={(e) => {
					void importFiles(Array.from(e.target.files ?? []), false);
					e.target.value = "";
				}}
			/>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 pt-4 pb-3">
				<span
					aria-hidden
					className="flex size-10 shrink-0 items-center justify-center rounded-xl text-[17px] font-semibold"
					style={{ background: "var(--tint)", color: "var(--ink)" }}
				>
					{course.label.trim().charAt(0).toUpperCase() || "?"}
				</span>
				<div className="min-w-0 flex-1">
					{renaming ? (
						<form
							className="flex items-center gap-2"
							onSubmit={(e) => {
								e.preventDefault();
								if (label.trim()) {
									void patch({ label });
									setRenaming(false);
								}
							}}
						>
							<Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 max-w-xs" aria-label="Class name" />
							<Button size="sm" type="submit">
								Save
							</Button>
							<Button size="sm" type="button" variant="ghost" onClick={() => setRenaming(false)}>
								Cancel
							</Button>
						</form>
					) : (
						<h3 className="truncate text-[17px] font-semibold">{course.label}</h3>
					)}
					<p className="mt-0.5 flex items-center gap-1.5 truncate text-xs text-muted-foreground">
						{course.next && <CalendarIcon className="size-3 shrink-0" />}
						{meta.join(" · ")}
					</p>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Button size="sm" variant="outline" onClick={() => void startSession()} data-testid="course-learn">
						Study
					</Button>
					<Button
						size="sm"
						variant="ghost"
						disabled={course.notes.length === 0}
						onClick={() => openStart("exam", undefined, { topic: course.label, notes: course.notes.map((n) => ({ id: n.id, name: n.name })) })}
						data-testid="course-exam"
					>
						Mock exam
					</Button>
					<MoreMenu
						label={`More for ${course.label}`}
						testId="course-more"
						items={[
							{ label: "Add files…", onSelect: () => fileInput.current?.click(), disabled: importing },
							{ label: "Add a folder…", onSelect: () => folderInput.current?.click(), disabled: importing, testId: "course-add-folder" },
							{ label: "Add from my notes…", onSelect: () => void openPicker() },
							{ label: "Rename", onSelect: () => { setLabel(course.label); setRenaming(true); }, divider: true },
							...(others.length > 0 ? [{ label: "Merge into…", onSelect: () => setMerging(true) }] : []),
							{ label: "Delete class", onSelect: remove, danger: true, divider: true },
						]}
					/>
				</div>
			</div>

			{merging && (
				<div className="mx-5 mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-muted/50 px-3 py-2 text-sm">
					<span className="text-muted-foreground">Merge {course.label} into</span>
					<select
						aria-label={`Merge ${course.label} into another class`}
						data-testid="course-merge"
						value=""
						onChange={(e) => void mergeInto(e.target.value)}
						className="h-8 rounded-md border border-border bg-surface px-2 text-sm"
					>
						<option value="">Choose a class…</option>
						{others.map((o) => (
							<option key={o.key} value={o.key}>
								{o.label}
							</option>
						))}
					</select>
					<Button size="xs" variant="ghost" onClick={() => setMerging(false)}>
						Cancel
					</Button>
				</div>
			)}

			{folder && (
				<div className="border-t border-border/60 pb-1">
					<FolderInbox folder={folder} act={act} label={course.label} />
				</div>
			)}

			<div className="flex flex-col gap-2 border-t border-border/60 px-5 py-3">
				{progress && (
					<p role="status" className="text-sm text-muted-foreground">
						{progress} The notes are saved first, then added to your map.
					</p>
				)}
				<NotesImportErrors errors={errors} warnings={warnings} />
				<div className="flex flex-wrap items-center gap-1.5">
					{shownNotes.map((n) => (
						<span key={n.id} className="group flex max-w-64 items-center rounded-lg border border-border/70 bg-background/60 text-sm transition-colors hover:border-border">
							<button type="button" title={`Open ${n.name}`} onClick={() => void openNote(n.id)} className="flex min-w-0 items-center gap-1.5 py-1 pl-2.5 pr-1">
								<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="truncate">{shortNoteName(n.name, course.label)}</span>
								{n.pages ? <span className="shrink-0 text-xs text-muted-foreground">{n.pages}p</span> : null}
							</button>
							<button
								type="button"
								aria-label={`Take ${n.name} out of ${course.label}`}
								title="Take out of this class (the file stays in your Library)"
								className="mr-1 flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
								onClick={() => void patch({ removeNoteIds: [n.id] })}
							>
								<XIcon className="size-3" />
							</button>
						</span>
					))}
					{course.notes.length > NOTES_SHOWN && (
						<button type="button" onClick={() => setAllNotes((v) => !v)} className="rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
							{allNotes ? "Show less" : `+${course.notes.length - NOTES_SHOWN} more`}
						</button>
					)}
					<button
						type="button"
						disabled={importing}
						onClick={() => fileInput.current?.click()}
						className="flex items-center gap-1 rounded-lg border border-dashed border-border px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:opacity-50"
					>
						<PlusIcon className="size-3.5" />
						{course.notes.length === 0 ? "Add notes, or drop a folder here" : "Add"}
					</button>
				</div>

				{picking && (
					<div className="flex flex-col gap-2 rounded-xl bg-muted/40 p-3">
						{existing.length === 0 ? (
							<p className="text-sm text-muted-foreground">Every saved note is already in this class.</p>
						) : (
							<div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
								{existing.map((n) => (
									<label key={n.id} className="flex items-center gap-2 text-sm">
										<input type="checkbox" className="accent-foreground" checked={chosen.includes(n.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, n.id] : c.filter((x) => x !== n.id)))} />
										<span className="truncate">{n.name}</span>
									</label>
								))}
							</div>
						)}
						<div className="flex justify-end gap-2">
							<Button size="sm" variant="ghost" onClick={() => setPicking(false)}>
								Cancel
							</Button>
							<Button
								size="sm"
								disabled={chosen.length === 0}
								onClick={() => {
									void patch({ addNoteIds: chosen });
									setPicking(false);
								}}
							>
								Add {chosen.length || ""}
							</Button>
						</div>
					</div>
				)}
			</div>
		</li>
	);
}

// ─── Dropped folders ────────────────────────────────────────────────────────

async function walk(entry: FileSystemEntry, prefix: string, out: File[]): Promise<void> {
	if (entry.isFile) {
		const file = await new Promise<File>((ok, fail) => (entry as FileSystemFileEntry).file(ok, fail));
		// folderFiles reads the folder path off webkitRelativePath.
		Object.defineProperty(file, "webkitRelativePath", { value: `${prefix}${entry.name}` });
		out.push(file);
	} else if (entry.isDirectory) {
		const reader = (entry as FileSystemDirectoryEntry).createReader();
		// readEntries returns at most ~100 at a time: read until it is empty.
		for (;;) {
			const batch = await new Promise<FileSystemEntry[]>((ok, fail) => reader.readEntries(ok, fail));
			if (batch.length === 0) break;
			for (const child of batch) await walk(child, `${prefix}${entry.name}/`, out);
		}
	}
}

/** The files of a drop; a dropped folder is walked (the browser gives only its entry). */
async function dropped(dt: DataTransfer): Promise<{ files: File[]; fromFolder: boolean }> {
	const entries = Array.from(dt.items ?? []).flatMap((i) => {
		const entry = i.webkitGetAsEntry?.();
		return entry ? [entry] : [];
	});
	if (entries.some((e) => e.isDirectory)) {
		const out: File[] = [];
		for (const entry of entries) await walk(entry, "", out);
		return { files: out, fromFolder: true };
	}
	return { files: Array.from(dt.files), fromFolder: false };
}
