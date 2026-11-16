/**
 * EXAM CHEAT SHEETS (2026-11-16): everything to know for one exam, on a
 * class or chosen notes, optionally narrowed by a focus line ("only the
 * proofs from TD 3"), with each line marked by what Socrates has measured
 * about it: known, shaky, or not seen yet.
 *
 * The model writes the sheet and tags each item with the tracked topics it
 * covers; it never decides the marks. Standing is folded here, in code,
 * from the same tested recall the memory model and the weak-spot report
 * read (retention.ts, weak-spots.ts), so a sheet can only say "you know
 * this" when an answer of yours showed it.
 *
 * Pure and browser-safe: the server reads the records, this folds them.
 */

import { GRADE_AGAIN, GRADE_HARD, type TopicRetention } from "./retention.ts";
import type { WeakSpot } from "./weak-spots.ts";
import type { ExamTopic } from "./exam.ts";

export const CURRENT_SHEET_VERSION = 1;
export const SHEET_ID = /^sheet_[a-z0-9]+_[a-f0-9]{8}$/;

/** Known needs this much predicted recall now, on top of a clean last answer. */
export const KNOWN_RECALL = 0.8;
/** Note files a sheet is written from (as for a mock exam). */
export const SHEET_MAX_NOTES = 5;
/** Shape laws for the model's draft. */
export const SHEET_SECTIONS = { min: 2, max: 10 } as const;
export const SHEET_MAX_ITEMS = 60;
export const SHEET_ITEM_CHARS = 900;
export const SHEET_MAX_FIGURES = 4;

/** The progress lines while a sheet is written, in order. */
export const SHEET_STEPS = ["Writing the sheet", "Checking every line against your notes"] as const;

export type Standing = "known" | "shaky" | "unseen";

export const STANDING_LABEL: Record<Standing, string> = {
	known: "You know this",
	shaky: "Shaky",
	unseen: "Not seen yet",
};

/** One tracked topic the sheet may cover, with what the app measured. */
export interface SheetTopic extends ExamTopic {
	standing: Standing;
	/** One plain sentence on why. */
	reason: string;
	/** Predicted recall now, 0-1; absent when never tested. */
	retention?: number;
	/** Questions recently missed on it (newest first). */
	missed?: string[];
}

export interface SheetItem {
	id: string;
	/** The term, formula name or idea, short. */
	term: string;
	/** The content to remember (markdown + LaTeX), terse. */
	body: string;
	/** A trap to avoid, written for shaky topics. */
	watch?: string;
	topicKeys: string[];
	/** Resolved SVG markup of a figure, when one helps. */
	figure?: string;
	sources: string[];
	standing: Standing;
	reason: string;
}

export interface SheetSection {
	title: string;
	items: SheetItem[];
}

export type SheetStatus = "generating" | "ready" | "failed";

export interface SheetRecord {
	id: string;
	version?: number;
	title: string;
	createdAt: string;
	updatedAt: string;
	scope: {
		/** The exam or subject: a class name or the learner's words. */
		text: string;
		/** Optional: what the sheet should relate to specifically. */
		focus: string;
		noteIds: string[];
	};
	status: SheetStatus;
	phase?: string;
	error?: string;
	topics: SheetTopic[];
	sections: SheetSection[];
	/** Items the check corrected or removed. */
	checks?: { items: number; fixed: number; dropped: number };
}

export interface SheetSummary {
	id: string;
	title: string;
	createdAt: string;
	status: SheetStatus;
	counts: Record<Standing, number>;
}

// ─── standing ───────────────────────────────────────────────────────────────

const pct = (x: number): number => Math.round(100 * x);

