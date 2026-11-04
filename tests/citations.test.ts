import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { numberCitations, parseCiteToken, passageFor, stripCitations } from "../src/core/citations.ts";
import { searchNotes } from "../src/agent/tools/notes.ts";

const ID = "src_0123456789ab";
const ID2 = "src_ba9876543210";

describe("note citations", () => {
	it("numbers codes in order of appearance and reuses a number for the same passage", () => {
		const out = numberCitations([`A [[${ID}#p3]] b [[${ID2}]]`, `C [[${ID}#p3]] d [[${ID}#p4]]`]);
		assert.equal(out[0], `A\`cite:1:${ID}~p3\` b\`cite:2:${ID2}\``);
		assert.equal(out[1], `C\`cite:1:${ID}~p3\` d\`cite:3:${ID}~p4\``);
	});

	it("hides a code that is still streaming, and round-trips tokens", () => {
		assert.equal(numberCitations(["Claim [[src_0123"])[0], "Claim ");
		assert.equal(numberCitations(["Claim [["])[0], "Claim ");
		assert.equal(numberCitations(["Array [[1, 2]]"])[0], "Array [[1, 2]]");
		assert.deepEqual(parseCiteToken(`cite:2:${ID}~l12`), { n: 2, citation: { noteId: ID, anchor: "l12" } });
		assert.equal(parseCiteToken("cite:2:nope"), null);
		assert.equal(stripCitations(`Claim [[${ID}#p2]].`), "Claim.");
	});

	it("finds the passage a code points at, and says nothing for a bad anchor", () => {
		const pdf = "--- Page 1 ---\nIntro\n--- Page 2 ---\nThe derivative is a limit.\n";
		assert.deepEqual(passageFor(pdf, "p2"), { where: "page 2", text: "The derivative is a limit." });
		assert.equal(passageFor(pdf, "p9"), null);
		const txt = "a\nb\nc\nd\ne\nf\ng\nh";
		assert.equal(passageFor(txt, "l4")?.text, "a\nb\nc\nd\ne\nf\ng");
		assert.equal(passageFor(txt, "l99"), null);
		assert.equal(passageFor(txt, "")?.where, "");
	});

	it("prints a cite code beside every search hit", () => {
		const meta = { id: ID, name: "Calc.pdf", kind: "pdf" as const, importedAt: "2026-01-01T00:00:00Z", bytes: 1, pages: 2 };
		const out = searchNotes([{ meta, text: "--- Page 2 ---\nThe derivative is a limit." }], "derivative");
		assert.match(out, new RegExp(`\\[Calc.pdf, p. 2\\] cite: \\[\\[${ID}#p2\\]\\]`));
	});
});
