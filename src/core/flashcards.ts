/**
 * FLASHCARDS FROM NOTES (2026-10-27): one click turns an imported notes
 * file into review cards, and the cards ride the SAME memory model as the
 * learner's topics (retention.ts, FSRS-4.5 default weights, due under the
 * same 90% target). Grading follows the retention doctrine: the learner
 * types an answer (or says "I don't know") BEFORE the card's answer shows,
 * then compares the two. There is no Easy grade, and a miss is never
 * softened by getting the card right again minutes later: the FIRST
 * answer of a sitting is the one that schedules the card.
 *
 * Every card carries a short QUOTE from the notes it was made from. The
 * generator keeps a card only when that quote is really in the notes
 * (locateQuote), and the review screen shows it under the answer, so a
 * card the model made up cannot slip in, and a wrong one is easy to spot.
 *
 * Pure and browser-safe: the server stores the decks and runs the model,
 * this shapes, matches and schedules.
 */

import {
	GRADE_AGAIN,
	GRADE_GOOD,
	GRADE_HARD,
	SITTING_GAP_MS,
	initialState,
	intervalDays,
	nextState,
	retrievability,
	type MemoryState,
	type RecallGrade,
} from "./retention.ts";

/** One answered card. */
export interface CardReview {
	/** Epoch ms. */
	at: number;
	grade: RecallGrade;
}

export interface Flashcard {
	id: string;
	/** The question side. */
	front: string;
	/** The answer side. */
	back: string;
	/** The words in the notes this card comes from (verbatim, short). */
	quote: string;
	/** The PDF page the quote is on (text notes have none). */
	page?: number;
	/** Epoch ms. */
	createdAt: number;
	/** Every answer, oldest first. Empty = a new card. */
	reviews: CardReview[];
}

/** One notes file's cards. Kept apart from the note itself, so a
 *  re-import of the file never wipes the review history. */
export interface FlashcardDeck {
	/** The notes source id (src_…), the deck's identity. */
	noteId: string;
	/** The notes file name (kept so a deck outlives a removed note). */
	noteName: string;
	/** Epoch ms of the last generation. */
	generatedAt: number;
	cards: Flashcard[];
}

/** New cards a day, across every deck: enough to make progress, few
 *  enough that a big PDF never turns into a wall. */
export const NEW_CARDS_PER_DAY = 15;
/** Cards per round: about five minutes. Another round is one click. */
export const CARD_ROUND_SIZE = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── scheduling ─────────────────────────────────────────────────────────────

export type CardStatus = "new" | "due" | "learning" | "known";

export interface CardSchedule {
	status: CardStatus;
	/** Sittings (answers on one card closer than SITTING_GAP_MS are one). */
	sittings: number;
	lapses: number;
	/** Predicted recall now, 0-1; null for a new card. */
	retention: number | null;
	/** Epoch ms when recall falls under the target; null for a new card. */
	dueAt: number | null;
	lastGrade: RecallGrade | null;
	lastReviewedAt: number | null;
	stability: number | null;
}

/** Fold a card's answers into its memory state. One sitting = one FSRS
 *  review, graded by its FIRST answer (what the learner knew walking in;
 *  later answers in the same sitting come right after seeing the card). */
export function cardSchedule(reviews: readonly CardReview[], now: number): CardSchedule {
	const sorted = [...reviews].sort((a, b) => a.at - b.at);
	if (sorted.length === 0) {
		return { status: "new", sittings: 0, lapses: 0, retention: null, dueAt: null, lastGrade: null, lastReviewedAt: null, stability: null };
	}
	const sittings: { first: RecallGrade; last: number }[] = [];
	for (const r of sorted) {
		const current = sittings.at(-1);
		if (current && r.at - current.last < SITTING_GAP_MS) current.last = r.at;
		else sittings.push({ first: r.grade, last: r.at });
	}
	let state: MemoryState | null = null;
	let prevAt = 0;
	let lapses = 0;
	for (const s of sittings) {
		state = state === null ? initialState(s.first) : nextState(state, s.first, (s.last - prevAt) / DAY_MS);
		if (s.first === GRADE_AGAIN) lapses++;
		prevAt = s.last;
	}
	const final = state!;
	const lastGrade = sittings.at(-1)!.first;
	const dueAt = prevAt + intervalDays(final.stability) * DAY_MS;
	const retention = retrievability((now - prevAt) / DAY_MS, final.stability);
	const due = dueAt <= now;
	return {
		status: due ? "due" : lastGrade === GRADE_GOOD && sittings.length > 1 ? "known" : "learning",
		sittings: sittings.length,
		lapses,
		retention,
		dueAt,
		lastGrade,
		lastReviewedAt: prevAt,
		stability: final.stability,
	};
}

