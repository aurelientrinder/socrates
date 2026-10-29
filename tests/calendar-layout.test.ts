import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dayOf, hourRange, packDay, weekStarts } from "../src/core/calendar-layout.ts";

const at = (h: number, m = 0) => h * 60 + m;

describe("packDay", () => {
	it("gives events that do not overlap the whole width", () => {
		const slots = packDay([
			{ start: at(8, 30), end: at(10, 15) },
			{ start: at(13, 30), end: at(15) },
		]);
		assert.deepEqual(slots.map((s) => [s.col, s.cols]), [[0, 1], [0, 1]]);
	});

	it("splits overlapping events side by side", () => {
		const slots = packDay([
			{ start: at(9), end: at(11) },
			{ start: at(9, 30), end: at(10) },
		]);
		assert.deepEqual(slots.map((s) => [s.col, s.cols]), [[0, 2], [1, 2]]);
	});

	it("reuses a freed column and keeps clusters apart", () => {
		const slots = packDay([
			{ start: at(9), end: at(10) },
			{ start: at(9, 30), end: at(11) },
			{ start: at(10), end: at(10, 30) }, // fits under the first, beside the second
			{ start: at(15), end: at(16) }, // a new cluster: full width again
		]);
		assert.deepEqual(slots.map((s) => [s.col, s.cols]), [[0, 2], [1, 2], [0, 2], [0, 1]]);
	});

	it("keeps input order and treats a very short event as at least half an hour", () => {
		const slots = packDay([
			{ start: at(9, 40), end: at(9, 45) },
			{ start: at(9), end: at(9, 5) },
			{ start: at(9, 10), end: at(9, 20) },
		]);
		assert.deepEqual(slots.map((s) => s.index), [0, 1, 2]);
		assert.deepEqual(slots.map((s) => s.cols), [1, 2, 2]);
	});
});

describe("hourRange", () => {
	it("defaults to 08-19 and widens for early or late events", () => {
		assert.deepEqual(hourRange([]), { from: 8, to: 19 });
		assert.deepEqual(hourRange([{ start: at(7, 30), end: at(8) }, { start: at(18), end: at(20, 15) }]), { from: 7, to: 21 });
		assert.deepEqual(hourRange([{ start: at(2), end: at(3) }]), { from: 6, to: 19 });
	});
});

describe("week dates", () => {
	it("steps whole weeks by calendar date across a clock change", () => {
		const monday = new Date(2026, 9, 26).getTime();
		const weeks = weekStarts(monday, 3);
		assert.deepEqual(weeks.map((w) => new Date(w).getDate()), [26, 2, 9]);
		assert.equal(new Date(dayOf(weeks[0]!, 4)).getDay(), 5);
	});
});
