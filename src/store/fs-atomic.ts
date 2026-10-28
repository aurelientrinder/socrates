/**
 * Write-then-rename for the JSON records a crash must never half-write:
 * the bytes land in a sibling temp file and rename() swaps it in, so a
 * reader (or the next launch) sees the old file or the whole new one.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";

export function writeFileAtomic(file: string, data: string | Uint8Array, opts: { mode?: number } = {}): void {
	const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
	try {
		fs.writeFileSync(tmp, data, opts.mode === undefined ? undefined : { mode: opts.mode });
		fs.renameSync(tmp, file);
	} catch (err) {
		fs.rmSync(tmp, { force: true });
		throw err;
	}
}
