import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	deriveLessonSections,
	distillLessonSection,
	formatSectionQuote,
	isExpositionPart,
	openingProbeSpan,
	sectionAnchorId,
	sectionForMessage,
} from "../src/core/lesson-sections.ts";
import type { PlanTree } from "../src/core/contracts/plan.ts";
import type { LhViewMessage } from "../src/core/view.ts";

describe("document-first lesson sections", () => {
	const tree: PlanTree = {
		version: 1,
		nodes: [
			{ id: "limits", title: "Limit definition", summary: "Formal epsilon-delta limit." },
			{ id: "deriv", title: "Derivative", summary: "Rate of change." },
			{ id: "chain", title: "Chain rule", summary: "Composite differentiation." },
		],
		edges: [
			{ from: "limits", to: "deriv" },
			{ from: "deriv", to: "chain" },
		],
	};

	const messages: LhViewMessage[] = [
		// Pre-teach probe messages (unsectioned)
		{ id: "u0", role: "user", parts: [{ type: "text", text: "Teach me chain rule" }] },
		{ id: "a0", role: "assistant", parts: [{ type: "text", id: "m0-t0", text: "Let's probe first." }] },
		// Section 1: limits
		{
			id: "a1",
			role: "assistant",
			parts: [
				{ type: "text", id: "m1-t0", text: "Here is the limit definition." },
				{
					type: "tool-quiz",
					id: "q1",
					state: "output-available",
					input: { nodeId: "limits", type: "check" },
					output: {
						kind: "quiz",
						questionText: "Does f(a) need to exist for lim_{x→a} f(x) to exist?",
						answers: [{ index: 1, label: "Yes", value: "yes" }],
						correct: false,
						confidence: 5,
						explanation: "Limits depend only on values near a, not at a itself.",
					},
				},
			],
		},
		{ id: "u1", role: "user", parts: [{ type: "text", text: "Got it!" }] },
		// Section 2: deriv
		{
			id: "a2",
			role: "assistant",
			parts: [
				{ type: "text", id: "m2-t0", text: "Now derivatives." },
				{ type: "tool-explain", id: "e1", state: "output-available", input: { nodeId: "deriv" }, output: { kind: "explain", questionText: "Explain secant slope", answers: [] } },
			],
		},
	];

	it("groups teach turns into contiguous sections with prerequisites and leaves probe turns unsectioned", () => {
		const sections = deriveLessonSections(messages, tree, (id) =>
			id === "limits" ? "visited" : id === "deriv" ? "current" : "upcoming",
		);
		assert.equal(sections.length, 2);

		assert.equal(sections[0]!.nodeId, "limits");
		assert.equal(sections[0]!.index, 1);
		assert.equal(sections[0]!.startIndex, 2);
		assert.equal(sections[0]!.endIndex, 3);
		assert.equal(sections[0]!.status, "visited");
		assert.deepEqual(sections[0]!.prerequisites, []);

		assert.equal(sections[1]!.nodeId, "deriv");
		assert.equal(sections[1]!.index, 2);
		assert.equal(sections[1]!.startIndex, 4);
		assert.equal(sections[1]!.endIndex, 4);
		assert.equal(sections[1]!.status, "current");
		assert.deepEqual(sections[1]!.prerequisites, [{ id: "limits", title: "Limit definition", status: "visited" }]);

		assert.equal(sectionAnchorId("deriv"), "section-deriv");
	});

	it("resolves deep-linked native message IDs to their enclosing section", () => {
		const sections = deriveLessonSections(messages, tree, () => "visited");
		assert.equal(sectionForMessage(sections, messages, "m1"), "limits");
		assert.equal(sectionForMessage(sections, messages, "m2"), "deriv");
		assert.equal(sectionForMessage(sections, messages, "m0"), null);
		assert.equal(sectionForMessage(sections, messages, "unknown"), null);
	});

	it("distills mastered sections into exposition, dialogue archive, and Watch-out traps", () => {
		const sections = deriveLessonSections(messages, tree, (id) => (id === "limits" ? "visited" : "current"));
		const distilled = distillLessonSection(sections[0]!, messages);
		assert.deepEqual(distilled.expositionIndices, [2]);
		assert.deepEqual(distilled.archiveIndices, [2, 3]);
		assert.equal(distilled.userTurns, 1);
		assert.equal(distilled.checkCount, 1);
		assert.equal(distilled.passedChecks, 0);
		assert.equal(distilled.traps.length, 1);
		assert.equal(distilled.traps[0]!.overconfident, true);
		assert.match(distilled.traps[0]!.explanation ?? "", /near a/);

		assert.equal(isExpositionPart({ type: "text", text: "Hello" }), true);
		assert.equal(isExpositionPart({ type: "data-diagram", data: { svg: "<svg/>" } }), true);
		assert.equal(isExpositionPart({ type: "reasoning", text: "hmm" }), false);
		assert.equal(isExpositionPart({ type: "tool-quiz", state: "output-available" }), false);
	});

	it("computes opening probe span and formats section highlight quotes", () => {
		const sections = deriveLessonSections(messages, tree, () => "visited");
		const probe = openingProbeSpan(sections, messages);
		assert.deepEqual(probe, { startIndex: 0, endIndex: 1, count: 2 });

		const quote = formatSectionQuote({ index: 2, title: "Derivative" }, "  Rate\n  of   change  ");
		assert.equal(quote, '> "Rate of change"\n> — § 2 Derivative\n\n');
		assert.equal(formatSectionQuote({ index: 1, title: "Empty" }, "   "), "");
	});
});
