"use client";

import { useEffect, useState } from "react";
import { ClockIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * THE SESSION TIMER (redesign wave, 2026-10-26): "12 of 25 min" in the
 * session's top bar, so stopping after the time you chose reads as
 * finishing, not quitting. The budget is set when the session starts
 * (the Start dialog's length, or a Today plan step's minutes); sessions
 * opened any other way show no timer. Time counts only while the session
 * is open and the window visible — studying time, not wall time. Both
 * numbers live in this browser's storage (lost with it, which only hides
 * the chip).
 */

/** The session lengths the Start dialog offers. */
export const SESSION_LENGTHS = [10, 25, 45] as const;
export const DEFAULT_SESSION_LENGTH = 25;

const budgetKey = (chatId: string) => `lh:session-budget:${chatId}`;
const spentKey = (chatId: string) => `lh:session-spent:${chatId}`;
const TICK_MS = 15_000;

/** The chat id in a start target ("/chat/<id>?prompt=…"), or null. Pure. */
export function chatIdOf(target: string): string | null {
	return /^\/chat\/([^/?#]+)/.exec(target)?.[1] ?? null;
}

/** Remember how long the learner meant to study in the session a start
 *  target opens. Call before navigating there. */
export function setSessionBudget(target: string, minutes: number): void {
	const id = chatIdOf(target);
	if (!id || !(minutes > 0)) return;
	try {
		localStorage.setItem(budgetKey(id), String(Math.round(minutes)));
	} catch {
		/* storage blocked: no timer for this session */
	}
}

function readNumber(key: string): number | null {
	try {
		const raw = localStorage.getItem(key);
		const n = raw === null ? NaN : Number(raw);
		return Number.isFinite(n) && n >= 0 ? n : null;
	} catch {
		return null;
	}
}

/** The chip's words. Pure. */
export function timerLabel(spentMinutes: number, budgetMinutes: number): string {
	if (spentMinutes >= budgetMinutes) return `${budgetMinutes} min done`;
	return `${spentMinutes} of ${budgetMinutes} min`;
}

/** The budget and the whole minutes spent so far; null when the session
 *  has no budget. */
export function useSessionTimer(chatId: string): { budget: number; spent: number } | null {
	const [state, setState] = useState<{ budget: number; spentSec: number } | null>(null);
	useEffect(() => {
		const budget = readNumber(budgetKey(chatId));
		if (budget === null || budget === 0) {
			setState(null);
			return;
		}
		let spentSec = readNumber(spentKey(chatId)) ?? 0;
		setState({ budget, spentSec });
		let last = Date.now();
		const tick = () => {
			const now = Date.now();
			// Only visible time counts; a long gap (sleep, a hidden window)
			// is capped at one tick so it never jumps the clock.
			if (document.visibilityState === "visible") spentSec += Math.min(now - last, TICK_MS) / 1000;
			last = now;
			try {
				localStorage.setItem(spentKey(chatId), String(Math.round(spentSec)));
			} catch {
				/* storage blocked: the chip still counts for this visit */
			}
			setState({ budget, spentSec });
		};
		const timer = setInterval(tick, TICK_MS);
		const onVisibility = () => {
			if (document.visibilityState === "visible") last = Date.now();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			tick();
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [chatId]);
	return state ? { budget: state.budget, spent: Math.floor(state.spentSec / 60) } : null;
}

export function SessionTimerChip({ budget, spent }: { budget: number; spent: number }) {
	const done = spent >= budget;
	return (
		<span
			data-testid="session-timer"
			title={done ? "You studied for the time you planned. A good moment to finish and recap." : "Time studied in this session"}
			className={cn(
				"flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-sm tabular-nums",
				done ? "bg-good-soft font-semibold text-good-ink" : "text-muted-foreground",
			)}
		>
			<ClockIcon className="size-3.5" aria-hidden="true" />
			{timerLabel(spent, budget)}
		</span>
	);
}

/** The progress line under the top bar: how far through the plan. */
export function PlanProgressLine({ value }: { value: number }) {
	const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
	return (
		<div role="progressbar" aria-label="Plan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-[3px] bg-accent">
			<div className="h-full bg-good transition-[width] duration-500" style={{ width: `${pct}%` }} />
		</div>
	);
}
