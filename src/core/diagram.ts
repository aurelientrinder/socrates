/**
 * Inline streamed SVG diagrams (`<diagram><svg ...>...</svg></diagram>`):
 * extracted from assistant text for live rendering inside question/problem
 * docks and fallback inline cards, and stripped from raw prose / coverage /
 * export text so downstream consumers never see markup soup.
 *
 * Pure, zero Node imports — safe across core, server, and browser components.
 */

const COMPLETE_DIAGRAM_RE = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/gi;
const OPEN_DIAGRAM_RE = /<diagram\b[^>]*>/gi;

export interface ExtractedDiagrams {
	/** Text with complete and trailing unclosed `<diagram>` tags removed. */
	cleanText: string;
	/** Inner contents of every complete `<diagram>...</diagram>` block in order. */
	complete: string[];
	/** Inner content of an in-progress unclosed trailing `<diagram>...`, if any. */
	streaming: string | null;
}

function collapseExcessNewlines(text: string): string {
	return text.replace(/\n{3,}/g, "\n\n").trim();
}

/** Extract complete and currently streaming `<diagram>` blocks from assistant text. */
export function extractDiagrams(text: string): ExtractedDiagrams {
	if (!text) return { cleanText: "", complete: [], streaming: null };
	const complete: string[] = [];
	let clean = "";
	let lastIndex = 0;

	COMPLETE_DIAGRAM_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = COMPLETE_DIAGRAM_RE.exec(text)) !== null) {
		clean += text.slice(lastIndex, match.index);
		const inner = match[1]?.trim() ?? "";
		if (inner) complete.push(inner);
		lastIndex = match.index + match[0].length;
	}

	const remainder = text.slice(lastIndex);
	OPEN_DIAGRAM_RE.lastIndex = 0;
	const openMatch = OPEN_DIAGRAM_RE.exec(remainder);
	let streaming: string | null = null;
	if (openMatch) {
		clean += remainder.slice(0, openMatch.index);
		streaming = remainder.slice(openMatch.index + openMatch[0].length);
	} else {
		clean += remainder;
	}

	return {
		cleanText: collapseExcessNewlines(clean),
		complete,
		streaming,
	};
}

/** Strip both completed and unclosed `<diagram>` blocks from text. */
export function stripDiagrams(text: string): string {
	if (!text) return text;
	return extractDiagrams(text).cleanText;
}
