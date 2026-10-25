/**
 * REVIEW SESSIONS — spaced-repetition review (src/core/review.ts, the
 * `review` tool, the answer stamp in input-events.ts):
 *
 * - the queue takes due topics only, weakest first, capped per session;
 * - the review-context marker round-trips and reaches the model as text;
 * - the tool rejects topics off the queue and second questions per topic;
 * - an answer to a review call is stamped with the CALL's topicId (a
 *   client-sent one is dropped), and the retention fold schedules it;
 * - the tally, the reminder gate, and the reviewer's prompt composition.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	newReviewContextMessage,
	pickReviewTopics,
	reminderText,
	REVIEW_SESSION_SIZE,
	reviewCallsOf,
	reviewTally,
	reviewTopicProblems,
	reviewTopicsOf,
	shouldRemind,
	type ReviewCandidate,
	type ReviewTopic,
} from "../src/core/review.ts";
import { inputAppends, withReviewTopic } from "../src/core/input-events.ts";
import { nativeInputCause, newAnswerResult, toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import { danglingQuestionOf } from "../src/core/native-messages.ts";
import { isQuestionTool } from "../src/core/input-events.ts";
import { toolQuestionKind } from "../src/core/pending.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import { GRADE_AGAIN, GRADE_GOOD, GRADE_HARD, recallEvents, retentionReport } from "../src/core/retention.ts";
import { reviewTool } from "../src/agent/tools/review.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

const DAY = 24 * 60 * 60 * 1000;

function candidate(key: string, retention: number, due = true, dueAt = 0): ReviewCandidate {
	return { key, kind: "proposition", title: key, chatId: "c", chatTitle: "C", retention, dueAt, due };
}

const TOPICS: ReviewTopic[] = [
	{ key: "prop:n_a", title: "Chain rule", summary: "d/dx f(g(x)) = f'(g(x)) g'(x)", sourceTitle: "Calculus", retention: 0.6 },
	{ key: "plan:chat_x:limits", title: "Limits", sourceTitle: "Calculus", retention: 0.8 },
];

let callSeq = 0;
function reviewCall(topicId: string): LhMessage {
	const id = `call_${++callSeq}`;
	return {
		id: `m_${id}`,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id,
				name: "review",
				arguments: {
					topicId,
					question: "q?",
					options: [{ label: "A", value: "a" }, { label: "B", value: "b" }],
					explanation: "because",
					correctAnswer: "a",
				},
			},
		],
		timestamp: 1,
	} as never;
}

function answer(correct: boolean, confidence?: number, extra: Partial<QuestionAnswerData> = {}): QuestionAnswerData {
	return {
		kind: "quiz",
		tool: "review",
		questionText: "q?",
		dontKnow: false,
		answers: [],
		correct,
		...(confidence !== undefined ? { confidence } : {}),
		answeredAt: new Date(Date.UTC(2026, 9, 25, 12)).toISOString(),
		...extra,
	};
}

function callIdOf(m: LhMessage): string {
	return ((m as { content: Array<{ id: string }> }).content[0]!).id;
}

describe("the review queue", () => {
	it("takes due topics only, weakest first, capped at the session size", () => {
		const picked = pickReviewTopics([
			candidate("prop:fresh", 0.95, false),
			candidate("prop:b", 0.7),
			candidate("prop:a", 0.5),
			candidate("prop:c", 0.7, true, -1),
			...Array.from({ length: 6 }, (_, i) => candidate(`prop:x${i}`, 0.85)),
		]);
		assert.equal(picked.length, REVIEW_SESSION_SIZE);
		assert.deepEqual(
			picked.slice(0, 3).map((t) => t.key),
			["prop:a", "prop:c", "prop:b"],
			"weakest first; equal retention breaks on the more overdue",
		);
		assert.ok(!picked.some((t) => t.key === "prop:fresh"));
	});

	it("is empty when nothing is due", () => {
		assert.deepEqual(pickReviewTopics([candidate("prop:a", 0.95, false)]), []);
	});
});

describe("the review-context marker", () => {
	it("round-trips its topics and lists every topicId for the model", () => {
		const marker = newReviewContextMessage(TOPICS);
		assert.deepEqual(reviewTopicsOf([marker as LhMessage]), TOPICS);
		const wire = toLlmMessages([marker as LhMessage]);
		const text = JSON.stringify(wire);
		assert.ok(text.includes("[prop:n_a] Chain rule"), "the model reads ids + titles");
		assert.ok(text.includes("[plan:chat_x:limits] Limits"));
		assert.equal(nativeInputCause(marker, []), "neutral", "scaffolding, never a learner input");
	});
});

describe("the review tool", () => {
	const marker = newReviewContextMessage(TOPICS) as LhMessage;

	it("is a question tool, quiz-shaped", () => {
		assert.ok(isQuestionTool("review"));
		assert.equal(toolQuestionKind("review"), "quiz");
	});

	it("rejects a topic off the queue, and a second question on one topic", () => {
		assert.deepEqual(reviewTopicProblems([marker], "prop:n_a"), []);
		assert.match(reviewTopicProblems([marker], "prop:nope")[0]!, /not on this session's review queue/);
		const asked = [marker, reviewCall("prop:n_a")];
		assert.match(reviewTopicProblems(asked, "prop:n_a")[0]!, /already reviewed/);
		assert.deepEqual(reviewTopicProblems(asked, "plan:chat_x:limits"), []);
	});

	it("a failed (error-result) call does not use up the topic", () => {
		const call = reviewCall("prop:n_a");
		const failed = { id: "r1", role: "toolResult", toolCallId: callIdOf(call), toolName: "review", content: [], isError: true, timestamp: 2 } as never;
		assert.deepEqual(reviewCallsOf([marker, call, failed]), []);
		assert.deepEqual(reviewTopicProblems([marker, call, failed], "prop:n_a"), []);
	});

	it("validates at the call boundary against the stored record", async () => {
		const tool = reviewTool({ chatId: "c", chatStore: { getChat: () => ({ messages: [marker] }) } });
		const base = { question: "q?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], explanation: "e", correctAnswer: "a" };
		const ok = await tool.execute("t1", { topicId: "prop:n_a", ...base });
		assert.equal((ok as { terminate?: boolean }).terminate, true, "a posed question ends the turn");
		const bad = await tool.execute("t2", { topicId: "prop:zzz", ...base });
		assert.match(JSON.stringify(bad.content), /not on this session's review queue/);
	});
});

describe("the answer stamp", () => {
	it("copies topicId from the persisted review call, never from the client", () => {
		const marker = newReviewContextMessage(TOPICS) as LhMessage;
		const call = reviewCall("prop:n_a");
		const record = { kind: "review", messages: [marker, call] };
		const [result] = inputAppends(record, {
			type: "answer",
			toolCallId: callIdOf(call),
			answer: answer(true, 90, { topicId: "prop:forged" }),
		});
		assert.equal(((result as { details?: unknown }).details as QuestionAnswerData).topicId, "prop:n_a");
	});

	it("strips a client topicId from every other tool's answer", () => {
		const stamped = withReviewTopic(answer(true, 90, { topicId: "prop:forged" }), { tool: "quiz", input: { topicId: "prop:x" } });
		assert.equal("topicId" in stamped, false);
	});

	it("feeds the retention fold: the review answer schedules its topic", () => {
		const marker = newReviewContextMessage(TOPICS) as LhMessage;
		const first = reviewCall("prop:n_a");
		const second = reviewCall("plan:chat_x:limits");
		const record = { kind: "review" as const, messages: [marker, first] as LhMessage[] };
		record.messages.push(...inputAppends(record, { type: "answer", toolCallId: callIdOf(first), answer: answer(true, 90) }));
		record.messages.push(second);
		record.messages.push(...inputAppends(record, { type: "answer", toolCallId: callIdOf(second), answer: answer(false, 80) }));
		assert.equal(danglingQuestionOf(record.messages), null);

		const events = recallEvents({ id: "chat_review", title: "Review", messages: record.messages });
		assert.deepEqual(
			events.map((e) => [e.topicKey, e.grade]),
			[
				["prop:n_a", GRADE_GOOD],
				["plan:chat_x:limits", GRADE_AGAIN],
			],
		);
		const now = Date.UTC(2026, 9, 25, 13);
		const report = retentionReport(events, now);
		const missed = report.topics.find((t) => t.key === "plan:chat_x:limits")!;
		const recalled = report.topics.find((t) => t.key === "prop:n_a")!;
		assert.ok(recalled.dueAt > missed.dueAt, "a recalled topic comes back later than a missed one");
		assert.ok(missed.dueAt - now < 2 * DAY, "a miss comes back within a couple of days");
	});
});

describe("the tally", () => {
	it("reads each topic's first answer: recalled, shaky (right but unsure), missed, skipped", () => {
		const topics: ReviewTopic[] = ["a", "b", "c", "d", "e"].map((k) => ({ key: `prop:${k}`, title: k, retention: 0.5 }));
		const messages: LhMessage[] = [newReviewContextMessage(topics) as LhMessage];
		const add = (key: string, a: QuestionAnswerData) => {
			const call = reviewCall(key);
			messages.push(call, newAnswerResult(callIdOf(call), "review", a));
		};
		add("prop:a", answer(true, 90));
		add("prop:b", answer(true, 30));
		add("prop:c", answer(false, 70));
		add("prop:d", answer(false, undefined, { dismissed: true }));
		const tally = reviewTally(messages);
		assert.deepEqual(
			{ total: tally.total, done: tally.done, recalled: tally.recalled, shaky: tally.shaky, missed: tally.missed, skipped: tally.skipped },
			{ total: 5, done: 4, recalled: 1, shaky: 1, missed: 1, skipped: 1 },
		);
		assert.equal(tally.outcomes["prop:e"], undefined);
	});

	it("shaky matches the retention fold's Hard grade", () => {
		const call = reviewCall("prop:n_a");
		const messages = [newReviewContextMessage(TOPICS) as LhMessage, call, newAnswerResult(callIdOf(call), "review", answer(true, 30, { topicId: "prop:n_a" }))];
		assert.equal(reviewTally(messages).outcomes["prop:n_a"], "shaky");
		assert.equal(recallEvents({ id: "r", title: "R", messages })[0]!.grade, GRADE_HARD);
	});
});

describe("the daily reminder", () => {
	it("fires once a day, only when opted in and something is due", () => {
		const today = "2026-10-25";
		assert.equal(shouldRemind({ enabled: true, due: 3, remindedDay: null, today }), true);
		assert.equal(shouldRemind({ enabled: true, due: 3, remindedDay: today, today }), false);
		assert.equal(shouldRemind({ enabled: false, due: 3, remindedDay: null, today }), false);
		assert.equal(shouldRemind({ enabled: true, due: 0, remindedDay: null, today }), false);
	});

	it("names the backlog and the session's length", () => {
		assert.deepEqual(reminderText(12), { title: "12 topics are due for review", body: "A 5-question review takes about 5 minutes." });
		assert.deepEqual(reminderText(1), { title: "1 topic is due for review", body: "A 1-question review takes about 1 minute." });
	});
});

describe("the reviewer's prompt", () => {
	it("composes its own base + doctrine and the confidence chunk, not the teaching base", () => {
		const prompt = composeInstructions("review");
		assert.match(prompt, /running a spaced-repetition review/);
		assert.match(prompt, /retrieval, not recognition/);
		assert.match(prompt, /Confidence — reading the learner's self-assessment/);
		assert.doesNotMatch(prompt, /`ask_user_question`/, "the reviewer holds no ask tool");
		assert.doesNotMatch(prompt, /The philosophy — why this system exists/);
	});
});
