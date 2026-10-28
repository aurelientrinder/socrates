/**
 * REMINDERS (2026-10-28): which gentle pings to schedule, as plain data.
 *
 * The server writes these as short alert-only events on the Socrates
 * calendar, so Google delivers them to the phone and the laptop even when
 * the app is closed. Deliberately few: one small nudge on each day that has
 * planned work (never on an empty day, never twice), and an exam heads-up
 * three days and one day out. Pure and browser-safe.
 */

import type { BriefingPlan } from "./briefing.ts";

export const REMINDER_HOUR_CHOICES = [8, 12, 16, 18, 20] as const;
export const DEFAULT_REMINDER_HOUR = 18;
/** Plan days looked at for nudges (today + 6). */
export const REMINDER_DAYS = 7;
/** Hard cap on scheduled reminders. */
export const MAX_REMINDERS = 14;
/** A reminder this close to now would fire before anyone reads it. */
const MIN_LEAD_MS = 5 * 60 * 1000;

export interface ReminderPrefs {
	enabled: boolean;
	/** Local hour of day, one of REMINDER_HOUR_CHOICES. */
	hour: number;
}

export interface Reminder {
	/** Stable across rebuilds, so a sync updates in place. */
	key: string;
	/** Epoch ms. */
	start: number;
	title: string;
	body: string;
}

function localTime(date: string, hour: number): number | null {
	const [y, m, d] = date.split("-").map(Number);
	return y && m && d ? new Date(y, m - 1, d, hour, 0, 0, 0).getTime() : null;
}

const addDays = (date: string, n: number): string | null => {
	const t = localTime(date, 12);
	if (t === null) return null;
	const d = new Date(t);
	d.setDate(d.getDate() + n);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function buildReminders(plan: BriefingPlan, prefs: ReminderPrefs, now: number): Reminder[] {
	if (!prefs.enabled || !plan.study) return [];
	const out: Reminder[] = [];
	const ok = (start: number | null): start is number => start !== null && start > now + MIN_LEAD_MS;

	for (const day of plan.study.days.slice(0, REMINDER_DAYS)) {
		const first = day.items[0];
		const start = localTime(day.date, prefs.hour);
		if (!first || !ok(start)) continue;
		out.push({
			key: `nudge:${day.date}`,
			start,
			title: "Socrates: 5 minutes?",
			body: `Small start: ${first.title} (${first.minutes} min). Even 5 minutes counts.`,
		});
	}

	for (const exam of plan.study.exams) {
		if (exam.kind !== "exam") continue;
		const examDate = new Date(exam.start);
		const date = `${examDate.getFullYear()}-${String(examDate.getMonth() + 1).padStart(2, "0")}-${String(examDate.getDate()).padStart(2, "0")}`;
		for (const [before, label] of [[3, "in 3 days"], [1, "tomorrow"]] as const) {
			const d = addDays(date, -before);
			const start = d ? localTime(d, prefs.hour) : null;
			if (!ok(start)) continue;
			const ready = exam.readinessPlanned !== null ? ` Following the plan you should recall about ${Math.round(exam.readinessPlanned * 100)}%.` : "";
			out.push({ key: `exam:${exam.eventId}:${before}`, start, title: `${exam.title} ${label}`, body: `Open Socrates for a short run-through.${ready}` });
		}
	}

	return out.sort((a, b) => a.start - b.start).slice(0, MAX_REMINDERS);
}
