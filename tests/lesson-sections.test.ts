import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	deriveLessonSections,
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
				{ type: "tool-quiz", id: "q1", input: { nodeId: "limits", type: "check" } },
			],
		},
		{ id: "u1", role: "user", parts: [{ type: "text", text: "Got it!" }] },
		// Section 2: deriv
		{
			id: "a2",
			role: "assistant",
			parts: [
				{ type: "text", id: "m2-t0", text: "Now derivatives." },
				{ type: "tool-explain", id: "e1", input: { nodeId: "deriv" } },
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
});
