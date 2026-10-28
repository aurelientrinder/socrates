"use client";

import { useCallback, useEffect, useState } from "react";
import { BellIcon } from "lucide-react";
import { REMINDER_HOUR_CHOICES } from "@/src/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * REMINDERS (Today, side column): opt-in gentle pings on the learner's
 * Socrates calendar, so the phone and the laptop both alert them even with
 * the app closed. Shown once Google Calendar is connected.
 */

interface Status {
	prefs: { enabled: boolean; hour: number };
	syncedAt?: number;
	scheduled?: number;
	error?: string;
}

const hourLabel = (h: number) => (h === 12 ? "12 pm" : h > 12 ? `${h - 12} pm` : `${h} am`);

export function RemindersCard() {
	const [status, setStatus] = useState<Status | null>(null);
	const [busy, setBusy] = useState(false);

	const post = useCallback(async (body: Record<string, unknown>) => {
		setBusy(true);
		try {
			const res = await fetch("/api/reminders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const data = (await res.json()) as Status & { error?: string };
			setStatus((prev) => (res.ok ? data : prev ? { ...prev, error: data.error } : prev));
		} catch {
			setStatus((prev) => (prev ? { ...prev, error: "Could not reach the app." } : prev));
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		void fetch("/api/reminders")
			.then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
			.then((s) => s && setStatus(s))
			.catch(() => undefined);
	}, []);

	if (!status) return null;
	const { enabled, hour } = status.prefs;
	return (
		<section data-testid="today-reminders" className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-surface px-5 py-4 text-sm">
			<div className="flex items-center gap-2">
				<BellIcon className="size-4 text-muted-foreground" aria-hidden />
				<h2 className="text-base font-semibold">Reminders</h2>
				<Button variant={enabled ? "ghost" : "default"} size="sm" className="ml-auto" disabled={busy} onClick={() => void post({ enabled: !enabled })}>
					{enabled ? "Turn off" : "Turn on"}
				</Button>
			</div>
			<p className="text-muted-foreground">
				{enabled
					? "A small alert on your phone and laptop on days with planned work, and a heads-up before each exam. They come from your Socrates calendar, so they arrive even when this app is closed. Open Socrates once in a while to refresh them."
					: "Get one small nudge a day, only on days with planned work, plus a heads-up before exams, on your phone and laptop."}
			</p>
			{enabled && (
				<div className="flex flex-wrap items-center gap-1" role="group" aria-label="Reminder time">
					{REMINDER_HOUR_CHOICES.map((h) => (
						<button
							key={h}
							type="button"
							aria-pressed={hour === h}
							disabled={busy}
							onClick={() => void post({ hour: h })}
							className={cn("rounded-md px-2 py-1 text-xs", hour === h ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:text-foreground")}
						>
							{hourLabel(h)}
						</button>
					))}
				</div>
			)}
			{enabled && status.scheduled !== undefined && !status.error && (
				<p className="text-xs text-muted-foreground">{status.scheduled} scheduled.</p>
			)}
			{status.error && <p className="text-destructive">{status.error}</p>}
			{enabled && (
				<Button variant="ghost" size="sm" className="self-start" disabled={busy} onClick={() => void post({ sync: true })}>
					Sync now
				</Button>
			)}
		</section>
	);
}
