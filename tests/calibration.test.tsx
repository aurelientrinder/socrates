/**
 * CALIBRATION — the cross-session confidence fold (src/core/calibration.ts)
 * and its view (components/calibration-view.tsx):
 *
 * - only graded quiz answers count (dismissals, asks, explains do not);
 * - "I don't know" carries no confidence: counted apart, never binned;
 * - bins snap to the slider's stops; the gap reads + as overconfident;
 * - confident misses (wrong at ≥70%) come newest first;
 * - the view leads with the verdict and renders the empty state.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import {
	calibrationAnswers,
	calibrationReport,
	calibrationVerdict,
	nearestStop,
	type CalibrationAnswer,
} from "../src/core/calibration.ts";
import { dismissedAnswer, type QuestionAnswerData } from "../src/core/question-core.ts";
import { newAnswerResult } from "../src/core/native-messages.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import { CalibrationView } from "../components/calibration-view.tsx";

let clock = 0;
function quiz(question: string, correct: boolean, confidence?: number, dontKnow = false): QuestionAnswerData {
	return {
		kind: "quiz",
		questionText: question,
		dontKnow,
		answers: [],
		correct,
		...(confidence !== undefined ? { confidence } : {}),
		answeredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, clock++)).toISOString(),
	};
}

function record(id: string, answers: unknown[]): { id: string; title: string; messages: LhMessage[] } {
	return {
		id,
		title: `Session ${id}`,
		messages: [
			{ id: "u1", role: "user", content: "teach me", timestamp: 1 } as never,
			...answers.map((a, i) => newAnswerResult(`call-${i}`, "quiz", a)),
		],
	};
}

const answer = (confidence: number | undefined, correct: boolean, extra: Partial<CalibrationAnswer> = {}): CalibrationAnswer => ({
	chatId: "c",
	chatTitle: "C",
	questionText: "q",
	confidence,
	correct,
	dontKnow: confidence === undefined,
	answeredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, clock++)).toISOString(),
	...extra,
});

describe("calibrationAnswers", () => {
	it("lifts only graded quiz answers out of a record", () => {
		const r = record("a", [
			quiz("2+2?", true, 90),
			dismissedAnswer("quiz", "skipped one"),
			{ kind: "ask", questionText: "what next?", dontKnow: false, answers: [], answeredAt: "2026-10-01T00:00:00Z" },
			quiz("capital?", false, undefined, true),
		]);
		const out = calibrationAnswers(r);
		assert.deepEqual(
			out.map((a) => [a.questionText, a.confidence, a.correct, a.dontKnow]),
			[
				["2+2?", 90, true, false],
				["capital?", undefined, false, true],
			],
		);
		assert.equal(out[0]!.chatTitle, "Session a");
	});
});

describe("calibrationReport", () => {
	it("bins by the nearest slider stop and measures the gap", () => {
		assert.equal(nearestStop(88), 90);
		assert.equal(nearestStop(62), 70);
		const report = calibrationReport([
			answer(90, true),
			answer(90, false),
			answer(90, false),
			answer(88, false),
			answer(50, true),
			answer(undefined, false),
		]);
		assert.equal(report.answered, 5);
		assert.equal(report.dontKnow, 1);
		const ninety = report.bins.find((b) => b.confidence === 90)!;
		assert.deepEqual([ninety.count, ninety.correct, ninety.accuracy], [4, 1, 25]);
		assert.equal(report.bins.find((b) => b.confidence === 0)!.accuracy, null);
		assert.equal(report.meanConfidence, 81.6);
		assert.equal(report.accuracy, 40);
		assert.equal(report.gap, 41.6);
		assert.match(calibrationVerdict(report), /^Overconfident by 42 points/);
	});

	it("lists confident misses newest first and skips low-confidence misses", () => {
		const old = answer(100, false, { questionText: "old" });
		const low = answer(30, false, { questionText: "low" });
		const recent = answer(70, false, { questionText: "recent" });
		const report = calibrationReport([old, low, recent, answer(90, true)]);
		assert.deepEqual(report.confidentMisses.map((a) => a.questionText), ["recent", "old"]);
	});

	it("groups per session, newest activity first", () => {
		const report = calibrationReport([
			answer(90, true, { chatId: "s1", chatTitle: "First" }),
			answer(50, false, { chatId: "s2", chatTitle: "Second" }),
			answer(70, true, { chatId: "s1", chatTitle: "First" }),
		]);
		assert.deepEqual(
			report.sessions.map((s) => [s.title, s.answered, s.meanConfidence, s.accuracy]),
			[
				["First", 2, 80, 100],
				["Second", 1, 50, 0],
			],
		);
	});

	it("reads well calibrated within five points, and empty as no data", () => {
		assert.match(calibrationVerdict(calibrationReport([answer(50, true), answer(50, false)])), /^Well calibrated/);
		assert.match(calibrationVerdict(calibrationReport([answer(30, true), answer(30, true)])), /^Underconfident by 70/);
		const empty = calibrationReport([]);
		assert.equal(empty.gap, null);
		assert.equal(calibrationVerdict(empty), "No rated quiz answers yet.");
	});
});

describe("CalibrationView", () => {
	it("leads with the verdict and lists the confident misses with session links", () => {
		const report = calibrationReport([
			answer(90, false, { chatId: "chat_1", chatTitle: "Derivatives", questionText: "d/dx sin x?" }),
			answer(90, true),
		]);
		const html = renderToStaticMarkup(<CalibrationView report={report} />);
		assert.match(html, /Overconfident by 40 points/);
		assert.match(html, /d\/dx sin x\?/);
		assert.match(html, /href="\/chat\/chat_1"/);
		assert.equal(html.match(/data-testid="calibration-bin"/g)?.length, 6);
	});

	it("renders the empty state without stats", () => {
		const html = renderToStaticMarkup(<CalibrationView report={calibrationReport([])} />);
		assert.match(html, /No rated quiz answers yet/);
		assert.doesNotMatch(html, /calibration-bin/);
	});
});
