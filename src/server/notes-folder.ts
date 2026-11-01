/**
 * WATCHED NOTES FOLDER service (2026-11-01): the learner's notes folder
 * (a reMarkable export folder, a Drive folder…), one subfolder per class,
 * turned into notes on the map — each page read ONCE, ever.
 *
 * Files (data dir, notes-folder/):
 *   config.json  — the watched folder and each subfolder's settings
 *   ledger.json  — every file seen (per watched folder) and every page
 *                  fingerprint already on the map ("known"). Never cleared:
 *                  stopping or changing the watched folder keeps it, so a
 *                  folder watched again later costs nothing for what was read.
 *   pages.json   — the text of every page read (fingerprint → text), so a
 *                  page read once is never sent to a model again, even when
 *                  a later step of its file failed.
 *
 * The rules (core/notes-folder.ts): a page is read only when its
 * fingerprint is not known. Nothing runs without the learner's say-so
 * except in a class set to automatic, and even there only "waiting" files
 * start: a failed file waits for Retry. One file is processed at a time, so
 * a new file never makes the folder be read again.
 *
 * Order of a run, built so a crash can never cause a second read:
 *   1. status "processing" written to disk before any model call;
 *   2. each batch of pages read is written to pages.json at once;
 *   3. the new pages go to the map (the notes pipeline resumes a half-done
 *      run by its chunk fingerprints);
 *   4. the pages are marked known, then the file moves to Processed.
 * A run cut short (Socrates closed) comes back as "failed" with Retry,
 * which pays only for what is still missing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PATHS } from "../../config.ts";
import {
	autoCandidates,
	courseGroupFor,
	courseKeyFor,
	firstStatus,
	folderNoteName,
	folderOf,
	isFolderMode,
	isNotesFile,
	LOOSE,
	pagePlan,
	PROCESSED_DIR,
	processedPathFor,
	recordKeyFor,
	type FileRecord,
	type NotesFolderConfig,
	type WatchedFolderSettings,
} from "../core/index.ts";
import { renameWithRetry } from "../store/fs-atomic.ts";
import { notesLibrary } from "../store/notes.ts";
import { getHeadless } from "../agent/subagents/headless.ts";
import { addNotesToCourse, createCourse, readCourseLinks } from "./courses.ts";
import {
	HandwritingRequestError,
	HandwritingUnavailableError,
	handwritingKey,
	PAGES_PER_REQUEST,
	readHandwriting,
	type PageImage,
} from "./handwriting.ts";
import { isPdfBytes, pdfPagePrints, sha256, textPagePrints, type PrintedPage } from "./page-prints.ts";
import { MAX_NOTE_BYTES } from "./notes.ts";

const DIR = () => path.join(PATHS.data, "notes-folder");
const CONFIG_FILE = () => path.join(DIR(), "config.json");
const LEDGER_FILE = () => path.join(DIR(), "ledger.json");
const PAGES_FILE = () => path.join(DIR(), "pages.json");

/** A refusal the learner can act on (routes answer 400/404 with the message). */
export class NotesFolderError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}

interface Ledger {
	/** Watched folder (absolute path) → record key → record. */
	roots: Record<string, Record<string, FileRecord>>;
	/** Page fingerprint → the note it went to the map in. */
	known: Record<string, string>;
	/** Edited pages the learner chose to keep as they were: never read, never flagged again. */
	ignored: Record<string, true>;
	/** Daily quota used up: automatic processing waits until then (ms epoch). */
	pausedUntil?: number;
	pauseReason?: string;
}

