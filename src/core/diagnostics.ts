/**
 * DIAGNOSTIC-HOTSPOT CONTEXT INJECTION (pure, zero-IO, browser-safe):
 * Builds a concise, high-signal diagnostic brief for a new session from:
 *   1. The topic's structural prerequisite neighborhood in the knowledge graph
 *      (1-2 hops of GraphChain premises, annotated with current FSRS recall
 *      and FIRe shaky-foundation flags);
 *   2. Active weak spots & overconfident misses (prioritizing spots overlapping
 *      the topic/neighborhood, then top global overconfident blind spots);
 *   3. Recurring practice `missClass` patterns (`cue`, `discrimination`,
 *      `execution`, `careless`, `structural`).
 *
 * Delivered as a collapsible `diagnostic-context` LhMarkerMessage (the
 * graph-context / review-context precedent) — zero extra LLM calls, omitted
 * completely when nothing relevant exists.
 */

import type { GraphChain, GraphNode } from "./contracts.ts";
import type { LhMarkerMessage } from "./native-messages.ts";
import { tokens } from "./briefing.ts";
import type { RetentionReport } from "./retention.ts";
import type { WeakSpotReport } from "./weak-spots.ts";

export const MISS_CLASSES = ["cue", "discrimination", "execution", "careless", "structural"] as const;
export type MissClass = (typeof MISS_CLASSES)[number];

const MISS_CLASS_SET = new Set<string>(MISS_CLASSES);

const MISS_CLASS_GUIDANCE: Record<MissClass, string> = {
	cue: "forgetting the trigger or formula to recall from memory",
	discrimination: "confusing similar concepts or when each applies",
	execution: "algebraic, procedural, or step-by-step execution slips",
	careless: "sign, reading, or careless slips despite knowing the idea",
	structural: "gaps in underlying derivation or conceptual structure",
};

/** One practice `conclude` miss classification extracted from a transcript. */
export interface MissClassEvent {
	missClass: MissClass;
	targets: string[];
	at: number;
}

export interface DiagnosticPrerequisite {
	id: string;
	name: string;
	statement: string;
	/** Predicted recall 0-1, or null if never tested yet. */
	retention: number | null;
	due: boolean;
	shakyFoundation?: string;
}

export interface DiagnosticWeakSpot {
	key: string;
	title: string;
	spot: "overconfident" | "shaky";
	retention: number;
	meanConfidence: number | null;
	accuracy: number | null;
	missedQuestion?: string;
}

export interface DiagnosticMissPattern {
	missClass: MissClass;
	count: number;
	guidance: string;
}

export interface DiagnosticContextData {
	prerequisites: DiagnosticPrerequisite[];
	weakSpots: DiagnosticWeakSpot[];
	missPatterns: DiagnosticMissPattern[];
}

export const MAX_DIAGNOSTIC_PREREQS = 6;
export const MAX_DIAGNOSTIC_WEAK_SPOTS = 5;
export const MAX_DIAGNOSTIC_MISS_PATTERNS = 3;
const MAX_PREREQ_DEPTH = 2;

/**
 * Extract non-null practice `conclude` `missClass` events from a chat's
 * message transcript (pure, mirrors recallEvents's problem→conclude scan).
 */
export function extractMissClasses(messages: readonly unknown[]): MissClassEvent[] {
	const okResults = new Set<string>();
	for (const m of messages) {
		const r = m as { role?: string; toolCallId?: string; isError?: boolean };
		if (r.role === "toolResult" && r.toolCallId && r.isError !== true) okResults.add(r.toolCallId);
	}
	const out: MissClassEvent[] = [];
	let activeTargets: string[] = [];
	for (const m of messages) {
		const msg = m as { role?: string; timestamp?: unknown; content?: unknown };
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const at = typeof msg.timestamp === "number" && Number.isFinite(msg.timestamp) ? msg.timestamp : 0;
		for (const b of msg.content as { type?: string; id?: string; name?: string; arguments?: unknown }[]) {
			if (b?.type !== "toolCall" || !b.id || !okResults.has(b.id)) continue;
			if (b.name === "problem") {
				const target = (b.arguments as { target?: unknown } | undefined)?.target;
				activeTargets = Array.isArray(target) ? target.filter((t): t is string => typeof t === "string") : [];
			} else if (b.name === "conclude") {
				const mc = (b.arguments as { missClass?: unknown } | undefined)?.missClass;
				if (typeof mc === "string" && MISS_CLASS_SET.has(mc)) {
					out.push({ missClass: mc as MissClass, targets: [...new Set(activeTargets)], at });
				}
				activeTargets = [];
			}
		}
	}
	return out;
}

