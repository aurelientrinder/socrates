/**
 * WATCHED NOTES FOLDER — the pure rules (2026-11-01). The learner points
 * Socrates at one folder (a reMarkable export folder, a Drive folder…) with
 * one subfolder per class. Each subfolder is linked to a class, can be
 * excluded, and decides whether its files already there are imported and
 * whether new ones are picked up. Per class, files are processed one by
 * one, all at once on a click, or automatically as they appear.
 *
 * THE LAW: no page is ever read or sent to the map twice. Every page of
 * every file gets a fingerprint (core: a hash of what is drawn/written on
 * it, computed locally, free); a page whose fingerprint is already on the
 * map is skipped wherever it shows up again: a renamed copy, a file moved
 * back out of Processed, a re-exported notebook. Only pages never seen cost
 * a model call. A re-exported notebook therefore costs its NEW pages only;
 * pages that changed in place ("edited") are flagged for the learner and
 * never read on their own.
 *
 * This module is pure (no fs): the server (src/server/notes-folder.ts)
 * walks the folder, fingerprints pages, and applies these rules.
 */

/** Where finished files go, inside their class folder. */
export const PROCESSED_DIR = "Processed";

/** The folder key of the files sitting directly in the watched folder. */
export const LOOSE = "";

export type FolderMode = "pick" | "all" | "auto";
export const FOLDER_MODES: readonly FolderMode[] = ["pick", "all", "auto"];

export interface WatchedFolderSettings {
	/** The class (course group key) its notes go to; null = no class. */
	course: string | null;
	/** Files that were already there when the folder was set up are listed for processing. */
	include: boolean;
	/** New files that appear later are picked up. */
	watch: boolean;
	mode: FolderMode;
}

export interface NotesFolderConfig {
	/** Absolute path of the watched folder. */
	root: string;
	/** Subfolder name (LOOSE for the root's own files) → its settings.
	 *  A subfolder that is not here has not been set up yet. */
	folders: Record<string, WatchedFolderSettings>;
	/** Subfolders the learner excluded (kept so they are not asked about again). */
	excluded: string[];
	setUpAt: string;
}

export type FileStatus =
	/** Ready to process (listed, nothing spent yet). */
	| "waiting"
	/** In the line to process (asked for, nothing spent yet). */
	| "queued"
	| "processing"
	/** Every page is on the map (or the learner kept the edits as they are). */
	| "processed"
	/** Stopped with an error. Never retried on its own: the learner clicks Retry. */
	| "failed"
	/** Not included (an older file of a folder set up without its existing files,
	 *  or a new file of a folder that is not watched). */
	| "skipped";

export interface FileRecord {
	/** Identity: the path inside the watched folder with the Processed step taken
	 *  out ("Analyse/Chapitre 1.pdf"), so a notebook keeps its record when it is
	 *  moved to Processed and when a newer export of it arrives. */
	key: string;
	/** The top subfolder it belongs to (LOOSE for the root's own files). */
	folder: string;
	/** The note's name in the Library ("Analyse › Chapitre 1.pdf"). */
	name: string;
	/** Where the file sits now, relative to the watched folder. */
	at: string;
	/** Content hash of the version on disk, with its size and mtime (a cheap
	 *  "unchanged" check that spares rehashing). */
	hash: string;
	size: number;
	mtimeMs: number;
	/** The fingerprint of each page of the version on disk, in order. */
	pages: string[];
	/** How many pages the version last processed had (0 = never processed):
	 *  an unread page before this index is an edit, one after it is new. */
	baselinePages: number;
	status: FileStatus;
	error?: string;
	/** Progress line while processing ("Reading handwriting, page 3 of 12"). */
	step?: string;
	firstSeen: string;
	processedAt?: string;
	/** The file is gone from the folder (kept so its pages stay known). */
	gone?: boolean;
	/** Moving it into Processed failed (read-only folder…); it is still done. */
	moveError?: string;
	/** Queued by "Read the edited pages": this run reads the edits too. */
	withEdits?: boolean;
}

export interface PagePlan {
	/** 1-based page numbers to read: never seen, past the processed version's length. */
	newPages: number[];
	/** 1-based page numbers that changed in place since the last processed version. */
	editedPages: number[];
}

/**
 * Which pages of a file still need reading. A page is unread when its
 * fingerprint is not on the map (`known`). Unread pages at a position the
 * processed version already had are edits; the rest are new. A fingerprint
 * that repeats inside the file (blank template pages) is read once.
 */
export function pagePlan(pages: readonly string[], known: ReadonlySet<string>, baselinePages: number): PagePlan {
	const newPages: number[] = [];
	const editedPages: number[] = [];
	const seen = new Set<string>();
	pages.forEach((fp, i) => {
		if (known.has(fp) || seen.has(fp)) return;
		seen.add(fp);
		(i < baselinePages ? editedPages : newPages).push(i + 1);
	});
	return { newPages, editedPages };
}

/** "Analyse/Processed/Chapitre 1.pdf" → "Analyse/Chapitre 1.pdf"; loose files too. */
export function recordKeyFor(relPath: string): string {
	const parts = relPath.split(/[\\/]+/).filter(Boolean);
	if (parts[0] === PROCESSED_DIR) return parts.slice(1).join("/");
	if (parts.length > 2 && parts[1] === PROCESSED_DIR) return [parts[0], ...parts.slice(2)].join("/");
	return parts.join("/");
}

/** The top subfolder of a record key (LOOSE for a file directly in the root). */
export function folderOf(key: string): string {
	const parts = key.split("/");
	return parts.length > 1 ? parts[0]! : LOOSE;
}

/** Where a processed file goes: "Analyse/Chapitre 1.pdf" → "Analyse/Processed/Chapitre 1.pdf". */
export function processedPathFor(key: string): string {
	const parts = key.split("/");
	if (parts.length === 1) return `${PROCESSED_DIR}/${parts[0]}`;
	return [parts[0], PROCESSED_DIR, ...parts.slice(1)].join("/");
}

/** Is this relative path inside a Processed folder? */
export function isProcessedPath(relPath: string): boolean {
	return recordKeyFor(relPath) !== relPath.split(/[\\/]+/).filter(Boolean).join("/");
}

/** The folder a new file's first status comes from: listed for processing, or skipped. */
export function firstStatus(settings: WatchedFolderSettings, atSetUp: boolean): FileStatus {
	return (atSetUp ? settings.include : settings.watch) ? "waiting" : "skipped";
}

/** Folders the scan walks: set up and not excluded (a folder with both switches
 *  off is excluded at set-up, so it never reaches the config). */
export function scannedFolders(config: NotesFolderConfig): string[] {
	return Object.keys(config.folders);
}

/** The settings a folder gets by default in the set-up window. */
export function defaultFolderSettings(course: string | null): WatchedFolderSettings {
	return { course, include: true, watch: true, mode: "pick" };
}

export function isFolderMode(v: unknown): v is FolderMode {
	return typeof v === "string" && (FOLDER_MODES as readonly string[]).includes(v);
}

/** Files of a folder that automatic mode may start on its own: waiting only
 *  (never a failed one: a failure waits for the learner's Retry). */
export function autoCandidates(records: readonly FileRecord[], config: NotesFolderConfig): FileRecord[] {
	return records.filter((r) => !r.gone && r.status === "waiting" && config.folders[r.folder]?.mode === "auto");
}
