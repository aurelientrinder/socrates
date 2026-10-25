/**
 * RETENTION — knowledge decay and the review schedule (src/core/retention.ts)
 * and its view (components/review-view.tsx):
 *
 * - FSRS math: R(S) = 90%, success grows stability, a lapse collapses it;
 * - grades come from results, never from confidence alone (no Easy);
 * - teach checks count per plan node, predictions and probe quizzes do not;
 * - practice conclude outcomes grade their target propositions;
 * - answers close in time fold into one sitting;
 * - review answers carrying a topic key schedule that topic without
 *   renaming it or moving its home session;
 * - the report splits due / upcoming and the view renders both states.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import {
	FSRS_WEIGHTS,
	GRADE_AGAIN,
	GRADE_GOOD,
	GRADE_HARD,
	initialState,
	intervalDays,
	nextState,
	parseTopicKey,
	practiceGrade,
	propositionNames,
	quizGrade,
	recallEvents,
	retentionAt,
	retentionReport,
	retrievability,
	topicRetention,
	type RecallEvent,
} from "../src/core/retention.ts";
import { newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import { ReviewView } from "../components/review-view.tsx";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);

function quizAnswer(correct: boolean, at: number, extra: Partial<QuestionAnswerData> = {}): QuestionAnswerData {
	return {
		kind: "quiz",
		questionText: "q",
		dontKnow: false,
		answers: [],
		correct,
		confidence: 80,
		answeredAt: new Date(at).toISOString(),
		...extra,
	};
}

function call(id: string, name: string, args: unknown, timestamp = 0): LhMessage {
	return { id: `a-${id}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp } as never;
}

function result(id: string, name: string, timestamp = 0): LhMessage {
	return { id: `r-${id}`, role: "toolResult", toolCallId: id, toolName: name, content: [], isError: false, timestamp } as never;
}

const event = (at: number, grade: 1 | 2 | 3, extra: Partial<RecallEvent> = {}): RecallEvent => ({
	topicKey: "plan:c:n",
	kind: "plan",
	topicId: "n",
	title: "Node",
	chatId: "c",
	chatTitle: "C",
	at,
	grade,
	...extra,
});

describe("FSRS math", () => {
	it("stability is the 90% point and recall decays with time", () => {
		assert.ok(Math.abs(retrievability(10, 10) - 0.9) < 1e-9);
		assert.ok(Math.abs(intervalDays(10) - 10) < 1e-9);
		assert.equal(retrievability(0, 5), 1);
		assert.ok(retrievability(30, 5) < retrievability(10, 5));
	});

	it("first review uses the grade's initial stability", () => {
		assert.equal(initialState(GRADE_GOOD).stability, FSRS_WEIGHTS[2]);
		assert.equal(initialState(GRADE_AGAIN).stability, FSRS_WEIGHTS[0]);
		assert.ok(initialState(GRADE_AGAIN).difficulty > initialState(GRADE_GOOD).difficulty);
	});

	it("a timely success grows stability, Hard less than Good; a lapse collapses it", () => {
		const s = initialState(GRADE_GOOD);
		const good = nextState(s, GRADE_GOOD, s.stability);
		const hard = nextState(s, GRADE_HARD, s.stability);
		const again = nextState(s, GRADE_AGAIN, s.stability);
		assert.ok(good.stability > hard.stability && hard.stability > s.stability);
		assert.ok(again.stability < s.stability);
		assert.ok(again.difficulty > good.difficulty);
	});
});

describe("grading", () => {
	it("quiz: results decide, confidence can only lower", () => {
		assert.equal(quizGrade({ correct: true, dontKnow: false, confidence: 90 }), GRADE_GOOD);
		assert.equal(quizGrade({ correct: true, dontKnow: false, confidence: 30 }), GRADE_HARD);
		assert.equal(quizGrade({ correct: false, dontKnow: false, confidence: 100 }), GRADE_AGAIN);
		assert.equal(quizGrade({ correct: false, dontKnow: true }), GRADE_AGAIN);
	});

	it("practice outcomes", () => {
		assert.equal(practiceGrade("solved"), GRADE_GOOD);
		assert.equal(practiceGrade("solvedWithHints"), GRADE_HARD);
		assert.equal(practiceGrade("movedOn"), GRADE_AGAIN);
		assert.equal(practiceGrade("surrendered"), GRADE_AGAIN);
		assert.equal(practiceGrade("dismissed"), null);
	});
});

describe("recallEvents", () => {
	it("counts teach checks per plan node, skipping predictions and probe quizzes", () => {
		const record = {
			id: "c1",
			title: "Calculus",
			tree: { nodes: [{ id: "chain-rule", title: "Chain rule" }], edges: [], version: 1 },
			messages: [
				call("p", "quiz", { question: "probe" }),
				newAnswerResult("p", "quiz", quizAnswer(false, T0)),
				call("q1", "quiz", { type: "predict", nodeId: "chain-rule" }),
				newAnswerResult("q1", "quiz", quizAnswer(false, T0 + 1000)),
				call("q2", "quiz", { type: "check", nodeId: "chain-rule" }),
				newAnswerResult("q2", "quiz", quizAnswer(true, T0 + 2000)),
				call("q3", "quiz", { type: "check", nodeId: "chain-rule" }),
				newAnswerResult("q3", "quiz", { ...quizAnswer(false, T0 + 3000), dismissed: true }),
			],
		};
		const out = recallEvents(record);
		assert.deepEqual(
			out.map((e) => [e.topicKey, e.title, e.grade]),
			[["plan:c1:chain-rule", "Chain rule", GRADE_GOOD]],
		);
	});

	it("grades practice targets by their conclude outcome", () => {
		const record = {
			id: "c2",
			title: "Practice",
			messages: [
				call("pr1", "problem", { target: ["n_a", "n_b"] }, T0),
				result("pr1", "problem"),
				call("co1", "conclude", { outcome: "solvedWithHints" }, T0 + 5000),
				result("co1", "conclude"),
				call("pr2", "problem", {}, T0 + 6000),
				result("pr2", "problem"),
				call("co2", "conclude", { outcome: "surrendered" }, T0 + 7000),
				result("co2", "conclude"),
			],
		};
		const names = propositionNames([
			{ id: "n_a", name: "Product rule" },
			{ id: "n_a", name: "later line" },
		]);
		const out = recallEvents(record, (id) => names.get(id));
		assert.deepEqual(
			out.map((e) => [e.topicKey, e.title, e.grade, e.at]),
			[
				["prop:n_a", "Product rule", GRADE_HARD, T0 + 5000],
				["prop:n_b", "n_b", GRADE_HARD, T0 + 5000],
			],
		);
	});

	it("a review answer carrying a topic key counts toward that topic", () => {
		const record = {
			id: "rev",
			title: "Review",
			messages: [newAnswerResult("x", "quiz", { ...quizAnswer(true, T0), topicId: "plan:c1:chain-rule" })],
		};
		const [e] = recallEvents(record);
		assert.equal(e!.topicKey, "plan:c1:chain-rule");
		assert.equal(e!.topicId, "chain-rule");
		assert.equal(e!.review, true);
		assert.equal(parseTopicKey("prop:n_x")?.kind, "proposition");
		assert.equal(parseTopicKey("nonsense"), null);
	});
});

describe("topicRetention", () => {
	it("folds answers within a sitting: a wobble caps it at Hard, a final miss is a lapse", () => {
		const shaky = topicRetention([event(T0, GRADE_AGAIN), event(T0 + 60_000, GRADE_GOOD)], T0 + 60_000);
		assert.equal(shaky.reviews, 1);
		assert.equal(shaky.answers, 2);
		assert.equal(shaky.stability, FSRS_WEIGHTS[1]);
		const lapse = topicRetention([event(T0, GRADE_GOOD), event(T0 + 60_000, GRADE_AGAIN)], T0 + 60_000);
		assert.equal(lapse.lapses, 1);
		assert.equal(lapse.stability, FSRS_WEIGHTS[0]);
	});

	it("spaced successes push the due date out", () => {
		const once = topicRetention([event(T0, GRADE_GOOD)], T0);
		const twice = topicRetention([event(T0, GRADE_GOOD), event(T0 + 4 * DAY, GRADE_GOOD)], T0 + 4 * DAY);
		assert.ok(twice.dueAt - twice.lastReviewedAt > once.dueAt - once.lastReviewedAt);
		assert.ok(Math.abs(retentionAt(once, once.dueAt) - 0.9) < 1e-9);
	});

	it("review answers never rename the topic or move its home session", () => {
		const t = topicRetention(
			[event(T0, GRADE_GOOD), event(T0 + 3 * DAY, GRADE_GOOD, { title: "n", chatId: "rev", chatTitle: "Review", review: true })],
			T0 + 3 * DAY,
		);
		assert.equal(t.title, "Node");
		assert.equal(t.chatId, "c");
		assert.equal(t.reviews, 2);
	});
});

describe("retentionReport + view", () => {
	it("splits due (weakest first) from upcoming (soonest first)", () => {
		const now = T0 + 30 * DAY;
		const report = retentionReport(
			[
				event(T0, GRADE_GOOD, { topicKey: "a", title: "Old" }),
				event(T0 + 20 * DAY, GRADE_AGAIN, { topicKey: "b", title: "Missed" }),
				event(now - 1000, GRADE_GOOD, { topicKey: "c", title: "Fresh" }),
			],
			now,
		);
		assert.deepEqual(report.due.map((t) => t.title), ["Missed", "Old"]);
		assert.deepEqual(report.upcoming.map((t) => t.title), ["Fresh"]);
		assert.equal(report.topics.length, 3);
		assert.ok(report.due.every((t) => t.retention < 0.9));

		const html = renderToStaticMarkup(<ReviewView report={report} />);
		assert.match(html, /2 topics are fading and due for review/);
		assert.equal(html.match(/data-testid="review-due"/g)?.length, 2);
		assert.match(html, /href="\/chat\/c"/);
	});

	it("renders the empty state", () => {
		const html = renderToStaticMarkup(<ReviewView report={retentionReport([], T0)} />);
		assert.match(html, /No tested topics yet/);
	});
});
