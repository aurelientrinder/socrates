import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { retryBase, type LhMessage } from "../src/core/native-messages.ts";

const user = (id: string): LhMessage => ({ id, role: "user", content: "hi", timestamp: 0 }) as LhMessage;
const reply = (id: string, ...tools: string[]): LhMessage =>
	({
		id,
		role: "assistant",
		content: [{ type: "text", text: "answer" }, ...tools.map((name, i) => ({ type: "toolCall", id: `${id}-${i}`, name, arguments: {} }))],
	}) as unknown as LhMessage;
const result = (id: string): LhMessage => ({ id, role: "toolResult", toolCallId: "x", toolName: "read", content: [], isError: false, timestamp: 0 }) as unknown as LhMessage;

describe("retryBase", () => {
	it("cuts the reply after the last learner message", () => {
		const base = retryBase([user("u1"), reply("a1"), user("u2"), reply("a2", "read"), result("r"), reply("a3")]);
		assert.deepEqual(base?.map((m) => m.id), ["u1", "a1", "u2"]);
	});
	it("a failed turn (nothing after the message) re-runs from it", () => {
		assert.deepEqual(retryBase([user("u1")])?.map((m) => m.id), ["u1"]);
	});
	it("nothing to retry before the learner has said anything", () => {
		assert.equal(retryBase([]), null);
		assert.equal(retryBase([reply("a0")]), null);
	});
	for (const tool of ["quiz", "ask", "plan_init", "research", "visual", "probe_done", "problem"]) {
		it(`a reply that called ${tool} is final`, () => {
			assert.equal(retryBase([user("u1"), reply("a1", tool)]), null);
		});
	}
	it("a marker after the message (steer delivery, compaction) is final", () => {
		assert.equal(retryBase([user("u1"), { id: "m", role: "custom", customType: "steer" } as unknown as LhMessage]), null);
	});
});