function tokenOverlapCount(a: Set<string>, b: Set<string>): number {
	let n = 0;
	for (const t of a) if (b.has(t)) n++;
	return n;
}

/**
 * Build a concise, bounded diagnostic brief for a new session, or null when
 * no relevant prerequisites, weak spots, or recurring miss patterns exist.
 */
export function buildDiagnosticBrief(input: {
	topic: string;
	pickedIds?: readonly string[];
	nodes: readonly Pick<GraphNode, "id" | "name" | "statement" | "aliases">[];
	chains: readonly Pick<GraphChain, "premises" | "conclusion">[];
	retention: Pick<RetentionReport, "topics">;
	weakSpots: Pick<WeakSpotReport, "spots">;
	misses?: readonly MissClassEvent[];
}): DiagnosticContextData | null {
	const topicTokens = tokens(input.topic);
	const pickedSet = new Set(input.pickedIds ?? []);
	const nodeById = new Map(input.nodes.map((n) => [n.id, n]));
	const retByKey = new Map(input.retention.topics.map((t) => [t.key, t]));

	// 1. Seed graph nodes: live explicit picks + top token-matched nodes for the topic.
	const seedIds = new Set<string>([...pickedSet].filter((id) => nodeById.has(id)));
	if (topicTokens.size > 0) {
		const scored: { id: string; score: number }[] = [];
		for (const n of input.nodes) {
			if (seedIds.has(n.id)) continue;
			const nodeTokens = tokens(`${n.name} ${n.statement} ${(n.aliases ?? []).join(" ")}`);
			const score = tokenOverlapCount(topicTokens, nodeTokens);
			if (score > 0) scored.push({ id: n.id, score });
		}
		scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
		for (const s of scored.slice(0, 4)) seedIds.add(s.id);
	}

	// 2. Walk 1-2 hops of prerequisite premises (premises → conclusion) from seeds.
	const directPremises = new Map<string, Set<string>>();
	for (const c of input.chains) {
		if (!c.conclusion) continue;
		let set = directPremises.get(c.conclusion);
		if (!set) {
			set = new Set<string>();
			directPremises.set(c.conclusion, set);
		}
		for (const p of c.premises) if (p && p !== c.conclusion) set.add(p);
	}

	const neighborhood = new Set<string>(seedIds);
	const queue: [string, number][] = [...seedIds].map((id) => [id, 0]);
	while (queue.length > 0) {
		const [cur, depth] = queue.shift()!;
		if (depth >= MAX_PREREQ_DEPTH) continue;
		const prems = directPremises.get(cur);
		if (!prems) continue;
		for (const p of prems) {
			if (!nodeById.has(p) || neighborhood.has(p)) continue;
			neighborhood.add(p);
			queue.push([p, depth + 1]);
		}
	}

	// Rank neighborhood nodes: weakest / due / shaky-foundation first, then matched seeds.
	// Skip untested explicit picks since graph-context already hands them to the tutor.
	const prerequisites: DiagnosticPrerequisite[] = [...neighborhood]
		.flatMap((id) => {
			const node = nodeById.get(id);
			if (!node) return [];
			const ret = retByKey.get(`prop:${id}`);
			if (pickedSet.has(id) && !ret) return [];
			return [
				{
					id: node.id,
					name: node.name,
					statement: node.statement,
					retention: ret ? ret.retention : null,
					due: ret?.due ?? false,
					...(ret?.shakyPremises?.length ? { shakyFoundation: ret.shakyPremises[0]!.title } : {}),
				},
			];
		})
		.sort((a, b) => {
			if (a.due !== b.due) return a.due ? -1 : 1;
			const aR = a.retention ?? 2;
			const bR = b.retention ?? 2;
			if (aR !== bR) return aR - bR;
			if (Boolean(a.shakyFoundation) !== Boolean(b.shakyFoundation)) return a.shakyFoundation ? -1 : 1;
			return a.id.localeCompare(b.id);
		})
		.slice(0, MAX_DIAGNOSTIC_PREREQS);

	// 3. Active weak spots: prioritize topic/neighborhood overlap, then global overconfident misses.
	const relevantSpots: DiagnosticWeakSpot[] = [];
	const globalOverconfident: DiagnosticWeakSpot[] = [];
	for (const s of input.weakSpots.spots) {
		const isNeighbor = s.kind === "proposition" && neighborhood.has(s.key.slice(5));
		const isTokenMatch = topicTokens.size > 0 && tokenOverlapCount(topicTokens, tokens(`${s.title} ${s.chatTitle}`)) > 0;
		const item: DiagnosticWeakSpot = {
			key: s.key,
			title: s.title,
			spot: s.spot,
			retention: s.retention,
			meanConfidence: s.meanConfidence,
			accuracy: s.accuracy,
			...(s.missedQuestions[0] ? { missedQuestion: s.missedQuestions[0] } : {}),
		};
		if (isNeighbor || isTokenMatch) relevantSpots.push(item);
		else if (s.spot === "overconfident") globalOverconfident.push(item);
	}
	const weakSpots = [...relevantSpots, ...globalOverconfident].slice(0, MAX_DIAGNOSTIC_WEAK_SPOTS);

	// 4. Recurring practice missClass patterns.
	const counts = new Map<MissClass, number>();
	for (const m of input.misses ?? []) counts.set(m.missClass, (counts.get(m.missClass) ?? 0) + 1);
	const allPatterns: DiagnosticMissPattern[] = [...counts.entries()]
		.map(([missClass, count]) => ({ missClass, count, guidance: MISS_CLASS_GUIDANCE[missClass] }))
		.sort((a, b) => b.count - a.count || a.missClass.localeCompare(b.missClass));
	const recurring = allPatterns.filter((p) => p.count >= 2);
	const missPatterns = (recurring.length > 0 ? recurring : allPatterns.slice(0, 2)).slice(0, MAX_DIAGNOSTIC_MISS_PATTERNS);

	if (prerequisites.length === 0 && weakSpots.length === 0 && missPatterns.length === 0) return null;
	return { prerequisites, weakSpots, missPatterns };
}

