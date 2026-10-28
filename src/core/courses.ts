/**
 * COURSE GROUPS (2026-10-28): one group per class the learner takes, holding
 * its notes and its sessions, so a calendar event of that class pulls the
 * right material into the study plan, the briefing and mock exams.
 *
 * This module is the pure half: which calendar courses to SUGGEST as
 * groups. Plain rules, no model — class timetables are regular (keywords
 * like CM/TD/lecture, course codes, a title that comes back every week),
 * and the learner confirms, renames or dismisses every suggestion. Nothing
 * becomes a group on its own. The groups themselves live in
 * briefing/courses.json (src/server/courses.ts); the event → group match
 * is core/briefing.ts courseGroupFor.
 */

import { classifyEvent, courseGroupFor, courseOf, sessionTypeOf, type CourseLinks, type SessionType, type StudyEvent } from "./briefing.ts";

/** A title with no class word must come back this often to be suggested. */
export const REPEAT_MIN = 3;
/** Class-word events: two of them make a course (one could be a one-off talk). */
export const CLASS_MIN = 2;

/** Recurring things that are not classes, English + French. */
const NOT_A_CLASS_RE =
	/\b(gym|sport|workout|run|running|football|foot|basket|tennis|swim|swimming|piscine|yoga|lunch|dinner|d[ée]jeuner|d[îi]ner|breakfast|work|travail|job|shift|meeting|r[ée]union|standup|stand-up|call|birthday|anniversaire|rdv|appointment|dentist|dentiste|m[ée]decin|doctor|therapy|church|messe|choir|chorale|party|soir[ée]e|vacances|holiday|holidays|f[ée]ri[ée])\b/i;

export interface CourseSuggestion {
	/** The courseOf key a group made from it is stored under. */
	key: string;
	/** Display label (the most common spelling in the calendar). */
	label: string;
	/** Classes of it in the window the calendar was read for. */
	classes: number;
	/** How many of them are lectures, tutorials and labs (CM, TD, TP): one course, told apart. */
	sessions: Record<SessionType, number>;
	exams: number;
	/** The next one, for "next class Tuesday". */
	nextStart: number | null;
	/** A few real event titles, so the learner can tell what it groups. */
	examples: string[];
	/** Why it is suggested, in plain words. */
	reason: string;
	/** Strength for ordering: class-word and exam courses before bare repeats. */
	score: number;
}

/**
 * Courses in the calendar that are not groups yet (nor dismissed): every
 * course key with two or more class events, an exam, or a title that comes
 * back REPEAT_MIN times. Strongest first.
 */
export function suggestCourses(
	events: readonly StudyEvent[],
	groups: CourseLinks,
	dismissed: readonly string[],
	now: number,
): CourseSuggestion[] {
	const skip = new Set(dismissed);
	const byKey = new Map<string, { sessions: Record<SessionType, number>; labels: Map<string, number>; titles: Set<string>; classes: number; exams: number; repeats: number; next: number | null; code: boolean }>();
	for (const e of events) {
		if (e.source !== "calendar") continue;
		const kind = e.kind ?? classifyEvent(e.title, e.source);
		if (kind === "deadline") continue;
		const course = courseOf(e.title);
		if (course.key.length < 2 || skip.has(course.key) || courseGroupFor(groups, course.key)) continue;
		if (kind === "other" && (e.allDay || NOT_A_CLASS_RE.test(e.title))) continue;
		const entry = byKey.get(course.key) ?? { sessions: { lecture: 0, tutorial: 0, lab: 0 }, labels: new Map(), titles: new Set(), classes: 0, exams: 0, repeats: 0, next: null, code: course.label !== course.label.toLowerCase() && /\d/.test(course.label) };
		entry.labels.set(course.label, (entry.labels.get(course.label) ?? 0) + 1);
		entry.titles.add(e.title);
		if (kind === "class") {
			entry.classes++;
			const type = sessionTypeOf(e.title);
			if (type) entry.sessions[type]++;
		}
		else if (kind === "exam") entry.exams++;
		else entry.repeats++;
		if (e.end >= now && (entry.next === null || e.start < entry.next)) entry.next = e.start;
		byKey.set(course.key, entry);
	}

	const out: CourseSuggestion[] = [];
	for (const [key, e] of byKey) {
		const total = e.classes + e.repeats;
		const ok = e.classes >= CLASS_MIN || e.exams > 0 || total >= REPEAT_MIN || (e.code && total >= CLASS_MIN);
		if (!ok) continue;
		const label = [...e.labels.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
		const parts: string[] = [];
		if (total > 0) parts.push(`${total} ${e.classes > 0 ? "class" : "event"}${total === 1 ? "" : e.classes > 0 ? "es" : "s"}${sessionMix(e.sessions)}`);
		if (e.exams > 0) parts.push(`${e.exams} exam${e.exams === 1 ? "" : "s"}`);
		out.push({
			key,
			label,
			classes: total,
			sessions: e.sessions,
			exams: e.exams,
			nextStart: e.next,
			examples: [...e.titles].slice(0, 3),
			reason: `${parts.join(" and ")} in your calendar`,
			score: e.classes * 2 + e.exams * 3 + e.repeats + (e.code ? 2 : 0),
		});
	}
	return out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
}

/** "(4 lectures, 4 tutorials, 2 labs)": what meets, when a course meets in more than one way. */
function sessionMix(sessions: Record<SessionType, number>): string {
	const parts = (Object.entries(sessions) as [SessionType, number][])
		.filter(([, n]) => n > 0)
		.map(([type, n]) => `${n} ${type === "lecture" ? "lecture" : type === "tutorial" ? "tutorial" : "lab"}${n === 1 ? "" : "s"}`);
	return parts.length > 1 ? ` (${parts.join(", ")})` : "";
}

/** The key a hand-made group is stored under: what courseOf would make of
 *  its name, so calendar events of that course find it on their own. */
export function courseKeyFor(label: string): string {
	const key = courseOf(label).key;
	return key || label.trim().toLowerCase().replace(/\s+/g, " ");
}

/** "Analyse › Chapitre 1.pdf": a file from a dropped folder, named by its
 *  path so two courses' "Chapitre 1.pdf" stay two notes. */
export function folderNoteName(relativePath: string): string {
	const parts = relativePath.split(/[\\/]+/).filter(Boolean);
	return parts.length > 1 ? parts.join(" › ") : (parts[0] ?? relativePath);
}

/** File types a course import takes (the notes import's own list). */
export function isNotesFile(name: string): boolean {
	return /\.(pdf|md|markdown|txt)$/i.test(name) && !name.split(/[\\/]/).some((p) => p.startsWith("."));
}
