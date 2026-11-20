import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildDiagnosticBrief,
	extractMissClasses,
	newDiagnosticContextMessage,
	type MissClassEvent,
} from "../src/core/diagnostics.ts";
import { GRADE_AGAIN, GRADE_GOOD, retentionReport, type RecallEvent } from "../src/core/retention.ts";
import { weakSpotReport } from "../src/core/weak-spots.ts";
import { nativeInputCause, toLlmMessages } from "../src/core/native-messages.ts";
import { projectView } from "../src/core/view.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("diagnostic-hotspot context injection", () => {
	it("extractMissClasses reads non-null conclude missClass calls and ignores null/errored ones", () => {
		const messages = [
			{
				id: "a1",
				role: "assistant",
				timestamp: 1000,
				content: [{ type: "toolCall", id: "p1", name: "problem", arguments: { target: ["n1"] } }],
			},
			{ id: "r1", role: "toolResult", toolCallId: "p1", toolName: "problem", content: [], isError: false },
			{
				id: "a2",
				role: "assistant",
				timestamp: 2000,
				content: [{ type: "toolCall", id: "c1", name: "conclude", arguments: { outcome: "movedOn", missClass: "discrimination" } }],
			},
			{ id: "r2", role: "toolResult", toolCallId: "c1", toolName: "conclude", content: [], isError: false },
			{
				id: "a3",
				role: "assistant",
				timestamp: 3000,
				content: [{ type: "toolCall", id: "c2", name: "conclude", arguments: { outcome: "solved", missClass: null } }],
			},
			{ id: "r3", role: "toolResult", toolCallId: "c2", toolName: "conclude", content: [], isError: false },
		];
		assert.deepEqual(extractMissClasses(messages), [
			{ missClass: "discrimination", targets: ["n1"], at: 2000 },
		]);
	});

	it("returns null when no relevant prerequisites, weak spots, or miss patterns exist", () => {
		const now = Date.UTC(2026, 10, 10);
		const brief = buildDiagnosticBrief({
			topic: "Quantum electrodynamics",
			nodes: [],
			chains: [],
			retention: { topics: [] },
			weakSpots: { spots: [] },
			misses: [],
		});
		assert.equal(brief, null);
		assert.ok(now > 0);
	});

	it("builds prerequisite neighborhood, prioritizes relevant overconfident spots, and aggregates recurring missClasses", () => {
		const t0 = Date.UTC(2026, 10, 1);
		const now = t0 + 4 * DAY_MS;
		const nodes = [
			{ id: "n_lim", name: "Limit definition", statement: "Epsilon-delta definition of a limit.", aliases: [] },
			{ id: "n_der", name: "Derivative", statement: "Limit of the difference quotient.", aliases: [] },
			{ id: "n_chain", name: "Chain rule", statement: "Derivative of a composite function.", aliases: ["composition derivative"] },
			{ id: "n_unrelated", name: "French Revolution", statement: "1789 political upheaval.", aliases: [] },
		];
		const chains = [
			{ premises: ["n_lim"], conclusion: "n_der" },
			{ premises: ["n_der"], conclusion: "n_chain" },
		];
		const events: RecallEvent[] = [
			{
				topicKey: "prop:n_lim",
				kind: "proposition",
				topicId: "n_lim",
				title: "Limit definition",
				chatId: "c1",
				chatTitle: "Calc",
				at: t0,
				grade: GRADE_AGAIN,
				confidence: 90,
				question: "State the epsilon-delta definition.",
			},
			{
				topicKey: "prop:n_der",
				kind: "proposition",
				topicId: "n_der",
				title: "Derivative",
				chatId: "c1",
				chatTitle: "Calc",
				at: t0,
				grade: GRADE_GOOD,
				confidence: 80,
			},
		];
		const retention = retentionReport(events, now, chains);
		const weakSpots = weakSpotReport(events, now, chains);
		const misses: MissClassEvent[] = [
			{ missClass: "discrimination", targets: ["n_chain"], at: t0 },
			{ missClass: "discrimination", targets: ["n_der"], at: t0 + 1000 },
			{ missClass: "structural", targets: ["n_lim"], at: t0 + 2000 },
			{ missClass: "structural", targets: ["n_lim"], at: t0 + 3000 },
			{ missClass: "careless", targets: ["n_der"], at: t0 + 4000 },
		];

		const brief = buildDiagnosticBrief({
			topic: "Help me master the chain rule",
			nodes,
			chains,
			retention,
			weakSpots,
			misses,
		});
		assert.ok(brief !== null);

		// Prerequisite neighborhood includes n_chain + 2-hop premises (n_der, n_lim), never n_unrelated
		const prereqIds = brief.prerequisites.map((p) => p.id);
		assert.ok(prereqIds.includes("n_chain"));
		assert.ok(prereqIds.includes("n_der"));
		assert.ok(prereqIds.includes("n_lim"));
		assert.ok(!prereqIds.includes("n_unrelated"));
		// Weakest/due premise (n_lim) surfaces first
		assert.equal(brief.prerequisites[0]!.id, "n_lim");

		// Overconfident weak spot captured with missed question
		assert.equal(brief.weakSpots.length, 1);
		assert.equal(brief.weakSpots[0]!.spot, "overconfident");
		assert.equal(brief.weakSpots[0]!.missedQuestion, "State the epsilon-delta definition.");

		// Recurring missClasses (>= 2) selected ahead of one-off careless miss
		assert.deepEqual(
			brief.missPatterns.map((m) => [m.missClass, m.count]),
			[
				["discrimination", 2],
				["structural", 2],
			],
		);

		// Marker round-trips cleanly through nativeInputCause, toLlmMessages, and projectMessages
		const marker = newDiagnosticContextMessage(brief, now);
		assert.equal(nativeInputCause(marker, []), "neutral");
		const llm = toLlmMessages([marker]);
		assert.equal(llm.length, 1);
		assert.equal(llm[0]!.role, "user");
		const rawContent = llm[0]!.content;
		const llmText =
			typeof rawContent === "string"
				? rawContent
				: rawContent.map((b) => (b.type === "text" ? b.text : "")).join("\n");
		assert.match(llmText, /Diagnostic context/);
		assert.match(llmText, /Limit definition/);
		assert.match(llmText, /discrimination \(2×\)/);

		const projected = projectView([marker]);
		assert.equal(projected.length, 1);
		assert.equal(projected[0]!.parts[0]!.type, "data-diagnostic-context");
	});
});
