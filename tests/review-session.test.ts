/**
 * REVIEW SESSION START (src/server/review.ts) under an isolated
 * LH_DATA_DIR: a lesson whose check answer has decayed makes its plan
 * node due; starting a review opens a kind:"review" session whose first
 * message is the queue, the node's summary carried as the agent's
 * material. Nothing due → no session. A weak-spot drill opens on a sure
 * miss that is not even due yet, carrying the missed question.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-session-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { reviewStatus, startDrillSession, startReviewSession, startTopicsSession } = await import("../src/server/review.ts");
const { newAnswerResult } = await import("../src/core/native-messages.ts");
const { reviewTopicsOf } = await import("../src/core/review.ts");

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 25, 12);

describe("starting a review session", () => {
	it("opens nothing when nothing is tracked", () => {
		assert.equal(startReviewSession(NOW), null);
		assert.deepEqual(reviewStatus(NOW), { due: 0, nextSession: 0, reviewedToday: 0 });
	});

	it("queues a decayed lesson topic with its summary as material", () => {
		const lesson = chatStore.createChat("Derivatives");
		chatStore.saveTree(lesson.id, {
			nodes: [{ id: "chain-rule", title: "Chain rule", summary: "Differentiate a composition: outer slope times inner slope." }],
			edges: [],
			version: 1,
		});
		const callId = "call_quiz_1";
		chatStore.saveMessages(lesson.id, [
			{
				id: "m1",
				role: "assistant",
				content: [{ type: "toolCall", id: callId, name: "quiz", arguments: { type: "check", nodeId: "chain-rule", question: "q", options: [], explanation: "e", correctAnswer: "a" } }],
				timestamp: NOW - 40 * DAY,
			} as never,
			newAnswerResult(callId, "quiz", {
				kind: "quiz",
				questionText: "q",
				dontKnow: false,
				answers: [],
				correct: true,
				confidence: 90,
				answeredAt: new Date(NOW - 40 * DAY).toISOString(),
			}),
		]);

		assert.deepEqual(reviewStatus(NOW), { due: 1, nextSession: 1, reviewedToday: 0 });
		const started = startReviewSession(NOW);
		assert.ok(started, "a due topic opens a session");
		assert.equal(started.topics, 1);
		const record = chatStore.getChat(started.id)!;
		assert.equal(record.kind, "review");
		const [topic] = reviewTopicsOf(record.messages);
		assert.equal(topic!.key, `plan:${lesson.id}:chain-rule`);
		assert.equal(topic!.title, "Chain rule");
		assert.equal(topic!.summary, "Differentiate a composition: outer slope times inner slope.");
		assert.equal(topic!.sourceTitle, "Derivatives");
	});
});

describe("starting a weak-spot drill", () => {
	it("drills a sure miss that is not due, with the missed question as its target", () => {
		const lesson = chatStore.createChat("Limits");
		chatStore.saveTree(lesson.id, {
			nodes: [{ id: "squeeze", title: "Squeeze theorem", summary: "Bound a function between two with the same limit." }],
			edges: [],
			version: 1,
		});
		const at = NOW - 60 * 60 * 1000;
		chatStore.saveMessages(lesson.id, [
			{
				id: "m1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call_q", name: "quiz", arguments: { type: "check", nodeId: "squeeze" } }],
				timestamp: at,
			} as never,
			newAnswerResult("call_q", "quiz", {
				kind: "quiz",
				questionText: "Why does sin(x)/x tend to 1?",
				dontKnow: false,
				answers: [],
				correct: false,
				confidence: 90,
				answeredAt: new Date(at).toISOString(),
			}),
		]);
		const key = `plan:${lesson.id}:squeeze`;

		assert.equal(startDrillSession(["plan:nope:x"], NOW), null, "an unknown key drills nothing");
		const started = startDrillSession([key], NOW);
		assert.ok(started, "a sure miss opens a drill");
		assert.equal(started.title, "Drill · 1 weak spot");
		const record = chatStore.getChat(started.id)!;
		assert.equal(record.kind, "review");
		const [topic] = reviewTopicsOf(record.messages);
		assert.equal(topic!.key, key);
		assert.deepEqual(topic!.missed, ["Why does sin(x)/x tend to 1?"]);
		const marker = record.messages[0] as { content: string; details: { mode?: string } };
		assert.equal(marker.details.mode, "drill");
		assert.match(marker.content, /weak-spot drill/);
		assert.match(marker.content, /recently missed: "Why does sin\(x\)\/x tend to 1\?"/);
	});
});

describe("starting a review from a study-plan step", () => {
	it("reviews the step's tracked topics, due or not, titled after the step", () => {
		const lesson = chatStore.createChat("Vectors");
		chatStore.saveTree(lesson.id, {
			nodes: [{ id: "dot", title: "Dot product", summary: "Sum of componentwise products; |a||b|cos θ." }],
			edges: [],
			version: 1,
		});
		const at = NOW - 60 * 60 * 1000; // answered an hour ago: not due
		chatStore.saveMessages(lesson.id, [
			{
				id: "m1",
				role: "assistant",
				content: [{ type: "toolCall", id: "call_d", name: "quiz", arguments: { type: "check", nodeId: "dot" } }],
				timestamp: at,
			} as never,
			newAnswerResult("call_d", "quiz", {
				kind: "quiz",
				questionText: "q",
				dontKnow: false,
				answers: [],
				correct: true,
				confidence: 80,
				answeredAt: new Date(at).toISOString(),
			}),
		]);
		const key = `plan:${lesson.id}:dot`;

		assert.equal(startTopicsSession(["plan:nope:x"], "Check Vectors", undefined, NOW), null, "unknown topics open nothing");
		const started = startTopicsSession([key, "plan:nope:x"], "Check Vectors", undefined, NOW);
		assert.ok(started, "a tracked topic opens a review even when not due");
		assert.equal(started.title, "Check Vectors");
		assert.equal(started.topics, 1);
		const record = chatStore.getChat(started.id)!;
		assert.equal(record.kind, "review");
		assert.deepEqual(reviewTopicsOf(record.messages).map((t) => t.key), [key]);
		const marker = record.messages[0] as { content: string; details: { mode?: string } };
		assert.equal(marker.details.mode, "plan");
		assert.match(marker.content, /study plan/);
	});
});
