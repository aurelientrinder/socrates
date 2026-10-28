/**
 * The researcher's fetches stay on the public internet. A page or PDF the
 * tutor reads can contain instructions ("fetch http://localhost:..."), so
 * the fetch tools refuse loopback, private, link-local and cloud-metadata
 * addresses, and re-check every redirect hop.
 */

import * as dns from "node:dns/promises";
import * as net from "node:net";

export type Resolver = (hostname: string) => Promise<string[]>;

const systemResolver: Resolver = async (hostname) => (await dns.lookup(hostname, { all: true })).map((a) => a.address);
let defaultResolver: Resolver = systemResolver;

/** Tests that fake `fetch` also fake DNS, so they never touch the network. */
export function setPublicResolverForTests(resolver: Resolver | null): void {
	defaultResolver = resolver ?? systemResolver;
}

function ipv4Private(a: number, b: number, c = -1): boolean {
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
		(a === 169 && b === 254) || // link-local, cloud metadata
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 192 && b === 0 && (c === 0 || c === 2)) || // IETF protocol and documentation ranges only: the rest of 192.0.0.0/16 is public (WordPress.com)
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224 // multicast, reserved
	);
}

export function isPrivateAddress(address: string): boolean {
	const ip = address.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
	if (net.isIPv4(ip)) {
		const [a, b, c] = ip.split(".").map(Number);
		return ipv4Private(a!, b!, c!);
	}
	if (net.isIPv6(ip)) {
		if (ip === "::" || ip === "::1") return true;
		const mapped = /^(?:::ffff:|64:ff9b::)(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(ip);
		if (mapped) {
			if (mapped[1]) return isPrivateAddress(mapped[1]);
			const hi = parseInt(mapped[2]!, 16);
			const lo = parseInt(mapped[3]!, 16);
			return ipv4Private(hi >> 8, hi & 255, lo >> 8);
		}
		const first = parseInt(ip.split(":")[0] || "0", 16);
		return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // unique-local, link-local
	}
	return true; // not an address we understand: refuse
}

/** Throws unless every address the URL's host resolves to is public. */
export async function assertPublicUrl(url: string, resolve?: Resolver): Promise<URL> {
	const parsed = new URL(url);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("Only http(s) URLs are supported");
	const host = parsed.hostname.replace(/^\[|\]$/g, "");
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
		throw new Error("Blocked: private and local addresses are off limits to the tutor");
	}
	const addresses = net.isIP(host) ? [host] : await (resolve ?? defaultResolver)(host);
	if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
		throw new Error("Blocked: private and local addresses are off limits to the tutor");
	}
	return parsed;
}

const MAX_REDIRECTS = 5;

/** fetch() that validates the URL and every redirect hop. */
export async function publicFetch(
	url: string,
	init: RequestInit = {},
	deps: { resolve?: Resolver; fetchFn?: typeof fetch } = {},
): Promise<Response> {
	const fetchFn = deps.fetchFn ?? fetch;
	let current = url;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		await assertPublicUrl(current, deps.resolve);
		const resp = await fetchFn(current, { ...init, redirect: "manual" });
		const location = resp.headers.get("location");
		if (resp.status >= 300 && resp.status < 400 && location) {
			current = new URL(location, current).toString();
			continue;
		}
		// `resp.url` is empty for manual fetches; carry the final URL.
		return Object.defineProperty(resp, "url", { value: current });
	}
	throw new Error("Too many redirects");
}
