/**
 * FLASHCARDS FROM NOTES, the server side: make a deck from a saved note
 * (one background run per note), read decks and the review queue, record
 * answers, and let the learner fix or drop a card.
 *
 * Making cards is a background run tracked in a small in-process registry
 * (the import precedent: one process, one truth on globalThis). The route
 * starts it and returns at once; the Library row polls the deck's status
 * and shows each part as it lands. Chunks run strictly one after another
 * under the shared background permit pool (bg-llm-semaphore), and
 * runSubagent waits out per-minute rate limits, so a free-tier key sees a
 * steady trickle of requests, never a burst.
 */

import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { withBgLlmSlot } from "../agent/subagents/bg-llm-semaphore.ts";
import { makeChunkCards, type MadeCard } from "../agent/subagents/flashcard-maker.ts";
import { rateLimitedUntil } from "../agent/rate-limit.ts";
import { emit } from "../core/events.ts";
import {
	cardQueue,
	cardViews,
	chunkPages,
	deckSummary,
	notesPages,
	sameFront,
	tidyCardText,
	verdictGrade,
	type CardQueue,
	type CardVerdict,
	type CardView,
	type DeckSummary,
	type Flashcard,
} from "../core/flashcards.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { providerKeyMissing } from "../core/settings.ts";
import { flashcardStore, newCardId } from "../store/flashcards.ts";
import { notesLibrary } from "../store/notes.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

/** Tokens of notes per model call. Big enough that a 40-page PDF is a
 *  handful of requests (free tiers count requests per minute), small
 *  enough that a cheap model keeps its focus. */
export const CARD_CHUNK_TOKENS = 6000;

/** A refusal the learner can act on — routes report its message as is. */
export class FlashcardError extends Error {}

export interface FlashcardRun {
	noteId: string;
	state: "running" | "done" | "failed" | "cancelled";
	startedAt: number;
	finishedAt?: number;
	/** Parts of the notes done / in total (one model call each). */
	partsDone: number;
	parts: number;
	cardsMade: number;
	/** Cards thrown away because their quote is not in the notes. */
	dropped: number;
	/** Waiting out the provider's per-minute limit, until this time. */
	pausedUntil?: number;
	error?: string;
}

interface RunEntry {
	run: FlashcardRun;
	controller: AbortController;
}

interface FlashcardGlobal {
	__lhFlashcardRuns?: Map<string, RunEntry>;
}

function runs(): Map<string, RunEntry> {
	const g = globalThis as typeof globalThis & FlashcardGlobal;
	return (g.__lhFlashcardRuns ??= new Map());
}

/** The note's current or last run (a finished one is kept so the Library
 *  can say how it went). */
export function flashcardRun(noteId: string): FlashcardRun | null {
	const entry = runs().get(noteId);
	if (!entry) return null;
	const pausedUntil = entry.run.state === "running" ? rateLimitedUntil(entry.controller.signal) : null;
	return { ...entry.run, ...(pausedUntil ? { pausedUntil } : {}) };
}

function resolveCardEngine(): PiEngine {
	const spec = resolveRoleSpec("extractor", stores.settingsStore.readSettings());
	if (!spec) throw new FlashcardError("No model is set up for background work yet. Pick one in Settings → Models first.");
	if (!providerKeyPresent(spec.provider)) throw new FlashcardError(providerKeyMissing(spec.provider, ["cheap"]).error);
	return piEngineForSpec(spec);
}

/** Start making cards from a saved note. Cards already answered are kept
 *  with their history; the unanswered ones are replaced when the run
 *  finishes (a failed or cancelled run leaves the old deck as it was). */
export function startFlashcards(noteId: string, opts: { engine?: PiEngine } = {}): FlashcardRun {
	const note = notesLibrary.get(noteId);
	const text = note ? notesLibrary.text(noteId) : null;
	if (!note || text === null) throw new FlashcardError("This note isn't saved any more. Import the file again first.");
	const existing = runs().get(noteId);
	if (existing?.run.state === "running") return flashcardRun(noteId)!;
	const chunks = chunkPages(notesPages(text), CARD_CHUNK_TOKENS);
	if (chunks.length === 0) {
		throw new FlashcardError("There's no text in this file to make cards from (it looks scanned). Run it through OCR, then import the text.");
	}
	const engine = opts.engine ?? resolveCardEngine();

	const entry: RunEntry = {
		controller: new AbortController(),
		run: { noteId, state: "running", startedAt: Date.now(), partsDone: 0, parts: chunks.length, cardsMade: 0, dropped: 0 },
	};
	runs().set(noteId, entry);
	emit("activity-changed", {});

	void (async () => {
		const made: MadeCard[] = [];
		try {
			for (const [i, chunk] of chunks.entries()) {
				const signal = entry.controller.signal;
				signal.throwIfAborted();
				const result = await withBgLlmSlot(signal, () =>
					makeChunkCards({ chunk, noteName: note.name, part: { i: i + 1, n: chunks.length }, engine, signal }),
				);
				for (const card of result.cards) if (!made.some((m) => sameFront(m.front, card.front))) made.push(card);
				entry.run.partsDone = i + 1;
				entry.run.cardsMade = made.length;
				entry.run.dropped += result.dropped;
				emit("activity-changed", {});
			}
			saveMadeCards(noteId, note.name, made);
			entry.run.state = "done";
		} catch (err) {
			const aborted = entry.controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
			entry.run.state = aborted ? "cancelled" : "failed";
			if (!aborted) entry.run.error = err instanceof Error ? err.message : String(err);
			// A first deck keeps what the finished parts made; a re-run
			// that stopped halfway leaves the old deck untouched.
			if (made.length > 0 && !flashcardStore.get(noteId)?.cards.length) saveMadeCards(noteId, note.name, made);
			console.warn(`[flashcards ${noteId}] ${entry.run.state}: ${entry.run.error ?? "by the learner"}`);
		} finally {
			entry.run.finishedAt = Date.now();
			emit("activity-changed", {});
		}
	})();
	return flashcardRun(noteId)!;
}

