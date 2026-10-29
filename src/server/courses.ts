/**
 * COURSE GROUPS service (2026-10-28): the groups the learner made — one per
 * class, each with its notes and sessions — and the calendar suggestions
 * for the ones not made yet (core/courses.ts suggestCourses).
 *
 * Files (data dir): briefing/courses.json (group key → CourseGroup; the
 * same file the briefing's "Link sessions" always wrote, so old links are
 * groups with sessions and no notes), briefing/course-dismissed.json (the
 * suggestions the learner said are not classes).
 *
 * Nothing here touches Google Calendar: suggestions are computed from the
 * events the day's briefing already read.
 */

import { renameWithRetry } from "../store/fs-atomic.ts";
import fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";
import {
	classifyEvent,
	courseGroupFor,
	courseKeyOfEvent,
	courseKeyFor,
	foldSessionKeys,
	suggestCourses,
	IGNORED,
	mergeGroups,
	prunePins,
	unmergeGroups,
	type MergeRestore,
	type CoursePins,
	type CourseGroup,
	type CourseLinks,
	type CourseMaterial,
	type CourseSuggestion,
	type PinScope,
	type StudyEvent,
} from "../core/index.ts";
import type { NoteMeta } from "../core/contracts.ts";
import { notesLibrary } from "../store/notes.ts";
import { stores } from "./stores.ts";

const DIR = path.join(PATHS.data, "briefing");
const COURSES_FILE = path.join(DIR, "courses.json");
const DISMISSED_FILE = path.join(DIR, "course-dismissed.json");
const PINS_FILE = path.join(DIR, "course-pins.json");
const MAX_LABEL = 120;
const NOTE_ID = /^src_[0-9a-f]{12}$/;
const CHAT_ID = /^[A-Za-z0-9_-]+$/;

/** A refusal the learner can act on (the routes report the message, status 400/404). */
export class CourseError extends Error {
	constructor(message: string, readonly status = 400) {
		super(message);
	}
}

