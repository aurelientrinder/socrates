/**
 * Server-side persistence for THE user settings record (settings-storage
 * wave, 2026-09-19): data/settings.json (config.SETTINGS_FILE), under the
 * LH_DATA_DIR seam — read-modify-write, NOT a ledger. Non-secret product
 * preferences only; secrets stay in auth.json / .env.local.
 *
 * This adapter OWNS the lazy migrations:
 *  1. schema-version bumps (CURRENT_SETTINGS_VERSION) slot in here — the
 *     chain is empty today (v1 is the first shape); pure additions never
 *     bump, so an up-to-date file is always a no-op pass-through.
 *    (The legacy default-settings.json fold died with the chat section —
 *     per-session models, owner 2026-09-28.)
 *
 * Everything off disk is sanitized (core/settings.ts) before it reaches a
 * caller; everything written was already validated by the routes
 * (settings-body.ts) and is sanitized here again — the file can never hold
 * a value that would silently shift a knob.
 */

import fs from "node:fs";
import path from "node:path";
import { SETTINGS_FILE } from "../../config.ts";
import {
	sanitizeUserSettings,
	type UserSettings,
} from "../core/settings.ts";
import type { SettingsStore } from "../core/ports.ts";
import { writeFileAtomic } from "./fs-atomic.ts";

/** What happened the last time settings.json could not be read. The file
 *  is never silently dropped: the damaged copy is kept beside it and the
 *  newest daily snapshot that still reads is put back. Shown once on Today
 *  until dismissed (process memory only; the kept copy is the record). */
export interface SettingsRecovery {
	at: string;
	/** File name of the damaged copy, next to settings.json. */
	keptAs: string;
	/** Snapshot day the settings came back from, or null (factory defaults). */
	restoredFrom: string | null;
}

const RECOVERY_KEY = Symbol.for("lh.settingsRecovery");

export function settingsRecovery(): SettingsRecovery | null {
	return ((globalThis as Record<symbol, unknown>)[RECOVERY_KEY] as SettingsRecovery | undefined) ?? null;
}

export function dismissSettingsRecovery(): void {
	delete (globalThis as Record<symbol, unknown>)[RECOVERY_KEY];
}

function parseRecord(raw: string): UserSettings | null {
	try {
		return sanitizeUserSettings(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** Newest backups/<day>/settings.json that still parses. */
function latestGoodSnapshot(): { day: string; record: UserSettings } | null {
	const dir = path.join(path.dirname(SETTINGS_FILE), "backups");
	let days: string[];
	try {
		days = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse();
	} catch {
		return null;
	}
	for (const day of days) {
		try {
			const record = parseRecord(fs.readFileSync(path.join(dir, day, "settings.json"), "utf-8"));
			if (record) return { day, record };
		} catch {
			// no settings in that snapshot
		}
	}
	return null;
}

function recoverFromDamage(now: Date = new Date()): UserSettings | null {
	const stamp = now.toISOString().replace(/[:.]/g, "-");
	const keptAs = `settings.damaged-${stamp}.json`;
	try {
		fs.renameSync(SETTINGS_FILE, path.join(path.dirname(SETTINGS_FILE), keptAs));
	} catch (err) {
		// Could not move it aside: leave the file alone so nothing is lost,
		// and run on defaults for now.
		console.error("[settings] settings.json is unreadable and could not be set aside:", err);
		return null;
	}
	const snapshot = latestGoodSnapshot();
	if (snapshot) writeFileAtomic(SETTINGS_FILE, JSON.stringify(snapshot.record, null, "\t"));
	const recovery: SettingsRecovery = { at: now.toISOString(), keptAs, restoredFrom: snapshot?.day ?? null };
	(globalThis as Record<symbol, unknown>)[RECOVERY_KEY] = recovery;
	console.error(`[settings] settings.json could not be read; kept it as ${keptAs}, ${snapshot ? `restored the ${snapshot.day} snapshot` : "using factory defaults"}.`);
	return snapshot?.record ?? null;
}

/** The persisted record, or null when none exists (first boot). Runs the
 *  migration chain on every read — cheap: a no-op file check when current.
 *  A file that does not parse is set aside and recovered (see
 *  SettingsRecovery), never silently replaced by defaults. */
export function readSettings(): UserSettings | null {
	let raw: string;
	try {
		raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
	} catch {
		return null; // no settings.json yet — first boot, all factory defaults
	}
	const record = parseRecord(raw);
	if (!record) return recoverFromDamage();
	// Version chain (empty today): a future v2 migration slots in here —
	// `if (record.version > CURRENT_SETTINGS_VERSION) …`. Unknown NEWER
	// versions pass through untouched (the sanitizer preserved unknowns).
	return record;
}

/** Persist the record (sanitized). Returns what was written. */
export function writeSettings(raw: unknown): UserSettings {
	const settings = sanitizeUserSettings(raw);
	if (!settings) throw new Error("settings record must be a JSON object");
	fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
	writeFileAtomic(SETTINGS_FILE, JSON.stringify(settings, null, "\t"));
	return settings;
}

/** The typed adapter (core/ports.ts SettingsStore), for the composition root. */
export const settingsStore: SettingsStore = {
	readSettings,
	writeSettings,
};