// ─── Storage ────────────────────────────────────────────────────────────────

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return null;
	}
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`);
	renameWithRetry(tmp, file);
}

export function readConfig(): NotesFolderConfig | null {
	const raw = readJson<Partial<NotesFolderConfig>>(CONFIG_FILE());
	if (!raw || typeof raw.root !== "string" || !raw.folders || typeof raw.folders !== "object") return null;
	const folders: Record<string, WatchedFolderSettings> = {};
	for (const [name, v] of Object.entries(raw.folders)) {
		if (!v || typeof v !== "object") continue;
		folders[name] = {
			course: typeof v.course === "string" ? v.course : null,
			include: v.include !== false,
			watch: v.watch !== false,
			mode: isFolderMode(v.mode) ? v.mode : "pick",
		};
	}
	return {
		root: raw.root,
		folders,
		excluded: Array.isArray(raw.excluded) ? raw.excluded.filter((x): x is string => typeof x === "string") : [],
		setUpAt: typeof raw.setUpAt === "string" ? raw.setUpAt : new Date().toISOString(),
	};
}

function writeConfig(config: NotesFolderConfig | null): void {
	if (config === null) fs.rmSync(CONFIG_FILE(), { force: true });
	else writeJson(CONFIG_FILE(), config);
}

function readLedger(): Ledger {
	const raw = readJson<Partial<Ledger>>(LEDGER_FILE());
	return {
		roots: raw?.roots && typeof raw.roots === "object" ? raw.roots : {},
		known: raw?.known && typeof raw.known === "object" ? raw.known : {},
		ignored: raw?.ignored && typeof raw.ignored === "object" ? raw.ignored : {},
		...(typeof raw?.pausedUntil === "number" ? { pausedUntil: raw.pausedUntil } : {}),
		...(typeof raw?.pauseReason === "string" ? { pauseReason: raw.pauseReason } : {}),
	};
}

function writeLedger(ledger: Ledger): void {
	writeJson(LEDGER_FILE(), ledger);
}

function readPageTexts(): Record<string, string> {
	const raw = readJson<Record<string, string>>(PAGES_FILE());
	return raw && typeof raw === "object" ? raw : {};
}

/** Pages that need no reading: on the map, or edits the learner kept as they were. */
function settledPages(ledger: Ledger): Set<string> {
	return new Set([...Object.keys(ledger.known), ...Object.keys(ledger.ignored)]);
}

/** In-process state, on globalThis: Next may load this module once per route
 *  bundle, and there must be ONE watcher, ONE worker and ONE ledger lock. */
interface Runtime {
	chain: Promise<unknown>;
	scanning: Promise<void> | null;
	rescanSoon: ReturnType<typeof setTimeout> | null;
	working: Promise<void> | null;
	watcher: fs.FSWatcher | null;
	watchedRoot: string | null;
	poll: ReturnType<typeof setInterval> | null;
	debounce: ReturnType<typeof setTimeout> | null;
	started: boolean;
}
const G = globalThis as typeof globalThis & { __lhNotesFolder?: Runtime };
const rt: Runtime = (G.__lhNotesFolder ??= {
	chain: Promise.resolve(),
	scanning: null,
	rescanSoon: null,
	working: null,
	watcher: null,
	watchedRoot: null,
	poll: null,
	debounce: null,
	started: false,
});

/** One writer at a time: the scanner and the worker both edit the ledger. */
function locked<T>(fn: () => Promise<T> | T): Promise<T> {
	const next = rt.chain.then(fn, fn);
	rt.chain = next.catch(() => {});
	return next;
}

function records(ledger: Ledger, root: string): Record<string, FileRecord> {
	return (ledger.roots[root] ??= {});
}

// ─── Dependencies (swapped in tests) ────────────────────────────────────────

export interface NotesFolderDeps {
	/** The notes pipeline (extraction.importNotes). */
	importNotes(input: { filePath: string; text: string }): Promise<unknown>;
	/** Rendered pages → their text (Gemini). */
	readPages(images: readonly PageImage[]): Promise<Map<number, string>>;
	/** Render pages of a PDF on disk to PNGs. */
	renderPages(pdfPath: string, pages: number[]): Promise<PageImage[]>;
	now(): number;
	/** Wait (per-minute rate limits). */
	sleep(ms: number): Promise<void>;
}

const realDeps: NotesFolderDeps = {
	async importNotes(input) {
		const { extraction } = await import("./chat-handler.ts");
		return extraction.importNotes(input);
	},
	async readPages(images) {
		const apiKey = handwritingKey();
		if (!apiKey) throw new HandwritingUnavailableError();
		return readHandwriting(images, { apiKey });
	},
	async renderPages(pdfPath, pages) {
		const out = await getHeadless().renderPdfPages(pdfPath, pages, { dpi: 110 });
		return out.map((p) => ({ page: p.page, png: p.png }));
	},
	now: () => Date.now(),
	sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
};

let deps: NotesFolderDeps = realDeps;
/** Tests only. */
export function setNotesFolderDeps(next: Partial<NotesFolderDeps> | null): void {
	deps = next ? { ...realDeps, ...next } : realDeps;
}

// ─── Walking the folder ─────────────────────────────────────────────────────

function cleanRoot(input: unknown): string {
	if (typeof input !== "string" || !input.trim()) throw new NotesFolderError("Choose a folder.");
	const root = path.resolve(input.trim());
	let stat: fs.Stats;
	try {
		stat = fs.statSync(root);
	} catch {
		throw new NotesFolderError("That folder can't be found.", 404);
	}
	if (!stat.isDirectory()) throw new NotesFolderError("That is a file, not a folder.");
	if (root === path.parse(root).root || root === os.homedir()) throw new NotesFolderError("Pick the folder your notes are in, not a whole drive or your home folder.");
	return root;
}

const hidden = (name: string) => name.startsWith(".") || name.startsWith("~$") || name === "desktop.ini" || name === "Thumbs.db";

/** Subfolders of the watched folder (Processed is the loose files' own). */
function subfolders(root: string): string[] {
	try {
		return fs
			.readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !hidden(e.name) && e.name !== PROCESSED_DIR)
			.map((e) => e.name)
			.sort((a, b) => a.localeCompare(b));
	} catch {
		return [];
	}
}

/** Notes files under a folder, as paths relative to the watched folder. */
function notesFilesIn(root: string, folder: string): string[] {
	const out: string[] = [];
	const walk = (rel: string, depth: number) => {
		if (depth > 8) return;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
		} catch {
			return;
		}
		for (const e of entries) {
			if (hidden(e.name)) continue;
			const child = rel ? `${rel}/${e.name}` : e.name;
			if (e.isDirectory()) {
				// The loose files' walk stays at the top (and in its own Processed).
				if (folder === LOOSE && !(rel === "" && e.name === PROCESSED_DIR)) continue;
				walk(child, depth + 1);
			} else if (e.isFile() && isNotesFile(e.name)) {
				out.push(child);
			}
		}
	};
	walk(folder, 0);
	return out;
}

export interface FolderPreview {
	name: string;
	files: number;
	/** The class it matches by name (a group key), if any. */
	course: string | null;
	courseLabel: string | null;
}

/** What the set-up window lists: the subfolders (and the loose files) of a folder. */
export function previewFolder(input: unknown): { root: string; folders: FolderPreview[]; loose: number; courses: { key: string; label: string }[] } {
	const root = cleanRoot(input);
	const links = readCourseLinks();
	const folders = subfolders(root).map((name): FolderPreview => {
		const match = matchCourse(name, links);
		return { name, files: notesFilesIn(root, name).length, course: match?.key ?? null, courseLabel: match ? links[match.key]!.label : null };
	});
	const courses = Object.entries(links).map(([key, g]) => ({ key, label: g.label })).sort((a, b) => a.label.localeCompare(b.label));
	return { root, folders, loose: notesFilesIn(root, LOOSE).length, courses };
}

function matchCourse(name: string, links: ReturnType<typeof readCourseLinks>): { key: string } | null {
	const found = courseGroupFor(links, courseKeyFor(name));
	if (found) return { key: found.key };
	const lower = name.trim().toLowerCase();
	const byLabel = Object.entries(links).find(([, g]) => g.label.trim().toLowerCase() === lower);
	return byLabel ? { key: byLabel[0] } : null;
}

// ─── Set-up ────────────────────────────────────────────────────────────────

export interface FolderChoice {
	/** A class key, { new: "Label" } to make one, or null for no class. */
	course: string | { new: string } | null;
	include: boolean;
	watch: boolean;
	mode?: unknown;
}

function resolveCourse(course: FolderChoice["course"]): string | null {
	if (course === null || course === undefined) return null;
	if (typeof course === "string") {
		if (!readCourseLinks()[course]) throw new NotesFolderError("That class is gone. Reload the page.", 404);
		return course;
	}
	if (typeof course === "object" && typeof course.new === "string") return createCourse({ label: course.new }).key;
	throw new NotesFolderError("Pick a class.");
}

/**
 * Save the set-up window: the watched folder and every listed subfolder's
 * choice. A subfolder with both switches off is excluded. Folders set up
 * here are scanned at once (their existing files listed per "include").
 */
export async function setUpFolder(input: { root: unknown; folders: Record<string, FolderChoice> }): Promise<NotesFolderState> {
	const root = cleanRoot(input.root);
	if (!input.folders || typeof input.folders !== "object") throw new NotesFolderError("Missing folder choices.");
	const previous = readConfig();
	const same = previous?.root === root;
	const config: NotesFolderConfig = same ? previous! : { root, folders: {}, excluded: [], setUpAt: new Date(deps.now()).toISOString() };
	const fresh: string[] = [];
	for (const [name, choice] of Object.entries(input.folders)) {
		if (name !== LOOSE && !subfolders(root).includes(name)) continue;
		if (!choice.include && !choice.watch) {
			delete config.folders[name];
			if (!config.excluded.includes(name)) config.excluded.push(name);
			continue;
		}
		const before = config.folders[name];
		config.folders[name] = {
			course: resolveCourse(choice.course),
			include: !!choice.include,
			watch: !!choice.watch,
			mode: isFolderMode(choice.mode) ? choice.mode : (before?.mode ?? "pick"),
		};
		config.excluded = config.excluded.filter((x) => x !== name);
		if (!before) fresh.push(name);
		else if (!before.include && choice.include) await includeSkipped(root, name);
	}
	writeConfig(config);
	await scanNotesFolder({ setUp: new Set(fresh) });
	startWatching();
	return notesFolderState();
}

/** Turning "include" on later: the files it skipped are listed again. */
async function includeSkipped(root: string, folder: string): Promise<void> {
	await locked(() => {
		const ledger = readLedger();
		for (const r of Object.values(records(ledger, root))) {
			if (r.folder === folder && r.status === "skipped") r.status = "waiting";
		}
		writeLedger(ledger);
	});
}

/** Change one subfolder later: its class, mode, switches, or exclude it. */
export async function updateFolder(name: string, patch: { course?: FolderChoice["course"]; mode?: unknown; include?: unknown; watch?: unknown; exclude?: unknown }): Promise<NotesFolderState> {
	const config = readConfig();
	if (!config) throw new NotesFolderError("No folder is watched.", 404);
	if (patch.exclude === true) {
		delete config.folders[name];
		if (!config.excluded.includes(name)) config.excluded.push(name);
		writeConfig(config);
		return notesFolderState();
	}
	const current = config.folders[name];
	if (!current) throw new NotesFolderError("That folder is not set up.", 404);
	if (patch.course !== undefined) current.course = resolveCourse(patch.course);
	if (patch.mode !== undefined) {
		if (!isFolderMode(patch.mode)) throw new NotesFolderError("Unknown mode.");
		current.mode = patch.mode;
	}
	if (typeof patch.watch === "boolean") current.watch = patch.watch;
	if (typeof patch.include === "boolean") {
		if (!current.include && patch.include) await includeSkipped(config.root, name);
		current.include = patch.include;
	}
	writeConfig(config);
	if (current.mode === "auto") kick();
	return notesFolderState();
}

/** Stop watching. The ledger stays: watching it again never re-reads a page. */
export function stopWatching(): NotesFolderState {
	writeConfig(null);
	closeWatcher();
	return notesFolderState();
}

// ─── Scanning ──────────────────────────────────────────────────────────────

/** A file still being written (a cloud folder syncing it) is left for the next scan. */
const SETTLE_MS = 8_000;

async function printFile(name: string, bytes: Uint8Array): Promise<PrintedPage[]> {
	if (isPdfBytes(name, bytes)) return pdfPagePrints(bytes);
	return textPagePrints(new TextDecoder("utf-8").decode(bytes));
}

/**
 * Walk the set-up subfolders and bring the ledger up to date. Local work only
 * (hashing, fingerprints): nothing here calls a model. Unchanged files (same
 * size and mtime) are not even reread.
 */
export async function scanNotesFolder(opts: { setUp?: ReadonlySet<string> } = {}): Promise<void> {
	if (rt.scanning && !opts.setUp) return rt.scanning;
	if (rt.scanning) await rt.scanning;
	const run = (async () => {
		const config = readConfig();
		if (!config) return;
		const found = new Map<string, { at: string; size: number; mtimeMs: number }>();
		let unsettled = false;
		for (const folder of Object.keys(config.folders)) {
			for (const rel of notesFilesIn(config.root, folder)) {
				let stat: fs.Stats;
				try {
					stat = fs.statSync(path.join(config.root, rel));
				} catch {
					continue;
				}
				if (deps.now() - stat.mtimeMs < SETTLE_MS) {
					unsettled = true;
					continue;
				}
				const key = recordKeyFor(rel);
				const entry = { at: rel, size: stat.size, mtimeMs: stat.mtimeMs };
				const other = found.get(key);
				// Both a newer export and its Processed copy: the one outside Processed is the current version.
				if (!other || (other.at !== key && rel === key)) found.set(key, entry);
			}
		}
		const ledger = await locked(() => readLedger());
		const known = settledPages(ledger);
		const recs = records(ledger, config.root);
		const changes: FileRecord[] = [];
		/** Files with nothing left to read: they go to Processed. */
		const done = new Set<string>();
		for (const [key, f] of found) {
			const rec = recs[key];
			if (rec && rec.size === f.size && rec.mtimeMs === f.mtimeMs && rec.at === f.at && !rec.gone) continue;
			if (rec && (rec.status === "processing" || rec.status === "queued")) continue;
			let bytes: Uint8Array;
			try {
				bytes = new Uint8Array(fs.readFileSync(path.join(config.root, f.at)));
			} catch {
				continue;
			}
			const hash = sha256(bytes);
			const folder = folderOf(key);
			const settings = config.folders[folder];
			if (!settings) continue;
			if (rec && rec.hash === hash) {
				changes.push({ ...rec, at: f.at, size: f.size, mtimeMs: f.mtimeMs, gone: false });
				// Moved back out of Processed with nothing new: it goes back.
				const plan = pagePlan(rec.pages, known, rec.baselinePages);
				if (rec.status === "processed" && plan.newPages.length === 0 && plan.editedPages.length === 0 && f.at === key) done.add(key);
				continue;
			}
			let pages: string[];
			let error: string | undefined;
			if (bytes.byteLength > MAX_NOTE_BYTES) {
				pages = [];
				error = `This file is over the ${MAX_NOTE_BYTES / 1024 / 1024} MB limit. Split it into smaller parts.`;
			} else {
				try {
					pages = (await printFile(f.at, bytes)).map((p) => p.fp);
				} catch (err) {
					pages = [];
					error = `This file can't be opened (${err instanceof Error ? err.message : String(err)}).`;
				}
			}
			const baselinePages = rec?.baselinePages ?? 0;
			const plan = pagePlan(pages, known, baselinePages);
			const base: FileRecord = {
				key,
				folder,
				name: folderNoteName(key),
				at: f.at,
				hash,
				size: f.size,
				mtimeMs: f.mtimeMs,
				pages,
				baselinePages,
				status: "waiting",
				firstSeen: rec?.firstSeen ?? new Date(deps.now()).toISOString(),
				...(rec?.processedAt ? { processedAt: rec.processedAt } : {}),
			};
			if (error) {
				changes.push({ ...base, status: "failed", error });
			} else if (pages.length > 0 && plan.newPages.length === 0) {
				// Nothing new (a copy, a re-export with no new page, a file moved back out of Processed).
				// Edited pages, if any, are flagged on it and it stays where it is.
				changes.push({ ...base, status: "processed", processedAt: rec?.processedAt ?? new Date(deps.now()).toISOString() });
				if (plan.editedPages.length === 0) done.add(key);
			} else if (!rec) {
				changes.push({ ...base, status: firstStatus(settings, opts.setUp?.has(folder) ?? false) });
			} else {
				// A newer version with new pages: listed again, unless its folder skips new files.
				const status = rec.status === "skipped" ? "skipped" : rec.status === "processed" && !settings.watch ? "skipped" : "waiting";
				changes.push({ ...base, status });
			}
		}
		await locked(() => {
			const fresh = readLedger();
			const live = records(fresh, config.root);
			for (const c of changes) {
				const now = live[c.key];
				if (now && (now.status === "processing" || now.status === "queued")) continue;
				live[c.key] = c;
			}
			for (const [key, rec] of Object.entries(live)) {
				if (!found.has(key) && !rec.gone && rec.status !== "processing" && config.folders[rec.folder] && !stillThere(config.root, rec)) {
					live[key] = { ...rec, gone: true, ...(rec.status === "queued" ? { status: "waiting" as const } : {}) };
				}
			}
			writeLedger(fresh);
		});
		// Files with nothing new are moved out of the way, like processed ones.
		for (const key of done) await moveToProcessed(config.root, key);
		if (unsettled) {
			if (rt.rescanSoon) clearTimeout(rt.rescanSoon);
			rt.rescanSoon = setTimeout(() => void scanNotesFolder(), SETTLE_MS + 1_000);
			rt.rescanSoon.unref?.();
		}
		queueAuto();
	})();
	rt.scanning = run.finally(() => {
		rt.scanning = null;
	});
	return rt.scanning;
}

