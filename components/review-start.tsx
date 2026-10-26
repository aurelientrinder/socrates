"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BellIcon, BellOffIcon, PlayIcon } from "lucide-react";
import { REVIEW_REMINDER_KEY, type ReviewStatus } from "@/src/core";
import { Button } from "@/components/ui/button";

/**
 * THE START PANEL (spaced repetition): one button that opens a short
 * review session on the weakest due topics, today's count, and the
 * opt-in daily reminder. Sits above the Review page's Due now list.
 */

/** The prompt that opens the session (turn 1, the learner's voice). */
export const REVIEW_START_PROMPT = "Start the review.";

export function ReviewStart({ status }: { status: ReviewStatus }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const n = status.nextSession;

	const start = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/review/start", { method: "POST" });
			if (!res.ok) {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not start the review.");
				setBusy(false);
				return;
			}
			const { id } = (await res.json()) as { id: string };
			router.push(`/chat/${id}?prompt=${encodeURIComponent(REVIEW_START_PROMPT)}`);
		} catch {
			setError("Could not start the review.");
			setBusy(false);
		}
	};

	return (
		<section data-testid="review-start" className="flex flex-col gap-3 rounded-lg border border-border/60 px-4 py-4">
			{n > 0 ? (
				<div className="flex flex-wrap items-center gap-3">
					<Button data-testid="review-start-button" onClick={() => void start()} disabled={busy}>
						<PlayIcon className="size-4" />
						Start review
					</Button>
					<p className="text-sm text-muted-foreground">
						{n} {n === 1 ? "question" : "questions"}, about {n} {n === 1 ? "minute" : "minutes"}
						{status.due > n ? `. ${status.due - n} more wait for the next round.` : "."}
					</p>
				</div>
			) : (
				<p className="text-sm text-muted-foreground">Nothing to review right now.</p>
			)}
			{error && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
				<span data-testid="review-today">
					{status.reviewedToday > 0
						? `${status.reviewedToday} ${status.reviewedToday === 1 ? "topic" : "topics"} reviewed today.`
						: "No reviews yet today."}
				</span>
				<ReminderToggle />
			</div>
		</section>
	);
}

/** The opt-in daily reminder (this device): one notification a day when
 *  something is due, while the app is open. */
function ReminderToggle() {
	const [on, setOn] = useState(false);
	const [denied, setDenied] = useState(false);
	useEffect(() => {
		try {
			setOn(localStorage.getItem(REVIEW_REMINDER_KEY) === "on");
		} catch {
			/* storage blocked: the toggle starts off */
		}
		if (typeof Notification !== "undefined") setDenied(Notification.permission === "denied");
	}, []);

	if (typeof window !== "undefined" && typeof Notification === "undefined") return null;

	const toggle = async () => {
		const next = !on;
		if (next && Notification.permission !== "granted") {
			const permission = await Notification.requestPermission();
			if (permission !== "granted") {
				setDenied(true);
				return;
			}
		}
		try {
			localStorage.setItem(REVIEW_REMINDER_KEY, next ? "on" : "off");
		} catch {
			/* storage blocked: the choice lasts this page only */
		}
		setOn(next);
	};

	return (
		<button
			type="button"
			data-testid="review-reminder-toggle"
			aria-pressed={on}
			onClick={() => void toggle()}
			className="flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-accent hover:text-foreground"
		>
			{on ? <BellIcon className="size-3" /> : <BellOffIcon className="size-3" />}
			{denied && !on ? "Notifications are blocked" : on ? "Daily reminder on" : "Daily reminder off"}
		</button>
	);
}
