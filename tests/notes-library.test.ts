/**
 * The saved-notes library (src/store/notes.ts) and the tutor's `notes`
 * tool over it, under an isolated LH_DATA_DIR (set before any import that
 * loads config.ts, so every app-module import is dynamic).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-notes-library-"));
process.env.LH_DATA_DIR = TMP_DATA;
const { notesLibrary, noteIdFor, safeFileName } = await import("../src/store/notes.ts");
const { notesToolFor } = await import("../src/agent/tools/notes.ts");
const notesTool = notesToolFor(notesLibrary);
after(() => { fs.rmSync(TMP_DATA, { recursive: true, force: true }); });

const bytes = (s: string) => new TextEncoder().encode(s);
async function callNotes(input: Record<string, unknown>): Promise<string> {
	const result = await notesTool.execute("call-1", input as never, undefined);
	return result.content.map((c) => ("text" in c ? c.text : "")).join("");
}

describe("notes library", () => {
	it("saves the original, the text and the metadata under the source id, and replaces on re-import", () => {
		const first = notesLibrary.save({ name: "Thermo.txt", bytes: bytes("v1"), text: "v1", kind: "text" });
		assert.equal(first.id, noteIdFor("Thermo.txt"));
		const second = notesLibrary.save({ name: "Thermo.txt", bytes: bytes("version two"), text: "version two", kind: "text" });
		assert.equal(second.id, first.id);
		assert.equal(notesLibrary.list().filter((n) => n.name === "Thermo.txt").length, 1);
		assert.equal(notesLibrary.text(first.id), "version two");
		assert.equal(fs.readFileSync(notesLibrary.originalPath(first.id)!, "utf-8"), "version two");
		assert.equal(notesLibrary.get(first.id)!.bytes, 11);
	});

	it("keeps unsafe names on disk-safe paths inside the note's folder", () => {
		assert.equal(safeFileName("..\\..\\evil:name?.txt"), "evil_name_.txt");
		assert.equal(safeFileName("meta.json"), "original-meta.json");
		const meta = notesLibrary.save({ name: "../../escape.md", bytes: bytes("x"), text: "x", kind: "text" });
		assert.equal(path.dirname(notesLibrary.originalPath(meta.id)!), path.join(TMP_DATA, "notes", meta.id));
	});

	it("rejects ids that are not note ids and removes saved copies", () => {
		assert.equal(notesLibrary.get("../graph"), null);
		assert.equal(notesLibrary.remove("../graph"), false);
		const meta = notesLibrary.save({ name: "gone.md", bytes: bytes("x"), text: "x", kind: "text" });
		assert.equal(notesLibrary.remove(meta.id), true);
		assert.equal(notesLibrary.get(meta.id), null);
		assert.equal(fs.existsSync(path.join(TMP_DATA, "notes", meta.id)), false);
	});
});

describe("notes tool", () => {
	it("lists, searches with page citations, and reads page ranges", async () => {
		notesLibrary.save({
			name: "Biology class notes.pdf", bytes: bytes("%PDF-"), kind: "pdf", pages: 3, emptyPages: [3],
			text: "--- Page 1 ---\nCells and organelles\nThe mitochondria makes ATP.\n\n--- Page 2 ---\nPhotosynthesis happens in the chloroplast.\nLight reactions first.\n\n--- Page 3 ---\n[no text on this page: scanned or image only]",
		});
		const list = await callNotes({});
		assert.match(list, /Biology class notes\.pdf \(PDF, 3 pages; no text on page 3 \(scanned\)/);

		const search = await callNotes({ query: "chloroplast" });
		assert.match(search, /1 match for "chloroplast"/);
		assert.match(search, /\[Biology class notes\.pdf, p\. 2\]\n> Photosynthesis happens in the chloroplast\./);

		const twoWords = await callNotes({ query: "mitochondria ATP" });
		assert.match(twoWords, /p\. 1/);
		assert.match(await callNotes({ query: "ribosome" }), /No saved note matches/);

		const page2 = await callNotes({ file: "biology", pages: "2" });
		assert.match(page2, /Original file: .*Biology class notes\.pdf/);
		assert.match(page2, /--- Page 2 ---\nPhotosynthesis/);
		assert.doesNotMatch(page2, /mitochondria/);

		assert.match(await callNotes({ file: "chemistry" }), /No saved note is called "chemistry"/);
	});
});