/** A file that only looked missing because it is being rewritten right now. */
function stillThere(root: string, rec: FileRecord): boolean {
	return fs.existsSync(path.join(root, rec.at)) || fs.existsSync(path.join(root, rec.key));
}

// ─── Processing ────────────────────────────────────────────────────────────

/** Ask for files to be processed. Only waiting (or, with retry, failed) files are queued. */
export async function requestProcessing(input: { keys?: unknown; folder?: unknown; all?: unknown; retry?: unknown; edited?: unknown }): Promise<NotesFolderState> {
	const config = readConfig();
	if (!config) throw new NotesFolderError("No folder is watched.", 404);
	await locked(() => {
		const ledger = readLedger();
		const recs = records(ledger, config.root);
		const keys = Array.isArray(input.keys) ? input.keys.filter((k): k is string => typeof k === "string") : [];
		const targets =
			input.all === true && typeof input.folder === "string"
				? Object.values(recs).filter((r) => r.folder === input.folder && !r.gone && r.status === "waiting")
				: keys.flatMap((k) => (recs[k] ? [recs[k]!] : []));
		for (const r of targets) {
			if (r.gone || !config.folders[r.folder]) continue;
			const startable = r.status === "waiting" || r.status === "skipped" || (input.retry === true && r.status === "failed");
			const edits = input.edited === true && r.status === "processed";
			if (!startable && !edits) continue;
			recs[r.key] = { ...r, status: "queued", step: undefined, error: undefined, withEdits: input.edited === true };
		}
		writeLedger(ledger);
	});
	kick();
	return notesFolderState();
}

