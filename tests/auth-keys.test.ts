/**
 * The curated auth-key catalog + shape rules (auth-keys wave, 2026-09-19;
 * search wave 2026-09-20: the Google CSE pair retired, Tavily + Brave in)
 * — PURE module, so this file owns no fs. Owner decisions being pinned:
 *  - the catalog is exactly the three known keys, ids = env-var names;
 *  - validation is SHAPE-ONLY (no live pings) and bad pastes are 400s;
 *  - masking is last-4 + length — plaintext never leaves the store.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AUTH_KEYS, genericProviderKeyGuard, isKnownAuthKey, maskKey, validateKeyShape } from "../src/core/auth-keys.ts";

describe("the catalog", () => {
	it("is exactly the CURATED app-service keys (provider keys live in the provider table)", () => {
		assert.deepEqual(
			AUTH_KEYS.map((k) => k.id),
			["GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "TODOIST_API_TOKEN"],
		);
		for (const k of AUTH_KEYS) {
			assert.ok(k.label.length > 0, `${k.id} has a label`);
			assert.ok(k.description.length > 0, `${k.id} has a description`);
			assert.ok(k.docsUrl.startsWith("https://"), `${k.id} has a docs link`);
		}
		// OPENROUTER_API_KEY graduated to the provider table (owner decision,
		// provider-keys interlude) — not curated anymore. The Google CSE
		// pair retired with its engine (search wave, 2026-09-20).
		assert.ok(!isKnownAuthKey("OPENROUTER_API_KEY"));
		assert.ok(!isKnownAuthKey("GOOGLE_SEARCH_API_KEY"), "the CSE pair is retired");
		assert.ok(!isKnownAuthKey("GOOGLE_CSE_ID"));
	});

	it("isKnownAuthKey: catalog yes, everything else no", () => {
		assert.ok(isKnownAuthKey("GOOGLE_OAUTH_CLIENT_ID"));
		assert.ok(isKnownAuthKey("TODOIST_API_TOKEN"));
		for (const retired of ["DEEPGRAM_API_KEY", "TAVILY_API_KEY", "BRAVE_API_KEY"]) assert.ok(!isKnownAuthKey(retired), `${retired} is retired`);
		assert.ok(!isKnownAuthKey("OPENROUTER_API_KEY"));
		assert.ok(!isKnownAuthKey("OPENAI_API_KEY"), "provider vars are a separate surface");
		assert.ok(!isKnownAuthKey("FUTURE_PLANS_TOKEN"));
		assert.ok(!isKnownAuthKey(""));
	});
});

describe("validateKeyShape (the 400 gate — curated keys)", () => {
	it("Google OAuth client ID: must end with the googleusercontent suffix", () => {
		assert.ok(validateKeyShape("GOOGLE_OAUTH_CLIENT_ID", `${"1".repeat(30)}.apps.googleusercontent.com`).ok);
		assert.ok(!validateKeyShape("GOOGLE_OAUTH_CLIENT_ID", "1".repeat(50)).ok, "wrong family");
	});

	it("Todoist: the 40-hex token", () => {
		assert.ok(validateKeyShape("TODOIST_API_TOKEN", "a".repeat(40)).ok);
		assert.ok(!validateKeyShape("TODOIST_API_TOKEN", "a".repeat(39)).ok, "truncated paste");
	});

	it("trims surrounding paste whitespace before checking", () => {
		assert.ok(validateKeyShape("TODOIST_API_TOKEN", `  ${"d".repeat(40)}  `).ok);
	});

	it("a retired key id is rejected like any unknown one", () => {
		assert.ok(!validateKeyShape("TAVILY_API_KEY", "tvly-abc123def456ghi78").ok);
	});

	it("unknown ids are rejected with the supported list", () => {
		const r = validateKeyShape("SOMETHING_ELSE", "whatever");
		assert.ok(!r.ok);
		if (!r.ok) assert.match(r.error, /SOMETHING_ELSE.*GOOGLE_OAUTH_CLIENT_ID/);
	});
});

describe("genericProviderKeyGuard (model-provider keys — paste hygiene only)", () => {
	it("accepts any ≥12-char whitespace-free value (families vary)", () => {
		assert.deepEqual(genericProviderKeyGuard("OPENROUTER_API_KEY", "sk-or-v1-abc123"), { ok: true });
		assert.deepEqual(genericProviderKeyGuard("OPENAI_API_KEY", "whaterver-value-here"), { ok: true });
		assert.deepEqual(genericProviderKeyGuard("HF_TOKEN", "hf_xxxxxxxx9999"), { ok: true });
	});

	it("rejects truncations and whitespace — the only guards", () => {
		const short = genericProviderKeyGuard("ZAI_API_KEY", "short");
		assert.ok(!short.ok);
		if (!short.ok) assert.match(short.error, /at least 12/);
		assert.ok(!genericProviderKeyGuard("OPENAI_API_KEY", "has whitespace now").ok);
		assert.ok(!genericProviderKeyGuard("OPENAI_API_KEY", "   ").ok);
	});

	it("trims before checking", () => {
		assert.ok(genericProviderKeyGuard("OPENROUTER_API_KEY", "  sk-or-v1-xyz999  ").ok);
	});
});

describe("maskKey (plaintext never leaves)", () => {
	it("shows the last 4 only", () => {
		assert.equal(maskKey("sk-or-v1-abcdefgh1234"), "…1234");
	});

	it("never reveals a degenerate short value in full", () => {
		assert.equal(maskKey("ab"), "…ab");
		assert.equal(maskKey("abcd"), "…abcd");
		assert.equal(maskKey("abcde"), "…bcde");
	});

	it("trims before masking", () => {
		assert.equal(maskKey("  sk-or-v1-xyzw9  "), "…yzw9");
	});
});
