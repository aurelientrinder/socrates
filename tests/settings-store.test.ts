/**
 * Tests for the settings STORE (settings-storage wave, 2026-09-19):
 * src/store/settings.ts — the record's fs adapter. Writes the real repo
 * data/ files (npm test's shared data/, disposable scratch by doctrine)
 * and cleans up after itself; a pre-existing settings.json is snapshotted
 * and restored so the worktree's own dev state survives the run.
 *
 * (The legacy default-settings.json fold and the chat-section facade died
 * with per-session models, owner 2026-09-28 — sessions own their model
 * from birth, stamped from the strong slot server-side.)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { SETTINGS_FILE } from "../config.ts";
import { dismissSettingsRecovery, readSettings, settingsRecovery, writeSettings } from "../src/store/settings.ts";

// Snapshot any pre-existing record; restore in after() so the worktree's
// own dev state survives a test run.
let hadSettings = false;
let savedSettings = "";
try {
	savedSettings = fs.readFileSync(SETTINGS_FILE, "utf-8");
	hadSettings = true;
} catch {
	/* first boot — nothing to snapshot */
}
after(() => {
	if (hadSettings) fs.writeFileSync(SETTINGS_FILE, savedSettings, "utf-8");
	else fs.rmSync(SETTINGS_FILE, { force: true });
});

afterEach(() => {
	fs.rmSync(SETTINGS_FILE, { force: true });
});

describe("the settings store", () => {
	it("reads null on first boot (no record)", () => {
		fs.rmSync(SETTINGS_FILE, { force: true });
		assert.equal(readSettings(), null);
	});

	it("write→read round-trips through the sanitizer", () => {
		writeSettings({ version: 1, graph: { enabled: false } });
		const out = readSettings();
		assert.ok(out);
		assert.deepEqual(out.graph, { enabled: false });
	});

	it("a chat section on disk is IGNORED — the field died with per-session models (owner, 2026-09-28)", () => {
		fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
		// A fossil `chat` section (the old default-settings record) must not
		// resurrect through the sanitizer — the key is simply gone.
		fs.writeFileSync(
			SETTINGS_FILE,
			JSON.stringify({
				version: 1,
				chat: { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" }, thinkingLevel: "low" },
				graph: { enabled: true },
			}),
			"utf-8",
		);
		const out = readSettings();
		assert.ok(out);
		assert.equal("chat" in out, false, "the chat section never surfaces");
		assert.deepEqual(out.graph, { enabled: true }); // siblings survive
	});

	it("corrupt settings.json with no snapshot → defaults, the damaged copy kept and noted", () => {
		const dir = path.dirname(SETTINGS_FILE);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(SETTINGS_FILE, "{not json", "utf-8");
		const backups = path.join(dir, "backups");
		const hadBackups = fs.existsSync(backups);
		const stash = `${backups}.test-stash`;
		if (hadBackups) fs.renameSync(backups, stash);
		try {
			dismissSettingsRecovery();
			assert.equal(readSettings(), null);
			const note = settingsRecovery();
			assert.ok(note, "the recovery is noted for Today");
			assert.equal(note.restoredFrom, null);
			const kept = path.join(dir, note.keptAs);
			assert.equal(fs.readFileSync(kept, "utf-8"), "{not json", "the damaged bytes are kept, not dropped");
			fs.rmSync(kept);
			assert.equal(fs.existsSync(SETTINGS_FILE), false);
		} finally {
			if (hadBackups) fs.renameSync(stash, backups);
			dismissSettingsRecovery();
		}
	});

	it("corrupt settings.json → the newest readable snapshot is put back", () => {
		const dir = path.dirname(SETTINGS_FILE);
		const backups = path.join(dir, "backups");
		const hadBackups = fs.existsSync(backups);
		const stash = `${backups}.test-stash`;
		if (hadBackups) fs.renameSync(backups, stash);
		try {
			fs.mkdirSync(path.join(backups, "2026-01-01"), { recursive: true });
			fs.mkdirSync(path.join(backups, "2026-01-02"), { recursive: true });
			fs.mkdirSync(path.join(backups, "2026-01-03"), { recursive: true });
			fs.writeFileSync(path.join(backups, "2026-01-01", "settings.json"), JSON.stringify({ version: 1, graph: { enabled: true } }));
			fs.writeFileSync(path.join(backups, "2026-01-02", "settings.json"), JSON.stringify({ version: 1, graph: { enabled: false } }));
			fs.writeFileSync(path.join(backups, "2026-01-03", "settings.json"), "\u0000\u0000"); // damaged too: skipped
			fs.writeFileSync(SETTINGS_FILE, "", "utf-8"); // a half-written file
			dismissSettingsRecovery();
			const out = readSettings();
			assert.ok(out);
			assert.deepEqual(out.graph, { enabled: false }, "the 01-02 snapshot, the newest that reads");
			assert.equal(settingsRecovery()?.restoredFrom, "2026-01-02");
			assert.deepEqual(readSettings()?.graph, { enabled: false }, "written back: the next read is a plain read");
			fs.rmSync(path.join(dir, settingsRecovery()!.keptAs), { force: true });
		} finally {
			fs.rmSync(backups, { recursive: true, force: true });
			if (hadBackups) fs.renameSync(stash, backups);
			dismissSettingsRecovery();
		}
	});
});
