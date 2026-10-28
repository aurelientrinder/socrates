"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { LayersIcon, PlayIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageResponse } from "@/components/ai-elements/message";
import { SectionHeading } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { nextReviewDays, repairMathForDisplay, type CardQueue, type CardVerdict, type CardView, type DeckSummary } from "@/src/core";

/**
 * FLASHCARD REVIEW (the Progress page's Flashcards tab): the next round of
 * cards made from the learner's notes. Each card asks for an answer FIRST
 * (typed, or "I don't know"), then shows the card's answer beside it with
 * the line of the notes it came from, and the learner grades the match:
 * Missed, Partly or Got it. No Easy. A missed card comes back at the end of
 * the round, but only the first answer of the day schedules it.
 */
export function FlashcardReview({ deck }: { deck?: string }) {
	const [data, setData] = useState<{ decks: DeckSummary[]; queue: CardQueue } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [round, setRound] = useState<CardView[] | null>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`/api/flashcards${deck ? `?deck=${encodeURIComponent(deck)}` : ""}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setData((await res.json()) as { decks: DeckSummary[]; queue: CardQueue });
			setError(null);
		} catch (err) {
			setError(`Couldn't load your cards (${err instanceof Error ? err.message : String(err)}).`);
		}
	}, [deck]);
	useEffect(() => {
		void load();
	}, [load]);

	if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
	if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

	if (round) {
		return (
			<Round
				cards={round}
				onFinish={() => {
					setRound(null);
					void load();
				}}
			/>
		);
	}

	const { queue, decks } = data;
	const only = deck ? decks.find((d) => d.noteId === deck) : undefined;
	return (
		<div data-testid="flashcards-view" className="flex flex-col gap-8">
			<header className="flex flex-col gap-2">
				<p data-testid="flashcards-headline" className="font-prose text-xl">
					{headline(queue, decks)}
				</p>
				<p className="max-w-2xl text-sm text-muted-foreground">
					Cards made from your imported notes. Answer each one before you see the card&apos;s answer, then compare: the
					cards you miss come back sooner, the ones you know wait longer. Make cards from a file in the{" "}
					<Link href="/library" className="underline underline-offset-2">Library</Link>.
				</p>
			</header>

			{decks.length > 0 && (
				<section
					data-testid="flashcards-start"
					className={cn("flex flex-col gap-3 rounded-xl px-5 py-4", queue.cards.length > 0 ? "bg-warn-soft" : "border border-border/70 bg-surface")}
				>
					{only && (
						<p className="text-sm">
							Only <span className="font-medium">{only.noteName}</span>.{" "}
							<Link href="/progress?tab=cards" className="underline underline-offset-2">All decks</Link>
						</p>
					)}
					{queue.cards.length > 0 ? (
						<div className="flex flex-wrap items-center gap-3">
							<Button data-testid="flashcards-start-button" onClick={() => setRound(queue.cards)}>
								<PlayIcon className="size-4" />
								Start
							</Button>
							<p className="text-base text-foreground/80">{roundText(queue)}</p>
						</div>
					) : (
						<p className="text-sm text-muted-foreground">
							{queue.newWaiting > 0
								? `Done for today. ${queue.newWaiting} new ${queue.newWaiting === 1 ? "card waits" : "cards wait"} for tomorrow.`
								: "Nothing to review right now."}
						</p>
					)}
					<p data-testid="flashcards-today" className="text-xs text-muted-foreground">
						{queue.reviewedToday > 0
							? `${queue.reviewedToday} ${queue.reviewedToday === 1 ? "card" : "cards"} reviewed today.`
							: "No cards reviewed yet today."}
					</p>
				</section>
			)}

			<section className="flex flex-col gap-3">
				<SectionHeading>Decks</SectionHeading>
				{decks.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No cards yet. In the Library, press <span className="font-medium">Make flashcards</span> on one of your notes.
					</p>
				) : (
					<ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-surface">
						{decks.map((d) => (
							<li key={d.noteId} data-testid="flashcards-deck">
								<Link
									href={`/progress?tab=cards&deck=${d.noteId}`}
									className="flex items-center gap-3 px-4 py-2.5 text-base transition-colors hover:bg-accent"
								>
									<LayersIcon className="size-4 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate">{d.noteName}</span>
									<span className="shrink-0 text-xs tabular-nums text-muted-foreground">{deckCounts(d)}</span>
								</Link>
							</li>
						))}
					</ul>
				)}
			</section>
		</div>
	);
}

