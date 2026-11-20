"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { CardQueue, CardVerdict, CardView } from "@/src/core";

const CACHE_KEY = "lh.mobile.flashcardQueue";
const PENDING_KEY = "lh.mobile.pendingAnswers";

interface PendingAnswer {
	noteId: string;
	cardId: string;
	verdict: CardVerdict;
	at: number;
}

interface ReviewSummary {
	due: number;
	tracked: number;
	honesty: { points: number } | null;
}

function readJson<T>(key: string, fallback: T): T {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : fallback;
	} catch {
		return fallback;
	}
}

function writeJson(key: string, value: unknown): void {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// quota exceeded or private mode
	}
}

/**
 * Mobile Companion (/mobile): thumb-first 2–5 minute burst view for on-the-go
 * reviews. Caches the flashcard queue in localStorage, accepts offline recall
 * verdicts into a local queue, and automatically flushes them once online.
 */
export function MobileCompanion() {
	const [cards, setCards] = useState<CardView[]>([]);
	const [idx, setIdx] = useState(0);
	const [draft, setDraft] = useState("");
	const [revealed, setRevealed] = useState(false);
	const [doneCount, setDoneCount] = useState(0);
	const [review, setReview] = useState<ReviewSummary | null>(null);
	const [pending, setPending] = useState<PendingAnswer[]>([]);
	const [online, setOnline] = useState(true);
	const [loading, setLoading] = useState(true);
	const [flushing, setFlushing] = useState(false);

	const flushPending = useCallback(async () => {
		const queued = readJson<PendingAnswer[]>(PENDING_KEY, []);
		if (queued.length === 0) {
			setPending([]);
			return;
		}
		setFlushing(true);
		const remaining: PendingAnswer[] = [];
		for (const item of queued) {
			try {
				const res = await fetch(
					`/api/flashcards/${encodeURIComponent(item.noteId)}/cards/${encodeURIComponent(item.cardId)}/answer`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ verdict: item.verdict }),
					},
				);
				if (!res.ok) remaining.push(item);
			} catch {
				remaining.push(item);
			}
		}
		writeJson(PENDING_KEY, remaining);
		setPending(remaining);
		setFlushing(false);
	}, []);

	const load = useCallback(async () => {
		setLoading(true);
		setPending(readJson<PendingAnswer[]>(PENDING_KEY, []));
		try {
			const [fcRes, revRes] = await Promise.all([
				fetch("/api/flashcards", { cache: "no-store" }),
				fetch("/api/review", { cache: "no-store" }),
			]);
			if (fcRes.ok) {
				const data = (await fcRes.json()) as { queue?: CardQueue };
				const nextCards = data.queue?.cards ?? [];
				setCards(nextCards);
				setIdx(0);
				writeJson(CACHE_KEY, nextCards);
			}
			if (revRes.ok) {
				setReview((await revRes.json()) as ReviewSummary);
			}
			setOnline(true);
		} catch {
			// Offline fallback: use cached card queue.
			setOnline(false);
			setCards(readJson<CardView[]>(CACHE_KEY, []));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		setOnline(typeof navigator === "undefined" ? true : navigator.onLine);
		void flushPending().then(() => load());
		const onOnline = () => {
			setOnline(true);
			void flushPending().then(() => load());
		};
		const onOffline = () => setOnline(false);
		window.addEventListener("online", onOnline);
		window.addEventListener("offline", onOffline);
		return () => {
			window.removeEventListener("online", onOnline);
			window.removeEventListener("offline", onOffline);
		};
	}, [flushPending, load]);

	async function answer(verdict: CardVerdict) {
		const card = cards[idx];
		if (!card) return;
		const nextIdx = idx + 1;
		setIdx(nextIdx);
		setDraft("");
		setRevealed(false);
		setDoneCount((n) => n + 1);

		const entry: PendingAnswer = { noteId: card.noteId, cardId: card.id, verdict, at: Date.now() };
		try {
			const res = await fetch(
				`/api/flashcards/${encodeURIComponent(card.noteId)}/cards/${encodeURIComponent(card.id)}/answer`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ verdict }),
				},
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
		} catch {
			// Queue offline for automatic replay when reconnected.
			const nextPending = [...readJson<PendingAnswer[]>(PENDING_KEY, []), entry];
			writeJson(PENDING_KEY, nextPending);
			setPending(nextPending);
			setOnline(false);
		}
	}

	const current = cards[idx];

	return (
		<div data-testid="mobile-companion" className="mx-auto flex h-full max-w-md flex-col gap-5 overflow-y-auto px-4 py-6">
			<header className="flex items-center justify-between gap-2">
				<div>
					<h1 className="font-prose text-xl font-semibold">Socrates</h1>
					<p className="text-xs text-muted-foreground">
						{online ? "Quick burst" : "Offline mode — answers queue locally"}
					</p>
				</div>
				<div className="flex items-center gap-2 text-xs">
					<Link href="/" className="rounded-lg border border-border bg-surface px-2.5 py-1.5 hover:bg-accent">
						Today
					</Link>
					<Link href="/progress" className="rounded-lg border border-border bg-surface px-2.5 py-1.5 hover:bg-accent">
						Progress
					</Link>
				</div>
			</header>

			{pending.length > 0 && (
				<div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5 text-xs">
					<span className="text-muted-foreground tabular-nums">
						{pending.length} offline {pending.length === 1 ? "answer" : "answers"} queued
					</span>
					<button
						type="button"
						disabled={flushing}
						onClick={() => void flushPending()}
						className="rounded-lg border border-border bg-surface px-2.5 py-1 font-medium hover:bg-accent disabled:opacity-50"
					>
						{flushing ? "Syncing…" : "Sync now"}
					</button>
				</div>
			)}

			{review && (
				<section className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-surface px-4 py-3 text-sm">
					<div>
						<p className="font-medium tabular-nums">
							{review.due > 0 ? `${review.due} due for review` : "All caught up"}
						</p>
						<p className="text-xs text-muted-foreground tabular-nums">
							{review.tracked} tracked topics
							{review.honesty ? ` · +${review.honesty.points}pt overconfidence` : ""}
						</p>
					</div>
					<Link
						href="/progress"
						className="shrink-0 rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-accent"
					>
						Review
					</Link>
				</section>
			)}

			<section className="flex flex-1 flex-col gap-3">
				<div className="flex items-center justify-between text-xs text-muted-foreground tabular-nums">
					<span>Flashcard burst</span>
					<span>
						{doneCount} done{cards.length > idx ? ` · ${cards.length - idx} left` : ""}
					</span>
				</div>

				{loading ? (
					<div className="rounded-2xl border border-border/70 bg-surface p-6 text-center text-sm text-muted-foreground">
						Loading burst…
					</div>
				) : !current ? (
					<div className="flex flex-col items-center gap-3 rounded-2xl border border-border/70 bg-surface p-6 text-center">
						<p className="font-prose text-base">
							{doneCount > 0 ? `Burst complete (${doneCount} answered).` : "No flashcards due right now."}
						</p>
						<button
							type="button"
							onClick={() => void load()}
							className="rounded-lg border border-border bg-card px-4 py-2 text-xs font-medium hover:bg-accent"
						>
							Refresh queue
						</button>
					</div>
				) : (
					<div className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-5 shadow-xs">
						<p className="text-[11px] text-muted-foreground">{current.noteName}</p>
						<p className="font-prose text-lg leading-snug">{current.front}</p>

						{!revealed ? (
							<>
								<textarea
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
									rows={3}
									placeholder="Recall from memory first (optional)…"
									className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm placeholder:text-muted-foreground/60"
								/>
								<div className="grid grid-cols-2 gap-2">
									<button
										type="button"
										onClick={() => void answer("dontKnow")}
										className="rounded-xl border border-border bg-surface py-2.5 text-sm text-muted-foreground hover:bg-accent"
									>
										I don&apos;t know
									</button>
									<button
										type="button"
										onClick={() => setRevealed(true)}
										className="rounded-xl bg-foreground py-2.5 text-sm font-medium text-background hover:opacity-90"
									>
										Show answer
									</button>
								</div>
							</>
						) : (
							<>
								<div className="rounded-xl border border-border/70 bg-surface p-3.5">
									<p className="font-prose text-base leading-relaxed">{current.back}</p>
									{current.quote && (
										<p className="mt-2 border-l-2 border-border pl-2.5 text-xs text-muted-foreground">
											“{current.quote}”
										</p>
									)}
								</div>
								<div className="grid grid-cols-3 gap-2">
									<button
										type="button"
										onClick={() => void answer("missed")}
										className="rounded-xl border border-border bg-surface py-2.5 text-sm font-medium hover:bg-accent"
									>
										Missed
									</button>
									<button
										type="button"
										onClick={() => void answer("partly")}
										className="rounded-xl border border-border bg-surface py-2.5 text-sm font-medium hover:bg-accent"
									>
										Partly
									</button>
									<button
										type="button"
										onClick={() => void answer("gotIt")}
										className="rounded-xl bg-foreground py-2.5 text-sm font-medium text-background hover:opacity-90"
									>
										Got it
									</button>
								</div>
							</>
						)}
					</div>
				)}
			</section>
		</div>
	);
}
