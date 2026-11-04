import assert from "node:assert/strict";
import test from "node:test";
import { fillGeminiThoughtSignatures, GEMINI_SKIP_SIGNATURE } from "../src/agent/models.ts";

test("fills missing thoughtSignature on replayed functionCall parts only", () => {
	const payload: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> } = {
		contents: [
			{ role: "user", parts: [{ text: "hi" }] },
			{
				role: "model",
				parts: [
					{ functionCall: { name: "quiz", args: {} } },
					{ functionCall: { name: "ask", args: {} }, thoughtSignature: "REAL" },
					{ text: "no call" },
				],
			},
		],
	};
	fillGeminiThoughtSignatures(payload);
	const parts = payload.contents[1]!.parts;
	assert.equal(parts[0]!.thoughtSignature, GEMINI_SKIP_SIGNATURE);
	assert.equal(parts[1]!.thoughtSignature, "REAL");
	assert.equal(parts[2]!.thoughtSignature, undefined);
	assert.equal(payload.contents[0]!.parts[0]!.thoughtSignature, undefined);
});

test("tolerates payloads without contents", () => {
	assert.deepEqual(fillGeminiThoughtSignatures({}), {});
	assert.equal(fillGeminiThoughtSignatures(undefined), undefined);
});