function readJson<T>(file: string): T | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
	} catch {
		return null;
	}
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`);
	renameWithRetry(tmp, file);
}

const strings = (v: unknown): string[] | undefined =>
	Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;

export function readCourseLinks(): CourseLinks {
	const links = readStoredLinks();
	// Groups made while CM, TD and TP counted as different courses fold into one.
	const folded = foldSessionKeys(links);
	if (Object.keys(folded).length !== Object.keys(links).length) writeCourseLinks(folded);
	return folded;
}

function readStoredLinks(): CourseLinks {
	const raw = readJson<Record<string, Partial<CourseGroup>>>(COURSES_FILE);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const out: CourseLinks = {};
	for (const [key, v] of Object.entries(raw)) {
		if (!v || typeof v.label !== "string") continue;
		const chatIds = strings(v.chatIds);
		const noteIds = strings(v.noteIds);
		const aliases = strings(v.aliases);
		out[key] = {
			label: v.label,
			...(chatIds ? { chatIds } : {}),
			...(noteIds ? { noteIds } : {}),
			...(aliases && aliases.length > 0 ? { aliases } : {}),
			...(typeof v.createdAt === "string" ? { createdAt: v.createdAt } : {}),
		};
	}
	return out;
}

function writeCourseLinks(links: CourseLinks): void {
	writeJson(COURSES_FILE, links);
}

/** Confirm which sessions belong to a course (empty list = "none of them").
 *  The briefing's "Link sessions": keeps the group's notes and aliases. */
export function setCourseLink(key: string, label: string, chatIds: string[]): CourseLinks {
	const links = readCourseLinks();
	const found = courseGroupFor(links, key);
	const at = found?.key ?? key;
	links[at] = { ...links[at], label: found ? links[at]!.label : label, chatIds: [...new Set(chatIds)] };
	writeCourseLinks(links);
	return links;
}

export function readDismissedCourses(): string[] {
	return strings(readJson<{ keys?: unknown }>(DISMISSED_FILE)?.keys) ?? [];
}

function cleanLabel(label: unknown): string {
	if (typeof label !== "string" || !label.trim()) throw new CourseError("Give the course a name.");
	return label.trim().replace(/\s+/g, " ").slice(0, MAX_LABEL);
}

function requireGroup(links: CourseLinks, key: string): CourseGroup {
	const group = links[key];
	if (!group) throw new CourseError("That course is gone. Reload the page.", 404);
	return group;
}

/**
 * Make a group: from a calendar suggestion (its key) or by hand (a name;
 * the key is what courseOf makes of it, so the calendar's events of that
 * course find it). An existing group under that key is returned as is.
 */
export function createCourse(input: { label?: unknown; key?: unknown }): { key: string; links: CourseLinks } {
	const label = cleanLabel(input.label);
	const key = typeof input.key === "string" && input.key.trim() ? input.key.trim().slice(0, 200) : courseKeyFor(label);
	const links = readCourseLinks();
	const found = courseGroupFor(links, key);
	if (found) return { key: found.key, links };
	links[key] = { label, noteIds: [], createdAt: new Date().toISOString() };
	writeCourseLinks(links);
	const dismissed = readDismissedCourses();
	if (dismissed.includes(key)) writeJson(DISMISSED_FILE, { keys: dismissed.filter((k) => k !== key) });
	return { key, links };
}

/**
 * Change one group: rename, add or take out notes, set its sessions, or
 * fold another calendar course into it (an alias, e.g. "MATH201" events
 * into a "Linear algebra" group made by hand).
 */
export function updateCourse(
	key: string,
	patch: { label?: unknown; addNoteIds?: unknown; removeNoteIds?: unknown; chatIds?: unknown; addAlias?: unknown },
): CourseLinks {
	const links = readCourseLinks();
	const group = { ...requireGroup(links, key) };
	if (patch.label !== undefined) group.label = cleanLabel(patch.label);
	const add = strings(patch.addNoteIds)?.filter((id) => NOTE_ID.test(id) && notesLibrary.get(id) !== null);
	if (add && add.length > 0) group.noteIds = [...new Set([...(group.noteIds ?? []), ...add])];
	const remove = strings(patch.removeNoteIds);
	if (remove && remove.length > 0) group.noteIds = (group.noteIds ?? []).filter((id) => !remove.includes(id));
	if (patch.chatIds !== undefined) {
		const chats = strings(patch.chatIds);
		if (!chats || !chats.every((id) => CHAT_ID.test(id))) throw new CourseError("chatIds must be session ids.");
		group.chatIds = [...new Set(chats)];
	}
	if (typeof patch.addAlias === "string" && patch.addAlias && patch.addAlias !== key) {
		const alias = patch.addAlias.slice(0, 200);
		if (courseGroupFor(links, alias)) throw new CourseError("That calendar course already belongs to a group.");
		group.aliases = [...new Set([...(group.aliases ?? []), alias])];
	}
	links[key] = group;
	writeCourseLinks(links);
	return links;
}

/** Remove a group. Its notes stay in the library, its sessions stay sessions;
 *  events the learner filed under it go back to unplaced. */
export function deleteCourse(key: string): CourseLinks {
	const links = readCourseLinks();
	requireGroup(links, key);
	delete links[key];
	writeCourseLinks(links);
	writeCoursePins(prunePins(readCoursePins(), links));
	return links;
}

// ─── The learner's hand-filed calendar events ────────────────────────────────

const pinMap = (v: unknown): Record<string, string> => {
	if (!v || typeof v !== "object" || Array.isArray(v)) return {};
	return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
};

/** Pins live in their own file so no classifier pass or group edit can overwrite them. */
export function readCoursePins(): CoursePins {
	const raw = readJson<{ events?: unknown; titles?: unknown }>(PINS_FILE);
	return { events: pinMap(raw?.events), titles: pinMap(raw?.titles) };
}

function writeCoursePins(pins: CoursePins): void {
	writeJson(PINS_FILE, pins);
}

/**
 * Merge course `from` into `into` (core/course-calendar.ts mergeGroups): notes
 * and sessions combine, `from`'s calendar titles now belong to `into`, hand-filed
 * events follow. Returns what is needed to undo it.
 */
export function mergeCourses(from: string, into: string): { restore: MergeRestore } {
	const links = readCourseLinks();
	requireGroup(links, from);
	requireGroup(links, into);
	const result = mergeGroups(links, readCoursePins(), from, into);
	if (!result) throw new CourseError("Pick two different courses to merge.");
	writeCourseLinks(result.links);
	writeCoursePins(result.pins);
	return { restore: result.restore };
}

/** Undo a merge: both courses come back as they were (only those two, and the pins that moved). */
export function unmergeCourses(restore: MergeRestore): void {
	const ok = (g: unknown): g is CourseGroup => !!g && typeof (g as CourseGroup).label === "string";
	if (!restore || typeof restore.from?.key !== "string" || typeof restore.into?.key !== "string" || !ok(restore.from.group) || !ok(restore.into.group) || !Array.isArray(restore.pins)) {
		throw new CourseError("That merge can't be undone.");
	}
	const pins = restore.pins.filter((p) => (p.scope === "event" || p.scope === "title") && typeof p.id === "string" && p.value === restore.from.key);
	const { links, pins: nextPins } = unmergeGroups(readCourseLinks(), readCoursePins(), { ...restore, pins });
	writeCourseLinks(links);
	writeCoursePins(nextPins);
}

export type PinChange = { scope: PinScope; id: string; value: string | null };

/**
 * Set or clear pins, all or none. `id` is the event id (scope "event") or the
 * titleKey (scope "title"); value is a group key, IGNORED, or null to clear.
 * Returns the previous values in the same shape, so the caller can undo.
 */
export function setCoursePins(changes: readonly PinChange[]): { pins: CoursePins; undo: PinChange[] } {
	const links = readCourseLinks();
	const pins = readCoursePins();
	for (const c of changes) {
		if (c.scope !== "event" && c.scope !== "title") throw new CourseError("Unknown pin scope.");
		if (typeof c.id !== "string" || !c.id || c.id.length > 400) throw new CourseError("Missing event.");
		if (c.value !== null && c.value !== IGNORED && !links[c.value]) throw new CourseError("That course is gone. Reload the page.", 404);
	}
	const undo: PinChange[] = [];
	for (const c of changes) {
		const map = c.scope === "event" ? pins.events : pins.titles;
		undo.unshift({ scope: c.scope, id: c.id, value: map[c.id] ?? null });
		if (c.value === null) delete map[c.id];
		else map[c.id] = c.value;
	}
	writeCoursePins(pins);
	return { pins, undo };
}

/** "Not a class": stop suggesting this calendar course. */
export function dismissCourseSuggestion(key: string): string[] {
	if (!key || key.length > 200) throw new CourseError("Missing course key.");
	const keys = [...new Set([...readDismissedCourses(), key])];
	writeJson(DISMISSED_FILE, { keys });
	return keys;
}

/** Put freshly imported notes in a group (the import route, after saving). */
export function addNotesToCourse(key: string, noteIds: readonly string[]): void {
	const links = readCourseLinks();
	const group = links[key];
	if (!group || noteIds.length === 0) return;
	links[key] = { ...group, noteIds: [...new Set([...(group.noteIds ?? []), ...noteIds])] };
	writeCourseLinks(links);
}

export function courseExists(key: string): boolean {
	return readCourseLinks()[key] !== undefined;
}

/**
 * Per group: its saved notes (removed files drop out) and the tracked-topic
 * keys of the ideas learned from them (graph nodes whose provenance is one
 * of the notes → "prop:<id>"), which is what lets a course's exam count
 * topics that came from its notes.
 */
export function courseMaterial(links: CourseLinks = readCourseLinks()): Record<string, CourseMaterial> {
	const withNotes = Object.entries(links).filter(([, g]) => (g.noteIds?.length ?? 0) > 0);
	if (withNotes.length === 0) return {};
	const nodesBySource = new Map<string, Set<string>>();
	try {
		for (const line of stores.graphStore.readNodes()) {
			for (const p of line.provenance) {
				const set = nodesBySource.get(p.chatId) ?? new Set<string>();
				set.add(line.id);
				nodesBySource.set(p.chatId, set);
			}
		}
	} catch {
		// no graph yet: notes only
	}
	const out: Record<string, CourseMaterial> = {};
	for (const [key, group] of withNotes) {
		const notes: CourseMaterial["notes"] = [];
		const topicKeys = new Set<string>();
		for (const id of group.noteIds ?? []) {
			const meta = notesLibrary.get(id);
			if (!meta) continue;
			notes.push({ id, name: meta.name });
			for (const node of nodesBySource.get(id) ?? []) topicKeys.add(`prop:${node}`);
		}
		out[key] = { notes, topicKeys: [...topicKeys] };
	}
	return out;
}

export interface CourseView {
	key: string;
	label: string;
	notes: NoteMeta[];
	/** Confirmed sessions (absent = not confirmed). */
	chatIds?: string[];
	aliases: string[];
	/** The next calendar event of it, from today's briefing. */
	next: { title: string; start: number; kind: string } | null;
	createdAt?: string;
}

/** Every group with its notes and next event, plus the calendar suggestions. */
export function listCourses(events: readonly StudyEvent[], now: number = Date.now()): { courses: CourseView[]; suggestions: CourseSuggestion[] } {
	const links = readCourseLinks();
	const nextOf = new Map<string, CourseView["next"]>();
	for (const e of [...events].sort((a, b) => a.start - b.start)) {
		if (e.end < now || e.ignored) continue;
		const found = courseGroupFor(links, courseKeyOfEvent(e));
		if (found && !nextOf.has(found.key)) nextOf.set(found.key, { title: e.title, start: e.start, kind: e.kind ?? classifyEvent(e.title, e.source) });
	}
	const courses = Object.entries(links)
		.map(([key, g]): CourseView => ({
			key,
			label: g.label,
			notes: (g.noteIds ?? []).flatMap((id) => {
				const meta = notesLibrary.get(id);
				return meta ? [meta] : [];
			}),
			...(g.chatIds ? { chatIds: g.chatIds } : {}),
			aliases: g.aliases ?? [],
			next: nextOf.get(key) ?? null,
			...(g.createdAt ? { createdAt: g.createdAt } : {}),
		}))
		.sort((a, b) => (a.next?.start ?? Infinity) - (b.next?.start ?? Infinity) || a.label.localeCompare(b.label));
	return { courses, suggestions: suggestCourses(events, links, readDismissedCourses(), now) };
}
