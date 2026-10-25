import { parseTopicKey } from "../core/retention.ts";
import { newReviewContextMessage, pickReviewTopics, REVIEW_SESSION_SIZE, type ReviewStatus, type ReviewTopic } from "../core/review.ts";
import type { TopicRetention } from "../core/retention.ts";
import type { GraphNode } from "../core/contracts.ts";
import { readSettings as readSettingsRecord } from "../store/settings.ts";
import { createChat, getChat, listChats, retentionAcrossSessions } from "./chats.ts";
import { stores } from "./stores.ts";

/**
 * REVIEW SESSIONS (spaced repetition), the server side: build today's
 * queue from the retention fold and open a kind:"review" session on it.
 * The session's first message is the review-context marker — the queue
 * the agent quizzes and the review tool validates against.
 */

/** What a topic covers, for the agent to write its question from: the
 *  plan node's summary from its own session, or the proposition's
 *  statement from the graph. */
function topicSummary(topic: Pick<TopicRetention, "key">, nodes: ReadonlyMap<string, GraphNode>): string | undefined {
	const parsed = parseTopicKey(topic.key);
	if (!parsed) return undefined;
	if (parsed.kind === "proposition") return nodes.get(parsed.topicId)?.statement;
	const chatId = /^plan:([^:]+):/.exec(topic.key)?.[1];
	const node = chatId ? getChat(chatId)?.tree?.nodes.find((n) => n.id === parsed.topicId) : undefined;
	return node?.summary;
}

/** The queue one review session would take right now, weakest first. */
export function reviewQueue(now: number = Date.now(), limit: number = REVIEW_SESSION_SIZE): ReviewTopic[] {
	const picked = pickReviewTopics(retentionAcrossSessions(now).due, limit);
	if (picked.length === 0) return [];
	const nodes = new Map(stores.graphStore.readNodes().map((n) => [n.id, n]));
	return picked.map((t) => {
		const summary = topicSummary(t, nodes);
		return {
			key: t.key,
			title: t.title,
			...(summary ? { summary } : {}),
			sourceTitle: t.chatTitle,
			retention: t.retention,
		};
	});
}

function startOfLocalDay(now: number): number {
	const d = new Date(now);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

export function reviewStatus(now: number = Date.now()): ReviewStatus {
	const due = retentionAcrossSessions(now).due.length;
	const dayStart = startOfLocalDay(now);
	let reviewedToday = 0;
	for (const summary of listChats()) {
		if (summary.kind !== "review" || Date.parse(summary.updatedAt) < dayStart) continue;
		const record = getChat(summary.id);
		if (!record) continue;
		for (const m of record.messages) {
			const details = (m as { role?: string; details?: { topicId?: unknown; answeredAt?: unknown; dismissed?: boolean } }).details;
			if ((m as { role?: string }).role !== "toolResult" || !details || typeof details.topicId !== "string" || details.dismissed) continue;
			if (typeof details.answeredAt === "string" && Date.parse(details.answeredAt) >= dayStart) reviewedToday++;
		}
	}
	return { due, nextSession: Math.min(due, REVIEW_SESSION_SIZE), reviewedToday };
}

/** Open a review session on the current queue; null when nothing is due.
 *  The session is stamped with the strong model slot, exactly like a
 *  session created from the home screen (POST /api/chats). */
export function startReviewSession(now: number = Date.now()): { id: string; title: string; topics: number } | null {
	const topics = reviewQueue(now);
	if (topics.length === 0) return null;
	const chat = createChat(`Review · ${topics.length} ${topics.length === 1 ? "topic" : "topics"}`, "review");
	const strong = readSettingsRecord()?.models?.strong;
	if (strong?.model) {
		stores.chatStore.saveSettings(chat.id, {
			model: { provider: strong.model.provider, id: strong.model.id },
			thinkingLevel: strong.thinkingLevel,
		});
	}
	stores.chatStore.saveMessages(chat.id, [newReviewContextMessage(topics)]);
	return { id: chat.id, title: chat.title, topics: topics.length };
}
