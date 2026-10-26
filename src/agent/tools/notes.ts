import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";
import { parsePageSpec } from "../subagents/pdf-ops.ts";
import type { NoteMeta } from "../../core/contracts.ts";
import type { NotesLibraryReader } from "../../core/ports.ts";

/**
 * The notes tool (2026-10-26): the learner's SAVED notes — every file
 * they imported (class notes, personal notes, PDFs), kept by the app in the notes
 * library (src/store/notes.ts) as original + plain text. Read-only. One
 * tool, three moves: list (no arguments), search (`query`), read (`file`,
 * optionally `pages`). Search first: it returns only the matching lines,
 * which keeps a long course file from flooding the context.
 *
 * The library arrives through the NotesLibraryReader port (the composition
 * root passes src/store/notes.ts); absent = no notes tool in the registry.
 */

const MAX_HITS = 30;
const CONTEXT_LINES = 1;
const MAX_READ_CHARS = 24_000;

const notesInput = Type.Object({
	query: Type.Optional(Type.String({ minLength: 1, description: "Words to search for across the saved notes (case-insensitive; every word must appear on the line or its neighbours)" })),
	file: Type.Optional(Type.String({ minLength: 1, description: "A saved file's name, exactly as the list shows it (or a unique part of it). With query: search only this file. Alone: read it." })),
	pages: Type.Optional(Type.String({ description: "PDF pages to read with `file`: '3', '2-5', '1,4'. Default: from the start." })),
});

function describe(note: NoteMeta): string {
	const parts = [note.kind === "pdf" ? `PDF, ${note.pages} pages` : "text"];
	if (note.emptyPages?.length) parts.push(`no text on page ${note.emptyPages.join(", ")} (scanned)`);
	parts.push(`imported ${note.importedAt.slice(0, 10)}`);
	return `- ${note.name} (${parts.join("; ")})`;
}

function findNote(notes: NoteMeta[], wanted: string): NoteMeta | string {
	const lower = wanted.toLowerCase();
	const exact = notes.find((n) => n.name.toLowerCase() === lower);
	if (exact) return exact;
	const partial = notes.filter((n) => n.name.toLowerCase().includes(lower));
	if (partial.length === 1) return partial[0]!;
	if (partial.length > 1) return `"${wanted}" matches several saved notes: ${partial.map((n) => n.name).join(", ")}. Use the full name.`;
	return `No saved note is called "${wanted}". Saved notes:\n${notes.map(describe).join("\n") || "(none)"}`;
}

/** Split a saved text into its non-blank lines, with each line's page (PDFs
 *  carry "--- Page N ---" headers) and its line number in the file. */
function rows(text: string): Array<{ page: number | null; lineNo: number; line: string }> {
	let page: number | null = null;
	const out: Array<{ page: number | null; lineNo: number; line: string }> = [];
	for (const [i, line] of text.split("\n").entries()) {
		const header = /^--- Page (\d+) ---$/.exec(line);
		if (header) {
			page = Number(header[1]);
			continue;
		}
		if (line.trim()) out.push({ page, lineNo: i + 1, line });
	}
	return out;
}

export function searchNotes(notes: Array<{ meta: NoteMeta; text: string }>, query: string): string {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	const hits: string[] = [];
	let total = 0;
	for (const { meta, text } of notes) {
		const lines = rows(text);
		for (let i = 0; i < lines.length; i++) {
			// Context stays on the hit's page, so the citation covers every line shown.
			let from = Math.max(0, i - CONTEXT_LINES);
			let to = Math.min(lines.length - 1, i + CONTEXT_LINES);
			while (lines[from]!.page !== lines[i]!.page) from++;
			while (lines[to]!.page !== lines[i]!.page) to--;
			const window = lines.slice(from, to + 1).map((r) => r.line.toLowerCase()).join(" ");
			const here = lines[i]!.line.toLowerCase();
			// A hit is a line that holds at least one word, with every word in its window.
			if (!words.some((w) => here.includes(w)) || !words.every((w) => window.includes(w))) continue;
			total++;
			if (hits.length >= MAX_HITS) continue;
			const where = lines[i]!.page !== null ? `${meta.name}, p. ${lines[i]!.page}` : `${meta.name}, line ${lines[i]!.lineNo}`;
			const context = lines.slice(from, to + 1).map((r, k) => `${from + k === i ? ">" : " "} ${r.line}`).join("\n");
			hits.push(`[${where}]\n${context}`);
			i = to; // don't report the neighbours of a hit as hits of their own
		}
	}
	if (total === 0) return `No saved note matches "${query}". Try fewer or different words, or list the notes (no arguments).`;
	const more = total > hits.length ? `\n\n[${total - hits.length} more matches not shown: narrow the query or add file.]` : "";
	return `${total} match${total === 1 ? "" : "es"} for "${query}":\n\n${hits.join("\n\n")}${more}`;
}

export function readNote(meta: NoteMeta, text: string, pages?: string): string {
	let body = text;
	if (meta.kind === "pdf" && pages) {
		const wanted = new Set(parsePageSpec(pages, meta.pages ?? 0));
		if (wanted.size === 0) return `No pages selected: "${pages}" matched nothing (the PDF has ${meta.pages} pages).`;
		body = text.split(/(?=^--- Page \d+ ---$)/m).filter((chunk) => wanted.has(Number(/^--- Page (\d+) ---/.exec(chunk)?.[1]))).join("").trim();
	}
	if (body.length <= MAX_READ_CHARS) return body;
	const cut = body.slice(0, MAX_READ_CHARS);
	const lastPage = [...cut.matchAll(/^--- Page (\d+) ---$/gm)].pop()?.[1];
	const next = meta.kind === "pdf" && lastPage ? ` Continue with pages="${lastPage}-${meta.pages}", or search with query.` : " Search with query to find the part you need.";
	return `${cut}\n\n[Cut at ${MAX_READ_CHARS} characters.${next}]`;
}

export function notesToolFor(library: NotesLibraryReader): AgentTool<typeof notesInput> {
	return {
		name: "notes",
		label: "notes",
		description:
			"The learner's SAVED notes: the class notes, handouts and personal notes they imported into the app (PDFs and text files). " +
			"No arguments: list them. `query`: search them all (or one `file`) and get the matching lines with file and page. " +
			"`file` alone: read that file's text (`pages` for a PDF range). Search before reading: course files are long. " +
			"Use it when what THEIR course says matters (a definition, a notation, a method the teacher used, what the exam covers), " +
			"and cite the file and page you used. Pages listed as scanned have no text here: for those, dispatch a pdf job " +
			"with `path` set to the original file's path that `file` returns.",
		parameters: notesInput,
		execute: serverExecute("notes", notesInput, async ({ query, file, pages }) => {
			const all = library.list();
			if (all.length === 0) return "No saved notes yet. The learner can import PDFs or text files with Import notes (home screen or the Notes page).";
			if (!query && !file) return `Saved notes (${all.length}):\n${all.map(describe).join("\n")}`;
			let scope = all;
			if (file) {
				const found = findNote(all, file);
				if (typeof found === "string") return found;
				scope = [found];
			}
			const withText = scope.flatMap((meta) => {
				const text = library.text(meta.id);
				return text === null ? [] : [{ meta, text }];
			});
			if (query) return searchNotes(withText, query);
			const [only] = withText;
			if (!only) return `The text of "${file}" is missing.`;
			const original = library.originalPath(only.meta.id);
			const header = `${describe(only.meta).slice(2)}${original ? `\nOriginal file: ${original}` : ""}\n\n`;
			return header + readNote(only.meta, only.text, pages);
		}),
	};
}
