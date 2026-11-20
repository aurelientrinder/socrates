/**
 * SIDE-BY-SIDE SOURCE QUOTING & SEARCH (pure, zero-IO, browser-safe):
 * Formats highlighted passages from imported PDFs/notes into cited markdown
 * blockquotes for the session composer, and filters extracted note pages by
 * search query.
 */

import type { NotesPage } from "./flashcards.ts";

export const MAX_SOURCE_QUOTE_CHARS = 600;

export interface SourceQuoteInput {
	noteName: string;
	passage: string;
	page?: number;
	/** Optional follow-up question appended after the quote. */
	prompt?: string;
}

/** Format a highlighted passage as a clean cited blockquote for the composer. */
export function formatSourceQuote(input: SourceQuoteInput): string {
	const cleaned = input.passage.replace(/\s+/g, " ").trim();
	if (!cleaned) return "";
	const clipped =
		cleaned.length > MAX_SOURCE_QUOTE_CHARS
			? `${cleaned.slice(0, MAX_SOURCE_QUOTE_CHARS).trimEnd()}…`
			: cleaned;
	const cite = input.page !== undefined ? `${input.noteName}, p. ${input.page}` : input.noteName;
	const lines = [`> "${clipped}"`, `> — *${cite}*`, ""];
	if (input.prompt?.trim()) lines.push(input.prompt.trim());
	return lines.join("\n");
}

export interface FilteredSourcePage {
	page?: number;
	text: string;
	matches: number;
}

/** Case-insensitive search across extracted note pages; empty query returns all. */
export function filterSourcePages(pages: readonly NotesPage[], query: string): FilteredSourcePage[] {
	const q = query.trim().toLowerCase();
	if (!q) return pages.map((p) => ({ ...(p.page !== undefined ? { page: p.page } : {}), text: p.text, matches: 0 }));
	const out: FilteredSourcePage[] = [];
	for (const p of pages) {
		const lower = p.text.toLowerCase();
		let matches = 0;
		let pos = 0;
		while ((pos = lower.indexOf(q, pos)) !== -1) {
			matches++;
			pos += q.length;
		}
		if (matches > 0) {
			out.push({ ...(p.page !== undefined ? { page: p.page } : {}), text: p.text, matches });
		}
	}
	return out;
}