/** A card as the views see it: the card, where it lives, its schedule. */
export interface CardView extends Flashcard {
	noteId: string;
	noteName: string;
	schedule: CardSchedule;
}

export interface DeckSummary {
	noteId: string;
	noteName: string;
	generatedAt: number;
	total: number;
	new: number;
	due: number;
	learning: number;
	known: number;
}

export function deckSummary(deck: FlashcardDeck, now: number): DeckSummary {
	const out: DeckSummary = { noteId: deck.noteId, noteName: deck.noteName, generatedAt: deck.generatedAt, total: deck.cards.length, new: 0, due: 0, learning: 0, known: 0 };
	for (const card of deck.cards) out[cardSchedule(card.reviews, now).status]++;
	return out;
}

export function cardViews(deck: FlashcardDeck, now: number): CardView[] {
	return deck.cards.map((c) => ({ ...c, noteId: deck.noteId, noteName: deck.noteName, schedule: cardSchedule(c.reviews, now) }));
}

/** New cards first answered since `dayStart` (today's share of the limit). */
export function newCardsStartedSince(decks: readonly FlashcardDeck[], dayStart: number): number {
	let n = 0;
	for (const deck of decks) {
		for (const card of deck.cards) {
			const first = Math.min(...card.reviews.map((r) => r.at));
			if (card.reviews.length > 0 && first >= dayStart) n++;
		}
	}
	return n;
}

export interface CardQueue {
	/** This round's cards: due ones first (weakest first), then new ones
	 *  in the order they appear in the notes. */
	cards: CardView[];
	/** Everything due now (the whole backlog, beyond this round too). */
	due: number;
	/** New cards still allowed today. */
	newToday: number;
	/** New cards waiting in total. */
	newWaiting: number;
	/** Cards answered today (local day). */
	reviewedToday: number;
}

/** The next round across `decks` (or one deck when the caller passes
 *  just that one). `dayStart` is the learner's local midnight. */
export function cardQueue(
	decks: readonly FlashcardDeck[],
	now: number,
	dayStart: number,
	opts: { newPerDay?: number; roundSize?: number } = {},
): CardQueue {
	const newPerDay = opts.newPerDay ?? NEW_CARDS_PER_DAY;
	const roundSize = opts.roundSize ?? CARD_ROUND_SIZE;
	const all = decks.flatMap((d) => cardViews(d, now));
	const due = all
		.filter((c) => c.schedule.status === "due")
		.sort((a, b) => a.schedule.retention! - b.schedule.retention! || a.schedule.dueAt! - b.schedule.dueAt!);
	const fresh = all.filter((c) => c.schedule.status === "new");
	const newToday = Math.max(0, newPerDay - newCardsStartedSince(decks, dayStart));
	const reviewedToday = all.filter((c) => c.reviews.some((r) => r.at >= dayStart)).length;
	const cards = [...due, ...fresh.slice(0, newToday)].slice(0, roundSize);
	return { cards, due: due.length, newToday: Math.min(newToday, fresh.length), newWaiting: fresh.length, reviewedToday };
}

/** The learner's verdict after comparing answers. "dontKnow" skips the
 *  comparison (nothing was recalled) and grades as a miss. */
export type CardVerdict = "missed" | "partly" | "gotIt" | "dontKnow";

export function verdictGrade(verdict: CardVerdict): RecallGrade {
	switch (verdict) {
		case "gotIt":
			return GRADE_GOOD;
		case "partly":
			return GRADE_HARD;
		default:
			return GRADE_AGAIN;
	}
}

export function isCardVerdict(v: unknown): v is CardVerdict {
	return v === "missed" || v === "partly" || v === "gotIt" || v === "dontKnow";
}

/** "in 3 days" for a card's next review, from its schedule. */
export function nextReviewDays(schedule: CardSchedule, now: number): number | null {
	return schedule.dueAt === null ? null : Math.max(0, Math.round((schedule.dueAt - now) / DAY_MS));
}

// ─── reading the notes ──────────────────────────────────────────────────────

/** One page of notes (a PDF page, or the whole text of a text note). */
export interface NotesPage {
	page?: number;
	text: string;
}

const PAGE_MARKER = /^--- Page (\d+) ---$/;

/** Split a saved note's text (store/notes: PDFs are "--- Page N ---"
 *  headed) into pages. Scanned-page placeholders are dropped. */
