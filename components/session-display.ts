import type { ChatListItem } from "@/src/core";

/**
 * How a session reads in the sidebar (sidebar refine, 2026-11-03): the
 * SUBJECT leads, and a small tile says what kind of session it is, so a
 * weak-spot drill or a review stands out from the lessons around it. The
 * stored title stays untouched (search, rename and the header still use
 * it); this only derives the row's display from it. Pure, for tests.
 */
export type SessionVariant = "learn" | "notes" | "practice" | "drill" | "review";

export interface SessionDisplay {
	variant: SessionVariant;
	/** The row's main line: the subject, or the session's own name. */
	name: string;
	/** The kind, in words, for the row's second line. */
	kindLabel: string;
	/** A count worth seeing at a glance ("1 weak spot", "3 topics"). */
	chip: string | null;
}

const NOTES_TEACH = /^Teach me what is in my notes "(.+)"\.?$/;
const NOTES_PRACTICE = /^Give me practice problems on my notes "(.+)"\.?$/;
const TEACH = /^Teach me (.+?)(?:, starting from what I already know.*)?\.?$/;
const DRILL = /^Drill · (\d+ weak spots?)$/;
const REVIEW = /^Review · (\d+ topics?)$/;

export function sessionDisplay(chat: Pick<ChatListItem, "title" | "kind">): SessionDisplay {
	const title = chat.title.trim() || "Untitled session";
	const kind = chat.kind ?? "teach";
	if (kind === "review") {
		const drill = DRILL.exec(title);
		if (drill) return { variant: "drill", name: "Weak spot drill", kindLabel: "Drill", chip: drill[1] ?? null };
		const review = REVIEW.exec(title);
		if (review) return { variant: "review", name: "Review", kindLabel: "Spaced review", chip: review[1] ?? null };
		return { variant: "review", name: title, kindLabel: "Review", chip: null };
	}
	if (kind === "practice") {
		const notes = NOTES_PRACTICE.exec(title);
		return { variant: "practice", name: notes?.[1] ?? title, kindLabel: notes ? "Practice · notes" : "Practice", chip: null };
	}
	const notes = NOTES_TEACH.exec(title);
	if (notes) return { variant: "notes", name: notes[1] ?? title, kindLabel: "From your notes", chip: null };
	const teach = TEACH.exec(title);
	return { variant: "learn", name: teach?.[1] ?? title, kindLabel: "Learn", chip: null };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The row's compact age: "now", "5m", "3h", "2d", then "27 Oct" (with
 *  the year once it is not this year's). Pure. */
export function shortAgo(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d`;
	const date = new Date(iso);
	const day = `${date.getDate()} ${MONTHS[date.getMonth()]}`;
	return date.getFullYear() === now.getFullYear() ? day : `${day} ${date.getFullYear()}`;
}

export type DateGroup = "Today" | "This week" | "Earlier";

/** Which list heading a session falls under, by its last activity. */
export function dateGroup(iso: string, now = new Date()): DateGroup {
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const t = new Date(iso).getTime();
	if (t >= start.getTime()) return "Today";
	if (t >= start.getTime() - 6 * 86_400_000) return "This week";
	return "Earlier";
}
