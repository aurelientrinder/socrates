/**
 * THE CLASS CALENDAR (2026-10-29): every calendar event ends up in exactly
 * one of three states, and the learner's own choice always wins.
 *
 *   filed     → it belongs to a course group
 *   ignored   → it is not a class (gym, lunch, a talk)
 *   unplaced  → nothing decided yet; shown with the group it most looks like
 *
 * Order of authority: the learner's pin on that one event, the learner's pin
 * on every event with that title, a "not a class" dismissal, the groups and
 * their aliases (the classifier's work), then the plain rule that gym and
 * lunch are not classes. A pin is stored apart from the groups
 * (briefing/course-pins.json), so re-running the classifier or reading a
 * fresh calendar never undoes a decision.
 *
 * Pure: the server owns the files (src/server/course-calendar.ts).
 */

import {
	classifyEvent,
	courseGroupFor,
	courseOf,
	tokens,
	type CourseLinks,
	type EventKind,
	type StudyEvent,
} from "./briefing.ts";
import { NOT_A_CLASS_RE } from "./courses.ts";

/** The pin value for "not a class". A group key otherwise. */
export const IGNORED = "~ignored";

export interface CoursePins {
	/** Calendar event id → group key | IGNORED. */
	events: Record<string, string>;
	/** titleKey(title) → group key | IGNORED. */
	titles: Record<string, string>;
}

export const NO_PINS: CoursePins = { events: {}, titles: {} };

/** A title as pins see it: case, accents and spacing do not matter. */
export function titleKey(title: string): string {
	return title.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

export type PinScope = "event" | "title";

/** The learner's pin on an event: its own first, then its title's. */
export function pinFor(pins: CoursePins, event: Pick<StudyEvent, "id" | "title">): { value: string; scope: PinScope } | null {
	const own = pins.events[event.id];
	if (own !== undefined) return { value: own, scope: "event" };
	const byTitle = pins.titles[titleKey(event.title)];
	if (byTitle !== undefined) return { value: byTitle, scope: "title" };
	return null;
}

export type Placement =
	| { state: "filed"; key: string; by: "you" | "auto" }
	| { state: "ignored"; by: "you" | "auto" }
	| { state: "unplaced"; guess: string | null };

export interface CalendarEvent {
	id: string;
	title: string;
	start: number;
	end: number;
	allDay: boolean;
	kind: EventKind;
	placement: Placement;
	/** Whether a pin of the learner's decides this event, and how wide it reaches. */
	pin?: PinScope;
}

/**
 * The group an event looks like: the one group whose name (or an alias) shares
 * a meaningful word with the title. Null unless exactly one does.
 */
export function guessGroup(links: CourseLinks, event: Pick<StudyEvent, "title">): string | null {
	const want = tokens(event.title);
	if (want.size === 0) return null;
	const hits: string[] = [];
	for (const [key, group] of Object.entries(links)) {
		const have = tokens([group.label, key, ...(group.aliases ?? [])].join(" "));
		// A shared word, or a long abbreviation of one ("thermo" for "thermodynamique").
		const alike = (t: string) => have.has(t) || (t.length >= 5 && [...have].some((h) => h.startsWith(t) || (h.length >= 5 && t.startsWith(h))));
		if ([...want].some(alike)) hits.push(key);
	}
	return hits.length === 1 ? hits[0]! : null;
}

/** Where one calendar event stands. */
export function placeEvent(
	event: StudyEvent,
	links: CourseLinks,
	pins: CoursePins,
	dismissed: readonly string[],
): CalendarEvent {
	const kind = event.kind ?? classifyEvent(event.title, event.source);
	const base = { id: event.id, title: event.title, start: event.start, end: event.end, allDay: event.allDay, kind };
	const pin = pinFor(pins, event);
	if (pin) {
		if (pin.value === IGNORED) return { ...base, placement: { state: "ignored", by: "you" }, pin: pin.scope };
		if (links[pin.value]) return { ...base, placement: { state: "filed", key: pin.value, by: "you" }, pin: pin.scope };
		// The group the pin named is gone: the event is undecided again.
	}
	const course = courseOf(event.title);
	if (course.key && dismissed.includes(course.key)) return { ...base, placement: { state: "ignored", by: "you" } };
	const found = courseGroupFor(links, course.key);
	if (found) return { ...base, placement: { state: "filed", key: found.key, by: "auto" } };
	if (kind === "other" && (event.allDay || NOT_A_CLASS_RE.test(event.title))) return { ...base, placement: { state: "ignored", by: "auto" } };
	return { ...base, placement: { state: "unplaced", guess: guessGroup(links, event) } };
}

/** Every calendar event (to-do tasks are not on the calendar), placed, in time order. */
export function placeEvents(
	events: readonly StudyEvent[],
	links: CourseLinks,
	pins: CoursePins,
	dismissed: readonly string[],
): CalendarEvent[] {
	return events
		.filter((e) => e.source === "calendar")
		.map((e) => placeEvent(e, links, pins, dismissed))
		.sort((a, b) => a.start - b.start || a.title.localeCompare(b.title));
}

/**
 * The events the rest of the app reads (briefing, study plan, mock exams)
 * with the learner's pins applied: a pinned event carries the group key it
 * was filed under, and "not a class" takes it out of the plan.
 */
export function applyPins(events: readonly StudyEvent[], links: CourseLinks, pins: CoursePins): StudyEvent[] {
	return events.map((e) => {
		if (e.source !== "calendar") return e;
		const pin = pinFor(pins, e);
		if (!pin) return e;
		if (pin.value === IGNORED) return { ...e, kind: "other" as const, ignored: true };
		return links[pin.value] ? { ...e, courseKey: pin.value } : e;
	});
}

/** A pin with no group behind it any more. */
export function prunePins(pins: CoursePins, links: CourseLinks): CoursePins {
	const alive = (v: string) => v === IGNORED || links[v] !== undefined;
	const keep = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).filter(([, v]) => alive(v)));
	return { events: keep(pins.events), titles: keep(pins.titles) };
}

/** Counts for "35 of 41 filed". */
export function coverage(placed: readonly CalendarEvent[]): { total: number; filed: number; ignored: number; unplaced: number } {
	let filed = 0;
	let ignored = 0;
	let unplaced = 0;
	for (const e of placed) {
		if (e.placement.state === "filed") filed++;
		else if (e.placement.state === "ignored") ignored++;
		else unplaced++;
	}
	return { total: placed.length, filed, ignored, unplaced };
}
