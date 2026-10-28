/**
 * HOW A CLASS MEETS (2026-10-28), read from an event title. One course has
 * several kinds of meeting — "CM Analyse", "TD Analyse", "TP Analyse" are
 * the same course — and the planner can still tell them apart: a lecture
 * (CM, cours magistral, amphi), a tutorial (TD, travaux dirigés:
 * exercises) and a lab (TP, travaux pratiques). The French forms carry a
 * number or a letter ("TD1", "TD 2", "TP-3", "TD2A") that names a group,
 * never a course. Pure and browser-safe.
 */

export type SessionType = "lecture" | "tutorial" | "lab";

/** The sources the course-title rules (core/briefing.ts) are built from. */
const NUM = "(?:[\\s._-]?\\d{1,2}[a-z]?)?";
export const LECTURE_SRC = `cours\\s+magistral|cm${NUM}|amphi(?:th[ée][aâ]tre)?(?:\\s[a-z0-9]{1,2})?|lectures?|conf[ée]rences?|cours`;
export const TUTORIAL_SRC = `travaux\\s+dirig[ée]s?|td${NUM}|tutorials?|tutorats?|recitations?|exercices?`;
export const LAB_SRC = `travaux\\s+pratiques?|tp${NUM}|labs?|laborato(?:ire|ry)s?`;
export const OTHER_CLASS_SRC = "class(?:es)?|courses?|seminars?|s[ée]minaires?";
export const CLASS_RE = new RegExp(`\\b(?:${LECTURE_SRC}|${TUTORIAL_SRC}|${LAB_SRC}|${OTHER_CLASS_SRC})\\b`, "i");
const SESSION_RES: [SessionType, RegExp][] = [
	["lecture", new RegExp(`\\b(?:${LECTURE_SRC})\\b`, "i")],
	["tutorial", new RegExp(`\\b(?:${TUTORIAL_SRC})\\b`, "i")],
	["lab", new RegExp(`\\b(?:${LAB_SRC})\\b`, "i")],
];
/** A group marker: "groupe 2", "Gr B", "G3" — which half of the class, not which course. */
export const GROUP_SRC = "(?:groupes?|grp?)\\.?\\s?[a-z0-9]{1,2}|g\\d{1,2}";

/** The kind of meeting a title names, the earliest one when it names several ("CM/TD" is a lecture); null when none. */
export function sessionTypeOf(title: string): SessionType | null {
	let best: { type: SessionType; at: number } | null = null;
	for (const [type, re] of SESSION_RES) {
		const at = title.search(re);
		if (at >= 0 && (best === null || at < best.at)) best = { type, at };
	}
	return best?.type ?? null;
}

