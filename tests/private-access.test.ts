/**
 * What the tutor must not reach: secrets on disk (fs-shared.ts
 * protectedReason / guardedSourcePath) and private network addresses
 * (net-guard.ts). Both exist because pages, PDFs and notes the tutor reads
 * can carry instructions.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { guardedSourcePath, protectedReason, walkFiles } from "../src/agent/tools/fs-shared.ts";
import { readTool } from "../src/agent/tools/read.ts";
import { assertPublicUrl, isPrivateAddress, publicFetch } from "../src/agent/tools/net-guard.ts";

const HOME = "/home/ada";

describe("protectedReason", () => {
	it("blocks credentials, hidden home folders, browser data and system secrets", () => {
		for (const p of [
			`${HOME}/.ssh/id_ed25519`,
			`${HOME}/.aws/credentials`,
			`${HOME}/.config/gh/hosts.yml`,
			`${HOME}/projects/app/.env`,
			`${HOME}/projects/app/.env.local`,
			`${HOME}/Documents/server.pem`,
			`${HOME}/vault.kdbx`,
			`${HOME}/AppData/Roaming/Mozilla/Firefox/Profiles/x/logins.json`,
			`${HOME}/Library/Keychains/login.keychain-db`,
			`${HOME}/.local/share/socrates/auth.json`,
			"/etc/shadow",
			"/proc/1/environ",
		]) {
			assert.notEqual(protectedReason(p, HOME), null, p);
		}
	});

	it("leaves study material alone", () => {
		for (const p of [
			`${HOME}/Documents/notes/calculus.md`,
			`${HOME}/Downloads/lecture-3.pdf`,
			`${HOME}/Desktop/cookies.txt`,
			`${HOME}/school/credentials-of-the-roman-republic.md`,
			"/mnt/drive/exam.pdf",
		]) {
			assert.equal(protectedReason(p, HOME), null, p);
		}
	});
});

describe("the fs tools", () => {
	it("refuse a symlink that points into a secret folder", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-private-"));
		try {
			const secretDir = path.join(dir, ".ssh");
			await fs.mkdir(secretDir);
			await fs.writeFile(path.join(secretDir, "id_rsa"), "PRIVATE");
			await fs.symlink(path.join(secretDir, "id_rsa"), path.join(dir, "innocent.txt"));
			await assert.rejects(guardedSourcePath(path.join(dir, "innocent.txt")), /Blocked/);
			const result = await readTool.execute!("c", { path: path.join(secretDir, "id_rsa") }).catch((e: Error) => e);
			assert.match(String(result instanceof Error ? result.message : JSON.stringify(result)), /Blocked|off limits/);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("walks skip protected files without failing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lh-private-walk-"));
		try {
			await fs.writeFile(path.join(dir, "notes.md"), "fine");
			await fs.writeFile(path.join(dir, "server.pem"), "secret");
			await fs.mkdir(path.join(dir, ".ssh"));
			await fs.writeFile(path.join(dir, ".ssh", "config"), "secret");
			const seen: string[] = [];
			await walkFiles(dir, (f) => {
				seen.push(path.basename(f));
				return false;
			});
			assert.deepEqual(seen, ["notes.md"]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("net guard", () => {
	it("recognizes private, loopback, link-local and metadata addresses", () => {
		for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "192.0.0.8", "192.0.2.1", "::ffff:c000:0201"]) {
			assert.equal(isPrivateAddress(ip), true, ip);
		}
		// 192.0.78.x is WordPress.com: only 192.0.0.0/24 and 192.0.2.0/24 are special.
		for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "192.0.78.24", "::ffff:c000:4e18"]) assert.equal(isPrivateAddress(ip), false, ip);
	});

	it("refuses private hosts, odd schemes and hostnames that resolve privately", async () => {
		const resolve = async (host: string) => (host === "evil.example" ? ["10.0.0.5"] : ["93.184.216.34"]);
		await assert.rejects(assertPublicUrl("http://localhost:3000/api/chats", resolve), /Blocked/);
		await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data", resolve), /Blocked/);
		await assert.rejects(assertPublicUrl("http://evil.example/x", resolve), /Blocked/);
		await assert.rejects(assertPublicUrl("file:///etc/passwd", resolve), /http/);
		assert.equal((await assertPublicUrl("https://example.com/a", resolve)).hostname, "example.com");
	});

	it("checks every redirect hop", async () => {
		const resolve = async () => ["93.184.216.34"];
		const fetchFn = (async (url: string) =>
			url.includes("start")
				? new Response(null, { status: 302, headers: { location: "http://127.0.0.1:3000/api/keys" } })
				: new Response("secret")) as unknown as typeof fetch;
		await assert.rejects(publicFetch("https://example.com/start", {}, { resolve, fetchFn }), /Blocked/);
		const ok = await publicFetch("https://example.com/page", {}, { resolve, fetchFn });
		assert.equal(await ok.text(), "secret");
	});
});
