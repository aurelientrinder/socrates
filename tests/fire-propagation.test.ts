import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	GRADE_AGAIN,
	GRADE_GOOD,
	GRADE_HARD,
	orderPrerequisitesFirst,
	retentionReport,
	withPrerequisiteRepairs,
	type ChainLink,
	type RecallEvent,
} from "../src/core/retention.ts";
import { standingOf } from "../src/core/cheatsheet.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function propEvent(id: string, title: string, at: number, grade: 1 | 2 | 3): RecallEvent {
	return {
		topicKey: `prop:${id}`,
		kind: "proposition",
		topicId: id,
		title,
		chatId: "chat_1",
		chatTitle: "Calculus",
		at,
		grade,
	};
}

describe("graph-propagated FSRS (FIRe)", () => {
	it("grants conservative upward credit (0.5 at 1 hop, 0.25 at 2 hops, 0 at 3+ hops) without mutating lastReviewedAt", () => {
		const t0 = Date.UTC(2026, 10, 1);
		const chains: ChainLink[] = [
			{ premises: ["A"], conclusion: "B" },
			{ premises: ["B"], conclusion: "C" },
			{ premises: ["C"], conclusion: "D" },
		];
		const events: RecallEvent[] = [
			propEvent("A", "Limits", t0, GRADE_GOOD),
			propEvent("B", "Derivatives", t0, GRADE_GOOD),
			propEvent("C", "Chain rule", t0, GRADE_GOOD),
			propEvent("D", "Implicit differentiation", t0 + 3 * DAY_MS, GRADE_GOOD),
		];
		const now = t0 + 4 * DAY_MS;

		const base = retentionReport(events, now);
		const fire = retentionReport(events, now, chains);

		const get = (rep: typeof base, id: string) => rep.topics.find((t) => t.key === `prop:${id}`)!;
		const baseA = get(base, "A");
		const baseB = get(base, "B");
		const baseC = get(base, "C");
		const fireA = get(fire, "A");
		const fireB = get(fire, "B");
		const fireC = get(fire, "C");

		// 3 hops away: zero credit
		assert.equal(fireA.stability, baseA.stability);
		assert.equal(fireA.implicitCredits, undefined);

		// 2 hops away (0.25) and 1 hop away (0.5): stability grows proportionally
		assert.ok(fireB.stability > baseB.stability, "2-hop premise gained fractional stability");
		assert.ok(fireC.stability > fireB.stability, "1-hop premise gained more stability than 2-hop premise");
		assert.equal(fireB.implicitCredits, 1);
		assert.equal(fireC.implicitCredits, 1);

		// Conservative doctrine: lastReviewedAt & direct review count stay honest
		assert.equal(fireC.lastReviewedAt, t0);
		assert.equal(fireC.reviews, 1);
	});

	it("gives no upward credit for Hard/Again and never fabricates untested premises", () => {
		const t0 = Date.UTC(2026, 10, 1);
		const chains: ChainLink[] = [
			{ premises: ["P", "Untested"], conclusion: "C" },
		];
		const events: RecallEvent[] = [
			propEvent("P", "Premise", t0, GRADE_GOOD),
			propEvent("C", "Conclusion", t0 + 2 * DAY_MS, GRADE_HARD),
			propEvent("C", "Conclusion", t0 + 4 * DAY_MS, GRADE_AGAIN),
		];
		const now = t0 + 5 * DAY_MS;

		const base = retentionReport(events, now);
		const fire = retentionReport(events, now, chains);

		assert.equal(fire.topics.find((t) => t.key === "prop:Untested"), undefined, "untested premise is never fabricated");
		assert.equal(
			fire.topics.find((t) => t.key === "prop:P")!.stability,
			base.topics.find((t) => t.key === "prop:P")!.stability,
			"Hard and Again give zero upward credit",
		);
	});

	it("handles cyclic chains safely", () => {
		const t0 = Date.UTC(2026, 10, 1);
		const chains: ChainLink[] = [
			{ premises: ["A"], conclusion: "B" },
			{ premises: ["B"], conclusion: "A" },
		];
		const events = [propEvent("A", "A", t0, GRADE_GOOD), propEvent("B", "B", t0 + 2 * DAY_MS, GRADE_GOOD)];
		const rep = retentionReport(events, t0 + 3 * DAY_MS, chains);
		assert.equal(rep.topics.length, 2);
		assert.equal(rep.topics.find((t) => t.key === "prop:A")!.implicitCredits, 1);
	});

	it("flags downward blast radius (shakyPremises) on conclusions and marks cheat-sheet standing shaky without mutating C's stability", () => {
		const t0 = Date.UTC(2026, 10, 1);
		const chains: ChainLink[] = [{ premises: ["P"], conclusion: "C" }];
		const events: RecallEvent[] = [
			propEvent("P", "Dot product", t0, GRADE_AGAIN),
			propEvent("C", "Orthogonal projection", t0, GRADE_GOOD),
		];
		const now = t0 + 1 * DAY_MS;

		const base = retentionReport(events, now);
		const fire = retentionReport(events, now, chains);

		const cBase = base.topics.find((t) => t.key === "prop:C")!;
		const cFire = fire.topics.find((t) => t.key === "prop:C")!;

		assert.equal(cFire.stability, cBase.stability, "conclusion's own FSRS stability is untouched");
		assert.equal(cFire.shakyPremises?.length, 1);
		assert.equal(cFire.shakyPremises![0]!.key, "prop:P");

		const standing = standingOf(cFire, undefined);
		assert.equal(standing.standing, "shaky");
		assert.match(standing.reason, /Built on a shaky foundation: Dot product/);

		// Once P is recovered cleanly, shakyPremises clears and C reads as known
		const recovered = retentionReport([...events, propEvent("P", "Dot product", now, GRADE_GOOD)], now + 1000, chains);
		const cRecovered = recovered.topics.find((t) => t.key === "prop:C")!;
		assert.equal(cRecovered.shakyPremises, undefined);
		assert.equal(standingOf(cRecovered, undefined).standing, "known");
	});

	it("orders prerequisites before conclusions and pulls broken premises into drill queues", () => {
		const t0 = Date.UTC(2026, 10, 1);
		const chains: ChainLink[] = [
			{ premises: ["P"], conclusion: "C" },
		];
		const events: RecallEvent[] = [
			propEvent("P", "Premise", t0, GRADE_AGAIN),
			propEvent("C", "Conclusion", t0, GRADE_GOOD),
			propEvent("U", "Unrelated", t0, GRADE_GOOD),
		];
		const rep = retentionReport(events, t0 + 1 * DAY_MS, chains);
		const P = rep.topics.find((t) => t.key === "prop:P")!;
		const C = rep.topics.find((t) => t.key === "prop:C")!;
		const U = rep.topics.find((t) => t.key === "prop:U")!;

		// orderPrerequisitesFirst puts P before C while preserving U's relative spot
		const ordered = orderPrerequisitesFirst([C, U, P], chains);
		assert.deepEqual(
			ordered.map((t) => t.key),
			["prop:U", "prop:P", "prop:C"],
		);

		// withPrerequisiteRepairs pulls shaky premise P ahead of picked conclusion C
		const repaired = withPrerequisiteRepairs([C], rep.topics, chains, 5);
		assert.deepEqual(
			repaired.map((t) => t.key),
			["prop:P", "prop:C"],
		);

		// Respects tight limit (cap = 1 still prioritizes root cause P)
		const capped = withPrerequisiteRepairs([C], rep.topics, chains, 1);
		assert.deepEqual(
			capped.map((t) => t.key),
			["prop:P"],
		);
	});
});
