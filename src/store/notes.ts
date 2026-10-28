/**
 * THE SAVED-NOTES LIBRARY — the fs adapter behind the Notes page and the
 * tutor's `notes` tool. Every file the learner imports is KEPT here (the
 * graph keeps only what extraction pulled out of it), one folder per file:
 *
 *   data/notes/<id>/meta.json   — NoteMeta (name, kind, pages, …)
 *   data/notes/<id>/text.txt    — the plain text (a PDF's, "--- Page N ---" headed)
 *   data/notes/<id>/<name>      — the original file, byte-for-byte
 *
 * <id> is the notes source id ("src_" + sha256(file name), the SAME id
 * extraction's importNotes mints), so a saved note and its graph source
 * record share one identity and re-importing a file replaces its folder.
 * Idioms: sync fs, id-guarded paths, JSON with tab indentation.
 */

import { renameWithRetry } from "./fs-atomic.ts";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { NoteMeta } from "../core/contracts.ts";

const ID = /^src_[0-9a-f]{12}$/;
const META = "meta.json";
const TEXT = "text.txt";

/** The notes source id for a file name — must match extraction.ts importNotes. */
export function noteIdFor(name: string): string {
	return `src_${crypto.createHash("sha256").update(name).digest("hex").slice(0, 12)}`;
}

function noteDir(id: string): string {
	if (!ID.test(id)) throw new Error(`Invalid note id: ${id}`);
	return path.join(PATHS.notes, id);
}

/** A file name safe to write on every OS (Windows is the strict one). */
export function safeFileName(name: string): string {
	const base = path.basename(name.replace(/\\/g, "/"));
	const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 120);
	return !cleaned || cleaned === META || cleaned === TEXT ? `original-${cleaned || "file"}` : cleaned;
}

function isNoteMeta(v: unknown): v is NoteMeta {
	if (!v || typeof v !== "object") return false;
	const m = v as Record<string, unknown>;
	return typeof m.id === "string" && ID.test(m.id) && typeof m.name === "string"
		&& (m.kind === "pdf" || m.kind === "text") && typeof m.importedAt === "string"
		&& typeof m.bytes === "number"
		&& (m.pages === undefined || typeof m.pages === "number")
		&& (m.emptyPages === undefined || (Array.isArray(m.emptyPages) && m.emptyPages.every((p) => typeof p === "number")));
}

export const notesLibrary = {
	/** Save (or replace) one imported file: its original bytes, its text,
	 *  its metadata. Written to a temp folder first, then swapped in, so a
	 *  failed write never leaves half a note. */
	save(input: { name: string; bytes: Uint8Array; text: string; kind: NoteMeta["kind"]; pages?: number; emptyPages?: number[] }): NoteMeta {
		const id = noteIdFor(input.name);
		const dir = noteDir(id);
		const meta: NoteMeta = {
			id,
			name: input.name,
			kind: input.kind,
			importedAt: new Date().toISOString(),
			bytes: input.bytes.byteLength,
			...(input.pages !== undefined ? { pages: input.pages } : {}),
			...(input.emptyPages?.length ? { emptyPages: input.emptyPages } : {}),
		};
		fs.mkdirSync(PATHS.notes, { recursive: true });
		const tmp = `${dir}.tmp-${crypto.randomUUID().slice(0, 8)}`;
		try {
			fs.mkdirSync(tmp);
			fs.writeFileSync(path.join(tmp, safeFileName(input.name)), input.bytes);
			fs.writeFileSync(path.join(tmp, TEXT), input.text, "utf-8");
			fs.writeFileSync(path.join(tmp, META), JSON.stringify(meta, null, "\t"), "utf-8");
			fs.rmSync(dir, { recursive: true, force: true });
			renameWithRetry(tmp, dir);
		} catch (err) {
			fs.rmSync(tmp, { recursive: true, force: true });
			throw err;
		}
		return meta;
	},

	/** Every saved note, newest import first. Unreadable folders are skipped. */
	list(): NoteMeta[] {
		let entries: string[];
		try {
			entries = fs.readdirSync(PATHS.notes);
		} catch {
			return [];
		}
		const out: NoteMeta[] = [];
		for (const id of entries) {
			if (!ID.test(id)) continue;
			const meta = notesLibrary.get(id);
			if (meta) out.push(meta);
		}
		return out.sort((a, b) => b.importedAt.localeCompare(a.importedAt));
	},

	get(id: string): NoteMeta | null {
		if (!ID.test(id)) return null;
		try {
			const meta: unknown = JSON.parse(fs.readFileSync(path.join(noteDir(id), META), "utf-8"));
			return isNoteMeta(meta) && meta.id === id ? meta : null;
		} catch {
			return null;
		}
	},

	/** The note's plain text, or null when it is not saved. */
	text(id: string): string | null {
		if (!notesLibrary.get(id)) return null;
		try {
			return fs.readFileSync(path.join(noteDir(id), TEXT), "utf-8");
		} catch {
			return null;
		}
	},

	/** Absolute path of the saved original, or null when it is not saved. */
	originalPath(id: string): string | null {
		const meta = notesLibrary.get(id);
		if (!meta) return null;
		const file = path.join(noteDir(id), safeFileName(meta.name));
		return fs.existsSync(file) ? file : null;
	},

	/** Remove the saved copy. The graph keeps what was learned from it. */
	remove(id: string): boolean {
		if (!notesLibrary.get(id)) return false;
		fs.rmSync(noteDir(id), { recursive: true, force: true });
		return true;
	},
};
