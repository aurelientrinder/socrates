import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";

const { isSafeExternalUrl } = createRequire(import.meta.url)("../electron/external-url.cjs") as {
	isSafeExternalUrl: (target: unknown) => boolean;
};

describe("isSafeExternalUrl", () => {
	it("opens web and mail links", () => {
		for (const u of ["https://example.com/a?b=1", "http://example.com", "mailto:a@b.co"]) assert.equal(isSafeExternalUrl(u), true, u);
	});

	it("refuses anything that can launch a program or reach a file share", () => {
		for (const u of ["file:///C:/Windows/System32/calc.exe", "smb://host/share/x.exe", "ms-msdt:/id", "javascript:alert(1)", "vscode://x", "\\\\host\\share", "not a url", "", undefined]) {
			assert.equal(isSafeExternalUrl(u), false, String(u));
		}
	});
});
