"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { LayersIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageResponse } from "@/components/ai-elements/message";
import { deckCounts } from "@/components/flashcard-review";
import { repairMathForDisplay, type CardView, type DeckSummary } from "@/src/core";

/** Transport-only mirror of src/server/flashcards.ts FlashcardRun. */
interface FlashcardRun {
	state: "running" | "done" | "failed" | "cancelled";
	partsDone: number;
	parts: number;
	cardsMade: number;
	dropped: number;
	pausedUntil?: number;
	error?: string;
	finishedAt?: number;
}

interface DeckResponse {
	deck: { summary: DeckSummary; cards: CardView[] } | null;
	run: FlashcardRun | null;
}

const POLL_MS = 2000;

/**
 * A notes file's flashcards, inside its Library row: one button makes the
 * deck (a background run, polled here part by part), then the row shows
 * the deck's counts, a link to review it, and the card list, where a wrong
 * or useless card can be fixed or dropped.
 */
export function NoteFlashcards({ noteId, disabled }: { noteId: string; disabled?: boolean }) {
	const [data, setData] = useState<DeckResponse | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [showCards, setShowCards] = useState(false);
	const [starting, setStarting] = useState(false);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`/api/flashcards/${noteId}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setData((await res.json()) as DeckResponse);
		} catch (err) {
			setError(`Couldn't load the flashcards (${err instanceof Error ? err.message : String(err)}).`);
		}
	}, [noteId]);
	useEffect(() => {
		void load();
	}, [load]);

	const running = data?.run?.state === "running";
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => void load(), POLL_MS);
		return () => clearInterval(timer);
	}, [running, load]);

	const make = async () => {
		const hasCards = (data?.deck?.cards.length ?? 0) > 0;
		if (hasCards && !window.confirm("Make this deck again? Cards you haven't answered yet are replaced. Cards you have answered stay, with their history.")) return;
		setStarting(true);
		setError(null);
		try {
			const res = await fetch(`/api/flashcards/${noteId}`, { method: "POST" });
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) setError(body.error ?? `Couldn't start (HTTP ${res.status}).`);
			await load();
		} catch (err) {
			setError(`Couldn't start (${err instanceof Error ? err.message : String(err)}).`);
		} finally {
			setStarting(false);
		}
	};

	const cancel = async () => {
		await fetch(`/api/flashcards/${noteId}/cancel`, { method: "POST" }).catch(() => undefined);
		await load();
	};

	if (!data) return error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null;
	const { deck, run } = data;

	return (
		<div data-testid="note-flashcards" className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
				<LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
				{running && run ? (
					<>
						<span data-testid="note-flashcards-progress" role="status" className="text-muted-foreground">
							{runningText(run)}
						</span>
						<Button size="xs" variant="ghost" onClick={() => void cancel()}>Cancel</Button>
					</>
				) : deck && deck.cards.length > 0 ? (
					<>
						<span data-testid="note-flashcards-counts" className="text-muted-foreground">{deckCounts(deck.summary)}</span>
						<Button size="xs" variant="ghost" asChild>
							<Link href={`/progress?tab=cards&deck=${noteId}`}>Review</Link>
						</Button>
						<Button size="xs" variant="ghost" onClick={() => setShowCards((v) => !v)}>
							{showCards ? "Hide cards" : "Cards"}
						</Button>
						<Button size="xs" variant="ghost" disabled={disabled || starting} onClick={() => void make()}>
							Remake
						</Button>
					</>
				) : (
					<>
						<Button data-testid="note-flashcards-make" size="xs" variant="outline" disabled={disabled || starting} onClick={() => void make()}>
							{starting ? "Starting…" : "Make flashcards"}
						</Button>
						<span className="text-muted-foreground">Review cards from this file, scheduled like your topics.</span>
					</>
				)}
			</div>
			{!running && run && <RunResult run={run} />}
			{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
			{showCards && deck && <CardList noteId={noteId} cards={deck.cards} onChanged={load} />}
		</div>
	);
}

function runningText(run: FlashcardRun): string {
	const base = `Making flashcards… part ${Math.min(run.partsDone + 1, run.parts)} of ${run.parts}`;
	const made = run.cardsMade > 0 ? `, ${run.cardsMade} ${run.cardsMade === 1 ? "card" : "cards"} so far` : "";
	if (run.pausedUntil) {
		const s = Math.max(1, Math.round((run.pausedUntil - Date.now()) / 1000));
		return `${base}${made}. Paused for the model's per-minute limit, resuming in ${s}s.`;
	}
	return `${base}${made}.`;
}

