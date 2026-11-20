/**
 * ENCRYPTED LOCAL-FIRST FOLDER SYNC (AES-256-GCM + scrypt):
 * Reads/writes one authenticated encrypted bundle (`socrates-sync.enc.json`)
 * in any user-chosen synced folder (iCloud Drive, Dropbox, Google Drive,
 * Syncthing), merging local and remote state deterministically via
 * `src/core/sync-merge.ts`.
 *
 * Security invariants:
 *   - Passphrase never touches disk or the synced bundle.
 *   - Wrong passphrase or tampered ciphertext aborts before touching local or
 *     remote files.
 *   - `auth.json` (API keys) and raw PDF originals are never synced.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PATHS, SETTINGS_FILE } from "../../config.ts";
import { emit } from "../core/events.ts";
import { mergeSyncFiles, type SyncBundlePayload, type SyncStats, type SyncStatus } from "../core/sync-merge.ts";
import { writeFileAtomic } from "../store/fs-atomic.ts";
import { readSyncConfig, writeSyncConfig } from "../store/sync.ts";
import { DATA_FOLDERS } from "./backup.ts";

export const SYNC_BUNDLE_FILENAME = "socrates-sync.enc.json";
const MIN_PASSPHRASE_LENGTH = 6;

export class SyncError extends Error {}

interface EncryptedEnvelope {
	app: "socrates-sync";
	version: 1;
	kdf: "scrypt";
	cipher: "aes-256-gcm";
	salt: string;
	iv: string;
	tag: string;
	ciphertext: string;
}

/** Encrypt a SyncBundlePayload into a portable authenticated JSON envelope. */
export function encryptSyncBundle(payload: SyncBundlePayload, passphrase: string): string {
	if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
		throw new SyncError(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
	}
	const salt = crypto.randomBytes(16);
	const iv = crypto.randomBytes(12);
	const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
	const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
	const plaintext = Buffer.from(JSON.stringify(payload), "utf-8");
	const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	const env: EncryptedEnvelope = {
		app: "socrates-sync",
		version: 1,
		kdf: "scrypt",
		cipher: "aes-256-gcm",
		salt: salt.toString("base64"),
		iv: iv.toString("base64"),
		tag: tag.toString("base64"),
		ciphertext: encrypted.toString("base64"),
	};
	return JSON.stringify(env);
}

/** Decrypt and authenticate a SyncBundlePayload envelope. */
export function decryptSyncBundle(raw: string, passphrase: string): SyncBundlePayload {
	let env: Partial<EncryptedEnvelope>;
	try {
		env = JSON.parse(raw) as Partial<EncryptedEnvelope>;
	} catch {
		throw new SyncError("Sync bundle is not valid JSON.");
	}
	if (
		env.app !== "socrates-sync" ||
		env.version !== 1 ||
		env.cipher !== "aes-256-gcm" ||
		typeof env.salt !== "string" ||
		typeof env.iv !== "string" ||
		typeof env.tag !== "string" ||
		typeof env.ciphertext !== "string"
	) {
		throw new SyncError("Unrecognized sync bundle format.");
	}
	try {
		const salt = Buffer.from(env.salt, "base64");
		const iv = Buffer.from(env.iv, "base64");
		const tag = Buffer.from(env.tag, "base64");
		const ciphertext = Buffer.from(env.ciphertext, "base64");
		const key = crypto.scryptSync(passphrase, salt, 32, { N: 16384, r: 8, p: 1 });
		const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
		decipher.setAuthTag(tag);
		const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
		const payload = JSON.parse(decrypted) as Partial<SyncBundlePayload>;
		if (payload.app !== "socrates" || payload.format !== 1 || !payload.files || typeof payload.files !== "object") {
			throw new SyncError("Decrypted sync payload is invalid.");
		}
		return payload as SyncBundlePayload;
	} catch (err) {
		if (err instanceof SyncError) throw err;
		throw new SyncError("Wrong passphrase or corrupted sync bundle.");
	}
}

function expandHome(p: string): string {
	const trimmed = p.trim();
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return path.join(os.homedir(), trimmed.slice(2));
	return path.resolve(trimmed);
}

function collectWithMtimes(
	dir: string,
	rel: string,
	files: Record<string, string>,
	mtimes: Record<string, number>,
): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		if (e.name.includes(".tmp-")) continue;
		const full = path.join(dir, e.name);
		const name = `${rel}/${e.name}`;
		if (e.isDirectory()) collectWithMtimes(full, name, files, mtimes);
		else if (e.isFile() && /\.(json|jsonl)$/.test(e.name)) {
			try {
				files[name] = fs.readFileSync(full, "utf-8");
				mtimes[name] = fs.statSync(full).mtimeMs;
			} catch {
				// skip unreadable
			}
		}
	}
}

