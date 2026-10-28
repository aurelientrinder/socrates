/**
 * The search engine's resolution: Gemini (Google Search grounding) is the
 * one engine and is live iff the Gemini key is present — no engine setting,
 * no silent fallback. The adapter's wire shape is pinned in
 * dictation-gemini.test.ts against a STUB fetch (never the network).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveSearchEngineFor } from "../src/server/search.ts";

describe("resolveSearchEngineFor", () => {
	it("no key: honestly unavailable, no default", () => {
		const out = resolveSearchEngineFor(undefined);
		assert.ok(!out.available);
		assert.equal(out.engine, null);
		assert.equal(out.key, null);
		assert.match(out.reason, /no search engine configured/i);
	});

	it("the Gemini key alone is enough", () => {
		const out = resolveSearchEngineFor("g-key");
		assert.ok(out.available);
		assert.equal(out.engine, "gemini");
		assert.equal(out.key, "g-key");
	});
});
