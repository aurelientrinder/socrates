/**
 * Local sync configuration store (data/sync.json): per-device settings
 * (sync folder path, stable deviceId, lastSyncedAt, lastStats). Never
 * included in synced bundles or backups because each device points to
 * its own local iCloud / Dropbox / Google Drive / Syncthing folder.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { SyncStats } from "../core/sync-merge.ts";
import { writeFileAtomic } from "./fs-atomic.ts";

export interface SyncConfigRecord {
	version: 1;
	deviceId: string;
	folder: string | null;
	lastSyncedAt: string | null;
	lastStats: SyncStats | null;
}

function syncFile(): string {
	return path.join(PATHS.data, "sync.json");
}

function newDeviceId(): string {
	return `dev_${crypto.randomBytes(6).toString("hex")}`;
}

export function readSyncConfig(): SyncConfigRecord {
	try {
		const raw = JSON.parse(fs.readFileSync(syncFile(), "utf-8")) as Partial<SyncConfigRecord>;
		if (raw.version === 1 && typeof raw.deviceId === "string" && raw.deviceId) {
			return {
				version: 1,
				deviceId: raw.deviceId,
				folder: typeof raw.folder === "string" && raw.folder.trim() ? raw.folder : null,
				lastSyncedAt: typeof raw.lastSyncedAt === "string" ? raw.lastSyncedAt : null,
				lastStats: raw.lastStats ?? null,
			};
		}
	} catch {
		// first boot
	}
	return { version: 1, deviceId: newDeviceId(), folder: null, lastSyncedAt: null, lastStats: null };
}

export function writeSyncConfig(record: SyncConfigRecord): SyncConfigRecord {
	fs.mkdirSync(PATHS.data, { recursive: true });
	writeFileAtomic(syncFile(), JSON.stringify(record, null, 2));
	return record;
}
