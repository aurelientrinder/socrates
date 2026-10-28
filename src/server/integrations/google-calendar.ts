/**
 * GOOGLE CALENDAR — sign-in and event reads/writes for the daily briefing.
 *
 * Sign-in is the installed-app OAuth flow Google documents for desktop
 * clients: authorization code + PKCE (S256) with a loopback redirect on a
 * one-shot 127.0.0.1 listener. It
 * deliberately does NOT redirect into the app's own /api surface: that
 * surface requires the per-launch desktop capability header, which a
 * browser redirect never carries.
 *
 * The OAuth client is the learner's own (a "Desktop app" client in their
 * Google Cloud project): its ID and secret live in auth.json via the keys
 * catalog (GOOGLE_OAUTH_CLIENT_ID / _SECRET). Google requires the secret
 * for desktop clients even with PKCE; it is not treated as confidential by
 * Google, but it is never committed or sent anywhere but Google's token
 * endpoint. The refresh token lives in its own 0600 file beside auth.json
 * (not in auth.json, which would reflect it into process.env); access
 * tokens stay in memory only.
 *
 * Scopes: read the calendar list, read/write events (study blocks are only
 * written on an explicit click), and openid email to show who is signed in.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { AUTH_FILE } from "../../../config.ts";
import type { StudyEvent } from "../../core/briefing.ts";
import { keyValue } from "../keys.ts";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const GOOGLE_SCOPES = [
	"openid",
	"email",
	"https://www.googleapis.com/auth/calendar.calendarlist.readonly",
	"https://www.googleapis.com/auth/calendar.events",
];
const CALLBACK_PATH = "/oauth2/callback";
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

export const CREDENTIALS_FILE = path.join(path.dirname(AUTH_FILE), "google-calendar.json");

interface StoredCredentials {
	refreshToken: string;
	email?: string;
	scope?: string;
	connectedAt: string;
}

export interface GoogleCalendarStatus {
	/** Client ID and secret are saved in Settings → Keys. */
	configured: boolean;
	connected: boolean;
	email?: string;
	/** A sign-in is waiting for the browser. */
	pending: boolean;
	/** The last sign-in or API failure, in plain words. */
	error?: string;
}

// ─── Credential file (0600, atomic) ─────────────────────────────────────────

function readCredentials(): StoredCredentials | null {
	try {
		const raw = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf-8"));
		return raw && typeof raw.refreshToken === "string" && raw.refreshToken ? (raw as StoredCredentials) : null;
	} catch {
		return null;
	}
}

function writeCredentials(creds: StoredCredentials): void {
	const dir = path.dirname(CREDENTIALS_FILE);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `.google-calendar.json.tmp-${process.pid}`);
	fs.writeFileSync(tmp, `${JSON.stringify(creds, null, "\t")}\n`, { mode: 0o600 });
	fs.chmodSync(tmp, 0o600);
	fs.renameSync(tmp, CREDENTIALS_FILE);
}

function deleteCredentials(): void {
	try {
		fs.unlinkSync(CREDENTIALS_FILE);
	} catch {
		// absent = already disconnected
	}
}

// ─── Process state (globalThis: survives HMR re-imports) ────────────────────

interface GoogleState {
	pending: { close: () => void } | null;
	error?: string;
	access?: { token: string; expiresAt: number };
}
const STATE_KEY = Symbol.for("lh.googleCalendar");
function state(): GoogleState {
	const g = globalThis as Record<symbol, GoogleState | undefined>;
	if (!g[STATE_KEY]) g[STATE_KEY] = { pending: null };
	return g[STATE_KEY];
}

function client(): { id: string; secret: string } | null {
	const id = keyValue("GOOGLE_OAUTH_CLIENT_ID")?.trim();
	const secret = keyValue("GOOGLE_OAUTH_CLIENT_SECRET")?.trim();
	return id && secret ? { id, secret } : null;
}

export function googleCalendarStatus(): GoogleCalendarStatus {
	const creds = readCredentials();
	const s = state();
	return {
		configured: client() !== null,
		connected: creds !== null,
		...(creds?.email ? { email: creds.email } : {}),
		pending: s.pending !== null,
		...(s.error ? { error: s.error } : {}),
	};
}

const base64url = (buf: Buffer) => buf.toString("base64url");

/** The email claim of an id_token received straight from Google's token
 *  endpoint over TLS (OIDC Core 3.1.3.7: no signature check needed there). */
function emailFromIdToken(idToken: unknown): string | undefined {
	if (typeof idToken !== "string") return undefined;
	try {
		const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf-8"));
		return typeof payload.email === "string" ? payload.email : undefined;
	} catch {
		return undefined;
	}
}

