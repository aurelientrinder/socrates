/**
 * REVIEW SESSION START (src/server/review.ts) under an isolated
 * LH_DATA_DIR: a lesson whose check answer has decayed makes its plan
 * node due; starting a review opens a kind:"review" session whose first
 * message is the queue, the node's summary carried as the agent's
 * material. Nothing due → no session.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-review-session-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { reviewStatus, startReviewSession } = await import("../src/server/review.ts");
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
