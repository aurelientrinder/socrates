/**
 * The Socrates calendar (google-calendar.ts): the app reads the learner's
 * calendars but writes only to a calendar it made for itself.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lh-socal-"));
process.env.LH_DATA_DIR = TMP;
process.env.LH_AUTH_FILE = path.join(TMP, "auth.json");
process.env.GOOGLE_OAUTH_CLIENT_ID = "id";
process.env.GOOGLE_OAUTH_CLIENT_SECRET = "secret";

const g = await import("../src/server/integrations/google-calendar.ts");
const realFetch = globalThis.fetch;

after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const NARROW = g.GOOGLE_SCOPES.join(" ");
const OLD = "openid email https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events";

function connect(scope: string) {
	fs.writeFileSync(g.CREDENTIALS_FILE, JSON.stringify({ refreshToken: "r", scope, connectedAt: "2026-10-28T00:00:00Z" }));
}

interface Call { method: string; url: string; body?: any }
let calls: Call[];
let existing: { id: string; summary: string; writable: boolean }[];

function fakeGoogle() {
	calls = [];
	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" && url.includes("googleapis.com/calendar") ? JSON.parse(init.body) : undefined;
		calls.push({ method, url, body });
		const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
		if (url.includes("oauth2.googleapis.com/token")) return json({ access_token: "tok", expires_in: 3600 });
		if (url.endsWith("/calendarList?minAccessRole=writer")) return json({ items: existing.map((c) => ({ id: c.id, summary: c.summary })) });
		if (url.endsWith("/calendars") && method === "POST") return json({ id: "made-by-app" });
		const m = /\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url);
		if (m && method === "POST") {
			const cal = existing.find((c) => c.id === decodeURIComponent(m[1]!));
			if (cal && !cal.writable) return json({}, 403);
			return json({ id: "ev1", htmlLink: "https://calendar.google.com/ev1" });
		}
		if (m && method === "DELETE") return new Response(null, { status: 204 });
		if (/\/calendars\/[^/]+$/.test(url) && method === "GET") return json({ id: "made-by-app" });
		return json({}, 404);
	}) as typeof fetch;
}

beforeEach(() => {
	existing = [];
	fs.rmSync(path.join(TMP, "briefing"), { recursive: true, force: true });
	fs.rmSync(g.CREDENTIALS_FILE, { force: true });
	fakeGoogle();
});
afterEach(() => {
	globalThis.fetch = realFetch;
});

const block = { title: "Study: limits", description: "why", start: Date.now() + 3600_000, minutes: 25 };

describe("scopes", () => {
	it("read every calendar's events but write only to calendars the app made", () => {
		assert.ok(g.GOOGLE_SCOPES.includes("https://www.googleapis.com/auth/calendar.events.readonly"));
		assert.ok(g.GOOGLE_SCOPES.includes("https://www.googleapis.com/auth/calendar.app.created"));
		assert.ok(!g.GOOGLE_SCOPES.includes("https://www.googleapis.com/auth/calendar.events"));
		assert.ok(!g.GOOGLE_SCOPES.includes("https://www.googleapis.com/auth/calendar"));
	});
});

describe("the Socrates calendar", () => {
	it("asks a sign-in from before the narrow scopes to reconnect, and writes nothing", async () => {
		connect(OLD);
		assert.equal(g.googleCalendarStatus().needsReconnect, true);
		await assert.rejects(g.createStudyBlock(block), /Reconnect/);
		assert.ok(!calls.some((c) => c.method === "POST"));
	});

	it("makes the calendar once and puts study blocks on it, not on the primary calendar", async () => {
		connect(NARROW);
		assert.equal(g.googleCalendarStatus().needsReconnect, undefined);
		const first = await g.createStudyBlock(block);
		assert.equal(first.url, "https://calendar.google.com/ev1");
		await g.createStudyBlock(block);
		const created = calls.filter((c) => c.url.endsWith("/calendars") && c.method === "POST");
		assert.equal(created.length, 1, "one calendar, reused");
		assert.equal(created[0]!.body.summary, "Socrates");
		const writes = calls.filter((c) => /\/events$/.test(c.url) && c.method === "POST");
		assert.equal(writes.length, 2);
		assert.ok(writes.every((w) => w.url.includes("/calendars/made-by-app/events")));
		assert.ok(!calls.some((c) => c.url.includes("/calendars/primary")));
		assert.equal(writes[0]!.body.extendedProperties.private.socratesBlock, "1");
	});

	it("reuses a Socrates calendar it can already write to", async () => {
		connect(NARROW);
		existing = [{ id: "mine", summary: "Socrates", writable: true }];
		await g.socratesCalendarId();
		assert.equal(await g.socratesCalendarId(), "mine");
		assert.ok(!calls.some((c) => c.url.endsWith("/calendars") && c.method === "POST"));
	});

	it("does not trust a same-named calendar it cannot write to", async () => {
		connect(NARROW);
		existing = [{ id: "by-hand", summary: "Socrates", writable: false }];
		assert.equal(await g.socratesCalendarId(), "made-by-app");
		const made = calls.find((c) => c.url.endsWith("/calendars") && c.method === "POST");
		assert.equal(made!.body.summary, "Socrates (app)");
	});
});

describe("reading events", () => {
	it("skips the app's reminder pings and files its study blocks as neither class nor exam", () => {
		const base = { id: "e", summary: "Exam prep", start: { dateTime: "2026-11-02T10:00:00Z" }, end: { dateTime: "2026-11-02T11:00:00Z" } };
		assert.equal(g.toStudyEvent({ ...base, extendedProperties: { private: { socratesReminder: "1" } } }, "cal"), null);
		assert.equal(g.toStudyEvent({ ...base, extendedProperties: { private: { socratesBlock: "1" } } }, "cal")!.kind, "other");
		assert.equal(g.toStudyEvent(base, "cal")!.kind, undefined);
	});
});
