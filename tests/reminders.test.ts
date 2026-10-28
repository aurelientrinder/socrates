import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReminders, MAX_REMINDERS } from "../src/core/reminders.ts";
import type { BriefingPlan } from "../src/core/briefing.ts";

const NOW = new Date(2026, 9, 28, 9, 0).getTime();
const date = (n: number) => {
	const d = new Date(2026, 9, 28 + n);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const item = { title: "Review eigenvalues", minutes: 10 };

function plan(days: number[], examInDays?: number): BriefingPlan {
	return {
		study: {
			days: Array.from({ length: 8 }, (_, i) => ({ date: date(i), items: days.includes(i) ? [item] : [], minutes: 0 })),
			exams: examInDays === undefined ? [] : [{ eventId: "e1", title: "Linear algebra exam", kind: "exam", start: new Date(2026, 9, 28 + examInDays, 10).getTime(), readinessPlanned: 0.8 }],
		},
	} as unknown as BriefingPlan;
}

describe("buildReminders", () => {
	const on = { enabled: true, hour: 18 };

	it("is empty when off or without a plan", () => {
		assert.deepEqual(buildReminders(plan([0, 1]), { enabled: false, hour: 18 }, NOW), []);
		assert.deepEqual(buildReminders({} as BriefingPlan, on, NOW), []);
	});

	it("nudges only on days with planned work", () => {
		const r = buildReminders(plan([0, 2]), on, NOW);
		assert.deepEqual(r.map((x) => x.key), [`nudge:${date(0)}`, `nudge:${date(2)}`]);
		assert.match(r[0]!.body, /Even 5 minutes counts/);
	});

	it("skips a time that has already passed or is imminent", () => {
		const r = buildReminders(plan([0]), on, new Date(2026, 9, 28, 17, 58).getTime());
		assert.equal(r.length, 0);
	});

	it("adds a heads-up three days and one day before an exam", () => {
		const r = buildReminders(plan([], 5), on, NOW);
		assert.deepEqual(r.map((x) => x.key), ["exam:e1:3", "exam:e1:1"]);
		assert.equal(r[1]!.title, "Linear algebra exam tomorrow");
		assert.equal(new Date(r[0]!.start).getDate(), 30);
	});

	it("drops an exam heads-up that is already past", () => {
		assert.deepEqual(buildReminders(plan([], 1), on, NOW).map((x) => x.key), ["exam:e1:1"]);
	});

	it("never exceeds the cap", () => {
		assert.ok(buildReminders(plan([0, 1, 2, 3, 4, 5, 6], 10), on, NOW).length <= MAX_REMINDERS);
	});
});