export function notesPages(text: string): NotesPage[] {
	const lines = text.split("\n");
	if (!lines.some((l) => PAGE_MARKER.test(l))) return text.trim() ? [{ text }] : [];
	const pages: NotesPage[] = [];
	let current: NotesPage | null = null;
	const lead: string[] = [];
	for (const line of lines) {
		const m = PAGE_MARKER.exec(line);
		if (m) {
			if (current) pages.push(current);
			current = { page: Number(m[1]), text: "" };
		} else if (current) current.text += (current.text ? "\n" : "") + line;
		else lead.push(line);
	}
	if (current) pages.push(current);
	const out = pages
		.map((p) => ({ ...p, text: p.text.trim() }))
		.filter((p) => p.text && !p.text.startsWith("[no text on this page"));
	return lead.join("\n").trim() ? [{ text: lead.join("\n").trim() }, ...out] : out;
}

/** Group pages into model-sized chunks (chars/4 ≈ tokens, like the rest
 *  of the app). Whole pages stay together; a page over the budget is
 *  split by lines and keeps its page number. Fewer, bigger chunks mean
 *  fewer requests against free-tier per-minute limits. */
export function chunkPages(pages: readonly NotesPage[], budgetTokens: number): NotesPage[][] {
	const budget = Math.max(200, budgetTokens) * 4;
	const pieces: NotesPage[] = [];
	for (const p of pages) {
		if (p.text.length <= budget) {
			pieces.push(p);
			continue;
		}
		let current = "";
		for (const line of p.text.split("\n")) {
			if (current && current.length + 1 + line.length > budget) {
				pieces.push({ ...p, text: current });
				current = line;
			} else current = current ? `${current}\n${line}` : line;
		}
		if (current.trim()) pieces.push({ ...p, text: current });
	}
	const chunks: NotesPage[][] = [];
	let size = 0;
	for (const piece of pieces) {
		const last = chunks.at(-1);
		if (last && size + piece.text.length <= budget) {
			last.push(piece);
			size += piece.text.length;
		} else {
			chunks.push([piece]);
			size = piece.text.length;
		}
	}
	return chunks;
}

/** How a chunk reads to the model: each page headed with its number. */
export function chunkText(chunk: readonly NotesPage[]): string {
	return chunk.map((p) => (p.page !== undefined ? `--- Page ${p.page} ---\n${p.text}` : p.text)).join("\n\n");
}

/** Text reduced to its words: case, accents' composed forms, punctuation,
 *  quote styles, PDF line-break hyphenation and spacing all stop mattering. */
export function matchWords(text: string): string[] {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/­/g, "")
		.replace(/(\p{L})-\s*\n\s*(\p{L})/gu, "$1$2")
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

/** Words per window when a quote is matched loosely. */
const WINDOW = 5;

/** Is `quote` really in `text`? Exact (by words) for short quotes; for a
 *  longer one, most of its 5-word stretches must appear in the text, so a
 *  PDF's broken line or a dropped symbol does not reject a real quote,
 *  while a paraphrase or an invented sentence does not pass. */
export function quoteInText(quote: string, text: string): boolean {
	const q = matchWords(quote);
	if (q.length < 3) return false;
	const hay = ` ${matchWords(text).join(" ")} `;
	if (hay.includes(` ${q.join(" ")} `)) return true;
	if (q.length < WINDOW * 2) return false;
	let hits = 0;
	let windows = 0;
	for (let i = 0; i + WINDOW <= q.length; i++) {
		windows++;
		if (hay.includes(` ${q.slice(i, i + WINDOW).join(" ")} `)) hits++;
	}
	return hits / windows >= 0.75;
}

/** The page of `chunk` the quote is on; undefined when it is on none.
 *  `{ page: undefined }` means "found, in a text note without pages". */
export function locateQuote(quote: string, chunk: readonly NotesPage[]): { page: number | undefined } | undefined {
	for (const p of chunk) if (quoteInText(quote, p.text)) return { page: p.page };
	// A quote may straddle two pages.
	for (let i = 0; i + 1 < chunk.length; i++) {
		if (quoteInText(quote, `${chunk[i]!.text}\n${chunk[i + 1]!.text}`)) return { page: chunk[i]!.page };
	}
	return undefined;
}

/** Two cards that ask the same thing (by words). */
export function sameFront(a: string, b: string): boolean {
	return matchWords(a).join(" ") === matchWords(b).join(" ");
}

/** A card reads at a glance: trimmed, with no runaway length. */
export function tidyCardText(s: string, max = 600): string {
	const t = s.replace(/\s+\n/g, "\n").trim();
	return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
