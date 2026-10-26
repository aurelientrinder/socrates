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

/** Whole minutes studied on each day of the week starting `weekStart`
 *  (seven entries, Monday first). `sessions` holds each session's message
 *  timestamps (ms), in any order. */
export function studyMinutesByDay(sessions: readonly (readonly number[])[], weekStart: Date): number[] {
	const ms = Array.from({ length: 7 }, () => 0);
	const dayStarts = Array.from({ length: 8 }, (_, i) => {
		const d = new Date(weekStart);
		d.setDate(d.getDate() + i);
		return d.getTime();
	});
	for (const stamps of sessions) {
		const sorted = stamps.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
		for (let i = 1; i < sorted.length; i++) {
			const from = sorted[i - 1]!;
			const gap = sorted[i]! - from;
			if (gap <= 0 || gap > STUDY_GAP_MS) continue;
			const day = dayStarts.findIndex((start, k) => k < 7 && from >= start && from < dayStarts[k + 1]!);
			if (day >= 0) ms[day]! += gap;
		}
	}
	return ms.map((v) => Math.round(v / 60_000));
}