export function cancelFlashcards(noteId: string): boolean {
	const entry = runs().get(noteId);
	if (entry?.run.state !== "running") return false;
	entry.controller.abort();
	return true;
}

/** Merge a run's cards into the deck: answered cards stay (history and
 *  all), unanswered ones are replaced, and a new card that asks what an
 *  answered one already asks is skipped. */
function saveMadeCards(noteId: string, noteName: string, made: MadeCard[]): void {
	const kept = (flashcardStore.get(noteId)?.cards ?? []).filter((c) => c.reviews.length > 0);
	const now = Date.now();
	const fresh: Flashcard[] = made
		.filter((m) => !kept.some((k) => sameFront(k.front, m.front)))
		.map((m) => ({ id: newCardId(), front: m.front, back: m.back, quote: m.quote, ...(m.page !== undefined ? { page: m.page } : {}), createdAt: now, reviews: [] }));
	flashcardStore.save({ noteId, noteName, generatedAt: now, cards: [...kept, ...fresh] });
}

function startOfLocalDay(now: number): number {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** One deck with every card's schedule (the Library's card list). */
export function flashcardDeck(noteId: string, now: number = Date.now()): { summary: DeckSummary; cards: CardView[] } | null {
	const deck = flashcardStore.get(noteId);
	return deck ? { summary: deckSummary(deck, now), cards: cardViews(deck, now) } : null;
}

export function flashcardDeckSummaries(now: number = Date.now()): DeckSummary[] {
	return flashcardStore.list().map((d) => deckSummary(d, now));
}

/** The next round of cards: across every deck, or one deck. */
export function flashcardQueue(opts: { noteId?: string; now?: number } = {}): CardQueue {
	const now = opts.now ?? Date.now();
	const all = flashcardStore.list();
	const decks = opts.noteId ? all.filter((d) => d.noteId === opts.noteId) : all;
	// Today's new-card allowance is shared by every deck, so count it on all.
	const queue = cardQueue(decks, now, startOfLocalDay(now));
	if (!opts.noteId) return queue;
	const overall = cardQueue(all, now, startOfLocalDay(now));
	const newAllowed = Math.min(queue.newToday, overall.newToday);
	const due = queue.cards.filter((c) => c.schedule.status === "due");
	const fresh = queue.cards.filter((c) => c.schedule.status === "new").slice(0, newAllowed);
	return { ...queue, cards: [...due, ...fresh], newToday: newAllowed };
}

/** Record one answer. Returns the card's new state. */
export function answerFlashcard(noteId: string, cardId: string, verdict: CardVerdict, now: number = Date.now()): CardView | null {
	let found = false;
	const deck = flashcardStore.update(noteId, (d) => {
		const cards = d.cards.map((c) => {
			if (c.id !== cardId) return c;
			found = true;
			return { ...c, reviews: [...c.reviews, { at: now, grade: verdictGrade(verdict) }] };
		});
		return found ? { ...d, cards } : null;
	});
	return deck ? (cardViews(deck, now).find((c) => c.id === cardId) ?? null) : null;
}

/** Fix a card's wording. Its review history stays. */
export function editFlashcard(noteId: string, cardId: string, change: { front?: string; back?: string }): boolean {
	const front = change.front !== undefined ? tidyCardText(change.front, 400) : undefined;
	const back = change.back !== undefined ? tidyCardText(change.back) : undefined;
	if (front === "" || back === "") throw new FlashcardError("A card needs both a question and an answer.");
	let found = false;
	flashcardStore.update(noteId, (d) => {
		const cards = d.cards.map((c) => {
			if (c.id !== cardId) return c;
			found = true;
			return { ...c, ...(front !== undefined ? { front } : {}), ...(back !== undefined ? { back } : {}) };
		});
		return found ? { ...d, cards } : null;
	});
	return found;
}

export function deleteFlashcard(noteId: string, cardId: string): boolean {
	let found = false;
	flashcardStore.update(noteId, (d) => {
		found = d.cards.some((c) => c.id === cardId);
		return found ? { ...d, cards: d.cards.filter((c) => c.id !== cardId) } : null;
	});
	return found;
}

/** Remove a whole deck (history included). A running run is stopped. */
export function deleteFlashcardDeck(noteId: string): boolean {
	cancelFlashcards(noteId);
	return flashcardStore.remove(noteId);
}
