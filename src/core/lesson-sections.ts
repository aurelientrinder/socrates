/**
 * DOCUMENT-FIRST LESSON SECTIONS (pure, zero-IO, browser-safe):
 * Groups teach-phase transcript messages into contiguous, collapsible textbook
 * chapter sections keyed to `PlanTree` nodes (in transcript order), attaches
 * each section's direct prerequisite nodes and derived statuses, and resolves
 * Knowledge Map `#message-<id>` deep-links to their enclosing section.
 */

import type { PlanNodeStatus, PlanTree } from "./contracts/plan.ts";
import { textPartMessageId } from "./session-navigation.ts";
import type { LhViewMessage } from "./view.ts";

export interface SectionPrerequisite {
	id: string;
	title: string;
	status: PlanNodeStatus;
}

export interface LessonSection {
	nodeId: string;
	/** 1-based chapter section number in transcript order. */
	index: number;
	title: string;
	summary?: string;
	status: PlanNodeStatus;
	/** Inclusive message indices in `LhViewMessage[]`. */
	startIndex: number;
	endIndex: number;
	/** Direct prerequisite parents (`edge.from → nodeId`) from the plan DAG. */
	prerequisites: SectionPrerequisite[];
}

export function sectionAnchorId(nodeId: string): string {
	return `section-${nodeId}`;
}

function firstTaggedNodeId(message: LhViewMessage, validIds: ReadonlySet<string>): string | null {
	if (message.role !== "assistant") return null;
	for (const part of message.parts) {
		if (part.type !== "tool-quiz" && part.type !== "tool-explain") continue;
		const nodeId = (part.input as { nodeId?: unknown } | undefined)?.nodeId;
		if (typeof nodeId === "string" && validIds.has(nodeId)) return nodeId;
	}
	return null;
}

/**
 * Derive contiguous chapter sections over `messages` from `tree`.
 * Messages before the first tagged teach-phase message stay unsectioned
 * (probe & planning); once teaching starts, each distinct `nodeId` begins
 * a section that runs until the next new `nodeId` (or end of transcript).
 */
export function deriveLessonSections(
	messages: readonly LhViewMessage[],
	tree: PlanTree | null | undefined,
	statusOf: (nodeId: string) => PlanNodeStatus,
): LessonSection[] {
	if (!tree || tree.nodes.length === 0 || messages.length === 0) return [];
	const byId = new Map(tree.nodes.map((n) => [n.id, n]));
	const validIds = new Set(byId.keys());

	// Direct prerequisite parents per node.
	const parentsOf = new Map<string, string[]>();
	for (const edge of tree.edges) {
		if (!validIds.has(edge.from) || !validIds.has(edge.to) || edge.from === edge.to) continue;
		const list = parentsOf.get(edge.to) ?? [];
		if (!list.includes(edge.from)) list.push(edge.from);
		parentsOf.set(edge.to, list);
	}

	const starts: { nodeId: string; startIndex: number }[] = [];
	let activeNodeId: string | null = null;
	const seen = new Set<string>();

	for (let i = 0; i < messages.length; i++) {
		const tagged = firstTaggedNodeId(messages[i]!, validIds);
		if (!tagged || tagged === activeNodeId) continue;
		// Keep one canonical section per nodeId (re-checking an earlier node
		// stays in its ongoing/current flow without duplicating chapter headings).
		if (seen.has(tagged)) continue;
		seen.add(tagged);
		activeNodeId = tagged;
		starts.push({ nodeId: tagged, startIndex: i });
	}

	return starts.map((s, idx) => {
		const node = byId.get(s.nodeId)!;
		const endIndex = idx + 1 < starts.length ? starts[idx + 1]!.startIndex - 1 : messages.length - 1;
		const prerequisites: SectionPrerequisite[] = (parentsOf.get(s.nodeId) ?? []).map((pid) => ({
			id: pid,
			title: byId.get(pid)!.title,
			status: statusOf(pid),
		}));
		return {
			nodeId: s.nodeId,
			index: idx + 1,
			title: node.title,
			...(node.summary ? { summary: node.summary } : {}),
			status: statusOf(s.nodeId),
			startIndex: s.startIndex,
			endIndex,
			prerequisites,
		};
	});
}

/**
 * Find the `nodeId` of the chapter section containing `targetMessageId`
 * (either matching `message.id` or any text part's native source message ID),
 * or null if the message is outside all sections.
 */
export function sectionForMessage(
	sections: readonly LessonSection[],
	messages: readonly LhViewMessage[],
	targetMessageId: string,
): string | null {
	if (!targetMessageId || sections.length === 0) return null;
	for (const sec of sections) {
		for (let i = sec.startIndex; i <= sec.endIndex && i < messages.length; i++) {
			const m = messages[i]!;
			if (m.id === targetMessageId) return sec.nodeId;
			for (const p of m.parts) {
				if (p.type === "text" && textPartMessageId(p.id) === targetMessageId) return sec.nodeId;
			}
		}
	}
	return null;
}