async function postForm(url: string, form: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(form).toString(),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: res.status, body };
}

/**
 * Start a sign-in: opens a one-shot loopback listener and returns the
 * Google consent URL for the shell to open in the real browser. The
 * listener closes after one valid callback, a cancel, or five minutes.
 */
export async function startGoogleSignIn(): Promise<{ ok: true; authUrl: string } | { ok: false; error: string }> {
	const c = client();
	if (!c) return { ok: false, error: "Add your Google OAuth client ID and secret in Settings → Keys first." };
	const s = state();
	s.pending?.close();
	s.error = undefined;

	const verifier = base64url(randomBytes(48));
	const challenge = base64url(createHash("sha256").update(verifier).digest());
	const expectedState = base64url(randomBytes(24));
	const server = http.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const port = (server.address() as { port: number }).port;
	const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
	let consumed = false;
	const timer = setTimeout(() => {
		if (!consumed) s.error = "Sign-in timed out. Try again.";
		close();
	}, SIGN_IN_TIMEOUT_MS);
	function close() {
		clearTimeout(timer);
		server.close();
		server.closeAllConnections();
		if (s.pending === handle) s.pending = null;
	}
	const handle = { close };
	s.pending = handle;

	server.on("request", (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		res.setHeader("Content-Security-Policy", "default-src 'none'");
		res.setHeader("Referrer-Policy", "no-referrer");
		let url: URL;
		try {
			url = new URL(req.url || "/", redirectUri);
		} catch {
			res.writeHead(400).end();
			return;
		}
		if (req.method !== "GET" || url.pathname !== CALLBACK_PATH || req.headers.host !== `127.0.0.1:${port}` || consumed) {
			res.writeHead(404).end();
			return;
		}
		const params = url.searchParams;
		if (["state", "code", "error"].some((k) => params.getAll(k).length > 1) || params.get("state") !== expectedState) {
			res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Sign-in could not be verified.");
			return;
		}
		consumed = true;
		res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(
			"Socrates: you can close this tab and go back to the app.",
		);
		close();
		const code = params.get("code");
		if (params.has("error") || !code) {
			s.error = params.get("error") === "access_denied" ? "Sign-in was cancelled." : "Google refused the sign-in.";
			return;
		}
		void (async () => {
			try {
				const { status, body } = await postForm(TOKEN_ENDPOINT, {
					grant_type: "authorization_code",
					code,
					code_verifier: verifier,
					redirect_uri: redirectUri,
					client_id: c.id,
					client_secret: c.secret,
				});
				const refreshToken = body.refresh_token;
				if (status !== 200 || typeof refreshToken !== "string" || typeof body.access_token !== "string") {
					s.error = `Google did not complete the sign-in (${typeof body.error === "string" ? body.error : status}).`;
					return;
				}
				writeCredentials({
					refreshToken,
					email: emailFromIdToken(body.id_token),
					scope: typeof body.scope === "string" ? body.scope : undefined,
					connectedAt: new Date().toISOString(),
				});
				const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
				s.access = { token: body.access_token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
			} catch {
				s.error = "Could not reach Google to finish the sign-in.";
			}
		})();
	});

	const authUrl = new URL(AUTH_ENDPOINT);
	authUrl.search = new URLSearchParams({
		client_id: c.id,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: GOOGLE_SCOPES.join(" "),
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: expectedState,
		// A refresh token every time, so a reconnect never ends up without one.
		access_type: "offline",
		prompt: "consent",
	}).toString();
	return { ok: true, authUrl: authUrl.toString() };
}

export function cancelGoogleSignIn(): void {
	state().pending?.close();
}

/** Disconnect: revoke at Google (best effort) and forget the token. */
export async function disconnectGoogle(): Promise<void> {
	const creds = readCredentials();
	const s = state();
	s.access = undefined;
	s.error = undefined;
	deleteCredentials();
	if (creds) {
		await postForm(REVOKE_ENDPOINT, { token: creds.refreshToken }).catch(() => undefined);
	}
}

class GoogleAuthError extends Error {}

async function accessToken(): Promise<string> {
	const s = state();
	if (s.access && s.access.expiresAt > Date.now()) return s.access.token;
	const creds = readCredentials();
	const c = client();
	if (!creds) throw new GoogleAuthError("Google Calendar is not connected.");
	if (!c) throw new GoogleAuthError("The Google OAuth client ID or secret is missing in Settings → Keys.");
	const { status, body } = await postForm(TOKEN_ENDPOINT, {
		grant_type: "refresh_token",
		refresh_token: creds.refreshToken,
		client_id: c.id,
		client_secret: c.secret,
	});
	if (status !== 200 || typeof body.access_token !== "string") {
		if (body.error === "invalid_grant") {
			// Revoked, expired (Testing-mode clients expire tokens after 7 days), or password changed.
			deleteCredentials();
			s.error = "Google sign-in expired. Connect again.";
		}
		throw new GoogleAuthError(`Google token refresh failed (${typeof body.error === "string" ? body.error : status}).`);
	}
	const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
	s.access = { token: body.access_token, expiresAt: Date.now() + (expiresIn - 60) * 1000 };
	return body.access_token;
}

async function api<T>(pathAndQuery: string, init?: { method?: string; body?: unknown }): Promise<T> {
	const token = await accessToken();
	const res = await fetch(`${CALENDAR_API}${pathAndQuery}`, {
		method: init?.method ?? "GET",
		headers: {
			Authorization: `Bearer ${token}`,
			...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (res.status === 401) state().access = undefined;
	if (!res.ok) throw new Error(`Google Calendar request failed (${res.status}).`);
	return (await res.json()) as T;
}

interface GoogleCalendarListEntry {
	id: string;
	summary?: string;
	selected?: boolean;
	primary?: boolean;
	accessRole?: string;
}

interface GoogleEvent {
	id: string;
	status?: string;
	summary?: string;
	htmlLink?: string;
	start?: { date?: string; dateTime?: string };
	end?: { date?: string; dateTime?: string };
	transparency?: string;
}

/** A date-only value ("2026-11-03") as local midnight; a dateTime as itself. */
function eventTime(t: { date?: string; dateTime?: string } | undefined): number | null {
	if (!t) return null;
	if (t.dateTime) {
		const ms = Date.parse(t.dateTime);
		return Number.isFinite(ms) ? ms : null;
	}
	if (t.date) {
		const [y, m, d] = t.date.split("-").map(Number);
		return y && m && d ? new Date(y, m - 1, d).getTime() : null;
	}
	return null;
}

export function toStudyEvent(e: GoogleEvent, calendarId: string): StudyEvent | null {
	if (e.status === "cancelled" || !e.summary) return null;
	const start = eventTime(e.start);
	const end = eventTime(e.end) ?? start;
	if (start === null || end === null) return null;
	return {
		id: `gcal:${calendarId}:${e.id}`,
		title: e.summary,
		start,
		end,
		allDay: !e.start?.dateTime,
		source: "calendar",
		...(e.htmlLink ? { url: e.htmlLink } : {}),
	};
}

/** Pages of events read per calendar (250 each). */
const MAX_EVENT_PAGES = 4;

/**
 * Events in [from, to] from every calendar the learner shows in Google
 * Calendar (calendarList `selected`), with recurring events expanded by
 * Google (singleEvents). Holiday and other read-only subscribed calendars
 * ride along when shown; their events classify as "other" and drop out.
 */
export async function listCalendarEvents(from: number, to: number): Promise<StudyEvent[]> {
	const list = await api<{ items?: GoogleCalendarListEntry[] }>("/users/me/calendarList?minAccessRole=reader");
	const calendars = (list.items ?? []).filter((c) => c.selected || c.primary);
	const out: StudyEvent[] = [];
	for (const cal of calendars) {
		// Five weeks of a class timetable can pass one page: follow the page tokens (bounded).
		let pageToken: string | undefined;
		for (let pages = 0; pages < MAX_EVENT_PAGES; pages++) {
			const query = new URLSearchParams({
				timeMin: new Date(from).toISOString(),
				timeMax: new Date(to).toISOString(),
				singleEvents: "true",
				orderBy: "startTime",
				maxResults: "250",
				...(pageToken ? { pageToken } : {}),
			});
			const page = await api<{ items?: GoogleEvent[]; nextPageToken?: string }>(`/calendars/${encodeURIComponent(cal.id)}/events?${query}`);
			for (const e of page.items ?? []) {
				const ev = toStudyEvent(e, cal.id);
				if (ev) out.push(ev);
			}
			pageToken = page.nextPageToken;
			if (!pageToken) break;
		}
	}
	return out.sort((a, b) => a.start - b.start);
}

/** Write one study block on the primary calendar (explicit click only). */
export async function createStudyBlock(input: { title: string; description: string; start: number; minutes: number }): Promise<{ url?: string }> {
	const event = await api<GoogleEvent>("/calendars/primary/events", {
		method: "POST",
		body: {
			summary: input.title,
			description: input.description,
			start: { dateTime: new Date(input.start).toISOString() },
			end: { dateTime: new Date(input.start + input.minutes * 60_000).toISOString() },
			reminders: { useDefault: true },
		},
	});
	return event.htmlLink ? { url: event.htmlLink } : {};
}

export { GoogleAuthError };
