/**
 * LITERAL "\n" REPAIR (2026-11-05). Some models double-escape line breaks in
 * what they write, so the text arrives with the two characters backslash +
 * n where a real line break belongs, and the learner reads "\n" in the
 * middle of the prose. Display-only (raw records stay as recorded).
 *
 * Math and code are protected: `\nabla`, `\neq`, `\notin` live inside $…$,
 * $$…$$ or code spans, and are left alone (except a display span's own
 * opening and closing line breaks). Outside those, backslash-n is prose.
 */

const PROTECTED = /(\$\$[\s\S]*?\$\$|\$[^$\n]+\$|```[\s\S]*?```|`[^`\n]+`)/;

export function repairLiteralNewlines(text: string): string {
	if (!text.includes("\\n")) return text;
	return text
		.split(PROTECTED)
		.map((seg, i) => {
			if (i % 2 === 0) return seg.replace(/\\n/g, "\n");
			// A display span opened or closed with a line break written as backslash-n:
			// the break belongs outside the math ($$\nx = 1\n$$).
			if (seg.startsWith("$$")) return seg.replace(/^\$\$(?:\s*\\n(?!abla|e|u|i\b|ot|eg|ewline|earrow|warrow|less|gtr|mid|parallel|prec|succ|sim|cong|vdash|exists|subset|supset))+/, () => "$$\n").replace(/(?:\\n\s*)+\$\$$/, () => "\n$$");
			return seg;
		})
		.join("");
}
