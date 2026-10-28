"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, FolderPlusIcon, PlusIcon } from "lucide-react";
import { courseNotesLine, folderNoteName, isNotesFile, type CourseSuggestion } from "@/src/core";
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

/**
 * COURSES (Library, 2026-10-28): one group per class, each holding its
 * notes. Drop a folder on a course and every PDF, .txt and .md in it is
 * imported through the normal notes import; pick notes you already have;
 * or let the calendar suggest the courses (plain rules over the event
 * titles — you confirm, rename or dismiss each; nothing is created or
 * written to the calendar on its own). A calendar event of a course then
 * pulls the course's notes into the study plan, the daily briefing and
 * mock exams.
 */
export function CoursesView() {
	const [data, setData] = useState<CoursesPayload | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [name, setName] = useState("");

	const load = useCallback(async () => {
		try {
			setData(await api("/api/courses", "GET"));
			setError(null);
		} catch (err) {
			setError(`Couldn't load your courses (${err instanceof Error ? err.message : String(err)}).`);
		}
	}, []);
	useEffect(() => {
		void load();
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

	return (
		<section data-testid="courses-view" aria-labelledby="courses-heading" className="flex flex-col gap-4">
			<header className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-4">
					<SectionHeading className="flex items-baseline gap-2">
						<span id="courses-heading">Your courses</span>
						<span className="text-sm font-normal text-muted-foreground">
							{data === null ? "loading…" : courses.length === 0 ? "none yet" : `${courses.length} ${courses.length === 1 ? "course" : "courses"}`}
						</span>
					</SectionHeading>
					<Button size="sm" variant="outline" data-testid="course-new" onClick={() => setCreating((v) => !v)}>
						<PlusIcon className="size-3.5" />
						New course
					</Button>
				</div>
				<p className="max-w-2xl text-sm text-muted-foreground">
					One group per class, with its notes. When your calendar has a class or exam of a course, the study plan and the daily
					briefing use that course&apos;s notes.
				</p>
				{creating && (
					<form
						className="flex max-w-md items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (name.trim()) void create(name);
						}}
					>
						<Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Course name, e.g. Linear algebra" data-testid="course-name" />
						<Button type="submit" size="sm" disabled={!name.trim()}>
							Create
						</Button>
					</form>
				)}
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
			</header>

			{suggestions.length > 0 && (
				<div data-testid="course-suggestions" className="flex flex-col gap-2 rounded-2xl bg-accent/50 px-4 py-3">
					<h3 className="text-base font-semibold">From your calendar</h3>
					<p className="text-sm text-muted-foreground">These look like classes. Add the ones you want a group for.</p>
					<ul className="flex flex-col divide-y divide-border/60">
						{suggestions.slice(0, 12).map((s) => (
							<SuggestionRow key={s.key} s={s} onAdd={(label) => void create(label, s.key)} onDismiss={() => void run(() => api("/api/courses/dismiss", "POST", { key: s.key }))} />
						))}
					</ul>
				</div>
			)}

			{courses.length > 0 && (
				<ul className="flex flex-col gap-3">
					{courses.map((c) => (
						<CourseCard key={c.key} course={c} onChanged={load} run={run} />
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
				<Input
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					aria-label={`Name for ${s.label}`}
					className="h-8 max-w-xs bg-surface text-base"
				/>
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
	onChanged,
	run,
}: {
	course: CourseData;
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
	const [label, setLabel] = useState(course.label);
	const [dragging, setDragging] = useState(false);
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
		setPicking((v) => !v);
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

	const remove = () => {
		if (!window.confirm(`Delete the course "${course.label}"? Its notes stay in your Library and your sessions are kept.`)) return;
		void run(() => api(`/api/courses/${encodeURIComponent(course.key)}`, "DELETE"));
	};

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
				"flex flex-col gap-3 rounded-2xl border bg-surface px-5 py-4 transition-colors",
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
			<div className="flex flex-wrap items-center gap-3">
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
							<Input autoFocus value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 max-w-xs" aria-label="Course name" />
							<Button size="sm" type="submit">
								Save
							</Button>
						</form>
					) : (
						<h3 className="truncate text-lg font-semibold">{course.label}</h3>
					)}
					<p className="truncate text-xs text-muted-foreground">
						{course.notes.length === 0 ? "No notes yet" : `${course.notes.length} ${course.notes.length === 1 ? "file" : "files"}`}
						{course.next ? ` · next: ${course.next.title}, ${when(course.next.start)}` : " · no class found in your calendar"}
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap items-center gap-1">
					<Button size="sm" disabled={importing} onClick={() => folderInput.current?.click()} data-testid="course-add-folder">
						<FolderPlusIcon className="size-3.5" />
						Add folder
					</Button>
					<Button size="sm" variant="ghost" disabled={importing} onClick={() => fileInput.current?.click()}>
						Add files
					</Button>
					<Button size="sm" variant="ghost" disabled={importing} onClick={() => void openPicker()}>
						From my notes
					</Button>
				</div>
			</div>

			{progress && (
				<p role="status" className="text-sm text-muted-foreground">
					{progress} The notes are saved first, then added to your map.
				</p>
			)}
			<NotesImportErrors errors={errors} warnings={warnings} />

			{course.notes.length > 0 && (
				<ul className="flex flex-wrap gap-1.5">
					{course.notes.map((n) => (
						<li key={n.id} className="flex max-w-72 items-center gap-1 rounded-full bg-accent py-0.5 pl-3 pr-1 text-sm">
							<span className="truncate">{n.name}</span>
							<button
								type="button"
								aria-label={`Take ${n.name} out of ${course.label}`}
								title="Take out of this course (the file stays in your Library)"
								className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground"
								onClick={() => void patch({ removeNoteIds: [n.id] })}
							>
								×
							</button>
						</li>
					))}
				</ul>
			)}
			{course.notes.length === 0 && !importing && (
				<p className="text-sm text-muted-foreground">Drop a folder of notes here, or use Add folder.</p>
			)}

			{picking && (
				<div className="flex flex-col gap-2 rounded-lg bg-muted/40 p-3">
					{existing.length === 0 ? (
						<p className="text-sm text-muted-foreground">Every saved note is already in this course.</p>
					) : (
						<div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
							{existing.map((n) => (
								<label key={n.id} className="flex items-center gap-2 text-sm">
									<input type="checkbox" checked={chosen.includes(n.id)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, n.id] : c.filter((x) => x !== n.id)))} />
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

			<div className="flex flex-wrap items-center gap-1 border-t border-border/60 pt-3">
				<Button size="sm" variant="outline" onClick={() => void startSession()} data-testid="course-learn">
					Study this course
				</Button>
				<Button
					size="sm"
					variant="outline"
					disabled={course.notes.length === 0}
					onClick={() => openStart("exam", undefined, { topic: course.label, notes: course.notes.map((n) => ({ id: n.id, name: n.name })) })}
					data-testid="course-exam"
				>
					Mock exam
				</Button>
				<span className="flex-1" />
				<Button size="sm" variant="ghost" onClick={() => { setLabel(course.label); setRenaming((v) => !v); }}>
					Rename
				</Button>
				<Button size="sm" variant="ghost" onClick={remove}>
					Delete
				</Button>
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