/** What the app has measured about one topic. Never tested is "unseen". */
export function standingOf(topic: TopicRetention | undefined, spot: WeakSpot | undefined): { standing: Standing; reason: string; retention?: number } {
	if (!topic) return { standing: "unseen", reason: "Never tested yet." };
	const retention = topic.retention;
	if (spot) return { standing: "shaky", reason: spot.reason, retention };
	if (topic.lastGrade === GRADE_AGAIN) return { standing: "shaky", reason: "You missed it the last time it was tested.", retention };
	if (topic.lastGrade === GRADE_HARD) return { standing: "shaky", reason: "Right last time, but only just: unsure or with hints.", retention };
	if (retention < KNOWN_RECALL) return { standing: "shaky", reason: `Right last time, but fading: about ${pct(retention)}% recall now.`, retention };
	return {
		standing: "known",
		reason: `Right ${topic.reviews === 1 ? "the one time" : `${topic.reviews - topic.lapses} of ${topic.reviews} times`} it was tested, about ${pct(retention)}% recall now.`,
		retention,
	};
}

/** Each offered topic with its standing. */
export function sheetTopics(topics: readonly ExamTopic[], tracked: readonly TopicRetention[], spots: readonly WeakSpot[]): SheetTopic[] {
	const byKey = new Map(tracked.map((t) => [t.key, t]));
	const spotByKey = new Map(spots.map((s) => [s.key, s]));
	return topics.map((t) => {
		const s = standingOf(byKey.get(t.key), spotByKey.get(t.key));
		const missed = spotByKey.get(t.key)?.missedQuestions ?? [];
		return { ...t, ...s, ...(missed.length > 0 ? { missed } : {}) };
	});
}

const RANK: Record<Standing, number> = { shaky: 0, unseen: 1, known: 2 };

/** An item's standing from the topics it covers: the weakest tested one
 *  wins; an item whose topics were never tested (or that has none) is
 *  not seen yet. One clean answer on a part does not vouch for the whole
 *  item when another tagged topic was missed. */
export function itemStanding(keys: readonly string[], topics: ReadonlyMap<string, SheetTopic>): { standing: Standing; reason: string } {
	const tagged = keys.map((k) => topics.get(k)).filter((t): t is SheetTopic => t !== undefined);
	const tested = tagged.filter((t) => t.standing !== "unseen");
	if (tested.length === 0) {
		return { standing: "unseen", reason: tagged.length > 0 ? "In your notes, but never tested yet." : "No tested answer on this yet." };
	}
	const worst = [...tested].sort((a, b) => RANK[a.standing] - RANK[b.standing] || (a.retention ?? 1) - (b.retention ?? 1))[0]!;
	if (worst.standing === "known" && tested.length < tagged.length) {
		return { standing: "shaky", reason: `Part of it is tested and known (${worst.title}), part never tested.` };
	}
	return { standing: worst.standing, reason: tested.length > 1 ? `${worst.title}: ${worst.reason}` : worst.reason };
}

export function sheetCounts(sections: readonly SheetSection[]): Record<Standing, number> {
	const counts: Record<Standing, number> = { known: 0, shaky: 0, unseen: 0 };
	for (const s of sections) for (const i of s.items) counts[i.standing]++;
	return counts;
}

export function sheetSummary(r: SheetRecord): SheetSummary {
	return { id: r.id, title: r.title, createdAt: r.createdAt, status: r.status, counts: sheetCounts(r.sections) };
}

/** The tracked topic keys behind the shaky items: what a drill should aim at. */
export function shakyKeys(record: Pick<SheetRecord, "sections" | "topics">): string[] {
	const topics = new Map(record.topics.map((t) => [t.key, t]));
	const out = new Set<string>();
	for (const s of record.sections) {
		for (const i of s.items) {
			if (i.standing !== "shaky") continue;
			for (const k of i.topicKeys) if (topics.get(k)?.standing === "shaky") out.add(k);
		}
	}
	return [...out];
}

// ─── the draft ──────────────────────────────────────────────────────────────

export interface SheetDraft {
	title: string;
	sections: Array<{
		title: string;
		items: Array<{ term: string; body: string; watch?: string; topicKeys?: string[]; figure?: string; sources?: string[] }>;
	}>;
}

