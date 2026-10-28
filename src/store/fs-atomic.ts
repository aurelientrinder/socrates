/**
 * Write-then-rename for the JSON records a crash must never half-write:
 * the bytes land in a sibling temp file and rename() swaps it in, so a
 * reader (or the next launch) sees the old file or the whole new one.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRY_WAITS_MS = [10, 25, 60, 120, 250];

/** rename() that survives Windows briefly holding the target open
 *  (antivirus, the search indexer, OneDrive): EPERM, EBUSY and EACCES are
 *  retried a few times before the error is let through. */
export function renameWithRetry(from: string, to: string, rename: (from: string, to: string) => void = fs.renameSync): void {
	for (let attempt = 0; ; attempt++) {
		try {
			rename(from, to);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			const wait = RETRY_WAITS_MS[attempt];
			if (wait === undefined || !code || !RETRY_CODES.has(code)) throw err;
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
		}
	}
}

export function writeFileAtomic(file: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
	const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
		renameWithRetry(tmp, file);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
}
