import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_FLOW_MINUTES,
	allocateFlowMinutes,
	buildStudyFlowPlan,
} from "../src/core/study-flow.ts";
import { GRADE_AGAIN, GRADE_GOOD, retentionReport, type RecallEvent } from "../src/core/retention.ts";
import { weakSpotReport } from "../src/core/weak-spots.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("adaptive study flow planner", () => {
	it("allocates stage budgets cleanly with and without warm-up", () => {
		const withWarmup = allocateFlowMinutes(25, true);
		assert.equal(withWarmup.warmupMinutes + withWarmup.learnMinutes + withWarmup.practiceMinutes, 25);
		assert.ok(withWarmup.warmupMinutes >= 3);
		assert.ok(withWarmup.learnMinutes > withWarmup.practiceMinutes);

		const noWarmup = allocateFlowMinutes(25, false);
		assert.equal(noWarmup.warmupMinutes, 0);
		assert.equal(noWarmup.learnMinutes + noWarmup.practiceMinutes, 25);
	});

	it("prioritizes Today's top briefing item (with noteId) and seeds Learn + Practice prompts", () => {
		const now = Date.UTC(2026, 10, 20, 9, 0);
		const events: RecallEvent[] = [
			{
				topicKey: "prop:n1",
				kind: "proposition",
				topicId: "n1",
				title: "Chain rule",
				chatId: "c1",
				chatTitle: "Calculus",
				at: now - 5 * DAY_MS,
				grade: GRADE_AGAIN,
				confidence: 90,
			},
		];
		const retention = retentionReport(events, now);
		const weakSpots = weakSpotReport(events, now);

		const plan = buildStudyFlowPlan({
			budgetMinutes: DEFAULT_FLOW_MINUTES,
			briefingItems: [
				{
					id: "item_1",
					action: "learn",
					title: "Start on Quantum Mechanics",
					reason: "Exam in 6 days.",
					minutes: 25,
					score: 1,
					topicKeys: [],
					topicTitles: ["Wavefunctions"],
					noteIds: ["src_qm1234567890"],
				},
			],
			retention,
			weakSpots,
			now,
		});

		assert.equal(plan.topic, "Wavefunctions");
		assert.equal(plan.noteId, "src_qm1234567890");
		assert.equal(plan.hasWarmup, true);
		assert.match(plan.learnPrompt, /Wavefunctions/);
		assert.match(plan.practicePrompt, /Wavefunctions/);
	});

	it("falls back to top weak spot, then open frontier when nothing is due", () => {
		const now = Date.UTC(2026, 10, 20, 9, 0);
		const freshEvents: RecallEvent[] = [
			{
				topicKey: "prop:n1",
				kind: "proposition",
				topicId: "n1",
				title: "Eigenvalues",
				chatId: "c1",
				chatTitle: "LA",
				at: now - 1000,
				grade: GRADE_GOOD,
			},
		];
		const emptyPlan = buildStudyFlowPlan({
			budgetMinutes: 15,
			briefingItems: [],
			retention: retentionReport(freshEvents, now),
			weakSpots: weakSpotReport(freshEvents, now),
			now,
		});
		assert.equal(emptyPlan.hasWarmup, false);
		assert.equal(emptyPlan.warmupMinutes, 0);
		assert.equal(emptyPlan.topic, "Next frontier topic");
		assert.equal(emptyPlan.learnMinutes + emptyPlan.practiceMinutes, 15);
	});
});
