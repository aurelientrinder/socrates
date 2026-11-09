/**
 * THE CLASS LENS (2026-10-29): classes seen from the rest of the app. A
 * class owns sessions (confirmed chats and imported notes files, the same ids
 * the map's birth-session clusters use), so anything that knows its session
 * knows its class. Pure; the server builds the class list (server/courses.ts).
 */

import type { GraphEdge } from "./contracts/graph.ts";

/** How many class colors exist; the calendar's `.cal-c0..5` tokens. */
export const CLASS_COLORS = 6;

export interface LensClass {
	key: string;
	label: string;
	/** Chat ids and notes-file ids that belong to it. */
	sessions: string[];
	/** Index into the class colors, stable while the set of classes is. */
	color: number;
}

/** Colors by sorted key, so every screen gives a class the same one. */
export function colorsFor(keys: readonly string[]): Map<string, number> {
	return new Map([...keys].sort((a, b) => a.localeCompare(b)).map((k, i) => [k, i % CLASS_COLORS]));
}

/** Lowercase, accent-free, words only: "Dynamique des Structures" and "dynamique-des structures" compare equal. */
function plain(text: string): string {
	return ` ${text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
}

/** The shortest name worth matching on: shorter ones ("td", "cm") match too much. */
const MIN_NAME = 5;

/**
 * Auto-filing (2026-11-09): sessions no class owns yet are placed in the class
 * whose name (label, key or alias) their title carries, or that the title is
 * a whole-word part of ("Dynamique des Structures" in "GM-M1-Dynamique des
 * Structures"). The longest matching name wins. Nothing is saved: a session
 * the learner files by hand always keeps that class, because only unowned
 * sessions are looked at, and an inferred one stops being inferred as soon as
 * it is filed. Returns session id → class key.
 */
export function inferSessionClasses(
	classes: readonly { key: string; label: string; aliases?: readonly string[]; sessions: readonly string[] }[],
	chats: readonly { id: string; title: string }[],
): Map<string, string> {
	const owned = new Set(classes.flatMap((c) => c.sessions));
	const names = classes.flatMap((c) =>
		[c.label, c.key, ...(c.aliases ?? [])]
			.map((n) => plain(n))
			.filter((n) => n.trim().length >= MIN_NAME)
			.map((n) => ({ key: c.key, name: n })),
	);
	const out = new Map<string, string>();
	for (const chat of chats) {
		if (owned.has(chat.id)) continue;
		const title = plain(chat.title);
		let best: { key: string; len: number } | null = null;
		for (const { key, name } of names) {
			const hit = title.includes(name) || (title.trim().length >= MIN_NAME && name.includes(title));
			const len = Math.min(name.length, title.length);
			if (hit && (!best || len > best.len)) best = { key, len };
		}
		if (best) out.set(chat.id, best.key);
	}
	return out;
}

/** The class a session belongs to (the first, when it was filed under several). */
export function classOfSession(classes: readonly LensClass[], sessionId: string): LensClass | null {
	return classes.find((c) => c.sessions.includes(sessionId)) ?? null;
}

/**
 * The nodes to show when looking at one class: its own, plus whatever they
 * connect to in other classes (two hops, through the implication nodes
 * between premises and conclusions). Connections across classes are the
 * point of the map, so a class never cuts them off.
 */
export function classView(
	nodes: readonly { id: string; provenance: readonly { chatId: string }[] }[],
	edges: readonly GraphEdge[],
	cls: Pick<LensClass, "sessions">,
): { own: Set<string>; shown: Set<string> } {
	const mine = new Set(cls.sessions);
	const own = new Set(nodes.filter((n) => n.provenance.some((p) => mine.has(p.chatId))).map((n) => n.id));
	const shown = new Set(own);
	const grow = (from: Set<string>) => {
		const added = new Set<string>();
		for (const e of edges) {
			if (from.has(e.from) && !shown.has(e.to)) added.add(e.to);
			if (from.has(e.to) && !shown.has(e.from)) added.add(e.from);
		}
		for (const id of added) shown.add(id);
		return added;
	};
	grow(own);
	// The junction nodes reached from the class lead on to the other side.
	grow(new Set([...shown].filter((id) => !own.has(id))));
	return { own, shown };
}

export interface ClassMemory {
	/** null: topics from sessions no class owns. */
	cls: LensClass | null;
	topics: number;
	due: number;
	/** Mean predicted recall of its topics, 0-1. */
	retention: number;
}

/**
 * How each class's memory stands: its topics, how many are due, and the mean
 * recall. Topics from sessions no class owns come last, as one group. Classes
 * with no topics yet are left out.
 */
export function memoryByClass(
	topics: readonly { chatId: string; retention: number; due: boolean }[],
	classes: readonly LensClass[],
): ClassMemory[] {
	const groups = new Map<string | null, typeof topics[number][]>();
	for (const t of topics) {
		const key = classOfSession(classes, t.chatId)?.key ?? null;
		groups.set(key, [...(groups.get(key) ?? []), t]);
	}
	const out: ClassMemory[] = [];
	for (const [key, list] of groups) {
		out.push({
			cls: key === null ? null : (classes.find((c) => c.key === key) ?? null),
			topics: list.length,
			due: list.filter((t) => t.due).length,
			retention: list.reduce((n, t) => n + t.retention, 0) / list.length,
		});
	}
	// Classes by name, the unfiled group last.
	return out.sort((a, b) => (a.cls === null ? 1 : b.cls === null ? -1 : a.cls.label.localeCompare(b.cls.label)));
}