/** How the last run went (shown until the page reloads after a while). */
function RunResult({ run }: { run: FlashcardRun }) {
	if (run.finishedAt && Date.now() - run.finishedAt > 10 * 60_000) return null;
	if (run.state === "failed") {
		return (
			<p role="alert" className="text-xs text-destructive">
				Making cards stopped: {run.error ?? "unknown error"}
				{run.cardsMade > 0 ? ` (${run.cardsMade} cards from the finished parts were kept if this was the first deck).` : ""}
			</p>
		);
	}
	if (run.state === "cancelled") return <p className="text-xs text-muted-foreground">Cancelled.</p>;
	return (
		<p role="status" className="text-xs text-good-ink">
			Made {run.cardsMade} {run.cardsMade === 1 ? "card" : "cards"}.
			{run.dropped > 0 ? ` ${run.dropped} more ${run.dropped === 1 ? "was" : "were"} left out because ${run.dropped === 1 ? "its" : "their"} source wasn't found in your notes.` : ""}
		</p>
	);
}

function CardList({ noteId, cards, onChanged }: { noteId: string; cards: CardView[]; onChanged: () => Promise<void> }) {
	const removeDeck = async () => {
		if (!window.confirm("Delete all the cards made from this file, and their review history?")) return;
		await fetch(`/api/flashcards/${noteId}`, { method: "DELETE" }).catch(() => undefined);
		await onChanged();
	};
	return (
		<div className="flex flex-col gap-2">
			<ol data-testid="note-flashcards-list" className="flex max-h-[28rem] flex-col divide-y divide-border/60 overflow-y-auto rounded-md bg-muted/40">
				{cards.map((card) => (
					<CardRow key={card.id} noteId={noteId} card={card} onChanged={onChanged} />
				))}
			</ol>
			<div>
				<Button size="xs" variant="ghost" className="text-destructive" onClick={() => void removeDeck()}>
					Delete all cards
				</Button>
			</div>
		</div>
	);
}

function CardRow({ noteId, card, onChanged }: { noteId: string; card: CardView; onChanged: () => Promise<void> }) {
	const [editing, setEditing] = useState(false);
	const [front, setFront] = useState(card.front);
	const [back, setBack] = useState(card.back);
	const [error, setError] = useState<string | null>(null);

	const save = async () => {
		setError(null);
		const res = await fetch(`/api/flashcards/${noteId}/cards/${card.id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ front, back }),
		}).catch(() => null);
		if (!res?.ok) return setError(((await res?.json().catch(() => ({}))) as { error?: string } | undefined)?.error ?? "Couldn't save.");
		setEditing(false);
		await onChanged();
	};

	const remove = async () => {
		await fetch(`/api/flashcards/${noteId}/cards/${card.id}`, { method: "DELETE" }).catch(() => undefined);
		await onChanged();
	};

	return (
		<li data-testid="note-flashcard" className="flex flex-col gap-1.5 px-3 py-2.5 text-sm">
			{editing ? (
				<>
					<Textarea aria-label="Question" value={front} onChange={(e) => setFront(e.target.value)} />
					<Textarea aria-label="Answer" value={back} onChange={(e) => setBack(e.target.value)} />
					<div className="flex gap-1">
						<Button size="xs" onClick={() => void save()}>Save</Button>
						<Button size="xs" variant="ghost" onClick={() => { setEditing(false); setFront(card.front); setBack(card.back); }}>Cancel</Button>
					</div>
					{error && <p role="alert" className="text-xs text-destructive">{error}</p>}
				</>
			) : (
				<>
					<MessageResponse className="font-medium">{repairMathForDisplay(card.front)}</MessageResponse>
					<MessageResponse className="text-muted-foreground">{repairMathForDisplay(card.back)}</MessageResponse>
					<div className="flex items-center gap-1 text-xs text-muted-foreground">
						<span className="flex-1">
							{card.page !== undefined ? `Page ${card.page} · ` : ""}
							{statusText(card)}
						</span>
						<Button size="xs" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
						<Button size="xs" variant="ghost" onClick={() => void remove()}>Delete</Button>
					</div>
				</>
			)}
		</li>
	);
}

function statusText(card: CardView): string {
	switch (card.schedule.status) {
		case "new":
			return "new";
		case "due":
			return "due now";
		default: {
			const days = card.schedule.dueAt === null ? 0 : Math.max(0, Math.round((card.schedule.dueAt - Date.now()) / 86_400_000));
			return days === 0 ? "due later today" : `due in ${days} ${days === 1 ? "day" : "days"}`;
		}
	}
}