function headline(queue: CardQueue, decks: DeckSummary[]): string {
	if (decks.length === 0) return "No flashcards yet.";
	if (queue.due > 0) return `${queue.due} ${queue.due === 1 ? "card is" : "cards are"} fading and due for review.`;
	if (queue.cards.length > 0) return `${queue.cards.length} new ${queue.cards.length === 1 ? "card" : "cards"} to learn today.`;
	return "All your cards are fresh.";
}

function roundText(queue: CardQueue): string {
	const due = queue.cards.filter((c) => c.schedule.status === "due").length;
	const fresh = queue.cards.length - due;
	const parts = [due > 0 ? `${due} due` : null, fresh > 0 ? `${fresh} new` : null].filter(Boolean).join(", ");
	const minutes = Math.max(1, Math.round(queue.cards.length / 4));
	const more = queue.due - due;
	return `${parts}, about ${minutes} ${minutes === 1 ? "minute" : "minutes"}${more > 0 ? `. ${more} more wait for the next round.` : "."}`;
}

export function deckCounts(d: Pick<DeckSummary, "total" | "due" | "new">): string {
	const parts = [`${d.total} ${d.total === 1 ? "card" : "cards"}`];
	if (d.due > 0) parts.push(`${d.due} due`);
	if (d.new > 0) parts.push(`${d.new} new`);
	return parts.join(" · ");
}

// ─── one round ──────────────────────────────────────────────────────────────

type Tally = Record<CardVerdict, number>;

