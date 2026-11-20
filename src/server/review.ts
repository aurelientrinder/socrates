import { orderPrerequisitesFirst, parseTopicKey, withPrerequisiteRepairs } from "../core/retention.ts";
import { getGraph } from "../core/graph.ts";
import {
	newReviewContextMessage,
	newWarmupContextMessage,
	pickReviewTopics,
	reviewResults,
	REVIEW_SESSION_SIZE,
	WARMUP_SIZE,
	type ReviewMode,
	type ReviewStatus,
	type ReviewTopic,
} from "../core/review.ts";
import type { LhMarkerMessage } from "../core/native-messages.ts";
import type { TopicRetention } from "../core/retention.ts";
import { assignReviewFormats, composeSource, planNodeTeaching } from "../core/recall-review.ts";
import type { GraphNode } from "../core/contracts.ts";
import { readSettings as readSettingsRecord } from "../store/settings.ts";
import { createChat, getChat, listChats, retentionAcrossSessions, weakSpotsAcrossSessions } from "./chats.ts";
import { stores } from "./stores.ts";

/**
 * REVIEW SESSIONS (spaced repetition), the server side: build today's
 * queue from the retention fold and open a kind:"review" session on it.
 * The session's first message is the review-context marker — the queue
 * the agent quizzes and the review tool validates against.
 */

/** What a topic covers, for the agent to write its question from (the
 *  plan node's summary from its own session, or the proposition's
 *  statement from the graph), and the fuller SOURCE a free-recall answer
 *  is marked against: what the learner was actually taught — the plan
 *  node's teaching read back out of its session, or the proposition's
 *  statement with the phrasings sessions used for it. */
function topicMaterial(
	topic: Pick<TopicRetention, "key">,
	nodes: ReadonlyMap<string, GraphNode>,
): { summary?: string; source?: string } {
	const parsed = parseTopicKey(topic.key);
	if (!parsed) return {};
	if (parsed.kind === "proposition") {
		const node = nodes.get(parsed.topicId);
		if (!node) return {};
		return { summary: node.statement, source: composeSource([node.statement, ...node.aliases]) };
	}
	const chatId = /^plan:([^:]+):/.exec(topic.key)?.[1];
	const chat = chatId ? getChat(chatId) : null;
	const node = chat?.tree?.nodes.find((n) => n.id === parsed.topicId);
	const teaching = chat ? planNodeTeaching(chat.messages, parsed.topicId) : "";
	return { summary: node?.summary, source: composeSource([node?.summary, teaching]) };
}

/** The queue one review session would take right now, weakest first,
 *  ordered prerequisites-before-conclusions. Unlinked flashcards stay
 *  in the fast-flip Cards UI. */
export function reviewQueue(now: number = Date.now(), limit: number = REVIEW_SESSION_SIZE): ReviewTopic[] {
	const due = retentionAcrossSessions(now).due.filter(
		(t): t is TopicRetention & { kind: "plan" | "proposition" } => t.kind !== "card",
	);
	const chains = getGraph(stores.graphStore).chains;
	return toReviewTopics(orderPrerequisitesFirst(pickReviewTopics(due, limit), chains));
}

/** The queue a weak-spot drill would take: the asked topics that are
 *  still weak spots, in the report's order (worst first), capped like a
 *  review. Broken/shaky ancestor premises are automatically pulled ahead
 *  of conclusions built on them so root causes are repaired first. */
export function drillQueue(keys: readonly string[] | undefined, now: number = Date.now(), limit: number = REVIEW_SESSION_SIZE): ReviewTopic[] {
	const spots = weakSpotsAcrossSessions(now).spots.filter((s) => s.kind !== "card");
	const asked = keys ? new Set(keys) : null;
	const picked = spots.filter((s) => !asked || asked.has(s.key)).slice(0, Math.max(0, limit));
	const allTracked = retentionAcrossSessions(now).topics.filter((t) => t.kind !== "card");
	const chains = getGraph(stores.graphStore).chains;
	const ordered = withPrerequisiteRepairs<TopicRetention>(picked, allTracked, chains, limit);
	const missed = new Map(spots.map((s) => [s.key, s.missedQuestions]));
	return toReviewTopics(ordered).map((t) => (missed.get(t.key)?.length ? { ...t, missed: missed.get(t.key) } : t));
}

/** The queue for a study-plan step (Today's Review, Check and Prep):
 *  the asked topics that are tracked, weakest first, ordered prerequisites
 *  before conclusions, due or not, capped like a review. */
