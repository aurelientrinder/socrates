/**
 * RESTORE: put the learner's data back from a daily snapshot or from an
 * export file (backup.ts makes both).
 *
 * Restoring REPLACES sessions, the map, flashcards, exams, digests, course
 * links and settings with what the snapshot holds, so before anything is
 * touched the current data is copied to backups/before-restore-<time>/, and
 * the swap only starts after every file was checked. Notes originals and
 * API keys are not part of a snapshot and are left as they are.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS, SETTINGS_FILE } from "../../config.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { renameWithRetry, writeFileAtomic } from "../store/fs-atomic.ts";
import { backupsDir, collect, DATA_FOLDERS, type DataExport } from "./backup.ts";
import { resetChatDigestCache } from "./chat-digests.ts";
import { runningTurnCount } from "./turn-runs.ts";

const KEEP_SAFETY_COPIES = 3;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const SAFETY = /^before-restore-\d{8}-\d{6}$/;
/** A relative path inside one of the data folders, json/jsonl only. */
const SAFE_PATH = new RegExp(`^(?:${DATA_FOLDERS.join("|")})(?:/[A-Za-z0-9][A-Za-z0-9._-]*)+\\.jsonl?$`);
const MAX_FILES = 200_000;

export class RestoreError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}

export interface SnapshotInfo {
	/** Folder name under backups/ (a date, or a safety copy). */
	name: string;
	kind: "daily" | "before-restore";
	/** Sessions the snapshot holds. */
	sessions: number;
}

function countJson(dir: string): number {
	try {
		return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
	} catch {
		return 0;
	}
}

/** Snapshots on disk, newest first. */
export function listSnapshots(): SnapshotInfo[] {
	let names: string[];
	try {
		names = fs.readdirSync(backupsDir());
	} catch {
		return [];
	}
	return names
		.filter((n) => DAY.test(n) || SAFETY.test(n))
		.sort()
		.reverse()
		.map((name) => ({ name, kind: DAY.test(name) ? "daily" : "before-restore", sessions: countJson(path.join(backupsDir(), name, "chats")) }));
}

function busyReason(): string | null {
	if (runningTurnCount() > 0) return "A session is answering right now. Restore when it has finished.";
	if (extractionStatuses().length > 0) return "Notes are being added to your map right now. Restore when that has finished.";
	return null;
}

/** Check a set of files before anything is replaced. */
function validate(files: Record<string, string>): void {
	const names = Object.keys(files);
	if (names.length === 0) throw new RestoreError("That file has no data in it.");
	if (names.length > MAX_FILES) throw new RestoreError("That file has too many entries to be a Socrates export.");
	for (const name of names) {
		if (name === "settings.json") continue;
		if (!SAFE_PATH.test(name) || name.split("/").includes("..")) throw new RestoreError(`Unexpected entry in the file: ${name.slice(0, 80)}`);
	}
	for (const [name, text] of Object.entries(files)) {
		if (typeof text !== "string") throw new RestoreError(`Entry ${name.slice(0, 80)} is not text.`);
		if (name.endsWith(".json")) {
			try {
				JSON.parse(text);
			} catch {
				throw new RestoreError(`Entry ${name.slice(0, 80)} is damaged (not valid JSON). Nothing was changed.`);
			}
		}
	}
}

function stamp(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** Copy today's data aside, so a restore can itself be undone. */
function makeSafetyCopy(now: Date): string {
	const name = `before-restore-${stamp(now)}`;
	const dir = path.join(backupsDir(), name);
	fs.mkdirSync(dir, { recursive: true });
	for (const folder of DATA_FOLDERS) {
		const from = path.join(PATHS.data, folder);
		if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, folder), { recursive: true });
	}
	if (fs.existsSync(SETTINGS_FILE)) fs.copyFileSync(SETTINGS_FILE, path.join(dir, "settings.json"));
	const old = fs.readdirSync(backupsDir()).filter((n) => SAFETY.test(n)).sort().slice(0, -KEEP_SAFETY_COPIES);
	for (const n of old) fs.rmSync(path.join(backupsDir(), n), { recursive: true, force: true });
	return name;
}

function restoreFiles(files: Record<string, string>, now: Date): { files: number; safetyCopy: string } {
	validate(files);
	const busy = busyReason();
	if (busy) throw new RestoreError(busy, 409);

	const safetyCopy = makeSafetyCopy(now);
	const staging = path.join(PATHS.data, `.restore-${stamp(now)}`);
	fs.rmSync(staging, { recursive: true, force: true });
	try {
		// Everything is written beside the live data first, then swapped in.
		for (const [name, text] of Object.entries(files)) {
			if (name === "settings.json") continue;
			const target = path.join(staging, name);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, text, "utf-8");
		}
		for (const folder of DATA_FOLDERS) {
			const live = path.join(PATHS.data, folder);
			const next = path.join(staging, folder);
			fs.rmSync(live, { recursive: true, force: true });
			if (fs.existsSync(next)) renameWithRetry(next, live);
		}
		if (files["settings.json"] !== undefined) writeFileAtomic(SETTINGS_FILE, files["settings.json"]);
	} finally {
		fs.rmSync(staging, { recursive: true, force: true });
	}
	resetChatDigestCache();
	return { files: Object.keys(files).length, safetyCopy };
}

/** Restore from one of the snapshots listed by listSnapshots(). */
export function restoreSnapshot(name: unknown, now: Date = new Date()) {
	if (typeof name !== "string" || !(DAY.test(name) || SAFETY.test(name))) throw new RestoreError("Pick one of the snapshots in the list.");
	const dir = path.join(backupsDir(), name);
	if (!fs.existsSync(dir)) throw new RestoreError("That snapshot is gone.", 404);
	const files: Record<string, string> = {};
	for (const folder of DATA_FOLDERS) collect(path.join(dir, folder), folder, files);
	try {
		files["settings.json"] = fs.readFileSync(path.join(dir, "settings.json"), "utf-8");
	} catch {
		// the snapshot had no settings
	}
	return restoreFiles(files, now);
}

/** Restore from the JSON file Settings → Export made. */
export function restoreExport(bundle: unknown, now: Date = new Date()) {
	const b = bundle as Partial<DataExport> | null;
	if (!b || b.app !== "socrates" || b.format !== 1 || !b.files || typeof b.files !== "object" || Array.isArray(b.files)) {
		throw new RestoreError("That is not a Socrates export file.");
	}
	return restoreFiles(b.files as Record<string, string>, now);
}
