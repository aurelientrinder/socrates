import { timingSafeEqual } from "node:crypto";

/** Per-launch desktop HTTP capability. This is not an OS-user malware
 * boundary and is not an OAuth credential.
 *
 * Browser-only mode (`npm run dev`, no desktop secret) used to accept every
 * request. It now accepts only loopback requests: the Host must be
 * localhost / 127.0.0.1 / [::1] (stops other machines on the network and DNS
 * rebinding) and an Origin, when the browser sends one, must be a loopback
 * origin too (stops other web sites posting to the API from your browser).
 * `LH_ALLOW_REMOTE_API=1` restores the old open behaviour for anyone who
 * deliberately serves the app to another device. */
export function desktopAPIAuthorized(
	headers: Headers,
	env: Record<string, string | undefined> = process.env,
): boolean {
	const expected = env.LH_DESKTOP_API_SECRET;
	if (env.LH_DESKTOP_SERVER !== "1" && !expected) return browserRequestIsLocal(headers, env);
	if (!expected || expected.length < 64) return false;
	const supplied = headers.get("x-learnharness-desktop");
	if (!supplied) return false;
	const actual = Buffer.from(supplied);
	const wanted = Buffer.from(expected);
	return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** "localhost:3000" → "localhost"; "[::1]:3000" → "[::1]". */
function hostnameOf(host: string): string {
	const value = host.trim().toLowerCase();
	if (value.startsWith("[")) {
		const end = value.indexOf("]");
		return end === -1 ? value : value.slice(0, end + 1);
	}
	const colon = value.lastIndexOf(":");
	return colon === -1 ? value : value.slice(0, colon);
}

export function isLoopbackHost(host: string | null | undefined): boolean {
	if (!host) return false;
	const name = hostnameOf(host);
	return LOOPBACK_HOSTS.has(name) || name.endsWith(".localhost");
}

function browserRequestIsLocal(headers: Headers, env: Record<string, string | undefined>): boolean {
	if (env.LH_ALLOW_REMOTE_API === "1") return true;
	if (!isLoopbackHost(headers.get("host"))) return false;
	const origin = headers.get("origin");
	if (origin === null) return true; // same-origin GET/HEAD, curl, server-side self calls
	if (origin === "null") return false; // sandboxed iframe / file: page
	try {
		const url = new URL(origin);
		return (url.protocol === "http:" || url.protocol === "https:") && isLoopbackHost(url.host);
	} catch {
		return false;
	}
}
