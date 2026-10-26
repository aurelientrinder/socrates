/**
 * STUDY TIME (src/core/study-time.ts): Today's "This week" minutes.
 *
 * - the week starts on local Monday midnight;
 * - short gaps between messages count, long pauses do not;
 * - each stretch lands on the day it started, and other weeks are ignored.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STUDY_GAP_MS, studyMinutesByDay, weekStartOf } from "../src/core/study-time.ts";

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