function Round({ cards, onFinish }: { cards: CardView[]; onFinish: () => void }) {
	const [queue, setQueue] = useState<CardView[]>(cards);
	const [index, setIndex] = useState(0);
	const [answer, setAnswer] = useState("");
	const [revealed, setRevealed] = useState<null | "typed" | "dontKnow">(null);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [tally, setTally] = useState<Tally>({ gotIt: 0, partly: 0, missed: 0, dontKnow: 0 });
	const [nextDue, setNextDue] = useState<Record<string, number | null>>({});
	/** Cards already graded once this round (a repeat does not count again in the tally). */
	const seen = useRef(new Set<string>());
	const inputRef = useRef<HTMLTextAreaElement>(null);

	const card = queue[index];
	useEffect(() => {
		if (!revealed) inputRef.current?.focus();
	}, [index, revealed]);

	const grade = useCallback(
		async (verdict: CardVerdict) => {
			if (!card || saving) return;
			setSaving(true);
			setError(null);
			try {
				const res = await fetch(`/api/flashcards/${card.noteId}/cards/${card.id}/answer`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ verdict }),
				});
				if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
				const { card: updated } = (await res.json()) as { card: CardView };
				if (!seen.current.has(card.id)) {
					seen.current.add(card.id);
					setTally((t) => ({ ...t, [verdict]: t[verdict] + 1 }));
				}
				setNextDue((m) => ({ ...m, [card.id]: nextReviewDays(updated.schedule, Date.now()) }));
				// Missed: see it again at the end of this round, until it sticks.
				if (verdict === "missed" || verdict === "dontKnow") setQueue((q) => [...q, card]);
				setIndex((i) => i + 1);
				setAnswer("");
				setRevealed(null);
			} catch (err) {
				setError(`Couldn't save that answer (${err instanceof Error ? err.message : String(err)}). Try again.`);
			} finally {
				setSaving(false);
			}
		},
		[card, saving],
	);

	// Keys once the answer shows: 1 Missed, 2 Partly, 3 Got it.
	useEffect(() => {
		if (revealed !== "typed") return;
		const onKey = (e: KeyboardEvent) => {
			if (e.metaKey || e.ctrlKey || e.altKey) return;
			const verdict = ({ "1": "missed", "2": "partly", "3": "gotIt" } as const)[e.key as "1" | "2" | "3"];
			if (verdict) {
				e.preventDefault();
				void grade(verdict);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [revealed, grade]);

	if (!card) return <RoundDone tally={tally} total={cards.length} nextDue={nextDue} onFinish={onFinish} />;

	const repeat = index >= cards.length;
	return (
		<section data-testid="flashcard-round" className="mx-auto flex w-full max-w-2xl flex-col gap-4">
			<div className="flex items-center justify-between text-xs text-muted-foreground">
				<span data-testid="flashcard-progress">
					{repeat ? "Once more: cards you missed" : `Card ${index + 1} of ${cards.length}`}
				</span>
				<Button size="xs" variant="ghost" onClick={onFinish}>
					Stop here
				</Button>
			</div>

			<article className="flex flex-col gap-4 rounded-xl border border-border/70 bg-surface px-5 py-5">
				<p className="text-xs text-muted-foreground">
					{card.noteName}
					{card.schedule.status === "new" ? " · new card" : ""}
				</p>
				<div data-testid="flashcard-front">
					<MessageResponse className="font-prose text-lg leading-relaxed">{repairMathForDisplay(card.front)}</MessageResponse>
				</div>

				{revealed === null ? (
					<form
						className="flex flex-col gap-3"
						onSubmit={(e) => {
							e.preventDefault();
							if (answer.trim()) setRevealed("typed");
						}}
					>
						<Textarea
							ref={inputRef}
							data-testid="flashcard-answer"
							value={answer}
							placeholder="Your answer, from memory…"
							onChange={(e) => setAnswer(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									if (answer.trim()) setRevealed("typed");
								}
							}}
						/>
						<div className="flex flex-wrap items-center gap-2">
							<Button type="submit" data-testid="flashcard-reveal" disabled={!answer.trim()}>
								Show answer
							</Button>
							<Button type="button" variant="ghost" data-testid="flashcard-dont-know" onClick={() => setRevealed("dontKnow")}>
								I don&apos;t know
							</Button>
							<span className="text-xs text-muted-foreground">Write it before you look: that&apos;s what shows what you really know.</span>
						</div>
					</form>
				) : (
					<div className="flex flex-col gap-4">
						{revealed === "typed" && (
							<div className="flex flex-col gap-1">
								<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Your answer</p>
								<p data-testid="flashcard-your-answer" className="whitespace-pre-wrap text-base">{answer}</p>
							</div>
						)}
						<div className="flex flex-col gap-1">
							<p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">The card</p>
							<div data-testid="flashcard-back">
								<MessageResponse className="text-base leading-relaxed">{repairMathForDisplay(card.back)}</MessageResponse>
							</div>
						</div>
						<blockquote data-testid="flashcard-quote" className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
							<span className="block text-xs">From your notes{card.page !== undefined ? `, page ${card.page}` : ""}:</span>
							&ldquo;{card.quote}&rdquo;
						</blockquote>

						{revealed === "typed" ? (
							<div className="flex flex-col gap-2">
								<p className="text-sm">Be strict: would this answer get the marks on an exam?</p>
								<div className="flex flex-wrap gap-2">
									<Button variant="outline" data-testid="flashcard-missed" disabled={saving} onClick={() => void grade("missed")}>
										Missed it <kbd className="text-xs text-muted-foreground">1</kbd>
									</Button>
									<Button variant="outline" data-testid="flashcard-partly" disabled={saving} onClick={() => void grade("partly")}>
										Partly <kbd className="text-xs text-muted-foreground">2</kbd>
									</Button>
									<Button variant="outline" data-testid="flashcard-got-it" disabled={saving} onClick={() => void grade("gotIt")}>
										Got it <kbd className="text-xs text-muted-foreground">3</kbd>
									</Button>
								</div>
							</div>
						) : (
							<div>
								<Button data-testid="flashcard-next" disabled={saving} onClick={() => void grade("dontKnow")}>
									Next card
								</Button>
							</div>
						)}
					</div>
				)}
				{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
			</article>
		</section>
	);
}

function RoundDone({ tally, total, nextDue, onFinish }: { tally: Tally; total: number; nextDue: Record<string, number | null>; onFinish: () => void }) {
	const answered = tally.gotIt + tally.partly + tally.missed + tally.dontKnow;
	const days = Object.values(nextDue).filter((d): d is number => d !== null);
	const soonest = days.length ? Math.min(...days) : null;
	return (
		<section data-testid="flashcard-done" className="mx-auto flex w-full max-w-2xl flex-col gap-4 rounded-xl border border-border/70 bg-surface px-5 py-5">
			<p className="font-prose text-xl">
				{answered === 0 ? "Stopped before any card." : `Round done: ${answered} of ${total} ${total === 1 ? "card" : "cards"}.`}
			</p>
			{answered > 0 && (
				<ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
					<li className="text-good-ink">{tally.gotIt} got it</li>
					<li>{tally.partly} partly</li>
					<li className="text-warn-ink">{tally.missed + tally.dontKnow} missed</li>
				</ul>
			)}
			{soonest !== null && (
				<p className="text-sm text-muted-foreground">
					{soonest === 0 ? "The cards you missed come back later today." : `The next of these comes back in ${soonest} ${soonest === 1 ? "day" : "days"}.`}
				</p>
			)}
			<div>
				<Button onClick={onFinish}>Back to decks</Button>
			</div>
		</section>
	);
}
