import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	FSRS_WEIGHTS,
	FSRS_WEIGHT_COUNT,
	GRADE_AGAIN,
	GRADE_GOOD,
	GRADE_HARD,
	initialState,
	intervalDays,
	nextState,
	retrievability,
	type RecallEvent,
} from "../src/core/retention.ts";
import {
	FSRS_MIN_REVIEWS,
	countFitReviews,
	evaluateFsrs,
	fitFsrsWeights,
	isValidFsrsWeights,
} from "../src/core/fsrs-fit.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("FSRS-6 math & personal weight fitting", () => {
	it("uses 21 FSRS-6 weights and preserves R(S) = 0.9 across custom w[20] decays", () => {
		assert.equal(FSRS_WEIGHTS.length, FSRS_WEIGHT_COUNT);
		assert.equal(isValidFsrsWeights([...FSRS_WEIGHTS]), true);

		for (const decay of [0.1542, 0.35, 0.5]) {
			const w = [...FSRS_WEIGHTS];
			w[20] = decay;
			assert.ok(Math.abs(retrievability(12, 12, w) - 0.9) < 1e-9);
			assert.ok(Math.abs(intervalDays(12, 0.9, w) - 12) < 1e-9);
		}
	});

	it("models same-day short-term stability without shrinking Good or growing Again", () => {
		const s = initialState(GRADE_GOOD);
		const sameDayGood = nextState(s, GRADE_GOOD, 0.25);
		const sameDayAgain = nextState(s, GRADE_AGAIN, 0.25);
		assert.ok(sameDayGood.stability >= s.stability, "same-day Good never shrinks stability");
		assert.ok(sameDayAgain.stability <= s.stability, "same-day Again never grows stability");
		assert.ok(sameDayAgain.difficulty > sameDayGood.difficulty);
	});

	it("refuses to fit under FSRS_MIN_REVIEWS and counts only follow-up sittings", () => {
		const t0 = Date.UTC(2026, 10, 1);
		const events: RecallEvent[] = [
			{ topicKey: "prop:a", kind: "proposition", topicId: "a", title: "A", chatId: "c1", chatTitle: "C1", at: t0, grade: GRADE_GOOD },
			{ topicKey: "prop:a", kind: "proposition", topicId: "a", title: "A", chatId: "c1", chatTitle: "C1", at: t0 + 2 * DAY_MS, grade: GRADE_GOOD },
			// Single-sitting topic contributes 0 follow-up reviews
			{ topicKey: "prop:b", kind: "proposition", topicId: "b", title: "B", chatId: "c1", chatTitle: "C1", at: t0, grade: GRADE_GOOD },
		];
		assert.equal(countFitReviews(events), 1);
		assert.equal(fitFsrsWeights(events), null);
		assert.equal(FSRS_MIN_REVIEWS, 100);
	});

	it("fits personal FSRS-6 weights to a fast-forgetting history and lowers log-loss within bounds", () => {
		const t0 = Date.UTC(2026, 10, 1);
		const events: RecallEvent[] = [];
		// 60 topics × 2 follow-up reviews = 120 follow-up observations where the
		// learner consistently forgets after 3 days (much faster than FSRS-6 defaults).
		for (let i = 0; i < 60; i++) {
			const key = `prop:n_${i}`;
			const base = t0 + i * DAY_MS;
			events.push(
				{ topicKey: key, kind: "proposition", topicId: `n_${i}`, title: `T${i}`, chatId: "c1", chatTitle: "C", at: base, grade: GRADE_GOOD },
				{
					topicKey: key,
					kind: "proposition",
					topicId: `n_${i}`,
					title: `T${i}`,
					chatId: "c1",
					chatTitle: "C",
					at: base + 3 * DAY_MS,
					grade: i % 5 === 0 ? GRADE_HARD : GRADE_AGAIN,
				},
				{
					topicKey: key,
					kind: "proposition",
					topicId: `n_${i}`,
					title: `T${i}`,
					chatId: "c1",
					chatTitle: "C",
					at: base + 6 * DAY_MS,
					grade: i % 4 === 0 ? GRADE_GOOD : GRADE_AGAIN,
				},
			);
		}

		const baseline = evaluateFsrs(events, FSRS_WEIGHTS);
		assert.equal(baseline.reviews, 120);

		const fit = fitFsrsWeights(events, { now: t0 + 100 * DAY_MS });
		assert.ok(fit !== null);
		assert.equal(fit.reviews, 120);
		assert.equal(fit.improved, true);
		assert.equal(isValidFsrsWeights(fit.weights), true);
		assert.ok(fit.fittedLogLoss < fit.baselineLogLoss, `expected ${fit.fittedLogLoss} < ${fit.baselineLogLoss}`);
		assert.ok(fit.fittedBrier < fit.baselineBrier, `expected ${fit.fittedBrier} < ${fit.baselineBrier}`);
	});
});
