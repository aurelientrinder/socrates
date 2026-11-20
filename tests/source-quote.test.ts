import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_SOURCE_QUOTE_CHARS,
	filterSourcePages,
	formatSourceQuote,
} from "../src/core/source-quote.ts";

describe("side-by-side source quoting & search", () => {
	it("formats cited quotes with and without page numbers and optional prompts", () => {
		const withPage = formatSourceQuote({
			noteName: "Quantum.pdf",
			page: 12,
			passage: "  Every   Hermitian operator\nhas real eigenvalues. ",
			prompt: "Can you walk me through why this follows?",
		});
		assert.equal(
			withPage,
			`> "Every Hermitian operator has real eigenvalues."\n> — *Quantum.pdf, p. 12*\n\nCan you walk me through why this follows?`,
		);

		const noPage = formatSourceQuote({
			noteName: "lecture.md",
			passage: "Entropy never decreases in an isolated system.",
		});
		assert.equal(noPage, `> "Entropy never decreases in an isolated system."\n> — *lecture.md*\n`);
		assert.equal(formatSourceQuote({ noteName: "x", passage: "   \n  " }), "");
	});

	it("clips overly long passages at MAX_SOURCE_QUOTE_CHARS", () => {
		const long = "a".repeat(MAX_SOURCE_QUOTE_CHARS + 50);
		const formatted = formatSourceQuote({ noteName: "Big.pdf", page: 1, passage: long });
		assert.ok(formatted.includes(`${"a".repeat(MAX_SOURCE_QUOTE_CHARS)}…"`));
	});

	it("filters extracted pages case-insensitively and counts matches", () => {
		const pages = [
			{ page: 1, text: "Eigenvalues and eigenvectors of linear maps." },
			{ page: 2, text: "Determinants and trace formulas." },
			{ page: 3, text: "The eigenvalue equation Av = λv defines each eigenvalue." },
		];
		const all = filterSourcePages(pages, "   ");
		assert.equal(all.length, 3);
		assert.equal(all[0]!.matches, 0);

		const hits = filterSourcePages(pages, "EIGENVALUE");
		assert.deepEqual(
			hits.map((h) => [h.page, h.matches]),
			[
				[1, 1],
				[3, 2],
			],
		);
	});
});