/** Keep the edited pages as they are: the file is done and goes to Processed. */
export async function keepEdits(key: string): Promise<NotesFolderState> {
	const config = readConfig();
	if (!config) throw new NotesFolderError("No folder is watched.", 404);
	await locked(() => {
		const ledger = readLedger();
		const rec = records(ledger, config.root)[key];
		if (!rec) throw new NotesFolderError("That file is gone. Reload the page.", 404);
		for (const n of pagePlan(rec.pages, settledPages(ledger), rec.baselinePages).editedPages) ledger.ignored[rec.pages[n - 1]!] = true;
		writeLedger(ledger);
	});
	await moveToProcessed(config.root, key);
	return notesFolderState();
}

/** A skipped file (an older file of a folder set up without them) goes on the list. */
export async function includeFile(key: string): Promise<NotesFolderState> {
	const config = readConfig();
	if (!config) throw new NotesFolderError("No folder is watched.", 404);
	await locked(() => {
		const ledger = readLedger();
		const rec = records(ledger, config.root)[key];
		if (rec && rec.status === "skipped") rec.status = "waiting";
		writeLedger(ledger);
	});
	queueAuto();
	return notesFolderState();
}

/** Automatic classes: queue their waiting files (never failed ones). */
function queueAuto(): void {
	const config = readConfig();
	if (!config) return;
	void locked(() => {
		const ledger = readLedger();
		if (ledger.pausedUntil && ledger.pausedUntil > deps.now()) return false;
		const recs = records(ledger, config.root);
		const ready = autoCandidates(Object.values(recs), config);
		if (ready.length === 0) return false;
		for (const r of ready) recs[r.key] = { ...r, status: "queued" };
		writeLedger(ledger);
		return true;
	}).then((queued) => {
		if (queued) kick();
	});
}

