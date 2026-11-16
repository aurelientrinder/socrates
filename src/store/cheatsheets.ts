/**
 * THE CHEAT SHEET STORE — the fs adapter for cheat sheets (src/core/cheatsheet.ts): one
 * JSON file per sheet in data/cheatsheets/. Same idioms as the exam store:
 * sync fs, id-guarded filenames, tab-indented JSON, write-then-rename.
 */

import { renameWithRetry } from "./fs-atomic.ts";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import { CURRENT_SHEET_VERSION, SHEET_ID, type SheetRecord } from "../core/cheatsheet.ts";

function sheetsDir(): string {
	return path.join(PATHS.data, "cheatsheets");
}

function sheetFile(id: string): string {
	if (!SHEET_ID.test(id)) throw new Error(`Invalid sheet id: ${id}`);
	return path.join(sheetsDir(), `${id}.json`);
}

export function newSheetId(now: number = Date.now()): string {
	return `sheet_${now.toString(36)}_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function isSheetRecord(v: unknown): v is SheetRecord {
	if (!v || typeof v !== "object") return false;
	const r = v as Partial<SheetRecord>;
	return typeof r.id === "string" && typeof r.title === "string" && typeof r.status === "string" && Array.isArray(r.sections);
}

export const sheetStore = {
	get(id: string): SheetRecord | null {
		if (!SHEET_ID.test(id)) return null;
		try {
			const record: unknown = JSON.parse(fs.readFileSync(sheetFile(id), "utf-8"));
			if (!isSheetRecord(record) || record.id !== id) return null;
			// A record from a newer build is never rewritten by this one.
			if ((record.version ?? 1) > CURRENT_SHEET_VERSION) return null;
			return { ...record, topics: record.topics ?? [], sections: record.sections ?? [] };
		} catch {
			return null;
		}
	},

	save(record: SheetRecord): SheetRecord {
		const next = { ...record, version: CURRENT_SHEET_VERSION, updatedAt: new Date().toISOString() };
		fs.mkdirSync(sheetsDir(), { recursive: true });
		const file = sheetFile(record.id);
		const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
		fs.writeFileSync(tmp, JSON.stringify(next, null, "\t"), "utf-8");
		renameWithRetry(tmp, file);
		return next;
	},

	/** Read-modify-write one record; null when it does not exist. */
	update(id: string, change: (record: SheetRecord) => SheetRecord): SheetRecord | null {
		const record = sheetStore.get(id);
		return record ? sheetStore.save(change(record)) : null;
	},

	/** Every sheet, newest first. Unreadable files are skipped. */
	list(): SheetRecord[] {
		let entries: string[];
		try {
			entries = fs.readdirSync(sheetsDir());
		} catch {
			return [];
		}
		const out: SheetRecord[] = [];
		for (const name of entries) {
			if (!name.endsWith(".json")) continue;
			const record = sheetStore.get(name.slice(0, -5));
			if (record) out.push(record);
		}
		return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	},

	remove(id: string): boolean {
		if (!sheetStore.get(id)) return false;
		fs.rmSync(sheetFile(id), { force: true });
		return true;
	},
};

export type SheetStore = typeof sheetStore;
