/**
 * DOCUMENT-FIRST LESSON SECTIONS (pure, zero-IO, browser-safe):
 * Groups teach-phase transcript messages into contiguous, collapsible textbook
 * chapter sections keyed to `PlanTree` nodes (in transcript order), attaches
 * each section's direct prerequisite nodes and derived statuses, and resolves
 * Knowledge Map `#message-<id>` deep-links to their enclosing section.
 */

import type { PlanNodeStatus, PlanTree } from "./contracts/plan.ts";
import type { QuestionAnswerData } from "./question-core.ts";
import { textPartMessageId } from "./session-navigation.ts";
import type { LhViewMessage, LhViewPart } from "./view.ts";

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

export interface SectionTrap {
	question: string;
	missedAnswer?: string;
	explanation?: string;
	overconfident?: boolean;
}

export interface DistilledSection {
	/** Message indices inside the section that contribute textbook exposition (prose or diagrams/artifacts). */
	expositionIndices: number[];
	/** Message indices inside the section that belong to the collapsible dialogue archive (user replies or Q&A checks). */
	archiveIndices: number[];
	userTurns: number;
	checkCount: number;
	passedChecks: number;
	traps: SectionTrap[];
}

export interface OpeningProbeSpan {
	startIndex: number;
	endIndex: number;
	count: number;
}

const QUESTION_PART_TYPES = new Set([
	"tool-quiz",
	"tool-explain",
	"tool-probe",
	"tool-review",
	"tool-ask_user_question",
]);

const EXPOSITION_DATA_TYPES = new Set([
	"data-diagram",
	"data-plan-block",
	"data-artifact",
]);

export function sectionAnchorId(nodeId: string): string {
	return `section-${nodeId}`;
}

export function isExpositionPart(part: LhViewPart): boolean {
	if (part.type === "text") {
		return typeof part.text === "string" && part.text.trim().length > 0;
	}
	return EXPOSITION_DATA_TYPES.has(part.type);
}

export function isQuestionToolPart(part: LhViewPart): boolean {
	return QUESTION_PART_TYPES.has(part.type) && part.state === "output-available";
}

function isNonDialogueMarker(message: LhViewMessage): boolean {
	if (message.role !== "user") return false;
	return message.parts.some(
		(p) =>
			p.type === "data-diagnostic-context" ||
			p.type === "data-graph-context" ||
			p.type === "data-phase-divider" ||
			p.type === "data-subagent-steer",
	);
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
 * Deterministically distill a chapter section into:
 * - textbook exposition messages (assistant prose + diagrams/artifacts)
 * - dialogue archive messages (user replies + answered Q&A cards)
 * - extracted "Watch out" traps from missed or overconfident checks
 */
export function distillLessonSection(
	section: LessonSection,
	messages: readonly LhViewMessage[],
): DistilledSection {
	const expositionIndices: number[] = [];
	const archiveIndices: number[] = [];
	const traps: SectionTrap[] = [];
	let userTurns = 0;
	let checkCount = 0;
	let passedChecks = 0;

	const last = Math.min(section.endIndex, messages.length - 1);
	for (let i = section.startIndex; i <= last; i++) {
		const m = messages[i]!;
		if (m.role === "user") {
			if (isNonDialogueMarker(m)) continue;
			userTurns++;
			archiveIndices.push(i);
			continue;
		}
		let hasExposition = false;
		let hasQuestion = false;
		for (const part of m.parts) {
			if (isExpositionPart(part)) hasExposition = true;
			if (isQuestionToolPart(part)) {
				hasQuestion = true;
				const answer = part.output as QuestionAnswerData | undefined;
				if (!answer || answer.dismissed) continue;
				if (answer.kind === "quiz" || answer.kind === "explain") {
					checkCount++;
					if (answer.kind === "quiz") {
						if (answer.correct && !answer.dontKnow) {
							passedChecks++;
						} else {
							const missedText = answer.dontKnow
								? "Didn't know"
								: answer.answers.map((a) => a.label).filter(Boolean).join(", ") || undefined;
							const overconfident =
								!answer.dontKnow && typeof answer.confidence === "number" && answer.confidence >= 4;
							const question = answer.questionText?.trim();
							if (question) {
								traps.push({
									question,
									...(missedText ? { missedAnswer: missedText } : {}),
									...(answer.explanation?.trim() ? { explanation: answer.explanation.trim() } : {}),
									...(overconfident ? { overconfident: true } : {}),
								});
							}
						}
					}
				}
			}
		}
		if (hasExposition) expositionIndices.push(i);
		if (hasQuestion) archiveIndices.push(i);
	}

	return {
		expositionIndices,
		archiveIndices,
		userTurns,
		checkCount,
		passedChecks,
		traps,
	};
}

/**
 * Returns the span of pre-section messages (opening probe & planning) before
 * the first chapter section, or null if there are none.
 */
export function openingProbeSpan(
	sections: readonly LessonSection[],
	messages: readonly LhViewMessage[],
): OpeningProbeSpan | null {
	if (sections.length === 0 || messages.length === 0) return null;
	const firstStart = sections[0]!.startIndex;
	if (firstStart <= 0) return null;
	let count = 0;
	for (let i = 0; i < firstStart && i < messages.length; i++) {
		if (!isNonDialogueMarker(messages[i]!)) count++;
	}
	if (count === 0) return null;
	return { startIndex: 0, endIndex: firstStart - 1, count };
}

/** Format a highlighted textbook passage into a cited blockquote for the composer. */
export function formatSectionQuote(
	section: Pick<LessonSection, "index" | "title">,
	selectedText: string,
): string {
	const cleaned = selectedText.replace(/\s+/g, " ").trim();
	if (!cleaned) return "";
	const clipped = cleaned.length > 500 ? `${cleaned.slice(0, 497)}…` : cleaned;
	return `> "${clipped}"\n> — § ${section.index} ${section.title}\n\n`;
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

