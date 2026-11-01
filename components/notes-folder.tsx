"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	AlertTriangleIcon,
	CheckIcon,
	ChevronRightIcon,
	FileTextIcon,
	FolderIcon,
	FolderOpenIcon,
	LoaderCircleIcon,
	PauseIcon,
	PenLineIcon,
	RotateCwIcon,
} from "lucide-react";
import { LOOSE, PROCESSED_DIR, type FolderMode, type NotesFolderConfig, type WatchedFolderSettings } from "@/src/core";
import { SectionHeading } from "@/components/page-header";
import { Toggle } from "@/components/settings/controls";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useClassColors } from "@/components/use-class-colors";
import { NOTES_CHANGED_EVENT } from "@/components/notes-view";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// Transport types (mirrors src/server/notes-folder.ts; never import the server here).
interface FileView {
	key: string;
	file: string;
	at: string;
	status: "waiting" | "queued" | "processing" | "processed" | "failed" | "skipped";
	pages: number;
	newPages: number;
	editedPages: number;
	update: boolean;
	error?: string;
	step?: string;
	processedAt?: string;
	moveError?: string;
}
interface FolderView {
	name: string;
	settings: WatchedFolderSettings;
	courseLabel: string | null;
	files: FileView[];
}
interface FolderState {
	config: NotesFolderConfig | null;
	folders: FolderView[];
	pending: string[];
	paused: { until: number; reason: string } | null;
	handwritingReady: boolean;
	busy: boolean;
	missing: boolean;
}
interface Preview {
	root: string;
	folders: { name: string; files: number; course: string | null; courseLabel: string | null }[];
	loose: number;
	courses: { key: string; label: string }[];
}
type CourseChoice = string | { new: string } | null;
interface Choice {
	course: CourseChoice;
	include: boolean;
	watch: boolean;
}

async function call<T>(url: string, method: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method,
		...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
	return data;
}

const MODES: { id: FolderMode; label: string; hint: string }[] = [
	{ id: "pick", label: "One by one", hint: "You choose which files to process." },
	{ id: "all", label: "All at once", hint: "One click processes every waiting file." },
	{ id: "auto", label: "Automatic", hint: "New files are processed as soon as they appear." },
];

/** The desktop bridge, read after mount (the page also renders on the server). */
function useDesktop(): { pickFolder?: () => Promise<string | null>; openWatchedFolder?: (sub?: string) => Promise<{ ok: boolean; error?: string }> } {
	const [lh, setLh] = useState<Window["lh"] | undefined>(undefined);
	useEffect(() => setLh(window.lh), []);
	return { pickFolder: lh?.pickFolder, openWatchedFolder: lh?.openWatchedFolder };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const folderTitle = (name: string) => (name === LOOSE ? "Files directly in the folder" : name);
const shortDate = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "");

/**
 * NOTES FOLDER (Library, 2026-11-01): the folder Socrates watches (a
 * reMarkable export folder, a Drive folder…), one subfolder per class.
 * Each class folder lists its files: waiting, being read, failed, processed.
 * Per class, files are processed one by one, all at once, or automatically.
 * A page is read once, ever: copies, renamed files and re-exports only cost
 * their new pages. Processed files move into a Processed subfolder.
 */
