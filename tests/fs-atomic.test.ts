/**
 * Atomic writes survive Windows briefly holding a file open: rename()
 * failing with EPERM/EBUSY/EACCES is retried, anything else is not.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renameWithRetry, writeFileAtomic } from "../src/store/fs-atomic.ts";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-atomic-"));
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

function failing(code: string, times: number) {
	let calls = 0;
	return {
		calls: () => calls,
		rename: (from: string, to: string) => {
			calls++;
			if (calls <= times) throw Object.assign(new Error(code), { code });
			fs.renameSync(from, to);
		},
	};
}

describe("renameWithRetry", () => {
	it("retries a busy target and then lands the rename", () => {
		const from = path.join(TMP, "new.json");
		const to = path.join(TMP, "a.json");
		fs.writeFileSync(from, "new");
		fs.writeFileSync(to, "old");
		const f = failing("EPERM", 2);
		renameWithRetry(from, to, f.rename);
		assert.equal(f.calls(), 3);
		assert.equal(fs.readFileSync(to, "utf-8"), "new");
	});

	it("gives up after a few tries and never retries other errors", () => {
		const busy = failing("EBUSY", 99);
		assert.throws(() => renameWithRetry("x", "y", busy.rename), /EBUSY/);
		assert.equal(busy.calls(), 6);
		const missing = failing("ENOENT", 99);
		assert.throws(() => renameWithRetry("x", "y", missing.rename), /ENOENT/);
		assert.equal(missing.calls(), 1);
	});

	it("writeFileAtomic still replaces the file", () => {
		const file = path.join(TMP, "b.json");
		writeFileAtomic(file, "one");
		writeFileAtomic(file, "two");
		assert.equal(fs.readFileSync(file, "utf-8"), "two");
		assert.deepEqual(fs.readdirSync(TMP).filter((f) => f.includes(".tmp-")), []);
	});
});
