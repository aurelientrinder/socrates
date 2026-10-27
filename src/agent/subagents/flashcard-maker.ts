/**
 * THE FLASHCARD MAKER (2026-10-27): one model call per chunk of notes,
 * submitting cards through one validated submit tool (runSubmitAgent).
 *
 * Hallucination guard: every card must carry a quote copied from the
 * notes. The quote is checked here against the chunk the model was shown
 * (core/flashcards.ts quoteInText); a card whose quote is not there is
 * dropped, and a submission where most quotes miss is sent back once to be
 * copied exactly. The page a card shows comes from where its quote was
 * found, never from the model's word.
 *
 * Rate limits: the caller runs chunks one at a time under the shared
 * background permit pool, and runSubagent waits out per-minute 429s, so a
 * free-tier key is spent a few requests at a time.
 */

import { Type } from "typebox";
import type { Usage } from "@earendil-works/pi-ai";
import type { PiEngine } from "../models.ts";
import { runSubmitAgent } from "./submit-agent.ts";
import { chunkText, locateQuote, tidyCardText, type NotesPage } from "../../core/flashcards.ts";

/** Cards per chunk, at most (a chunk is ≤ ~6k tokens of notes). */
export const MAX_CARDS_PER_CHUNK = 25;

export const FLASHCARD_INSTRUCTIONS = `You turn a student's own course notes into flashcards for spaced-repetition review.
The student will see the FRONT, answer from memory, then compare with the BACK. Their exams test understanding of
these notes, so the cards must be faithful to them.

RULES
1. Use ONLY what these notes say. Never add a fact, number, example, name or explanation that is not in the notes,
   even if you know it to be true. When the notes are unclear or incomplete on something, make no card for it.
2. One card tests ONE thing: a definition, a key fact, a formula (and what its symbols mean), a cause and its effect,
   a step of a method, the conditions of a theorem, the difference between two things that are easy to confuse.
3. FRONT: a question the student answers from memory, specific enough that only one answer fits. No yes/no
   questions, and never give the answer away in the question. Prefer "why" and "how" questions where the notes
   explain a reason or a mechanism.
4. BACK: the answer, short (one or two sentences, or a formula), as the notes put it.
5. QUOTE: copy, character for character, ONE passage from the notes (a sentence or part of one, 6 to 40 words) that
   contains the answer. It is checked against the notes: a card whose quote is not found there is thrown away. Do
   not include the "--- Page N ---" headers in a quote.
6. Cover what an exam would test. Skip course logistics, headers, author names, dates of lectures and trivia.
7. Write the cards in the language of the notes. Math in LaTeX: $...$ inline.
8. About one card per idea worth remembering, at most ${MAX_CARDS_PER_CHUNK} cards. Fewer good cards beat many weak
   ones. If this part of the notes has nothing worth a card, submit an empty list.

Submit all the cards in ONE call to submit_cards.`;

const cardsSchema = Type.Object({
	cards: Type.Array(
		Type.Object({
			front: Type.String({ description: "The question the student answers from memory." }),
			back: Type.String({ description: "The short answer, as the notes put it." }),
			quote: Type.String({ description: "A passage copied exactly from the notes (6-40 words) that contains the answer." }),
		}),
		{ description: `The flashcards for this part of the notes (at most ${MAX_CARDS_PER_CHUNK}).` },
	),
});

interface RawCard {
	front: string;
	back: string;
	quote: string;
}

export interface MadeCard {
	front: string;
	back: string;
	quote: string;
	page?: number;
}

export interface ChunkCards {
	cards: MadeCard[];
	/** Cards dropped because their quote is not in the notes. */
	dropped: number;
}

/** Weak models sometimes send the array as one JSON string. */
function healCards(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
	if (typeof out.cards === "string") {
		try {
			const parsed: unknown = JSON.parse(out.cards);
			if (Array.isArray(parsed)) out.cards = parsed;
		} catch {
			// leave it for validation
		}
	}
	return out;
}

function usable(c: RawCard): boolean {
	return c.front.trim().length > 0 && c.back.trim().length > 0;
}

/** Make the cards for one chunk of notes. */
export async function makeChunkCards(opts: {
	chunk: readonly NotesPage[];
	noteName: string;
	part: { i: number; n: number };
	engine: PiEngine | undefined;
	signal: AbortSignal | undefined;
	onUsage?: (usage: Usage, model: string) => void;
}): Promise<ChunkCards> {
	const { chunk } = opts;
	const where = opts.part.n > 1 ? ` (part ${opts.part.i} of ${opts.part.n})` : "";
	const submitted = await runSubmitAgent<{ cards: RawCard[] }>({
		role: "extractor",
		toolName: "submit_cards",
		toolDescription: "Submit the flashcards for this part of the notes.",
		parameters: cardsSchema,
		fill: (input: { cards?: RawCard[] }) => ({ cards: (input.cards ?? []).filter(usable) }),
		// A batch whose quotes mostly miss was paraphrased: one more try.
		validate: ({ cards }) => {
			if (cards.length < 3) return null;
			const found = cards.filter((c) => locateQuote(c.quote, chunk)).length;
			return found / cards.length >= 0.5
				? null
				: `Only ${found} of ${cards.length} quotes were found in the notes. Copy each quote character for character from the notes (no paraphrase, no page headers), then submit all the cards again.`;
		},
		systemPrompt: FLASHCARD_INSTRUCTIONS,
		prompt: `Notes file: ${opts.noteName}${where}\n\n<notes>\n${chunkText(chunk)}\n</notes>`,
		engine: opts.engine,
		signal: opts.signal,
		onStep: (usage, model) => opts.onUsage?.(usage, model),
		neverSubmitted: "The model never sent any cards.",
		prepareArguments: healCards,
	});

	const cards: MadeCard[] = [];
	let dropped = 0;
	for (const c of submitted.cards.slice(0, MAX_CARDS_PER_CHUNK)) {
		const at = locateQuote(c.quote, chunk);
		if (!at) {
			dropped++;
			continue;
		}
		cards.push({
			front: tidyCardText(c.front, 400),
			back: tidyCardText(c.back),
			quote: tidyCardText(c.quote, 400),
			...(at.page !== undefined ? { page: at.page } : {}),
		});
	}
	return { cards, dropped };
}
