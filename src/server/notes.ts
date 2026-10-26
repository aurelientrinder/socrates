/**
 * Notes import + the saved-notes library (2026-10-26): every imported file
 * is turned into plain text HERE (PDFs through pdfjs, locally — no model
 * call), saved to the library (src/store/notes.ts), then handed to the
 * extraction pipeline exactly as a .txt import always was.
 */

import { pdfPageTexts } from "../agent/subagents/pdf-ops.ts";
import type { NoteMeta } from "../core/contracts.ts";
import { notesLibrary } from "../store/notes.ts";

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

/** Read one uploaded file, pull its text out, and save it to the library. */
export async function prepareNote(name: string, bytes: Uint8Array): Promise<PreparedNote> {
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
	const emptyPages = pages.flatMap((t, i) => (t.replace(/\s+/g, "").length < 20 ? [i + 1] : []));
	const text = pages
		.map((t, i) => `--- Page ${i + 1} ---\n${emptyPages.includes(i + 1) ? "[no text on this page: scanned or image only]" : t}`)
		.join("\n\n");
	const meta = notesLibrary.save({ name, bytes, text, kind: "pdf", pages: pages.length, emptyPages });
	if (emptyPages.length === pages.length) {
		return { meta, text: "" };
	}
	return {
		meta,
		text,
		...(emptyPages.length
			? { warning: `${emptyPages.length} of ${pages.length} pages have no text (scanned or images) and were skipped: page ${pageList(emptyPages)}. The tutor can still read them from the saved PDF.` }
			: {}),
	};
}

/** The message for a PDF with no text layer at all. */
export const SCANNED_PDF_MESSAGE =
	"No text found: this PDF looks scanned. It's saved in Notes, so the tutor can still read its pages, but nothing was added to your map. For the map, run it through OCR first (Google Drive: right-click → Open with → Google Docs), download that as .txt and import it.";