function readLocalSyncSnapshot(): { files: Record<string, string>; mtimes: Record<string, number> } {
	const files: Record<string, string> = {};
	const mtimes: Record<string, number> = {};
	for (const folder of DATA_FOLDERS) {
		if (folder === "digests") continue;
		collectWithMtimes(path.join(PATHS.data, folder), folder, files, mtimes);
	}
	for (const [rel, full] of [
		["settings.json", SETTINGS_FILE],
		["fsrs-weights.json", path.join(PATHS.data, "fsrs-weights.json")],
	] as const) {
		try {
			files[rel] = fs.readFileSync(full, "utf-8");
			mtimes[rel] = fs.statSync(full).mtimeMs;
		} catch {
			// absent
		}
	}
	return { files, mtimes };
}

const ALLOWED_TOP = new Set<string>([
	...DATA_FOLDERS.filter((f) => f !== "digests"),
	"settings.json",
	"fsrs-weights.json",
]);

function safeTargetPath(rel: string): string | null {
	if (!rel || rel.includes("..") || path.isAbsolute(rel)) return null;
	const top = rel.split("/")[0];
	if (!top || !ALLOWED_TOP.has(top)) return null;
	if (!/\.(json|jsonl)$/.test(rel)) return null;
	const target = rel === "settings.json" ? SETTINGS_FILE : path.resolve(PATHS.data, rel);
	if (rel !== "settings.json" && !target.startsWith(path.resolve(PATHS.data) + path.sep)) return null;
	return target;
}

export function syncStatus(): SyncStatus {
	const cfg = readSyncConfig();
	return {
		configured: Boolean(cfg.folder),
		folder: cfg.folder,
		deviceId: cfg.deviceId,
		lastSyncedAt: cfg.lastSyncedAt,
		lastStats: cfg.lastStats,
	};
}

export function configureSyncFolder(folder: string | null): SyncStatus {
	const cfg = readSyncConfig();
	const resolved = folder && folder.trim() ? expandHome(folder) : null;
	if (resolved) fs.mkdirSync(resolved, { recursive: true });
	writeSyncConfig({ ...cfg, folder: resolved });
	return syncStatus();
}

/**
 * Run a full two-way encrypted sync against the configured folder (or an
 * explicit override folder for testing). Returns updated status and stats.
 */
export function runFolderSync(
	passphrase: string,
	opts: { folder?: string; now?: Date } = {},
): { status: SyncStatus; stats: SyncStats } {
	const cfg = readSyncConfig();
	const folder = opts.folder ? expandHome(opts.folder) : cfg.folder;
	if (!folder) throw new SyncError("Choose a sync folder first (e.g. an iCloud Drive, Dropbox, or Syncthing folder).");
	if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
		throw new SyncError(`Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
	}
	fs.mkdirSync(folder, { recursive: true });

	const bundlePath = path.join(folder, SYNC_BUNDLE_FILENAME);
	let remote: SyncBundlePayload | null = null;
	if (fs.existsSync(bundlePath)) {
		const raw = fs.readFileSync(bundlePath, "utf-8");
		remote = decryptSyncBundle(raw, passphrase);
	}

	const local = readLocalSyncSnapshot();
	const merged = remote
		? mergeSyncFiles(local.files, remote.files, { localMtimes: local.mtimes, remoteMtimes: remote.mtimes })
		: {
				files: local.files,
				stats: { added: 0, updated: 0, mergedDecks: 0, mergedLedgers: 0, unchanged: Object.keys(local.files).length },
			};

	// Write changed/added files locally.
	for (const [rel, text] of Object.entries(merged.files)) {
		if (local.files[rel] === text) continue;
		const target = safeTargetPath(rel);
		if (!target) continue;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		writeFileAtomic(target, text);
	}

	// Re-snapshot mtimes and write encrypted merged bundle to the sync folder.
	const now = (opts.now ?? new Date()).toISOString();
	const nextMtimes: Record<string, number> = { ...local.mtimes };
	for (const rel of Object.keys(merged.files)) {
		const target = safeTargetPath(rel);
		if (!target) continue;
		try {
			nextMtimes[rel] = fs.statSync(target).mtimeMs;
		} catch {
			nextMtimes[rel] = Date.now();
		}
	}
	const outPayload: SyncBundlePayload = {
		app: "socrates",
		format: 1,
		exportedAt: now,
		deviceId: cfg.deviceId,
		files: merged.files,
		mtimes: nextMtimes,
	};
	writeFileAtomic(bundlePath, encryptSyncBundle(outPayload, passphrase));

	writeSyncConfig({
		...cfg,
		folder,
		lastSyncedAt: now,
		lastStats: merged.stats,
	});
	emit("chats-changed", {});
	emit("activity-changed", {});
	return { status: syncStatus(), stats: merged.stats };
}