/** Format a DiagnosticContextData as a model-facing LhMarkerMessage. */
export function newDiagnosticContextMessage(data: DiagnosticContextData, timestamp: number = Date.now()): LhMarkerMessage {
	const lines: string[] = [
		"[Diagnostic context — derived from the learner's knowledge graph, memory schedule, and practice history. Use this to target probing and explanations at real blind spots without mentioning this note.]",
	];
	if (data.prerequisites.length > 0) {
		lines.push("", "Prerequisite neighborhood:");
		for (const p of data.prerequisites) {
			const status =
				p.retention === null
					? "untested"
					: `${Math.round(p.retention * 100)}% recall${p.due ? ", due" : ""}`;
			const shaky = p.shakyFoundation ? `; shaky foundation: ${p.shakyFoundation}` : "";
			lines.push(`- ${p.name} (${status}${shaky}): ${p.statement}`);
		}
	}
	if (data.weakSpots.length > 0) {
		lines.push("", "Active weak spots & overconfident misses:");
		for (const w of data.weakSpots) {
			const meta =
				w.spot === "overconfident" && w.meanConfidence !== null && w.accuracy !== null
					? `overconfident: felt ${Math.round(w.meanConfidence)}%, got ${Math.round(w.accuracy)}%, ${Math.round(w.retention * 100)}% recall`
					: `shaky, ${Math.round(w.retention * 100)}% recall`;
			const missed = w.missedQuestion ? ` — recent miss: "${w.missedQuestion}"` : "";
			lines.push(`- ${w.title} (${meta})${missed}`);
		}
	}
	if (data.missPatterns.length > 0) {
		lines.push("", "Recurring practice miss patterns:");
		for (const m of data.missPatterns) {
			lines.push(`- ${m.missClass} (${m.count}×) — ${m.guidance}`);
		}
	}
	return {
		id: `dc_${timestamp.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
		role: "custom",
		customType: "diagnostic-context",
		content: lines.join("\n"),
		display: true,
		details: data,
		timestamp,
	};
}
