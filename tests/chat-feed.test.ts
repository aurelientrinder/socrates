import { test } from "node:test";
import assert from "node:assert/strict";
import { thinkingGroupOf } from "../components/chat";
import { replyCopyText } from "../components/reply-actions";

test("a reply's thinking folds into one block at the first reasoning part", () => {
	const parts = [
		{ type: "step-start" },
		{ type: "reasoning", text: "first thought" },
		{ type: "text", text: "Let me check." },
		{ type: "tool-list_sessions" },
		{ type: "step-start" },
		{ type: "reasoning", text: "second thought" },
		{ type: "text", text: "Here it is." },
	];
	assert.deepEqual(thinkingGroupOf(parts), { first: 1, texts: ["first thought", "second thought"] });
});

test("a reply without thinking has no block", () => {
	assert.deepEqual(thinkingGroupOf([{ type: "text", text: "hi" }]), { first: -1, texts: [] });
});

test("copy takes only what the tutor said", () => {
	const parts = [
		{ type: "reasoning", text: "hidden" },
		{ type: "text", text: " One. " },
		{ type: "tool-quiz" },
		{ type: "text", text: "" },
		{ type: "text", text: "Two." },
	];
	assert.equal(replyCopyText(parts), "One.\n\nTwo.");
});
