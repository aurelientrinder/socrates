/**
 * ORPHANED TOOL RESULTS (the toolu_0179 incident, 2026-10-26): pi-ai drops
 * errored/aborted assistant messages before the wire but keeps the results
 * after them — Anthropic then 400s with "unexpected `tool_use_id` found in
 * `tool_result` blocks" on every later turn. toLlmMessages must never hand
 * pi a result whose call is not in the replayed assistant message before it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import {
	asAgentMessages,
	newUserMessage,
	toLlmMessages,
	INTERRUPTED_TEXT,
	ORPHANED_RESULT_LABEL,
	type LhMessage,
} from "../src/core/native-messages.ts";

const MODEL = { provider: "test", api: "faux", id: "test-model", input: ["text"] } as never;

function assistant(
	id: string,
	calls: Array<{ id: string; name: string }>,
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): LhMessage {
	return {
		id,
		role: "assistant",
		content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.name, arguments: {} })),
		api: "faux",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 0,
	} as LhMessage;
}

function result(toolCallId: string, toolName: string, text = "ok"): LhMessage {
	return {
		id: `r_${toolCallId}`,
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 0,
	} as LhMessage;
}

/** What the provider adapter actually receives (pi-ai's own pass). */
function wire(messages: readonly LhMessage[]): Message[] {
	return transformMessages(toLlmMessages(asAgentMessages(messages)), MODEL);
}

/** Every result on the wire answers a call in the nearest assistant before it. */
function assertPaired(messages: readonly Message[]): void {
	let open = new Set<string>();
	for (const m of messages) {
		if (m.role === "assistant") {
			open = new Set(m.content.filter((b) => b.type === "toolCall").map((b) => (b as { id: string }).id));
		} else if (m.role === "toolResult") {
			assert.ok(open.has(m.toolCallId), `orphaned result ${m.toolCallId}`);
			open.delete(m.toolCallId);
		} else {
			open = new Set();
		}
	}
}

describe("toLlmMessages — orphaned tool results", () => {
	it("an answered question from an errored turn flattens to a user message (the incident shape)", () => {
		const record = [
			newUserMessage("teach me"),
			assistant("a1", [
				{ id: "c1", name: "search_notes" },
				{ id: "c2", name: "search_notes" },
			]),
			result("c1", "search_notes"),
			result("c2", "search_notes"),
			assistant("a2", [{ id: "toolu_0179", name: "ask" }], "error"),
			result("toolu_0179", "ask", "{\"choice\":\"B\"}"),
		];
		const out = wire(record);
		assertPaired(out);
		const last = out[out.length - 1]!;
		assert.equal(last.role, "user");
		const text = (last.content as Array<{ text: string }>)[0]!.text;
		assert.ok(text.startsWith(ORPHANED_RESULT_LABEL("ask")));
		assert.ok(text.includes('"choice":"B"'), "the learner's answer still reaches the model");
	});

	it("an aborted turn's unanswered call gets no synthesized result", () => {
		const record = [newUserMessage("hi"), assistant("a1", [{ id: "q1", name: "quiz" }], "aborted")];
		const out = wire(record);
		assertPaired(out);
		assert.ok(!JSON.stringify(out).includes(INTERRUPTED_TEXT));
	});

	it("a result separated from its call by a user message is flattened", () => {
		const record = [
			newUserMessage("hi"),
			assistant("a1", [{ id: "q1", name: "quiz" }]),
			newUserMessage("steer"),
			result("q1", "quiz"),
		];
		assertPaired(wire(record));
	});

	it("healthy pairs pass through natively, and dangling calls still get the interrupted result", () => {
		const record = [
			newUserMessage("hi"),
			assistant("a1", [
				{ id: "c1", name: "search_notes" },
				{ id: "q1", name: "ask" },
			]),
			result("c1", "search_notes"),
		];
		const out = toLlmMessages(asAgentMessages(record));
		assert.deepEqual(
			out.map((m) => m.role),
			["user", "assistant", "toolResult", "toolResult"],
		);
		assert.deepEqual(
			out.slice(2).map((m) => (m as ToolResultMessage).toolCallId).sort(),
			["c1", "q1"],
		);
		assertPaired(out);
	});
});
