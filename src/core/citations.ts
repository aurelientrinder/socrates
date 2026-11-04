/**
 * INLINE NOTE CITATIONS (2026-11-04). The tutor's `notes` tool prints a cite
 * code beside every passage it returns; when the tutor leans on that passage
 * it writes the code right after the claim:
 *
 *   [[src_1a2b3c4d5e6f#p3]]   page 3 of a PDF note
 *   [[src_1a2b3c4d5e6f#l12]]  line 12 of a text note
 *   [[src_1a2b3c4d5e6f]]      the note as a whole
 *
 * The chat turns each distinct code into a small clickable [1], [2], … in
 * order of appearance within the reply. Clicking one fetches the saved note
 * and shows the passage itself, so the learner reads the source rather than
 * trusting the tutor's paraphrase. The passage comes from the note library,
 * never from the model: a code that points at nothing says so.
 */

export interface Citation {
	noteId: string;
	/** "p3" (PDF page), "l12" (text line), or "" (whole note). */
	anchor: string;
}

const CODE = / ?\[\[(src_[0-9a-f]{12})(?:#([pl]\d{1,6}))?\]\]/g;
/** A code still being typed at the end of streaming text: hide it. */
const PARTIAL_TAIL = /\[\[(?:s(?:r(?:c(?:_[0-9a-f]{0,12}(?:#[pl]?\d{0,6})?)?)?)?)?\]?$/;

/** The code the `notes` tool prints beside a passage. */
export function citeCode(noteId: string, anchor: string | null): string {
	return `[[${noteId}${anchor ? `#${anchor}` : ""}]]`;
}

/** How a numbered marker travels through markdown: an inline-code span the
 *  chat's code override recognises (links would pass the sanitizer, but this
 *  needs no link plumbing). */
export function citeToken(n: number, c: Citation): string {
	return `\`cite:${n}:${c.noteId}${c.anchor ? `~${c.anchor}` : ""}\``;
}

export function parseCiteToken(code: string): { n: number; citation: Citation } | null {
	const m = /^cite:(\d{1,3}):(src_[0-9a-f]{12})(?:~([pl]\d{1,6}))?$/.exec(code);
	return m ? { n: Number(m[1]), citation: { noteId: m[2]!, anchor: m[3] ?? "" } } : null;
}

/** Replace the codes in a reply's text parts with numbered markdown links.
 *  Numbers run through the whole reply (all parts, in order); the same
 *  passage keeps one number. */
export function numberCitations(texts: readonly string[]): string[] {
	const numbers = new Map<string, number>();
	return texts.map((text) =>
		text.replace(PARTIAL_TAIL, "").replace(CODE, (_all, noteId: string, anchor: string | undefined) => {
			const c: Citation = { noteId, anchor: anchor ?? "" };
			const key = `${c.noteId}#${c.anchor}`;
			let n = numbers.get(key);
			if (n === undefined) {
				n = numbers.size + 1;
				numbers.set(key, n);
			}
			return citeToken(n, c);
		}),
	);
}

/** Codes removed, for plain-text exports. */
export function stripCitations(text: string): string {
	return text.replace(/ ?\[\[src_[0-9a-f]{12}(?:#[pl]\d{1,6})?\]\]/g, "");
}

export interface Passage {
	/** "page 3", "line 12", or "" for the whole note. */
	where: string;
	text: string;
}

const PAGE_HEADER = /^--- Page (\d+) ---$/;
const CONTEXT = 3;
const WHOLE_NOTE_CHARS = 1_200;

/** The text a citation points at, taken from the saved note's plain text.
 *  null = the anchor does not exist in the note (a bad code). */
export function passageFor(text: string, anchor: string): Passage | null {
	if (!anchor) return { where: "", text: text.trim().slice(0, WHOLE_NOTE_CHARS) };
	const n = Number(anchor.slice(1));
	if (anchor.startsWith("p")) {
		for (const chunk of text.split(/(?=^--- Page \d+ ---$)/m)) {
			const header = PAGE_HEADER.exec(chunk.split("\n", 1)[0]!);
			if (header && Number(header[1]) === n) {
				const body = chunk.slice(chunk.indexOf("\n") + 1).trim();
				return { where: `page ${n}`, text: body || "(no text on this page: it is scanned)" };
			}
		}
		return null;
	}
	const lines = text.split("\n");
	if (n < 1 || n > lines.length) return null;
	const from = Math.max(0, n - 1 - CONTEXT);
	const to = Math.min(lines.length, n + CONTEXT);
	return { where: `line ${n}`, text: lines.slice(from, to).join("\n").trim() };
}
