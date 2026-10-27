/**
 * WEAK SPOTS — the overconfidence report (src/core/weak-spots.ts) and its
 * view (components/weak-spots-view.tsx):
 *
 * - a topic answered wrong while sure (70%+) is an overconfident weak
 *   spot, and its reason names the confidence and the score; a miss at
 *   30% is an honest guess, so it reads as shaky;
 * - a topic whose last sitting was missed or shaky is a shaky weak spot,
 *   even without confidence data (practice);
 * - a topic only ever recalled cleanly is never listed, however faded;
 * - only the latest RECENT_ANSWERS rated answers count, so a fixed topic
 *   drops off;
 * - overconfident ranks first, then confident + forgotten; missed questions ride along
 *   for the drill (newest first, deduplicated);
 * - recall events carry the stated confidence and the question;
 * - the view renders the drill button, one row per spot, and the empty
 *   states.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { GRADE_AGAIN, GRADE_GOOD, GRADE_HARD, recallEvents, type RecallEvent, type RecallGrade } from "../src/core/retention.ts";
import { RECENT_ANSWERS, weakSpotHeadline, weakSpotReport } from "../src/core/weak-spots.ts";
import { newAnswerResult, type LhMessage } from "../src/core/native-messages.ts";
import { WeakSpotsView } from "../components/weak-spots-view.tsx";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";

/** The drill buttons call useRouter: give them a router to find. */
const render = (report: Parameters<typeof WeakSpotsView>[0]["report"]): string =>
	renderToStaticMarkup(
		<AppRouterContext.Provider value={{} as never}>
			<WeakSpotsView report={report} />
		</AppRouterContext.Provider>,
	);

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 1);

function ev(key: string, at: number, grade: RecallGrade, extra: Partial<RecallEvent> = {}): RecallEvent {
	return {
		topicKey: key,
		kind: key.startsWith("prop:") ? "proposition" : "plan",
		topicId: key.split(":").at(-1)!,
		title: key.split(":").at(-1)!,
		chatId: "c1",
		chatTitle: "Calculus",
		at,
		grade,
		...extra,
	};
}

describe("weakSpotReport", () => {
	it("lists a sure miss as overconfident, with a plain reason", () => {
		const events = [
			ev("plan:c1:chain", T0, GRADE_GOOD, { confidence: 90 }),
			ev("plan:c1:chain", T0 + 2 * DAY, GRADE_AGAIN, { confidence: 90, question: "d/dx sin(x²)?" }),
		];
		const report = weakSpotReport(events, T0 + 3 * DAY);
		assert.equal(report.spots.length, 1);
		const [spot] = report.spots;
		assert.equal(spot!.spot, "overconfident");
		assert.equal(spot!.meanConfidence, 90);
		assert.equal(spot!.accuracy, 50);
		assert.equal(spot!.gap, 40);
		assert.equal(spot!.sureMisses, 1);
		assert.deepEqual(spot!.missedQuestions, ["d/dx sin(x²)?"]);
		assert.match(spot!.reason, /90% sure on average but got 1 of 2 right, and missed once while at least 70% sure/);
		assert.equal(report.overconfident, 1);
	});

	it("lists a last-time miss or wobble as shaky, practice and honest guesses included", () => {
		const events = [
			ev("prop:p1", T0, GRADE_AGAIN),
			ev("plan:c1:limits", T0, GRADE_HARD, { confidence: 30 }),
			ev("plan:c1:guess", T0, GRADE_AGAIN, { confidence: 30 }),
		];
		const report = weakSpotReport(events, T0 + DAY);
		assert.deepEqual(
			report.spots.map((s) => [s.key, s.spot]).sort(),
			[
				["plan:c1:guess", "shaky"],
				["plan:c1:limits", "shaky"],
				["prop:p1", "shaky"],
			],
		);
		assert.match(report.spots.find((s) => s.key === "prop:p1")!.reason, /missed it the last time/);
		assert.match(report.spots.find((s) => s.key === "plan:c1:limits")!.reason, /only just/);
	});

	it("never lists a topic only ever recalled cleanly, however faded", () => {
		const report = weakSpotReport([ev("plan:c1:old", T0, GRADE_GOOD, { confidence: 90 })], T0 + 200 * DAY);
		assert.equal(report.tracked, 1);
		assert.equal(report.spots.length, 0);
		assert.match(weakSpotHeadline(report), /No weak spots/);
	});

	it("drops a topic once its latest answers are right and sure", () => {
		const events = [ev("plan:c1:chain", T0, GRADE_AGAIN, { confidence: 90 })];
		for (let i = 1; i <= RECENT_ANSWERS; i++) events.push(ev("plan:c1:chain", T0 + i * 2 * DAY, GRADE_GOOD, { confidence: 90 }));
		const report = weakSpotReport(events, T0 + (2 * RECENT_ANSWERS + 1) * DAY);
		assert.equal(report.spots.length, 0);
	});

	it("ranks overconfident and forgotten first, and keeps the newest distinct misses", () => {
		const events = [
			ev("plan:c1:shaky", T0 + 9 * DAY, GRADE_HARD, { confidence: 40 }),
			ev("plan:c1:sure", T0, GRADE_AGAIN, { confidence: 95, question: "old" }),
			ev("plan:c1:sure", T0 + 7 * DAY, GRADE_AGAIN, { confidence: 95, question: "newer" }),
			ev("plan:c1:sure", T0 + 8 * DAY, GRADE_AGAIN, { confidence: 95, question: "newer" }),
		];
		const report = weakSpotReport(events, T0 + 10 * DAY);
		assert.deepEqual(
			report.spots.map((s) => s.key),
			["plan:c1:sure", "plan:c1:shaky"],
		);
		assert.deepEqual(report.spots[0]!.missedQuestions, ["newer", "old"]);
		assert.match(weakSpotHeadline(report), /2 weak spots, and you felt surer than you were right on 1 of them/);
	});
});