/** Everything wrong with a draft, in words the model can act on. */
export function sheetDraftProblems(draft: SheetDraft): string[] {
	const out: string[] = [];
	const sections = draft.sections ?? [];
	if (sections.length < SHEET_SECTIONS.min || sections.length > SHEET_SECTIONS.max) {
		out.push(`Group the sheet into ${SHEET_SECTIONS.min} to ${SHEET_SECTIONS.max} sections (you sent ${sections.length}).`);
	}
	const items = sections.reduce((n, s) => n + (s.items?.length ?? 0), 0);
	if (items === 0) out.push("The sheet has no items.");
	if (items > SHEET_MAX_ITEMS) out.push(`At most ${SHEET_MAX_ITEMS} items in all (you sent ${items}): merge or cut the least important.`);
	sections.forEach((s, si) => {
		if (!s.title?.trim()) out.push(`section ${si + 1}: give it a title.`);
		if (!s.items?.length) out.push(`section ${si + 1} ("${s.title}"): no items.`);
		s.items?.forEach((item, ii) => {
			const where = `section ${si + 1}, item ${ii + 1}`;
			if (!item.term?.trim()) out.push(`${where}: give it a term.`);
			if (!item.body?.trim()) out.push(`${where} ("${item.term}"): the body is empty.`);
			else if (item.body.length > SHEET_ITEM_CHARS) out.push(`${where} ("${item.term}"): ${item.body.length} characters; a cheat sheet line stays under ${SHEET_ITEM_CHARS}. Cut it down.`);
		});
	});
	return out;
}

/** The record's sections from a checked draft: ids, trimmed text, topic
 *  keys limited to the offered ones, figures resolved, standing folded. */
export function sectionsFromDraft(draft: SheetDraft, topics: readonly SheetTopic[], figures: ReadonlyMap<string, string> = new Map()): SheetSection[] {
	const byKey = new Map(topics.map((t) => [t.key, t]));
	let n = 0;
	return draft.sections
		.map((s) => ({
			title: s.title.trim(),
			items: s.items
				.filter((i) => i.term?.trim() && i.body?.trim())
				.map((i): SheetItem => {
					const topicKeys = [...new Set((i.topicKeys ?? []).map((k) => k.trim()).filter((k) => byKey.has(k)))];
					const figure = i.figure?.trim() ? figures.get(i.figure.trim()) : undefined;
					return {
						id: `i${++n}`,
						term: i.term.trim(),
						body: i.body.trim(),
						...(i.watch?.trim() ? { watch: i.watch.trim() } : {}),
						topicKeys,
						...(figure ? { figure } : {}),
						sources: (i.sources ?? []).map((x) => x.trim()).filter(Boolean),
						...itemStanding(topicKeys, byKey),
					};
				}),
		}))
		.filter((s) => s.items.length > 0);
}

export interface SheetVerdict {
	id: string;
	verdict: "ok" | "fix" | "drop";
	reason: string;
	body?: string;
}

/** The check's verdicts applied: a fix replaces the body, a drop removes
 *  the item (and an emptied section). Unknown ids are ignored. */
export function applySheetCheck(sections: readonly SheetSection[], verdicts: readonly SheetVerdict[]): { sections: SheetSection[]; fixed: number; dropped: number } {
	const byId = new Map(verdicts.map((v) => [v.id, v]));
	let fixed = 0;
	let dropped = 0;
	const out = sections
		.map((s) => ({
			...s,
			items: s.items.flatMap((i) => {
				const v = byId.get(i.id);
				if (v?.verdict === "drop") {
					dropped++;
					return [];
				}
				if (v?.verdict === "fix" && v.body?.trim()) {
					fixed++;
					return [{ ...i, body: v.body.trim() }];
				}
				return [i];
			}),
		}))
		.filter((s) => s.items.length > 0);
	return { sections: out, fixed, dropped };
}
