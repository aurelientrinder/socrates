/**
 * THE CLASS CALENDAR service (2026-10-29): the eight weeks the Library's
 * Calendar tab shows, every event placed (filed / ignored / unplaced) by
 * core/course-calendar.ts, plus the groups to file them in.
 *
 * Events come from Google Calendar when it is connected, read at most every
 * CACHE_MS and kept in briefing/calendar-window.json (so opening the tab is
 * instant and survives a flaky connection). Not connected: the events
 * today's briefing already read. Nothing here writes to the calendar.
 */

import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import { renameWithRetry } from "../store/fs-atomic.ts";
import { coverage, placeEvents, type CalendarEvent, type StudyEvent } from "../core/index.ts";
import { savedBriefing } from "./briefing.ts";
import { readCourseLinks, readCoursePins, readDismissedCourses } from "./courses.ts";
import { googleCalendarStatus, listCalendarEvents } from "./integrations/google-calendar.ts";
import { notesLibrary } from "../store/notes.ts";

const FILE = path.join(PATHS.data, "briefing", "calendar-window.json");
const CACHE_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const CALENDAR_WEEKS = 8;

interface WindowCache {
	from: number;
	to: number;
	fetchedAt: number;
	events: StudyEvent[];
}

function readCache(): WindowCache | null {
	try {
		const raw = JSON.parse(fs.readFileSync(FILE, "utf-8")) as WindowCache;
		return Array.isArray(raw.events) && typeof raw.from === "number" ? raw : null;
	} catch {
		return null;
	}
}

function writeCache(cache: WindowCache): void {
	fs.mkdirSync(path.dirname(FILE), { recursive: true });
	const tmp = `${FILE}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(cache));
	renameWithRetry(tmp, FILE);
}

/** Monday 00:00 local of the week `now` is in. */
export function weekStart(now: number): number {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
	return d.getTime();
}

export interface CalendarGroup {
	key: string;
	label: string;
	noteCount: number;
	/** The next exam of it in the window, for "Exam Tue 15 Dec" / "No exam in calendar". */
	nextExam: { title: string; start: number } | null;
	events: number;
}

export interface CalendarPayload {
	/** Where the events came from: Google Calendar, today's briefing, or nowhere. */
	source: "google" | "briefing" | "none";
	connected: boolean;
	/** Why Google could not be read just now (cached events are shown instead). */
	error?: string;
	now: number;
	from: number;
	to: number;
	events: CalendarEvent[];
	groups: CalendarGroup[];
	coverage: ReturnType<typeof coverage>;
}

/** The window's raw events: fresh from Google, the cache, or the briefing's. */
async function windowEvents(from: number, to: number, now: number, refresh: boolean): Promise<{ events: StudyEvent[]; source: CalendarPayload["source"]; error?: string }> {
	if (googleCalendarStatus().connected) {
		const cache = readCache();
		const fresh = cache && cache.from === from && now - cache.fetchedAt < CACHE_MS;
		if (fresh && !refresh) return { events: cache.events, source: "google" };
		try {
			const events = (await listCalendarEvents(from, to)).filter((e) => e.source === "calendar");
			writeCache({ from, to, fetchedAt: now, events });
			return { events, source: "google" };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			if (cache && cache.from === from) return { events: cache.events, source: "google", error };
			return { events: [], source: "none", error };
		}
	}
	const briefed = savedBriefing(now)?.events.filter((e) => e.source === "calendar") ?? [];
	return { events: briefed, source: briefed.length > 0 ? "briefing" : "none" };
}

export async function courseCalendar(opts: { refresh?: boolean; now?: number } = {}): Promise<CalendarPayload> {
	const now = opts.now ?? Date.now();
	const from = weekStart(now);
	const to = from + CALENDAR_WEEKS * 7 * DAY_MS;
	const got = await windowEvents(from, to, now, opts.refresh === true);
	const links = readCourseLinks();
	const inWindow = got.events.filter((e) => e.start >= from && e.start < to);
	const events = placeEvents(inWindow, links, readCoursePins(), readDismissedCourses());
	const groups = Object.entries(links)
		.map(([key, g]): CalendarGroup => {
			const mine = events.filter((e) => e.placement.state === "filed" && e.placement.key === key);
			const exam = mine.find((e) => e.kind === "exam" && e.end >= now);
			return {
				key,
				label: g.label,
				noteCount: (g.noteIds ?? []).filter((id) => notesLibrary.get(id) !== null).length,
				nextExam: exam ? { title: exam.title, start: exam.start } : null,
				events: mine.length,
			};
		})
		.sort((a, b) => a.label.localeCompare(b.label));
	return {
		source: got.source,
		connected: googleCalendarStatus().connected,
		...(got.error ? { error: got.error } : {}),
		now,
		from,
		to,
		events,
		groups,
		coverage: coverage(events),
	};
}
