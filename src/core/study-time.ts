/**
 * STUDY TIME (redesign wave, 2026-10-26): "This week" on Today — about how
 * many minutes the learner studied each day, Monday first. Estimated from
 * the transcripts alone (no timer state, so it holds on every device):
 * within one session, the time between two consecutive messages counts
 * when it is short enough to be one sitting; a longer pause is a break and
 * counts nothing. Each stretch is credited to the day it started on, in
 * the server's local time. Pure, browser-safe.
 */

/** A pause longer than this between two messages is a break, not study. */
export const STUDY_GAP_MS = 10 * 60_000;

/** Local midnight of the Monday of `now`'s week. */
export function weekStartOf(now: Date): Date {
	const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	return d;
}

/** Whole minutes studied on each of `days` days from local midnight
 *  `start` (seven by default: a week, Monday first). `sessions` holds each
 *  session's message timestamps (ms), in any order. */
export function studyMinutesByDay(sessions: readonly (readonly number[])[], start: Date, days = 7): number[] {
	const ms = Array.from({ length: days }, () => 0);
	const dayStarts = Array.from({ length: days + 1 }, (_, i) => {
		const d = new Date(start);
		d.setDate(d.getDate() + i);
		return d.getTime();
	});
	for (const stamps of sessions) {
		const sorted = stamps.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
		for (let i = 1; i < sorted.length; i++) {
			const from = sorted[i - 1]!;
			const gap = sorted[i]! - from;
			if (gap <= 0 || gap > STUDY_GAP_MS) continue;
			const day = dayStarts.findIndex((dayStart, k) => k < days && from >= dayStart && from < dayStarts[k + 1]!);
			if (day >= 0) ms[day]! += gap;
		}
	}
	return ms.map((v) => Math.round(v / 60_000));
}

/**
 * THE STREAK (2026-10-27): a gentle count of study days, for the learner
 * who struggles with motivation. A day counts with STREAK_MIN_MINUTES of
 * study (a five-minute session is enough). Gentle in two ways: today never
 * breaks it (the day is not over), and one rest day between two study days
 * is forgiven; two missed days in a row end it. Only study days are counted.
 */

/** The study a day needs to count toward the streak. */
export const STREAK_MIN_MINUTES = 3;
/** How far back the streak is read. A longer run shows as this many days. */
export const STREAK_LOOKBACK_DAYS = 60;

export interface StudyStreak {
	/** Study days in the current run, today included when it counts. */
	days: number;
	studiedToday: boolean;
	/** The run ends unless today counts (yesterday was already a rest day). */
	atRisk: boolean;
}

/** Local midnight `days - 1` days before `now`'s day: the first day of a
 *  `days`-long record that ends today. */
export function daysBackStart(now: Date, days: number): Date {
	const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	d.setDate(d.getDate() - (days - 1));
	return d;
}

/** The streak from minutes per day, oldest first, the last entry today. Pure. */
export function studyStreak(minutesByDay: readonly number[], minMinutes = STREAK_MIN_MINUTES): StudyStreak {
	const studied = (i: number) => (minutesByDay[i] ?? 0) >= minMinutes;
	const today = minutesByDay.length - 1;
	if (today < 0) return { days: 0, studiedToday: false, atRisk: false };
	let days = 0;
	let missed = 0;
	for (let i = today; i >= 0; i--) {
		if (studied(i)) {
			days++;
			missed = 0;
		} else if (i !== today && ++missed >= 2) {
			break;
		}
	}
	const studiedToday = studied(today);
	return { days, studiedToday, atRisk: days > 0 && !studiedToday && !studied(today - 1) };
}