export function NotesFolderView() {
	const [state, setState] = useState<FolderState | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [setup, setSetup] = useState<{ root: string | null; only?: string[] } | null>(null);
	const { open: openSettings } = useSettingsDialog();
	const desktop = useDesktop();
	const processedCount = useRef<number | null>(null);

	const load = useCallback(async () => {
		try {
			const next = await call<FolderState>("/api/notes-folder", "GET");
			setState(next);
			setError(null);
			// A newly processed file is a new note: the notes list and the courses refresh.
			const done = next.folders.reduce((n, f) => n + f.files.filter((x) => x.status === "processed").length, 0);
			if (processedCount.current !== null && done !== processedCount.current) window.dispatchEvent(new Event(NOTES_CHANGED_EVENT));
			processedCount.current = done;
		} catch (err) {
			setError(`Couldn't load the notes folder (${err instanceof Error ? err.message : String(err)}).`);
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);
	useEffect(() => {
		const id = window.setTimeout(() => void load(), state?.busy ? 2_000 : 15_000);
		return () => window.clearTimeout(id);
	}, [state, load]);

	const act = async (url: string, body: unknown = {}) => {
		try {
			setState(await call<FolderState>(url, "POST", body));
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const chooseFolder = async () => {
		const pick = desktop.pickFolder;
		if (!pick) return setSetup({ root: null });
		const root = await pick();
		if (root) setSetup({ root });
	};

	const stop = async () => {
		if (!window.confirm("Stop watching this folder? Nothing is deleted, and pages already read stay on your map. If you watch it again later, they are not read again.")) return;
		setState(await call<FolderState>("/api/notes-folder", "DELETE"));
	};

	const config = state?.config ?? null;
	const waitingHandwriting = state?.folders.some((f) => f.files.some((x) => x.status === "waiting" || x.status === "failed")) ?? false;

	return (
		<section data-testid="notes-folder" aria-labelledby="notes-folder-heading" className="flex flex-col gap-4">
			<header className="flex flex-col gap-2">
				<div className="flex items-center justify-between gap-4">
					<SectionHeading className="flex items-baseline gap-2">
						<span id="notes-folder-heading">Notes folder</span>
						{config && (
							<span className="text-sm font-normal text-muted-foreground">
								{state!.busy ? "working…" : `${plural(state!.folders.length, "class folder")}`}
							</span>
						)}
					</SectionHeading>
					{config && (
						<div className="flex items-center gap-1">
							{desktop.openWatchedFolder && (
								<Button size="sm" variant="ghost" onClick={() => void desktop.openWatchedFolder!()}>
									<FolderOpenIcon className="size-3.5" />
									Open
								</Button>
							)}
							<Button size="sm" variant="outline" data-testid="notes-folder-setup" onClick={() => setSetup({ root: config.root })}>
								Folder settings
							</Button>
						</div>
					)}
				</div>
				{config ? (
					<div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
						<FolderIcon className="size-3.5 shrink-0" />
						<span className="truncate font-mono text-[12.5px]" title={config.root} data-testid="notes-folder-root">
							{config.root}
						</span>
						<span className="shrink-0">·</span>
						<button type="button" className="shrink-0 underline-offset-2 hover:text-foreground hover:underline" onClick={() => void stop()}>
							Stop watching
						</button>
					</div>
				) : null}
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
			</header>

			{state && !config && (
				<div data-testid="notes-folder-empty" className="flex flex-wrap items-center gap-5 rounded-2xl border border-dashed border-border px-6 py-5">
					<div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent">
						<PenLineIcon className="size-5" />
					</div>
					<div className="min-w-60 flex-1">
						<h3 className="text-base font-semibold">Watch the folder your notes are exported to</h3>
						<p className="mt-1 max-w-xl text-sm text-muted-foreground">
							Your reMarkable&apos;s export folder, a Google Drive or Dropbox folder: one subfolder per class. New notes show up here, handwriting
							included, and each page is read once, never twice.
						</p>
					</div>
					<Button data-testid="notes-folder-choose" onClick={() => void chooseFolder()}>
						<FolderOpenIcon className="size-4" />
						Choose folder…
					</Button>
				</div>
			)}

			{config && (
				<div className="flex flex-col gap-2">
					{state!.missing && (
						<Banner tone="warn" icon={<AlertTriangleIcon className="size-4" />}>
							The folder can&apos;t be found. If it is on a drive or in a cloud folder, connect it; otherwise use Folder settings to pick it again.
						</Banner>
					)}
					{state!.paused && (
						<Banner tone="warn" icon={<PauseIcon className="size-4" />} action={<Button size="sm" variant="outline" onClick={() => void act("/api/notes-folder/resume")}>Try now</Button>}>
							{state!.paused.reason}
						</Banner>
					)}
					{!state!.handwritingReady && waitingHandwriting && (
						<Banner tone="info" icon={<PenLineIcon className="size-4" />} action={<Button size="sm" variant="outline" onClick={() => openSettings("keys", "GEMINI_API_KEY")}>Add a key</Button>}>
							Reading handwriting needs a Gemini API key (the free tier is enough). Typed pages work without one.
						</Banner>
					)}
					{state!.pending.length > 0 && (
						<Banner
							tone="info"
							icon={<FolderIcon className="size-4" />}
							testId="notes-folder-pending"
							action={<Button size="sm" onClick={() => setSetup({ root: config.root, only: state!.pending })}>Set up</Button>}
						>
							{state!.pending.length === 1 ? (
								<>New folder found: <strong className="font-medium text-foreground">{state!.pending[0]}</strong>. Nothing in it is read until you set it up.</>
							) : (
								<>{state!.pending.length} new folders found ({state!.pending.join(", ")}). Nothing in them is read until you set them up.</>
							)}
						</Banner>
					)}
				</div>
			)}

			{config && state!.folders.length > 0 && (
				<ul className="flex flex-col gap-3">
					{state!.folders.map((f) => (
						<ClassFolder key={f.name} folder={f} act={act} />
					))}
				</ul>
			)}

			{setup && (
				<SetupDialog
					initialRoot={setup.root}
					only={setup.only}
					current={config}
					onClose={() => setSetup(null)}
					onSaved={(next) => {
						setState(next);
						setSetup(null);
					}}
				/>
			)}
		</section>
	);
}

function Banner({ tone, icon, children, action, testId }: { tone: "warn" | "info"; icon: React.ReactNode; children: React.ReactNode; action?: React.ReactNode; testId?: string }) {
	return (
		<div
			data-testid={testId}
			className={cn(
				"flex flex-wrap items-center gap-3 rounded-xl px-4 py-2.5 text-sm",
				tone === "warn" ? "bg-amber-500/10 text-amber-900 dark:text-amber-200" : "bg-accent/60 text-muted-foreground",
			)}
		>
			<span className="shrink-0">{icon}</span>
			<p className="min-w-48 flex-1">{children}</p>
			{action}
		</div>
	);
}

// ─── One class folder ───────────────────────────────────────────────────────

function ClassFolder({ folder, act }: { folder: FolderView; act: (url: string, body?: unknown) => Promise<void> }) {
	const colors = useClassColors();
	const [chosen, setChosen] = useState<string[]>([]);
	const [showDone, setShowDone] = useState(false);
	const [showSkipped, setShowSkipped] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const { settings } = folder;

	const groups = useMemo(() => {
		const by = (s: FileView["status"][]) => folder.files.filter((f) => s.includes(f.status));
		return {
			working: by(["processing", "queued"]),
			waiting: by(["waiting"]),
			failed: by(["failed"]),
			edited: folder.files.filter((f) => f.status === "processed" && f.editedPages > 0),
			done: folder.files.filter((f) => f.status === "processed" && f.editedPages === 0),
			skipped: by(["skipped"]),
		};
	}, [folder.files]);
	const waitingPages = groups.waiting.reduce((n, f) => n + f.newPages, 0);
	const color = settings.course ? colors.get(settings.course) : undefined;
	const live = new Set(groups.waiting.map((f) => f.key));
	const picked = chosen.filter((k) => live.has(k));

	const process = (body: unknown) => {
		setChosen([]);
		return act("/api/notes-folder/process", body);
	};
	const setMode = (mode: FolderMode) => act("/api/notes-folder/folder", { name: folder.name, mode });

	const summary = [
		groups.working.length > 0 && `${groups.working.length} in progress`,
		groups.waiting.length > 0 && `${groups.waiting.length} waiting`,
		groups.failed.length > 0 && `${groups.failed.length} failed`,
		`${groups.done.length + groups.edited.length} processed`,
	].filter(Boolean);

	return (
		<li data-testid="notes-folder-class" className="flex flex-col rounded-2xl border border-border/70 bg-surface">
			<div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 pt-4 pb-3">
				<div className="flex min-w-0 flex-1 items-center gap-3">
					<span
						aria-hidden
						className={cn("size-2.5 shrink-0 rounded-full", color !== undefined ? `cal-c${color}` : "bg-muted-foreground/40")}
						style={color !== undefined ? { background: "var(--bar)" } : undefined}
					/>
					<div className="min-w-0">
						<h3 className="truncate text-lg font-semibold">{folder.courseLabel ?? "No class"}</h3>
						<p className="flex items-center gap-1 truncate text-xs text-muted-foreground">
							<FolderIcon className="size-3 shrink-0" />
							<span className="truncate">{folderTitle(folder.name)}</span>
							<span>·</span>
							<span>{summary.join(" · ")}</span>
						</p>
					</div>
				</div>
				<div role="group" aria-label={`How ${folder.courseLabel ?? folderTitle(folder.name)} is processed`} className="flex rounded-[10px] bg-muted p-[3px] text-[13px] font-medium">
					{MODES.map((m) => (
						<button
							key={m.id}
							type="button"
							title={m.hint}
							aria-pressed={settings.mode === m.id}
							data-testid={`notes-folder-mode-${m.id}`}
							onClick={() => void setMode(m.id)}
							className={cn(
								"rounded-[7px] px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground",
								settings.mode === m.id && "bg-card text-foreground shadow-[0_1px_2px_rgba(31,30,29,0.1),0_0_0_1px_rgba(31,30,29,0.04)] dark:bg-accent",
							)}
						>
							{m.label}
						</button>
					))}
				</div>
			</div>

			<div className="flex flex-col gap-0.5 px-3 pb-2">
				{groups.working.map((f) => (
					<FileRow key={f.key} f={f} lead={<LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" />} meta={f.status === "queued" ? "In line" : (f.step ?? "Starting")} />
				))}

				{groups.failed.map((f) => (
					<FileRow
						key={f.key}
						f={f}
						lead={<AlertTriangleIcon className="size-4 text-destructive" />}
						meta={<span className="text-destructive">{f.error}</span>}
						action={
							<Button size="xs" variant="outline" onClick={() => void process({ keys: [f.key], retry: true })}>
								<RotateCwIcon className="size-3" />
								Retry
							</Button>
						}
					/>
				))}

				{groups.waiting.map((f) => (
					<FileRow
						key={f.key}
						f={f}
						lead={
							settings.mode === "pick" ? (
								<input
									type="checkbox"
									aria-label={`Choose ${f.file}`}
									className="size-4 accent-foreground"
									checked={chosen.includes(f.key)}
									onChange={(e) => setChosen((c) => (e.target.checked ? [...c, f.key] : c.filter((k) => k !== f.key)))}
								/>
							) : (
								<FileTextIcon className="size-4 text-muted-foreground" />
							)
						}
						meta={
							<>
								{f.update ? <span className="font-medium text-foreground">Updated · {plural(f.newPages, "new page")}</span> : plural(f.pages, "page")}
								{f.error && <span className="text-amber-700 dark:text-amber-300"> · paused: {f.error}</span>}
							</>
						}
						action={
							settings.mode === "pick" && (
								<Button size="xs" variant="outline" onClick={() => void process({ keys: [f.key] })}>
									Process
								</Button>
							)
						}
					/>
				))}

				{groups.edited.map((f) => (
					<FileRow
						key={f.key}
						f={f}
						lead={<PenLineIcon className="size-4 text-amber-600 dark:text-amber-300" />}
						meta={<>Re-exported · {plural(f.editedPages, "page")} you changed after {f.editedPages === 1 ? "it was" : "they were"} read. Not read again unless you say so.</>}
						action={
							<div className="flex gap-1">
								<Button size="xs" variant="outline" onClick={() => void process({ keys: [f.key], edited: true })}>
									Read {f.editedPages === 1 ? "it" : "them"}
								</Button>
								<Button size="xs" variant="ghost" onClick={() => void act("/api/notes-folder/keep", { key: f.key })}>
									Keep as read
								</Button>
							</div>
						}
					/>
				))}

				{groups.waiting.length === 0 && groups.working.length === 0 && groups.failed.length === 0 && groups.edited.length === 0 && (
					<p className="px-2 py-2 text-sm text-muted-foreground">
						{settings.watch ? "Nothing waiting. New files in this folder show up here." : "Nothing waiting. This folder isn't watched for new files."}
					</p>
				)}
			</div>

			{groups.waiting.length > 0 && settings.mode !== "auto" && (
				<div className="flex flex-wrap items-center justify-end gap-3 border-t border-border/60 px-5 py-3">
					<span className="mr-auto text-xs text-muted-foreground">
						{settings.mode === "pick"
							? picked.length > 0
								? `${plural(picked.length, "file")} chosen`
								: "Choose files, or process them one at a time."
							: `${plural(groups.waiting.length, "file")}, ${plural(waitingPages, "page")} to read. Pages already on your map are skipped.`}
					</span>
					{settings.mode === "pick" ? (
						<>
							<Button size="sm" variant="ghost" onClick={() => setChosen(picked.length === groups.waiting.length ? [] : groups.waiting.map((f) => f.key))}>
								{picked.length === groups.waiting.length ? "Clear" : "Choose all"}
							</Button>
							<Button size="sm" disabled={picked.length === 0} onClick={() => void process({ keys: picked })} data-testid="notes-folder-process-selected">
								Process {picked.length > 0 ? picked.length : ""}
							</Button>
						</>
					) : (
						<Button size="sm" onClick={() => void process({ folder: folder.name, all: true })} data-testid="notes-folder-process-all">
							Process all {groups.waiting.length}
						</Button>
					)}
				</div>
			)}
			{settings.mode === "auto" && groups.waiting.length > 0 && (
				<p className="border-t border-border/60 px-5 py-3 text-xs text-muted-foreground">These start on their own, one file at a time.</p>
			)}

			<div className="flex flex-wrap items-center gap-1 border-t border-border/60 px-3 py-2">
				<Disclosure open={showDone} onToggle={() => setShowDone((v) => !v)} label={`Processed (${groups.done.length})`} disabled={groups.done.length === 0} />
				{groups.skipped.length > 0 && <Disclosure open={showSkipped} onToggle={() => setShowSkipped((v) => !v)} label={`Not included (${groups.skipped.length})`} />}
				<span className="flex-1" />
				<Button size="xs" variant="ghost" onClick={() => setSettingsOpen((v) => !v)} aria-expanded={settingsOpen}>
					Settings
				</Button>
			</div>

			{showDone && groups.done.length > 0 && (
				<ul className="flex flex-col gap-0.5 px-3 pb-3" data-testid="notes-folder-done">
					{groups.done.map((f) => (
						<FileRow
							key={f.key}
							f={f}
							quiet
							lead={<CheckIcon className="size-4 text-muted-foreground" />}
							meta={
								<>
									{plural(f.pages, "page")} · {shortDate(f.processedAt)} · {f.moveError ? <span className="text-amber-700 dark:text-amber-300">{f.moveError}</span> : `in ${PROCESSED_DIR}`}
								</>
							}
						/>
					))}
				</ul>
			)}
			{showSkipped && groups.skipped.length > 0 && (
				<ul className="flex flex-col gap-0.5 px-3 pb-3">
					{groups.skipped.map((f) => (
						<FileRow
							key={f.key}
							f={f}
							quiet
							lead={<FileTextIcon className="size-4 text-muted-foreground" />}
							meta={plural(f.pages, "page")}
							action={
								<Button size="xs" variant="ghost" onClick={() => void act("/api/notes-folder/include", { key: f.key })}>
									Include
								</Button>
							}
						/>
					))}
				</ul>
			)}
			{settingsOpen && <FolderSettings folder={folder} act={act} />}
		</li>
	);
}

function Disclosure({ open, onToggle, label, disabled }: { open: boolean; onToggle: () => void; label: string; disabled?: boolean }) {
	return (
		<button
			type="button"
			disabled={disabled}
			aria-expanded={open}
			onClick={onToggle}
			className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
		>
			<ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} />
			{label}
		</button>
	);
}

function FileRow({ f, lead, meta, action, quiet }: { f: FileView; lead: React.ReactNode; meta: React.ReactNode; action?: React.ReactNode; quiet?: boolean }) {
	return (
		<div data-testid="notes-folder-file" data-status={f.status} className="flex min-h-11 items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-accent/40">
			<span className="flex size-5 shrink-0 items-center justify-center">{lead}</span>
			<div className="min-w-0 flex-1">
				<p className={cn("truncate text-sm", quiet ? "text-muted-foreground" : "font-medium")}>{f.file}</p>
				<p className="truncate text-xs text-muted-foreground">{meta}</p>
			</div>
			{action && <div className="shrink-0">{action}</div>}
		</div>
	);
}

function FolderSettings({ folder, act }: { folder: FolderView; act: (url: string, body?: unknown) => Promise<void> }) {
	const [courses, setCourses] = useState<{ key: string; label: string }[]>([]);
	useEffect(() => {
		void call<{ courses: { key: string; label: string }[] }>("/api/courses", "GET").then((d) => setCourses(d.courses.map((c) => ({ key: c.key, label: c.label })))).catch(() => {});
	}, []);
	const patch = (p: Record<string, unknown>) => act("/api/notes-folder/folder", { name: folder.name, ...p });
	const { settings } = folder;
	return (
		<div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border/60 bg-muted/30 px-5 py-3 text-sm">
			<label className="flex items-center gap-2">
				<span className="text-muted-foreground">Class</span>
				<select
					value={settings.course ?? ""}
					onChange={(e) => void patch({ course: e.target.value || null })}
					className="h-8 rounded-md border border-border bg-surface px-2 text-sm"
				>
					<option value="">No class</option>
					{courses.map((c) => (
						<option key={c.key} value={c.key}>
							{c.label}
						</option>
					))}
				</select>
			</label>
			<label className="flex items-center gap-2">
				<Toggle checked={settings.include} onChange={(on) => void patch({ include: on })} label="Include files that were already there" />
				<span>Files already there</span>
			</label>
			<label className="flex items-center gap-2">
				<Toggle checked={settings.watch} onChange={(on) => void patch({ watch: on })} label="Watch for new files" />
				<span>Watch for new files</span>
			</label>
			<span className="flex-1" />
			<Button
				size="xs"
				variant="ghost"
				onClick={() => {
					if (window.confirm(`Exclude "${folderTitle(folder.name)}"? Socrates stops looking at it. What was already read stays on your map.`)) void patch({ exclude: true });
				}}
			>
				Exclude this folder
			</Button>
		</div>
	);
}

// ─── The set-up window ─────────────────────────────────────────────────────

function SetupDialog({
	initialRoot,
	only,
	current,
	onClose,
	onSaved,
}: {
	initialRoot: string | null;
	only?: string[];
	current: NotesFolderConfig | null;
	onClose: () => void;
	onSaved: (state: FolderState) => void;
}) {
	const [root, setRoot] = useState(initialRoot ?? "");
	const [typed, setTyped] = useState(initialRoot ?? "");
	const [preview, setPreview] = useState<Preview | null>(null);
	const [choices, setChoices] = useState<Record<string, Choice>>({});
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const backdrop = useBackdropDismiss(onClose);
	const desktop = useDesktop();

	useEffect(() => {
		if (!root) return;
		let live = true;
		call<Preview>("/api/notes-folder/preview", "POST", { root })
			.then((p) => {
				if (!live) return;
				setPreview(p);
				setError(null);
				const same = current?.root === p.root;
				const next: Record<string, Choice> = {};
				const rows = [...p.folders.map((f) => f.name), ...(p.loose > 0 ? [LOOSE] : [])];
				for (const name of rows) {
					const had = same ? current!.folders[name] : undefined;
					const excluded = same && current!.excluded.includes(name);
					const match = p.folders.find((f) => f.name === name)?.course ?? null;
					next[name] = had
						? { course: had.course, include: had.include, watch: had.watch }
						: excluded
							? { course: match, include: false, watch: false }
							: { course: match ?? (name === LOOSE ? null : { new: name }), include: true, watch: true };
				}
				setChoices(next);
			})
			.catch((err) => live && setError(err instanceof Error ? err.message : String(err)));
		return () => {
			live = false;
		};
	}, [root, current]);

	const rows = preview ? [...preview.folders.map((f) => ({ name: f.name, files: f.files })), ...(preview.loose > 0 ? [{ name: LOOSE, files: preview.loose }] : [])] : [];
	const shown = only ? rows.filter((r) => only.includes(r.name)) : rows;
	const set = (name: string, patch: Partial<Choice>) => setChoices((c) => ({ ...c, [name]: { ...c[name]!, ...patch } }));
	const active = shown.filter((r) => choices[r.name] && (choices[r.name]!.include || choices[r.name]!.watch)).length;

	const save = async () => {
		if (!preview) return;
		setSaving(true);
		try {
			const folders = Object.fromEntries(shown.map((r) => [r.name, choices[r.name]!]));
			onSaved(await call<FolderState>("/api/notes-folder", "PUT", { root: preview.root, folders }));
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setSaving(false);
		}
	};

	const repick = async () => {
		const pick = desktop.pickFolder;
		if (!pick) return;
		const next = await pick();
		if (next) {
			setPreview(null);
			setRoot(next);
			setTyped(next);
		}
	};

	return (
		<div role="dialog" aria-modal="true" aria-label="Set up your notes folder" data-testid="notes-folder-dialog" className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--lh-scrim,rgba(0,0,0,0.4))] p-4" {...backdrop}>
			<div className="flex max-h-[min(44rem,calc(100vh-2rem))] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
				<div className="flex flex-col gap-1 border-b border-border/70 px-6 pt-5 pb-4">
					<h2 className="text-lg font-semibold">{only ? "New folders" : "Set up your notes folder"}</h2>
					<p className="text-sm text-muted-foreground">
						{only
							? "Choose what Socrates does with them."
							: "Each subfolder is a class. Choose which ones Socrates looks at: the files already there, the ones that come later, or none (excluded)."}
					</p>
					{desktop.pickFolder ? (
						<div className="mt-2 flex min-w-0 items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-sm">
							<FolderIcon className="size-4 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={root}>
								{root || "No folder chosen"}
							</span>
							{!only && (
								<Button size="xs" variant="ghost" onClick={() => void repick()}>
									Change…
								</Button>
							)}
						</div>
					) : (
						<form
							className="mt-2 flex items-center gap-2"
							onSubmit={(e) => {
								e.preventDefault();
								setPreview(null);
								setRoot(typed.trim());
							}}
						>
							<Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Folder path, e.g. C:\Users\you\Documents\reMarkable" className="font-mono text-[12.5px]" aria-label="Folder path" />
							<Button size="sm" type="submit" variant="outline" disabled={!typed.trim()}>
								Look
							</Button>
						</form>
					)}
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
					{error && (
						<p role="alert" className="py-2 text-sm text-destructive">
							{error}
						</p>
					)}
					{root && !preview && !error && <p className="py-6 text-center text-sm text-muted-foreground">Looking at the folder…</p>}
					{preview && shown.length === 0 && (
						<p className="py-6 text-center text-sm text-muted-foreground">This folder has no subfolders or notes yet. Make one folder per class in it, then come back.</p>
					)}
					{preview && shown.length > 0 && (
						<table className="w-full border-separate border-spacing-0 text-sm" data-testid="notes-folder-rows">
							<thead>
								<tr className="text-left text-xs text-muted-foreground">
									<th className="pb-2 font-medium">Folder</th>
									<th className="pb-2 font-medium">Class</th>
									<th className="w-28 pb-2 text-center font-medium">Files already there</th>
									<th className="w-28 pb-2 text-center font-medium">Watch for new files</th>
								</tr>
							</thead>
							<tbody>
								{shown.map((r) => {
									const c = choices[r.name];
									if (!c) return null;
									const off = !c.include && !c.watch;
									return (
										<tr key={r.name} data-testid="notes-folder-row" className={cn("transition-opacity", off && "opacity-55")}>
											<td className="border-t border-border/60 py-2.5 pr-3 align-middle">
												<div className="flex items-center gap-2">
													<FolderIcon className="size-4 shrink-0 text-muted-foreground" />
													<div className="min-w-0">
														<p className="truncate font-medium">{folderTitle(r.name)}</p>
														<p className="text-xs text-muted-foreground">{off ? "Excluded" : plural(r.files, "file")}</p>
													</div>
												</div>
											</td>
											<td className="border-t border-border/60 py-2.5 pr-3 align-middle">
												<CoursePicker name={r.name} value={c.course} courses={preview.courses} disabled={off} onChange={(course) => set(r.name, { course })} />
											</td>
											<td className="border-t border-border/60 py-2.5 text-center align-middle">
												<span className="inline-flex">
													<Toggle checked={c.include} onChange={(on) => set(r.name, { include: on })} label={`Include the files already in ${folderTitle(r.name)}`} />
												</span>
											</td>
											<td className="border-t border-border/60 py-2.5 text-center align-middle">
												<span className="inline-flex">
													<Toggle checked={c.watch} onChange={(on) => set(r.name, { watch: on })} label={`Watch ${folderTitle(r.name)} for new files`} />
												</span>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					)}
				</div>

				<div className="flex flex-wrap items-center gap-3 border-t border-border/70 px-6 py-4">
					<p className="mr-auto max-w-md text-xs text-muted-foreground">
						Nothing is read yet: each class starts in <span className="font-medium text-foreground">One by one</span>, and you can switch it to all at once or automatic.
						Finished files move into a <span className="font-mono">{PROCESSED_DIR}</span> folder.
					</p>
					<Button variant="ghost" onClick={onClose}>
						Cancel
					</Button>
					<Button onClick={() => void save()} disabled={!preview || saving || shown.length === 0} data-testid="notes-folder-save">
						{saving ? "Saving…" : current && current.root === preview?.root ? "Save" : `Watch ${active > 0 ? plural(active, "folder") : ""}`.trim()}
					</Button>
				</div>
			</div>
		</div>
	);
}

function CoursePicker({ name, value, courses, disabled, onChange }: { name: string; value: CourseChoice; courses: { key: string; label: string }[]; disabled?: boolean; onChange: (c: CourseChoice) => void }) {
	const NEW = "\u0000new";
	const selected = value === null ? "" : typeof value === "string" ? value : NEW;
	return (
		<select
			aria-label={`Class for ${folderTitle(name)}`}
			disabled={disabled}
			value={selected}
			onChange={(e) => onChange(e.target.value === NEW ? { new: name || "Notes" } : e.target.value || null)}
			className="h-8 w-full max-w-56 rounded-md border border-border bg-surface px-2 text-sm disabled:cursor-not-allowed"
		>
			{name !== LOOSE && !courses.some((c) => c.label.toLowerCase() === name.toLowerCase()) && <option value={NEW}>New class “{name}”</option>}
			{courses.map((c) => (
				<option key={c.key} value={c.key}>
					{c.label}
				</option>
			))}
			<option value="">No class</option>
		</select>
	);
}