/** Start the worker if it is not running. One file at a time, oldest request first. */
function kick(): void {
	if (rt.working) return;
	rt.working = (async () => {
		for (;;) {
			const config = readConfig();
			if (!config) return;
			const next = await locked(() => {
				const ledger = readLedger();
				const queued = Object.values(records(ledger, config.root)).filter((r) => r.status === "queued" && !r.gone);
				const rec = queued.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen))[0];
				if (!rec) return null;
				// Written to disk BEFORE anything is spent.
				records(ledger, config.root)[rec.key] = { ...rec, status: "processing", step: "Starting" };
				writeLedger(ledger);
				return rec;
			});
			if (!next) return;
			await processOne(config, next);
		}
	})().finally(() => {
		rt.working = null;
	});
}

/** For tests and the API: resolves when the queue is empty. */
export async function notesFolderSettled(): Promise<void> {
	for (;;) {
		await rt.chain;
		if (!rt.working && !rt.scanning) {
			// A queued kick may still be on its way through the lock.
			await new Promise((ok) => setImmediate(ok));
			await rt.chain;
			if (!rt.working && !rt.scanning) return;
		}
		await (rt.working ?? rt.scanning);
	}
}

async function setRecord(root: string, key: string, patch: Partial<FileRecord>): Promise<void> {
	await locked(() => {
		const ledger = readLedger();
		const rec = records(ledger, root)[key];
		if (rec) Object.assign(rec, patch);
		writeLedger(ledger);
	});
}

