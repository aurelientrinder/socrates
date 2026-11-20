/**
 * ADAPTIVE STUDY FLOW PLANNER (pure, zero-IO, browser-safe):
 * Builds a single cohesive 3-stage study block (Warm-up → Learn → Practice)
 * from Today's briefing, FSRS-6 retention, and weak-spot signals so the
 * learner never has to play traffic controller between modes.
 */

import type { BriefingItem } from "./briefing.ts";
import type { RetentionReport } from "./retention.ts";
import type { WeakSpotReport } from "./weak-spots.ts";

export const FLOW_DURATIONS = [15, 25, 45] as const;
export type FlowDuration = (typeof FLOW_DURATIONS)[number];
export const DEFAULT_FLOW_MINUTES: FlowDuration = 25;

export type FlowStage = "warmup" | "learn" | "practice" | "done";

export interface StudyFlowPlan {
	id: string;
	budgetMinutes: number;
	topic: string;
	/** Optional saved note id so Side-by-Side Source can open automatically. */
	noteId?: string;
	hasWarmup: boolean;
	warmupMinutes: number;
	learnMinutes: number;
	practiceMinutes: number;
	reason: string;
	learnPrompt: string;
	practicePrompt: string;
	createdAt: number;
}

export interface StudyFlowInput {
	budgetMinutes?: number;
	topicOverride?: string;
	briefingItems?: readonly BriefingItem[];
	retention: Pick<RetentionReport, "due" | "topics">;
	weakSpots: Pick<WeakSpotReport, "spots">;
	now?: number;
}

function clampBudget(minutes: number | undefined): number {
	if (typeof minutes !== "number" || !Number.isFinite(minutes)) return DEFAULT_FLOW_MINUTES;
	return Math.max(10, Math.min(90, Math.round(minutes)));
}

/** Allocate stage minutes cleanly inside `budgetMinutes`. */
export function allocateFlowMinutes(
	budgetMinutes: number,
	hasWarmup: boolean,
): { warmupMinutes: number; learnMinutes: number; practiceMinutes: number } {
	const warmupMinutes = hasWarmup ? Math.max(3, Math.min(6, Math.round(budgetMinutes * 0.16))) : 0;
	const remaining = Math.max(6, budgetMinutes - warmupMinutes);
	const learnMinutes = Math.max(4, Math.round(remaining * 0.62));
	const practiceMinutes = Math.max(2, remaining - learnMinutes);
	return { warmupMinutes, learnMinutes, practiceMinutes };
}

/** Build a deterministic 3-stage Study Flow plan for right now. */
export function buildStudyFlowPlan(input: StudyFlowInput): StudyFlowPlan {
	const now = input.now ?? Date.now();
	const budgetMinutes = clampBudget(input.budgetMinutes);
	const dueReviewable = input.retention.due.filter((t) => t.kind !== "card");
	const hasWarmup = dueReviewable.length > 0;
	const { warmupMinutes, learnMinutes, practiceMinutes } = allocateFlowMinutes(budgetMinutes, hasWarmup);

	const customTopic = input.topicOverride?.trim();
	const topItem = (input.briefingItems ?? [])[0];
	const topSpot = input.weakSpots.spots.find((s) => s.kind !== "card");
	const topDue = dueReviewable[0];

	let topic: string;
	let reason: string;
	let noteId: string | undefined;

	if (customTopic) {
		topic = customTopic;
		reason = `Focused ${budgetMinutes}-minute flow on ${customTopic}.`;
	} else if (topItem) {
		topic = topItem.topicTitles[0] ?? topItem.title.replace(/^(Review|Start on|Quick check:|Exam rehearsal:|Before [^:]+:)\s*/i, "");
		reason = topItem.reason || `Top priority on Today's plan: ${topItem.title}.`;
		noteId = topItem.noteIds?.[0];
	} else if (topSpot) {
		topic = topSpot.title;
		reason = topSpot.reason;
	} else if (topDue) {
		topic = topDue.title;
		reason = `Fading fastest (${Math.round(topDue.retention * 100)}% predicted recall).`;
	} else {
		topic = "Next frontier topic";
		reason = "Nothing is overdue — pick one concept to build deep understanding and lock it in.";
	}

	const learnPrompt =
		topic === "Next frontier topic"
			? `I have ${learnMinutes} minutes for the Learn stage of a ${budgetMinutes}-minute Study Flow. Ask me what I want to learn today, probe my edge, and teach one crisp chunk before I switch to practice.`
			: `Let's run the Learn stage (~${learnMinutes} min) of my ${budgetMinutes}-minute Study Flow on: ${topic}. Probe my edge first, then build understanding cleanly so I'm ready to practice it right after.`;

	const practicePrompt =
		topic === "Next frontier topic"
			? `Now I'm in the Practice lock-in stage (~${practiceMinutes} min) of my Study Flow. Give me 1–2 discrimination or composition problems on what I just studied, with no hints unless I ask.`
			: `Now I'm in the Practice lock-in stage (~${practiceMinutes} min) of my Study Flow on: ${topic}. Give me 1–2 discrimination or composition problems to lock this in from memory.`;

	return {
		id: `flow_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
		budgetMinutes,
		topic,
		...(noteId ? { noteId } : {}),
		hasWarmup,
		warmupMinutes,
		learnMinutes,
		practiceMinutes,
		reason,
		learnPrompt,
		practicePrompt,
		createdAt: now,
	};
}