export function topicsQueue(keys: readonly string[], now: number = Date.now(), limit: number = REVIEW_SESSION_SIZE): ReviewTopic[] {
	const asked = new Set(keys);
	const chains = getGraph(stores.graphStore).chains;
	const picked = retentionAcrossSessions(now)
		.topics.filter((t) => t.kind !== "card" && asked.has(t.key))
		.slice(0, Math.max(0, limit));
	return toReviewTopics(orderPrerequisitesFirst(picked, chains));
}

function toReviewTopics(picked: readonly TopicRetention[]): ReviewTopic[] {
	if (picked.length === 0) return [];
	const nodes = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
	const topics = picked.map((t) => {
		const { summary, source } = topicMaterial(t, nodes);
		return {
			key: t.key,
			title: t.title,
			...(summary ? { summary } : {}),
			...(source ? { source } : {}),
			sourceTitle: t.chatTitle,
			retention: t.retention,
		};
	});
	// Only recall topics carry their source into the session: it is the
	// marking ground, and the marker rides every turn's context.
	return assignReviewFormats(topics).map(({ source, ...t }) => (t.format === "recall" ? { ...t, source } : t));
}

function startOfLocalDay(now: number): number {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

export function reviewStatus(now: number = Date.now()): ReviewStatus {
	const due = retentionAcrossSessions(now).due.filter((t) => t.kind !== "card").length;
	const dayStart = startOfLocalDay(now);
	let reviewedToday = 0;
	// Any session kind: a learn or practice session's warm-up answers are
	// reviews too.
	for (const summary of listChats()) {
		if (Date.parse(summary.updatedAt) < dayStart) continue;
		const record = getChat(summary.id);
		if (!record) continue;
		reviewedToday += reviewResults(record.messages).filter((r) => r.outcome !== "skipped" && r.at >= dayStart).length;
	}
	return { due, nextSession: Math.min(due, REVIEW_SESSION_SIZE), reviewedToday };
}

/** Open a review session on the current queue; null when nothing is due.
 *  The session is stamped with the strong model slot, exactly like a
 *  session created from the home screen (POST /api/chats). */
export function startReviewSession(now: number = Date.now()): { id: string; title: string; topics: number } | null {
	const topics = reviewQueue(now);
	if (topics.length === 0) return null;
	return openReviewSession(`Review · ${topics.length} ${topics.length === 1 ? "topic" : "topics"}`, topics, "review");
}

/** Open a weak-spot drill (a review session on weak spots, due or not);
 *  null when none of the asked topics is a weak spot any more. */
export function startDrillSession(keys?: readonly string[], now: number = Date.now()): { id: string; title: string; topics: number } | null {
	const topics = drillQueue(keys, now);
	if (topics.length === 0) return null;
	return openReviewSession(`Drill · ${topics.length} weak ${topics.length === 1 ? "spot" : "spots"}`, topics, "drill");
}

/** Open a review session on a study-plan step's topics, titled after the
 *  step; null when none of them is tracked any more. */
export function startTopicsSession(
	keys: readonly string[],
	title?: string,
	limit: number = REVIEW_SESSION_SIZE,
	now: number = Date.now(),
): { id: string; title: string; topics: number } | null {
	const topics = topicsQueue(keys, now, limit);
	if (topics.length === 0) return null;
	return openReviewSession(title?.trim() || `Review · ${topics.length} ${topics.length === 1 ? "topic" : "topics"}`, topics, "plan");
}

function openReviewSession(title: string, topics: ReviewTopic[], mode: ReviewMode): { id: string; title: string; topics: number } {
	const chat = createChat(title, "review");
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	stores.chatStore.saveMessages(chat.id, [newReviewContextMessage(topics, mode)]);
	return { id: chat.id, title: chat.title, topics: topics.length };
}

/** A new learn or practice session's warm-up: the WARMUP_SIZE weakest due
 *  topics, all multiple choice, as a warm-up review-context marker; null when nothing is due
 *  (no warm-up — the memory model says every tested topic still holds). */
export function warmupContextMessage(now: number = Date.now()): LhMarkerMessage | null {
	// Multiple choice only: a warm-up is a minute of quick questions, so
	// free recall (and its marking step) stays in review sessions.
	const topics = reviewQueue(now, WARMUP_SIZE).map(({ format: _format, source: _source, ...t }) => t);
	return topics.length > 0 ? newWarmupContextMessage(topics) : null;
}
