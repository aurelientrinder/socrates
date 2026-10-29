/**
 * The week grid's geometry (components/course-calendar.tsx): where an event
 * sits in its day column, and how overlapping events share the column.
 * Pure, so it is tested without a browser.
 */

export interface Span {
	/** Minutes since local midnight. */
	start: number;
	end: number;
}

export interface Slot {
	/** Index into the input list. */
	index: number;
	/** Which of `cols` side-by-side columns it takes (0-based). */
	col: number;
	cols: number;
}

/** Shortest an event is drawn, so a 15-minute slot is still clickable. */
export const MIN_SPAN_MINUTES = 30;

/**
 * Side-by-side columns for one day's events: events that overlap in time
 * share the width of the day; a cluster only splits as wide as it needs.
 */
export function packDay(spans: readonly Span[]): Slot[] {
	const order = spans.map((_, i) => i).sort((a, b) => spans[a]!.start - spans[b]!.start || spans[b]!.end - spans[a]!.end);
	const out: Slot[] = [];
	let cluster: Slot[] = [];
	let colEnds: number[] = [];
	let clusterEnd = -Infinity;
	const flush = () => {
		const cols = Math.max(1, colEnds.length);
		for (const s of cluster) out.push({ ...s, cols });
		cluster = [];
		colEnds = [];
		clusterEnd = -Infinity;
	};
	for (const index of order) {
		const s = spans[index]!;
		const end = Math.max(s.end, s.start + MIN_SPAN_MINUTES);
		if (cluster.length > 0 && s.start >= clusterEnd) flush();
		let col = colEnds.findIndex((e) => e <= s.start);
		if (col === -1) col = colEnds.length;
		colEnds[col] = end;
		clusterEnd = Math.max(clusterEnd, end);
		cluster.push({ index, col, cols: 1 });
	}
	flush();
	return out.sort((a, b) => a.index - b.index);
}

/**
 * The hours the grid shows: 08:00-19:00 by default, wider when an event
 * starts earlier or ends later, never beyond 06:00-23:00.
 */
export function hourRange(spans: readonly Span[], min = 8, max = 19): { from: number; to: number } {
	let from = min;
	let to = max;
	for (const s of spans) {
		from = Math.min(from, Math.floor(s.start / 60));
		to = Math.max(to, Math.ceil(s.end / 60));
	}
	return { from: Math.max(6, from), to: Math.min(23, to) };
}

/** Minutes since local midnight. */
export function minutesOfDay(ms: number): number {
	const d = new Date(ms);
	return d.getHours() * 60 + d.getMinutes();
}

/** Local midnight of the day `ms` is in. */
export function dayStart(ms: number): number {
	const d = new Date(ms);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** `weeks` Monday-first week starts from `from` (a Monday), by calendar date (DST-safe). */
export function weekStarts(from: number, weeks: number): number[] {
	return Array.from({ length: weeks }, (_, w) => {
		const d = new Date(from);
		d.setDate(d.getDate() + w * 7);
		return d.getTime();
	});
}

/** The date `offset` days after `weekStart`, as local midnight (DST-safe). */
export function dayOf(weekStart: number, offset: number): number {
	const d = new Date(weekStart);
	d.setDate(d.getDate() + offset);
	return d.getTime();
}
