/**
 * THE FLASHCARD DECKS — the fs adapter behind flashcards from notes:
 *
 *   data/flashcards/<noteId>.json   — FlashcardDeck (cards + review history)
 *
 * One deck per notes source, keyed by the notes source id (src_…). Kept
 * OUTSIDE the note's own folder on purpose: a re-import replaces that
 * folder, and must never take the review history with it.
 * Idioms (store/notes.ts): sync fs, id-guarded paths, JSON with tab
 * indentation, written to a temp file and renamed so a crash never leaves
 * half a deck.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { Flashcard, FlashcardDeck } from "../core/flashcards.ts";

const ID = /^src_[0-9a-f]{12}$/;

function deckFile(noteId: string): string {
	if (!ID.test(noteId)) throw new Error(`Invalid note id: ${noteId}`);
	return path.join(PATHS.flashcards, `${noteId}.json`);
}

function isCard(v: unknown): v is Flashcard {
	if (!v || typeof v !== "object") return false;
	const c = v as Record<string, unknown>;
	return typeof c.id === "string" && typeof c.front === "string" && typeof c.back === "string"
		&& typeof c.quote === "string" && typeof c.createdAt === "number"
		&& (c.page === undefined || typeof c.page === "number")
		&& Array.isArray(c.reviews)
		&& c.reviews.every((r) => r && typeof r.at === "number" && (r.grade === 1 || r.grade === 2 || r.grade === 3));
}

function isDeck(v: unknown): v is FlashcardDeck {
	if (!v || typeof v !== "object") return false;
	const d = v as Record<string, unknown>;
	return typeof d.noteId === "string" && ID.test(d.noteId) && typeof d.noteName === "string"
		&& typeof d.generatedAt === "number" && Array.isArray(d.cards) && d.cards.every(isCard);
}

export function newCardId(): string {
	return `card_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export const flashcardStore = {
	get(noteId: string): FlashcardDeck | null {
		if (!ID.test(noteId)) return null;
		try {
			const deck: unknown = JSON.parse(fs.readFileSync(deckFile(noteId), "utf-8"));
			return isDeck(deck) && deck.noteId === noteId ? deck : null;
		} catch {
			return null;
		}
	},

	/** Every deck, most recently generated first. Unreadable files are skipped. */
	list(): FlashcardDeck[] {
		let entries: string[];
		try {
			entries = fs.readdirSync(PATHS.flashcards);
		} catch {
			return [];
		}
		const out: FlashcardDeck[] = [];
		for (const file of entries) {
			const m = /^(src_[0-9a-f]{12})\.json$/.exec(file);
			const deck = m ? flashcardStore.get(m[1]!) : null;
			if (deck) out.push(deck);
		}
		return out.sort((a, b) => b.generatedAt - a.generatedAt);
	},

	save(deck: FlashcardDeck): void {
		const file = deckFile(deck.noteId);
		fs.mkdirSync(PATHS.flashcards, { recursive: true });
		const tmp = `${file}.tmp-${crypto.randomUUID().slice(0, 8)}`;
		try {
			fs.writeFileSync(tmp, JSON.stringify(deck, null, "\t"), "utf-8");
			fs.renameSync(tmp, file);
		} catch (err) {
			fs.rmSync(tmp, { force: true });
			throw err;
		}
	},

	/** Read, change, write — sync, so no other request lands in between. */
	update(noteId: string, change: (deck: FlashcardDeck) => FlashcardDeck | null): FlashcardDeck | null {
		const deck = flashcardStore.get(noteId);
		if (!deck) return null;
		const next = change(deck);
		if (next) flashcardStore.save(next);
		return next;
	},

	remove(noteId: string): boolean {
		if (!flashcardStore.get(noteId)) return false;
		fs.rmSync(deckFile(noteId), { force: true });
		return true;
	},
};
