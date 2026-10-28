/**
 * YOUR DATA, SAFE: a daily snapshot and a one-file export.
 *
 * Everything the learner built (sessions, the knowledge map, flashcards,
 * mock exams, course links, settings) is plain JSON on disk. A snapshot
 * copies it once a day into data/backups/<date>/, keeping the last few,
 * so a bad write or a deleted file is a copy away. Notes originals and
 * API keys are left out: notes can be imported again and keys are
 * secrets that do not belong in a file you might share.
 *
 * The export is the same data as ONE downloadable JSON file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS, SETTINGS_FILE } from "../../config.ts";

/** Folders under data/ that hold the learner's own work. */
const DATA_FOLDERS = ["chats", "graph", "flashcards", "exams", "digests", "briefing"] as const;
const KEEP_SNAPSHOTS = 5;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function backupsDir(): string {
	return path.join(PATHS.data, "backups");
}

function dayName(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

const RUNNING_KEY = Symbol.for("lh.backupRunning");

/** Take today's snapshot unless there is one. Cheap when it exists (one
 *  directory listing); the copy itself runs in the background. */
export function backupIfDue(now: Date = new Date()): void {
	const g = globalThis as Record<symbol, boolean | undefined>;
	if (g[RUNNING_KEY]) return;
	const today = dayName(now);
	const dir = backupsDir();
	if (fs.existsSync(path.join(dir, today))) return;
	if (!DATA_FOLDERS.some((f) => fs.existsSync(path.join(PATHS.data, f)))) return;
	g[RUNNING_KEY] = true;
	void (async () => {
		const tmp = path.join(dir, `${today}.tmp`);
		try {
			await fs.promises.rm(tmp, { recursive: true, force: true });
			await fs.promises.mkdir(tmp, { recursive: true });
			for (const folder of DATA_FOLDERS) {
				const from = path.join(PATHS.data, folder);
				if (fs.existsSync(from)) await fs.promises.cp(from, path.join(tmp, folder), { recursive: true });
			}
			if (fs.existsSync(SETTINGS_FILE)) await fs.promises.copyFile(SETTINGS_FILE, path.join(tmp, "settings.json"));
			await fs.promises.rename(tmp, path.join(dir, today));
			const old = fs.readdirSync(dir).filter((d) => DAY.test(d)).sort().slice(0, -KEEP_SNAPSHOTS);
			for (const d of old) await fs.promises.rm(path.join(dir, d), { recursive: true, force: true });
		} catch (err) {
			console.error("[backup] snapshot failed:", err);
			await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
		} finally {
			g[RUNNING_KEY] = false;
		}
	})();
}

export interface DataExport {
	app: "socrates";
	format: 1;
	exportedAt: string;
	/** Relative path under the data folder → the file's text. */
	files: Record<string, string>;
}

function collect(dir: string, rel: string, out: Record<string, string>): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.name.includes(".tmp-")) continue;
		const full = path.join(dir, e.name);
		const name = `${rel}/${e.name}`;
		if (e.isDirectory()) collect(full, name, out);
		else if (e.isFile() && /\.(json|jsonl)$/.test(e.name)) {
			try {
				out[name] = fs.readFileSync(full, "utf-8");
			} catch {
				// unreadable file: leave it out rather than fail the export
			}
		}
	}
}

/** Everything the snapshot covers, as one object. */
export function exportData(now: Date = new Date()): DataExport {
	const files: Record<string, string> = {};
	for (const folder of DATA_FOLDERS) collect(path.join(PATHS.data, folder), folder, files);
	try {
		files["settings.json"] = fs.readFileSync(SETTINGS_FILE, "utf-8");
	} catch {
		// no settings yet
	}
	return { app: "socrates", format: 1, exportedAt: now.toISOString(), files };
}
