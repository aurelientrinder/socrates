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
