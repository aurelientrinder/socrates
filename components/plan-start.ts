"use client";

import { quickPrompt, startPrompt, type BriefingItem } from "@/src/core";
import { startDraftSession } from "@/components/new-session";
import { REVIEW_START_PROMPT } from "@/components/review-start";
import { QUICK_SESSION_MINUTES, setSessionBudget } from "@/components/session-timer";

/**
 * Starting a plan step (QoL pass, 2026-11-08): one implementation shared by
 * Today's Start buttons and the sidebar's Start button, so both open the
 * same session and both tick the step off.
 */

/** Steps that are recall on topics already studied. */
export function isRecallStep(item: BriefingItem): boolean {
	return (item.action === "check" || item.action === "review" || item.action === "prep") && item.topicKeys.length > 0;
}

/** Topics in a five-minute review ("Only 5 minutes" on a recall step). */
const QUICK_REVIEW_TOPICS = 3;

/** Open a review session on a plan step's topics; null when the server
 *  has none of them (the caller falls back to a learn session). */
async function startStepReview(item: BriefingItem, limit?: number): Promise<string | null> {
	const res = await fetch("/api/review/start", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ keys: item.topicKeys, title: item.title, ...(limit ? { limit } : {}) }),
	});
	if (!res.ok) return null;
	const { id } = (await res.json()) as { id?: string };
	return id ? `/chat/${id}?prompt=${encodeURIComponent(REVIEW_START_PROMPT)}` : null;
}

/** Tell the server which session a plan step started, so Today can tick
 *  it off once the session has had its time. Best effort. */
function noteStarted(id: string, target: string): void {
	const chatId = /^\/chat\/([^/?#]+)/.exec(target)?.[1];
	if (!chatId) return;
	void fetch("/api/briefing/started", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id, chatId }),
	}).catch(() => undefined);
}

/** Create the session for a plan step and return where to go (null = nothing
 *  started). `quick` is "Only 5 minutes". */
export async function startPlanStep(item: BriefingItem, quick = false): Promise<string | null> {
	const recall = isRecallStep(item);
	let target: string | null;
	if (quick) {
		// Five minutes of a recall step: the same review, three topics.
		// Otherwise the step's title names the session and turn 1 carries
		// the five-minute scope.
		target =
			(recall ? await startStepReview(item, QUICK_REVIEW_TOPICS) : null) ??
			(await startDraftSession(item.title, fetch, undefined, undefined, quickPrompt(item), { warmup: false }));
	} else {
		// A check, review or class prep on known topics is a real review
		// session, so the answers move the review schedule. Without topics it
		// falls back to a learn session, with no warm-up: it is recall already.
		target =
			(recall ? await startStepReview(item) : null) ??
			(await startDraftSession(startPrompt(item), fetch, undefined, undefined, undefined, recall ? { warmup: false } : undefined));
	}
	if (target) {
		setSessionBudget(target, quick ? QUICK_SESSION_MINUTES : item.minutes);
		noteStarted(item.id, target);
	}
	return target;
}
