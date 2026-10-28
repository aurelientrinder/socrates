/**
 * Flashcards from notes: reading a saved note into pages and chunks, the
 * quote check that keeps invented cards out, the FSRS schedule (first
 * answer of a sitting decides, no Easy), the daily round, the maker over a
 * faux engine, and the deck store + answer flow under an isolated
 * LH_DATA_DIR (set before any import that loads config.ts).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-flashcards-"));
process.env.LH_DATA_DIR = TMP_DATA;
const core = await import("../src/core/flashcards.ts");
const { GRADE_AGAIN, GRADE_GOOD, GRADE_HARD, TARGET_RETENTION } = await import("../src/core/retention.ts");
const { makeChunkCards } = await import("../src/agent/subagents/flashcard-maker.ts");
const { flashcardStore } = await import("../src/store/flashcards.ts");
const { answerFlashcard, deleteFlashcard, editFlashcard, flashcardQueue, FlashcardError } = await import("../src/server/flashcards.ts");
after(() => { fs.rmSync(TMP_DATA, { recursive: true, force: true }); });

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-10-27T12:00:00Z");

const PDF_TEXT = [
	"--- Page 1 ---",
	"Thermodynamics, lecture 3",
	"The first law states that the change in internal energy of a system equals the heat added minus the work done by the system.",
	"",
	"--- Page 2 ---",
	"[no text on this page: scanned or image only]",
	"",
	"--- Page 3 ---",
	"Entropy of an isolated system never decreases over time. This is the second law of thermo-",
	"dynamics, and it gives time its direction.",
].join("\n");

function card(id: string, reviews: { at: number; grade: 1 | 2 | 3 }[] = [], extra: Partial<import("../src/core/flashcards.ts").Flashcard> = {}) {
	return { id, front: `Q ${id}`, back: `A ${id}`, quote: "q", createdAt: NOW - 30 * DAY, reviews, ...extra };
}

describe("reading notes", () => {
	it("splits a saved PDF text into numbered pages and skips scanned ones", () => {
		const pages = core.notesPages(PDF_TEXT);
		assert.deepEqual(pages.map((p) => p.page), [1, 3]);
		assert.match(pages[0]!.text, /^Thermodynamics/);
	});

	it("keeps a plain text note as one page without a number", () => {
		assert.deepEqual(core.notesPages("Just some notes.\nTwo lines."), [{ text: "Just some notes.\nTwo lines." }]);
		assert.deepEqual(core.notesPages("   \n"), []);
	});

	it("groups whole pages under the budget and splits an oversized page by lines, keeping its number", () => {
		const pages = [
			{ page: 1, text: "a".repeat(300) },
			{ page: 2, text: "b".repeat(300) },
			{ page: 3, text: Array.from({ length: 10 }, () => "c".repeat(300)).join("\n") },
		];
		const chunks = core.chunkPages(pages, 200); // 800 chars a chunk
		assert.deepEqual(chunks[0]!.map((p) => p.page), [1, 2]);
		assert.ok(chunks.slice(1).every((c) => c.every((p) => p.page === 3)));
		assert.ok(chunks.every((c) => c.reduce((n, p) => n + p.text.length, 0) <= 800));
		assert.match(core.chunkText(chunks[0]!), /^--- Page 1 ---\na+\n\n--- Page 2 ---/);
	});
});

describe("the quote check", () => {
	const pages = core.notesPages(PDF_TEXT);

	it("finds a quote despite case, punctuation, curly quotes and a PDF line-break hyphen", () => {
		assert.deepEqual(core.locateQuote("the FIRST law states that the change in internal energy", pages), { page: 1 });
		assert.deepEqual(core.locateQuote("This is the second law of thermodynamics, and it gives time its direction", pages), { page: 3 });
	});

	it("rejects a paraphrase and an invented sentence", () => {
		assert.equal(core.locateQuote("Energy is conserved: heat in minus work out equals the internal energy change.", pages), undefined);
		assert.equal(core.locateQuote("The third law says entropy approaches a constant at absolute zero.", pages), undefined);
		assert.equal(core.locateQuote("law", pages), undefined, "a word or two proves nothing");
	});

	it("accepts a long quote with one dropped word, but not a quote stitched from elsewhere", () => {
		const long = "The first law states that the change in internal energy of a system equals heat added minus the work done by the system.";
		assert.ok(core.quoteInText(long, pages[0]!.text));
		assert.ok(!core.quoteInText("The first law states that entropy of an isolated system gives time its direction always.", pages[0]!.text));
	});
});

describe("the schedule", () => {
	it("a new card has no schedule; a first Good answer is due in a few days", () => {
		assert.equal(core.cardSchedule([], NOW).status, "new");
		const s = core.cardSchedule([{ at: NOW - HOUR, grade: GRADE_GOOD }], NOW);
		assert.equal(s.status, "learning");
		const days = (s.dueAt! - NOW) / DAY;
		assert.ok(days > 2 && days < 4, `due in ${days} days`);
		assert.ok(s.retention! > TARGET_RETENTION);
	});

	it("the first answer of a sitting decides: a miss stays a miss even if right minutes later", () => {
		const missedThenRight = core.cardSchedule([{ at: NOW - 20 * 60_000, grade: GRADE_AGAIN }, { at: NOW - 10 * 60_000, grade: GRADE_GOOD }], NOW);
		const missed = core.cardSchedule([{ at: NOW - 20 * 60_000, grade: GRADE_AGAIN }], NOW);
		assert.equal(missedThenRight.sittings, 1);
		assert.equal(missedThenRight.lapses, 1);
		assert.equal(missedThenRight.lastGrade, GRADE_AGAIN);
		assert.equal(Math.round(missedThenRight.stability! * 1000), Math.round(missed.stability! * 1000));
		assert.ok((missedThenRight.dueAt! - NOW) / DAY < 1, "a missed card comes back within a day");
	});

	it("answers on separate days grow the interval; Hard grows it less than Good", () => {
		const good = core.cardSchedule([{ at: NOW - 10 * DAY, grade: GRADE_GOOD }, { at: NOW - 7 * DAY, grade: GRADE_GOOD }], NOW);
		const hard = core.cardSchedule([{ at: NOW - 10 * DAY, grade: GRADE_GOOD }, { at: NOW - 7 * DAY, grade: GRADE_HARD }], NOW);
		assert.equal(good.status, "known");
		assert.ok(good.stability! > hard.stability!);
	});

	it("verdicts map to grades with no Easy, and I don't know is a miss", () => {
		assert.equal(core.verdictGrade("gotIt"), GRADE_GOOD);
		assert.equal(core.verdictGrade("partly"), GRADE_HARD);
		assert.equal(core.verdictGrade("missed"), GRADE_AGAIN);
		assert.equal(core.verdictGrade("dontKnow"), GRADE_AGAIN);
		assert.equal(core.isCardVerdict("easy"), false);
	});
});

describe("the round", () => {
	const dayStart = NOW - 12 * HOUR;

	it("puts due cards first, weakest first, then today's share of new cards in note order", () => {
		const deck = {
			noteId: "src_aaaaaaaaaaaa",
			noteName: "a.pdf",
			generatedAt: NOW,
			cards: [
				card("new1"),
				card("slightlyDue", [{ at: NOW - 4 * DAY, grade: GRADE_GOOD }]),
				card("veryDue", [{ at: NOW - 30 * DAY, grade: GRADE_GOOD }]),
				card("fresh", [{ at: NOW - HOUR, grade: GRADE_GOOD }]),
				card("new2"),
			],
		};
		const q = core.cardQueue([deck], NOW, dayStart);
		assert.deepEqual(q.cards.map((c) => c.id), ["veryDue", "slightlyDue", "new1", "new2"]);
		assert.equal(q.due, 2);
		assert.equal(q.newWaiting, 2);
		assert.equal(q.reviewedToday, 1);
	});

	it("caps new cards per day, counting the ones already started today", () => {
		const cards = Array.from({ length: 30 }, (_, i) => card(`n${i}`));
		cards[0] = card("n0", [{ at: NOW - HOUR, grade: GRADE_GOOD }]);
		cards[1] = card("n1", [{ at: NOW - 2 * HOUR, grade: GRADE_AGAIN }]);
		const q = core.cardQueue([{ noteId: "src_bbbbbbbbbbbb", noteName: "b", generatedAt: NOW, cards }], NOW, dayStart, { newPerDay: 10 });
		assert.equal(q.cards.filter((c) => c.schedule.status === "new").length, 8);
		assert.equal(q.newToday, 8);
	});
});

describe("the maker", () => {
	const pages = core.notesPages(PDF_TEXT);
	const engineFor = (cards: { front: string; back: string; quote: string }[]) => {
		const faux = createFauxCore({});
		faux.setResponses([
			() => fauxAssistantMessage([fauxToolCall("submit_cards", { cards }, { id: "call-1" })], { stopReason: "toolUse" }),
			() => fauxAssistantMessage("done"),
		]);
		return { model: faux.getModel(), streamFn: faux.streamSimple } as never;
	};

	it("keeps cards whose quote is in the notes, takes the page from the quote, and drops the rest", async () => {
		const result = await makeChunkCards({
			chunk: pages,
			noteName: "thermo.pdf",
			part: { i: 1, n: 1 },
			signal: undefined,
			engine: engineFor([
				{ front: "What does the first law say?", back: "ΔU = Q − W", quote: "the change in internal energy of a system equals the heat added minus the work done" },
				{ front: "What gives time its direction?", back: "The second law (entropy never decreases)", quote: "Entropy of an isolated system never decreases over time" },
				{ front: "What is the third law?", back: "Invented", quote: "The third law says entropy approaches a constant at absolute zero" },
				{ front: "  ", back: "no question", quote: "Entropy of an isolated system never decreases over time" },
			]),
		});
		assert.deepEqual(result.cards.map((c) => [c.front, c.page]), [["What does the first law say?", 1], ["What gives time its direction?", 3]]);
		assert.equal(result.dropped, 1);
	});
});

describe("decks and answers", () => {
	const noteId = "src_cccccccccccc";

	it("records answers, edits and deletes, and keeps history on edit", () => {
		flashcardStore.save({ noteId, noteName: "c.pdf", generatedAt: NOW, cards: [card("x"), card("y")] });
		const answered = answerFlashcard(noteId, "x", "missed", NOW);
		assert.equal(answered?.schedule.lapses, 1);
		assert.equal(answerFlashcard(noteId, "nope", "gotIt", NOW), null);
		assert.equal(answerFlashcard("src_dddddddddddd", "x", "gotIt", NOW), null);

		assert.equal(editFlashcard(noteId, "x", { front: "  New question  " }), true);
		const x = flashcardStore.get(noteId)!.cards.find((c) => c.id === "x")!;
		assert.equal(x.front, "New question");
		assert.equal(x.reviews.length, 1);
		assert.throws(() => editFlashcard(noteId, "x", { back: " " }), FlashcardError);

		assert.equal(deleteFlashcard(noteId, "y"), true);
		assert.deepEqual(flashcardStore.get(noteId)!.cards.map((c) => c.id), ["x"]);
	});

	it("rejects ids that are not note ids", () => {
		assert.equal(flashcardStore.get("../chats/x"), null);
		assert.equal(flashcardStore.remove("../chats/x"), false);
	});

	it("a one-deck round still respects the day's new-card allowance across all decks", () => {
		const started = Array.from({ length: 15 }, (_, i) => card(`s${i}`, [{ at: NOW - HOUR, grade: GRADE_GOOD }]));
		flashcardStore.save({ noteId: "src_eeeeeeeeeeee", noteName: "e", generatedAt: NOW, cards: started });
		flashcardStore.save({ noteId: "src_ffffffffffff", noteName: "f", generatedAt: NOW, cards: [card("f1"), card("f2")] });
		const q = flashcardQueue({ noteId: "src_ffffffffffff", now: NOW });
		assert.equal(q.cards.length, 0, "15 new cards already started today");
	});
});

describe("a whole run", () => {
	it("makes a deck from a saved note in the background, and a remake keeps answered cards", async () => {
		const { notesLibrary } = await import("../src/store/notes.ts");
		const { startFlashcards, flashcardRun } = await import("../src/server/flashcards.ts");
		const meta = notesLibrary.save({ name: "Thermo run.pdf", bytes: new TextEncoder().encode("%PDF-"), text: PDF_TEXT, kind: "pdf", pages: 3, emptyPages: [2] });
		const engine = (cards: { front: string; back: string; quote: string }[]) => {
			const faux = createFauxCore({});
			faux.setResponses([
				() => fauxAssistantMessage([fauxToolCall("submit_cards", { cards }, { id: "call-1" })], { stopReason: "toolUse" }),
				() => fauxAssistantMessage("done"),
			]);
			return { model: faux.getModel(), streamFn: faux.streamSimple } as never;
		};
		const finished = async () => {
			for (let i = 0; i < 200 && flashcardRun(meta.id)?.state === "running"; i++) await new Promise((r) => setTimeout(r, 10));
			return flashcardRun(meta.id)!;
		};
		const firstLaw = { front: "What does the first law say?", back: "ΔU = Q − W", quote: "the change in internal energy of a system equals the heat added minus the work done" };
		const entropy = { front: "What does entropy do in an isolated system?", back: "It never decreases.", quote: "Entropy of an isolated system never decreases over time" };

		startFlashcards(meta.id, { engine: engine([firstLaw, entropy]) });
		const run = await finished();
		assert.equal(run.state, "done", run.error);
		assert.equal(run.cardsMade, 2);
		const deck = flashcardStore.get(meta.id)!;
		assert.deepEqual(deck.cards.map((c) => c.page), [1, 3]);

		answerFlashcard(meta.id, deck.cards[0]!.id, "gotIt");
		startFlashcards(meta.id, { engine: engine([{ ...firstLaw, back: "A rewording" }, { ...entropy, front: "Does entropy ever decrease in an isolated system, and why does it matter?" }]) });
		assert.equal((await finished()).state, "done");
		const remade = flashcardStore.get(meta.id)!;
		assert.equal(remade.cards.length, 2, "the answered card stays, its duplicate is skipped, the unanswered one is replaced");
		assert.equal(remade.cards[0]!.id, deck.cards[0]!.id);
		assert.equal(remade.cards[0]!.reviews.length, 1);
		assert.match(remade.cards[1]!.front, /why does it matter/);
	});
});
