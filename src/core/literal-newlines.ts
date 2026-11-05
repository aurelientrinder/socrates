/**
 * LITERAL "\n" REPAIR (2026-11-05). Some models double-escape line breaks in
 * what they write, so the text arrives with the two characters backslash +
 * n where a real line break belongs, and the learner reads "\n" in the
 * middle of the prose. Display-only (raw records stay as recorded).
 *
 * Math and code are protected: `\nabla`, `\neq`, `\notin` live inside $…$,
 * $$…$$ or code spans, and are left alone. Outside those, backslash-n is
 * prose, never LaTeX.
 */

const PROTECTED = /(\$\$[\s\S]*?\$\$|\$[^$\n]+\$|```[\s\S]*?```|`[^`\n]+`)/;

export function repairLiteralNewlines(text: string): string {
	if (!text.includes("\\n")) return text;
	return text
		.split(PROTECTED)
		.map((seg, i) => (i % 2 === 1 ? seg : seg.replace(/\\r?\\n/g, "\n").replace(/\\n/g, "\n")))
		.join("");
}
