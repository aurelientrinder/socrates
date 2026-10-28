/**
 * STUDY TIME (src/core/study-time.ts): Today's "This week" minutes.
 *
 * - the week starts on local Monday midnight;
 * - short gaps between messages count, long pauses do not;
 * - each stretch lands on the day it started, and other weeks are ignored;
 * - the streak counts study days, forgives today and one rest day between
 *   study days, and ends after two missed days in a row.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STREAK_MIN_MINUTES, STUDY_GAP_MS, daysBackStart, studyMinutesByDay, studyStreak, weekStartOf } from "../src/core/study-time.ts";

const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m).getTime(); // October 2026

describe("weekStartOf", () => {
	it("is the local Monday midnight", () => {
		// 2026-10-26 is a Monday, 2026-11-01 a Sunday.
		assert.deepEqual(weekStartOf(new Date(2026, 9, 28, 15)), new Date(2026, 9, 26));
		assert.deepEqual(weekStartOf(new Date(2026, 10, 1, 23)), new Date(2026, 9, 26));
		assert.deepEqual(weekStartOf(new Date(2026, 9, 26, 0, 5)), new Date(2026, 9, 26));
	});
});

describe("studyMinutesByDay", () => {
	const week = new Date(2026, 9, 26);

	it("counts short gaps and skips breaks", () => {
		const session = [at(26, 10, 0), at(26, 10, 4), at(26, 10, 10), at(26, 12, 0), at(26, 12, 5)];
		assert.deepEqual(studyMinutesByDay([session], week), [15, 0, 0, 0, 0, 0, 0]);
		assert.equal(STUDY_GAP_MS, 10 * 60_000);
	});

	it("sums sessions per day and ignores other weeks and order", () => {
		const a = [at(28, 9, 8), at(28, 9, 0)];
		const b = [at(28, 20, 0), at(28, 20, 2), at(25, 9, 0), at(25, 9, 5)];
		const lone = [at(30, 9, 0)]; // one message: no stretch
		assert.deepEqual(studyMinutesByDay([a, b, lone], week), [0, 0, 10, 0, 0, 0, 0]);
	});

	it("credits a stretch across midnight to the day it started", () => {
		assert.deepEqual(studyMinutesByDay([[at(27, 23, 58), at(28, 0, 3)]], week), [0, 5, 0, 0, 0, 0, 0]);
	});
});

describe("studyMinutesByDay over a longer range", () => {
	it("reads any number of days from the start", () => {
		const start = daysBackStart(new Date(2026, 9, 28, 15), 10);
		assert.deepEqual(start, new Date(2026, 9, 19));
		const days = studyMinutesByDay([[at(19, 9, 0), at(19, 9, 6)], [at(28, 8, 0), at(28, 8, 4)]], start, 10);
		assert.equal(days.length, 10);
		assert.equal(days[0], 6);
		assert.equal(days[9], 4);
	});
});

describe("studyStreak", () => {
	const S = 20; // a study day
	const R = 0; // a missed day

	it("counts consecutive study days, today included", () => {
		assert.deepEqual(studyStreak([R, R, S, S, S]), { days: 3, studiedToday: true, atRisk: false });
	});

	it("does not break on today before it is over", () => {
		assert.deepEqual(studyStreak([R, S, S, R]), { days: 2, studiedToday: false, atRisk: false });
	});

	it("forgives one rest day between study days", () => {
		assert.deepEqual(studyStreak([S, R, S, R, S]), { days: 3, studiedToday: true, atRisk: false });
	});

	it("ends after two missed days in a row", () => {
		assert.deepEqual(studyStreak([S, S, R, R, S]), { days: 1, studiedToday: true, atRisk: false });
		assert.equal(studyStreak([S, S, R, R, R]).days, 0);
	});

	it("is at risk when yesterday was a rest day and today does not count yet", () => {
		assert.deepEqual(studyStreak([S, S, R, R]), { days: 2, studiedToday: false, atRisk: true });
	});

	it("needs a few minutes for a day to count, so a five-minute session is enough", () => {
		assert.equal(STREAK_MIN_MINUTES <= 5, true);
		assert.equal(studyStreak([STREAK_MIN_MINUTES - 1]).days, 0);
		assert.equal(studyStreak([STREAK_MIN_MINUTES]).days, 1);
	});

	it("is empty with no record", () => {
		assert.deepEqual(studyStreak([]), { days: 0, studiedToday: false, atRisk: false });
		assert.deepEqual(studyStreak([R]), { days: 0, studiedToday: false, atRisk: false });
	});
});