function pageHeader(n: number): string {
	return `--- Page ${n} ---`;
}

async function processOne(config: NotesFolderConfig, rec: FileRecord & { withEdits?: boolean }): Promise<void> {
	const { root } = config;
	const step = (text: string) => setRecord(root, rec.key, { step: text });
	let tmpPdf: string | null = null;
	try {
		const abs = path.join(root, rec.at);
		const bytes = new Uint8Array(fs.readFileSync(abs));
		if (sha256(bytes) !== rec.hash) {
			// Changed since it was listed: back to the list, the next scan updates it.
			await setRecord(root, rec.key, { status: "waiting", step: undefined, mtimeMs: 0 });
			void scanNotesFolder();
			return;
		}
		const pdf = isPdfBytes(rec.at, bytes);
		const printed = await printFile(rec.at, bytes);
		const fps = printed.map((p) => p.fp);
		const known = settledPages(readLedger());
		const plan = pagePlan(fps, known, rec.baselinePages);
		const toRead = [...plan.newPages, ...(rec.withEdits ? plan.editedPages : [])].sort((a, b) => a - b);
		const texts = readPageTexts();

		// Pages that need eyes and were never read: Gemini, a few at a time.
		const vision = toRead.filter((n) => printed[n - 1]!.needsVision && texts[printed[n - 1]!.fp] === undefined);
		for (const n of toRead) {
			const p = printed[n - 1]!;
			if (!p.needsVision && texts[p.fp] === undefined) texts[p.fp] = p.text;
		}
		if (vision.length > 0) {
			if (!pdf) throw new Error("This file needs reading by eye but is not a PDF.");
			tmpPdf = path.join(DIR(), "tmp", `${rec.hash.slice(0, 16)}.pdf`);
			fs.mkdirSync(path.dirname(tmpPdf), { recursive: true });
			fs.writeFileSync(tmpPdf, bytes);
			for (let i = 0; i < vision.length; i += PAGES_PER_REQUEST) {
				const batch = vision.slice(i, i + PAGES_PER_REQUEST);
				await step(`Reading handwriting, page ${Math.min(i + batch.length, vision.length)} of ${vision.length}`);
				const images = await deps.renderPages(tmpPdf, batch);
				const read = await readWithRetry(images);
				// Saved at once: a page read is never paid for again, whatever fails next.
				await locked(() => {
					const all = readPageTexts();
					for (const n of batch) {
						const fp = printed[n - 1]!.fp;
						const layer = printed[n - 1]!.text;
						const ink = read.get(n) ?? "";
						all[fp] = layer && ink && !ink.includes(layer.slice(0, 40)) ? `${layer}\n\n${ink}` : ink || layer;
						texts[fp] = all[fp]!;
					}
					writeJson(PAGES_FILE(), all);
				});
			}
		} else {
			await locked(() => {
				const all = readPageTexts();
				for (const n of toRead) all[printed[n - 1]!.fp] ??= texts[printed[n - 1]!.fp] ?? "";
				writeJson(PAGES_FILE(), all);
			});
		}

		// The whole file's text for the Library and the tutor; only the new pages for the map.
		const fullText = printed
			.map((p, i) => `${pageHeader(i + 1)}\n${texts[p.fp] ?? (pdf ? "[changed since it was last read: not read yet]" : "")}`)
			.join("\n\n");
		const meta = notesLibrary.save({
			name: rec.name,
			bytes,
			text: pdf ? fullText : printed.map((p) => p.text).join("\n\n"),
			kind: pdf ? "pdf" : "text",
			...(pdf ? { pages: printed.length } : {}),
		});
		const course = config.folders[rec.folder]?.course;
		if (course && readCourseLinks()[course]) addNotesToCourse(course, [meta.id]);

		const newText = toRead
			.map((n) => ({ n, text: (texts[printed[n - 1]!.fp] ?? "").trim() }))
			.filter((p) => p.text)
			.map((p) => (pdf ? `${pageHeader(p.n)}\n${p.text}` : p.text))
			.join("\n\n");
		if (newText) {
			await step(toRead.length === printed.length ? "Adding to your map" : `Adding ${toRead.length} new ${toRead.length === 1 ? "page" : "pages"} to your map`);
			await deps.importNotes({ filePath: rec.name, text: newText });
		}

		// Done: the pages are known, then the file moves to Processed.
		const after = await locked(() => {
			const ledger = readLedger();
			for (const n of toRead) ledger.known[printed[n - 1]!.fp] = meta.id;
			const live = records(ledger, root)[rec.key];
			const remaining = pagePlan(fps, settledPages(ledger), printed.length);
			if (live) {
				Object.assign(live, {
					status: "processed",
					step: undefined,
					error: undefined,
					pages: fps,
					baselinePages: printed.length,
					processedAt: new Date(deps.now()).toISOString(),
				});
				delete live.withEdits;
			}
			writeLedger(ledger);
			return remaining.editedPages.length;
		});
		if (after === 0) await moveToProcessed(root, rec.key);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const daily = err instanceof HandwritingRequestError && err.dailyQuota;
		const quota = daily || /PerDay|per day/i.test(message);
		await locked(() => {
			const ledger = readLedger();
			const live = records(ledger, root)[rec.key];
			// A used-up daily limit is not the file's fault: it goes back on the list
			// (pages already read are kept), and the queue waits for the limit to reset.
			if (live) Object.assign(live, { status: quota ? "waiting" : "failed", step: undefined, error: message });
			if (live) delete live.withEdits;
			if (quota) {
				ledger.pausedUntil = deps.now() + 6 * 60 * 60 * 1000;
				ledger.pauseReason = "The free daily limit is used up. Processing waits until it resets; pages already read are kept.";
				for (const r of Object.values(records(ledger, root))) if (r.status === "queued") r.status = "waiting";
			}
			writeLedger(ledger);
		});
	} finally {
		if (tmpPdf) fs.rmSync(tmpPdf, { force: true });
	}
}

