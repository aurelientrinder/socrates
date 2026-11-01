/**
 * Notes import + the saved-notes library (2026-10-26): every imported file
 * is turned into plain text HERE (PDFs through pdfjs, locally — no model
 * call), saved to the library (src/store/notes.ts), then handed to the
 * extraction pipeline exactly as a .txt import always was.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getHeadless } from "../agent/subagents/headless.ts";
import { pdfPageTexts } from "../agent/subagents/pdf-ops.ts";
import type { NoteMeta } from "../core/contracts.ts";
import { notesLibrary } from "../store/notes.ts";
import {
	handwritingKey,
	HandwritingRequestError,
	PAGES_PER_REQUEST,
	readHandwriting,
	type PageImage,
} from "./handwriting.ts";

/** Per-file ceiling. Bigger than any typed course notes; a long scanned
 *  PDF can pass it — the message says what to do then. */
export const MAX_NOTE_BYTES = 50 * 1024 * 1024;

/** A refusal the learner can act on — the route reports its message as is. */
export class NoteFileError extends Error {}

export interface PreparedNote {
	meta: NoteMeta;
	/** What extraction reads. Empty when a PDF had no text layer at all. */
	text: string;
	/** Shown beside a successful import (scanned pages that were skipped). */
	warning?: string;
}

function isPdf(name: string, bytes: Uint8Array): boolean {
	return /\.pdf$/i.test(name) || (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-");
}

function pageList(pages: number[]): string {
	return pages.length > 8 ? `${pages.slice(0, 8).join(", ")}…` : pages.join(", ");
}

/** Reads scanned pages with the AI (swapped in tests). */
export interface ScanReader {
	available(): boolean;
	render(pdfPath: string, pages: number[]): Promise<PageImage[]>;
	read(images: readonly PageImage[]): Promise<Map<number, string>>;
	sleep(ms: number): Promise<void>;
}

const realScanReader: ScanReader = {
	available: () => handwritingKey() !== null,
	async render(pdfPath, pages) {
		const out = await getHeadless().renderPdfPages(pdfPath, pages, { dpi: 110 });
		return out.map((p) => ({ page: p.page, png: p.png }));
	},
	read: (images) => readHandwriting(images, { apiKey: handwritingKey()! }),
	sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)),
};

let scanReader: ScanReader = realScanReader;
/** Tests only. */
export function setScanReader(next: Partial<ScanReader> | null): void {
	scanReader = next ? { ...realScanReader, ...next } : realScanReader;
}

/** One scan at a time: the free tier's per-minute limit is shared by every file. */
let scanTurn: Promise<unknown> = Promise.resolve();

async function readBatch(images: readonly PageImage[]): Promise<Map<number, string>> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await scanReader.read(images);
		} catch (err) {
			if (err instanceof HandwritingRequestError && err.rateLimited && attempt < 3) {
				const seconds = Number(/retry in ([\d.]+)s/i.exec(err.detail)?.[1] ?? /"retryDelay":\s*"(\d+)s"/.exec(err.detail)?.[1] ?? 30);
				await scanReader.sleep(Math.min(Math.max(seconds, 5), 90) * 1000);
				continue;
			}
			throw err;
		}
	}
}

/**
 * Scanned or handwritten pages have no text layer: the AI reads them from
 * their picture (the same Gemini reading the notes folder uses). Returns
 * page → text for the pages it could read; a failure stops there and says why.
 */
async function readScannedPages(
	bytes: Uint8Array,
	pages: number[],
	onStep: (text: string) => void,
): Promise<{ read: Map<number, string>; error?: string }> {
	const run = scanTurn.then(async () => {
		const read = new Map<number, string>();
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-scan-"));
		const pdfPath = path.join(dir, "scan.pdf");
		try {
			fs.writeFileSync(pdfPath, bytes);
			for (let i = 0; i < pages.length; i += PAGES_PER_REQUEST) {
				const batch = pages.slice(i, i + PAGES_PER_REQUEST);
				onStep(`Reading scanned page ${Math.min(i + batch.length, pages.length)} of ${pages.length}`);
				const got = await readBatch(await scanReader.render(pdfPath, batch));
				for (const [n, t] of got) read.set(n, t);
			}
			return { read };
		} catch (err) {
			return { read, error: err instanceof Error ? err.message : String(err) };
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	scanTurn = run.catch(() => undefined);
	return run;
}

/** Read one uploaded file, pull its text out, and save it to the library.
 *  `onStep` reports progress while scanned pages are being read. */
export async function prepareNote(name: string, bytes: Uint8Array, onStep: (text: string) => void = () => {}): Promise<PreparedNote> {
	if (bytes.byteLength > MAX_NOTE_BYTES) {
		throw new NoteFileError(`This file is ${Math.round(bytes.byteLength / 1024 / 1024)} MB, over the ${MAX_NOTE_BYTES / 1024 / 1024} MB limit. Split the PDF into smaller parts and import those.`);
	}
	// Any text format stays welcome: the extractor is format-agnostic.
	if (!isPdf(name, bytes)) {
		const text = new TextDecoder("utf-8").decode(bytes);
		if (text.includes("\u0000")) throw new NoteFileError("This doesn't look like a text file. Import PDF, .txt or .md files.");
		return { meta: notesLibrary.save({ name, bytes, text, kind: "text" }), text };
	}

	let pages: string[];
	try {
		pages = await pdfPageTexts(bytes);
	} catch (err) {
		throw new NoteFileError(`This PDF can't be opened (${err instanceof Error ? err.message : String(err)}). If it's password-protected, save an unprotected copy and import that.`);
	}
	// Under ~20 characters is a page number or a stray header, not notes.
	let emptyPages = pages.flatMap((t, i) => (t.replace(/\s+/g, "").length < 20 ? [i + 1] : []));
	let scanNote: string | undefined;
	if (emptyPages.length > 0 && scanReader.available()) {
		const { read, error } = await readScannedPages(bytes, emptyPages, onStep);
		pages = pages.map((t, i) => (read.has(i + 1) ? read.get(i + 1)! : t));
		const stillEmpty = emptyPages.filter((n) => (pages[n - 1] ?? "").replace(/\s+/g, "").length < 20);
		const readCount = emptyPages.length - stillEmpty.length;
		emptyPages = stillEmpty;
		if (error) scanNote = `Reading the scanned pages stopped early: ${error}${readCount > 0 ? ` (${readCount} pages were read.)` : ""} Add the file again to try the rest.`;
	}
	const text = pages
		.map((t, i) => `--- Page ${i + 1} ---\n${emptyPages.includes(i + 1) ? "[no text on this page: scanned or image only]" : t}`)
		.join("\n\n");
	const meta = notesLibrary.save({ name, bytes, text, kind: "pdf", pages: pages.length, emptyPages });
	if (emptyPages.length === pages.length) {
		return { meta, text: "", ...(scanNote ? { warning: scanNote } : {}) };
	}
	return {
		meta,
		text,
		...(scanNote ? { warning: scanNote } : emptyPages.length
			? { warning: `${emptyPages.length} of ${pages.length} pages have no text (scanned or images) and were skipped: page ${pageList(emptyPages)}. The tutor can still read them from the saved PDF.` }
			: {}),
	};
}

/** The message for a PDF with no text layer at all. */
export const SCANNED_PDF_MESSAGE =
	"No text found: this PDF looks scanned. It's saved in Notes, so the tutor can still read its pages, but nothing was added to your map. Add a free Gemini key in Settings → Keys and Socrates reads scanned and handwritten pages by itself; then add the file again.";