describe("recallEvents carries confidence and question", () => {
	it("stamps a check answer with its stated confidence and question text", () => {
		const callMsg = {
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: "q1", name: "quiz", arguments: { type: "check", nodeId: "chain" } }],
			timestamp: T0,
		} as unknown as LhMessage;
		const answer = newAnswerResult("q1", "quiz", {
			kind: "quiz",
			questionText: "What is the chain rule?",
			dontKnow: false,
			answers: [],
			correct: false,
			confidence: 80,
			answeredAt: new Date(T0).toISOString(),
		});
		const dontKnow = newAnswerResult("q2", "quiz", {
			kind: "quiz",
			questionText: "Again?",
			dontKnow: true,
			answers: [],
			correct: false,
			confidence: 50,
			answeredAt: new Date(T0 + 1).toISOString(),
		});
		const call2 = { ...callMsg, id: "a2", content: [{ type: "toolCall", id: "q2", name: "quiz", arguments: { type: "check", nodeId: "chain" } }] } as unknown as LhMessage;
		const out = recallEvents({ id: "c1", title: "Calc", messages: [callMsg, answer, call2, dontKnow] });
		assert.equal(out[0]!.confidence, 80);
		assert.equal(out[0]!.question, "What is the chain rule?");
		assert.equal(out[1]!.confidence, undefined, "I don't know carries no confidence");
	});
});

describe("WeakSpotsView", () => {
	it("renders the drill button and one row per spot", () => {
		const report = weakSpotReport(
			[
				ev("plan:c1:chain", T0, GRADE_AGAIN, { confidence: 90, question: "d/dx sin(x²)?" }),
				ev("prop:p1", T0, GRADE_AGAIN),
			],
			T0 + DAY,
		);
		const html = render(report);
		assert.match(html, /data-testid="weak-spots-drill-button"/);
		assert.match(html, /Drill the worst 2/);
		assert.equal(html.match(/data-testid="weak-spot"/g)?.length, 2);
		assert.match(html, /data-spot="overconfident"/);
		assert.match(html, /Missed: d\/dx sin\(x²\)\?/);
	});

	it("renders the empty states", () => {
		assert.match(render(weakSpotReport([], T0)), /No tested topics yet/);
		const clean = render(weakSpotReport([ev("plan:c1:a", T0, GRADE_GOOD, { confidence: 90 })], T0));
		assert.match(clean, /Nothing to drill/);
		assert.doesNotMatch(clean, /weak-spots-drill-button/);
	});
});