/** A per-minute limit is waited out (a few times); anything else fails the file. */
async function readWithRetry(images: readonly PageImage[]): Promise<Map<number, string>> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await deps.readPages(images);
		} catch (err) {
			if (err instanceof HandwritingRequestError && err.rateLimited && attempt < 3) {
				const seconds = Number(/retry in ([\d.]+)s/i.exec(err.detail)?.[1] ?? /"retryDelay":\s*"(\d+)s"/.exec(err.detail)?.[1] ?? 30);
				await deps.sleep(Math.min(Math.max(seconds, 5), 90) * 1000);
				continue;
			}
			throw err;
		}
	}
}

async function moveToProcessed(root: string, key: string): Promise<void> {
	await locked(() => {
		const ledger = readLedger();
		const rec = records(ledger, root)[key];
		if (!rec || rec.gone) return;
		const dest = processedPathFor(key);
		if (rec.at === dest) return;
		const from = path.join(root, rec.at);
		const to = path.join(root, dest);
		try {
			fs.mkdirSync(path.dirname(to), { recursive: true });
			// The older version in Processed is replaced by this one (same notebook, newer export).
			if (fs.existsSync(to)) fs.rmSync(to, { force: true });
			renameWithRetry(from, to);
			const stat = fs.statSync(to);
			Object.assign(rec, { at: dest, mtimeMs: stat.mtimeMs, size: stat.size });
			delete rec.moveError;
		} catch (err) {
			rec.moveError = `Couldn't move it into ${PROCESSED_DIR} (${err instanceof Error ? err.message : String(err)}). It is done all the same and won't be read again.`;
		}
		writeLedger(ledger);
	});
}

// ─── Watching ──────────────────────────────────────────────────────────────

/** A rescan every few minutes catches what the OS watcher misses (network and cloud folders). */
const POLL_MS = 3 * 60 * 1000;

function closeWatcher(): void {
	rt.watcher?.close();
	rt.watcher = null;
	rt.watchedRoot = null;
}

