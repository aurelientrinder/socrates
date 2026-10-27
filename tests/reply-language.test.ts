/**
 * THE TUTOR'S LANGUAGE (settings agent.replyLanguage, 2026-10-27).
 *
 * - a known code yields the LANGUAGE line, anything else none (automatic);
 * - the record sanitizer keeps a known code and drops an unknown one;
 * - the agent PUT body accepts a known code, rejects an unknown one, and
 *   treats null as "back to automatic";
 * - resolution passes the code through, absent stays absent.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { replyLanguageInstruction, resolveSettings, sanitizeUserSettings } from "../src/core/index.ts";
import { parseAgentSettingsBody } from "../src/server/settings-body.ts";
import { composeReplyLanguage } from "../components/settings/agent-section.tsx";

describe("reply language", () => {
	it("builds the instruction only for a known language", () => {
		assert.match(replyLanguageInstruction("fr") ?? "", /in French/);
		assert.equal(replyLanguageInstruction(null), null);
		assert.equal(replyLanguageInstruction("klingon"), null);
	});

	it("sanitizes the stored record leniently", () => {
		assert.equal(sanitizeUserSettings({ version: 1, agent: { replyLanguage: "de" } })?.agent?.replyLanguage, "de");
		assert.equal(sanitizeUserSettings({ version: 1, agent: { replyLanguage: "zz" } })?.agent?.replyLanguage, undefined);
	});

	it("validates the PUT body strictly", () => {
		const ok = parseAgentSettingsBody({ replyLanguage: "es" });
		assert.ok(ok.ok && ok.settings.replyLanguage === "es");
		const bad = parseAgentSettingsBody({ replyLanguage: "zz" });
		assert.ok(!bad.ok && /replyLanguage must be one of/.test(bad.error));
		const reset = parseAgentSettingsBody({ replyLanguage: null });
		assert.ok(reset.ok && reset.settings.replyLanguage === undefined);
	});

	it("resolves as stored", () => {
		assert.equal(resolveSettings({ version: 1, agent: { replyLanguage: "it" } }).agent.replyLanguage, "it");
		assert.equal(resolveSettings(null).agent.replyLanguage, undefined);
	});

	it("composes the agent section without touching other keys", () => {
		const agent = { tools: { research: false } };
		assert.deepEqual(composeReplyLanguage(agent, "fr"), { tools: { research: false }, replyLanguage: "fr" });
		assert.deepEqual(composeReplyLanguage({ ...agent, replyLanguage: "fr" }, null), agent);
	});
});