function startWatching(): void {
	const config = readConfig();
	if (!config) return closeWatcher();
	if (rt.watchedRoot === config.root && rt.watcher) return;
	closeWatcher();
	try {
		rt.watcher = fs.watch(config.root, { recursive: true }, () => {
			if (rt.debounce) clearTimeout(rt.debounce);
			rt.debounce = setTimeout(() => void scanNotesFolder(), 2_500);
			rt.debounce.unref?.();
		});
		rt.watcher.on("error", () => closeWatcher());
		rt.watchedRoot = config.root;
	} catch {
		// No OS watcher here: the periodic rescan does the job.
	}
	if (!rt.poll) {
		rt.poll = setInterval(() => {
			startWatching();
			void scanNotesFolder();
		}, POLL_MS);
		rt.poll.unref?.();
	}
}

/**
 * Called by the routes (and once at server start): watch, recover from a
 * run cut short, scan, and resume the queue. Idempotent.
 */
export function ensureNotesFolder(): void {
	if (rt.started) return;
	rt.started = true;
	if (!readConfig()) return;
	void locked(() => {
		const ledger = readLedger();
		let changed = false;
		for (const recs of Object.values(ledger.roots)) {
			for (const r of Object.values(recs)) {
				if (r.status === "processing") {
					Object.assign(r, { status: "failed", step: undefined, error: "Stopped when Socrates closed. Retry continues where it stopped: pages already read are not paid for again." });
					changed = true;
				}
			}
		}
		if (changed) writeLedger(ledger);
	}).then(() => {
		startWatching();
		void scanNotesFolder().then(() => kick());
	});
}

/** Tests: forget the in-process state between cases. */
export function resetNotesFolderForTests(): void {
	closeWatcher();
	if (rt.poll) clearInterval(rt.poll);
	if (rt.rescanSoon) clearTimeout(rt.rescanSoon);
	if (rt.debounce) clearTimeout(rt.debounce);
	rt.poll = null;
	rt.rescanSoon = null;
	rt.debounce = null;
	rt.started = false;
}

// ─── The view ──────────────────────────────────────────────────────────────

export interface FolderFileView {
	key: string;
	/** The file name, with its path inside the class folder. */
	file: string;
	at: string;
	status: FileRecord["status"];
	pages: number;
	newPages: number;
	editedPages: number;
	/** A newer version of a file processed before. */
	update: boolean;
	error?: string;
	step?: string;
	processedAt?: string;
	moveError?: string;
}

export interface FolderView {
	name: string;
	settings: WatchedFolderSettings;
	courseLabel: string | null;
	files: FolderFileView[];
}

export interface NotesFolderState {
	config: NotesFolderConfig | null;
	folders: FolderView[];
	/** Subfolders that appeared and are not set up or excluded yet. */
	pending: string[];
	paused: { until: number; reason: string } | null;
	handwritingReady: boolean;
	busy: boolean;
	missing: boolean;
}

export function notesFolderState(): NotesFolderState {
	const config = readConfig();
	const ledger = readLedger();
	const handwritingReady = handwritingKey() !== null;
	const paused = ledger.pausedUntil && ledger.pausedUntil > deps.now() ? { until: ledger.pausedUntil, reason: ledger.pauseReason ?? "" } : null;
	if (!config) return { config: null, folders: [], pending: [], paused, handwritingReady, busy: false, missing: false };
	const missing = !fs.existsSync(config.root);
	const links = readCourseLinks();
	const known = settledPages(ledger);
	const recs = Object.values(records(ledger, config.root)).filter((r) => !r.gone);
	const folders = Object.entries(config.folders)
		.map(([name, settings]): FolderView => ({
			name,
			settings,
			courseLabel: settings.course ? (links[settings.course]?.label ?? null) : null,
			files: recs
				.filter((r) => r.folder === name)
				.map((r): FolderFileView => {
					const plan = pagePlan(r.pages, known, r.baselinePages);
					return {
						key: r.key,
						file: name === LOOSE ? r.key : r.key.slice(name.length + 1),
						at: r.at,
						status: r.status,
						pages: r.pages.length,
						newPages: plan.newPages.length,
						editedPages: plan.editedPages.length,
						update: r.baselinePages > 0,
						...(r.error ? { error: r.error } : {}),
						...(r.step ? { step: r.step } : {}),
						...(r.processedAt ? { processedAt: r.processedAt } : {}),
						...(r.moveError ? { moveError: r.moveError } : {}),
					};
				})
				.sort((a, b) => a.file.localeCompare(b.file)),
		}))
		.sort((a, b) => (a.name === LOOSE ? 1 : b.name === LOOSE ? -1 : a.name.localeCompare(b.name)));
	const pending = missing ? [] : subfolders(config.root).filter((n) => !config.folders[n] && !config.excluded.includes(n));
	const busy = recs.some((r) => r.status === "queued" || r.status === "processing");
	return { config, folders, pending, paused, handwritingReady, busy, missing };
}

/** Clear a daily-limit pause by hand ("Try now"). */
export function resumeNotesFolder(): NotesFolderState {
	const ledger = readLedger();
	delete ledger.pausedUntil;
	delete ledger.pauseReason;
	writeLedger(ledger);
	queueAuto();
	return notesFolderState();
}

