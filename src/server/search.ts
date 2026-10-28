/**
 * The search engine's server composition: the Gemini (Google Search
 * grounding) adapter behind the core port (core/search.ts) + the
 * live-engine resolution the settings UI and the agent-layer tool both read.
 *
 * Owner decisions baked in:
 *  - NO engine setting: search is live iff the Gemini key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - No key = honestly unavailable (the reason says so).
 *
 * The adapter is an injected dependency (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import type { SearchHit, SearchProvider, SearchStatus } from "../core/search.ts";
import { keyValue } from "./keys.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** The Gemini model the tool engines (search grounding, dictation)
 *  call. Flash-Lite on purpose: on the free AI Studio tier every model has
 *  its OWN daily quota, so these calls don't eat into the teaching
 *  model's. LH_GEMINI_TOOL_MODEL overrides (e.g. when Google retires the
 *  alias). */
export function geminiToolModel(): string {
	return process.env.LH_GEMINI_TOOL_MODEL || "gemini-flash-lite-latest";
}

/** Gemini's errors are {error: {code, message, status}} — the message when
 *  present, the raw slice otherwise; 429 says what it means on the free
 *  tier. Shared with the batch dictation engine. */
export async function geminiErrorMessage(resp: Response, what: string): Promise<string> {
	const body = await resp.text();
	let detail = body.slice(0, 200);
	try {
		const parsed = JSON.parse(body) as { error?: { message?: string } };
		if (parsed.error?.message) detail = parsed.error.message.slice(0, 200);
	} catch {
		/* keep the raw slice */
	}
	if (resp.status === 429) return `Gemini ${what} quota reached (free-tier limits reset daily): ${detail}`;
	return `Gemini ${what} API ${resp.status}: ${detail}`;
}

/** Gemini: grounding with Google Search — POST …/models/{model}:
 *  generateContent with tools [{google_search: {}}] and the key in the
 *  x-goog-api-key header. Rides the model-provider GEMINI_API_KEY (no
 *  separate search key; the free tier includes a daily grounding
 *  allowance). The hits come from candidates[0].groundingMetadata:
 *  groundingChunks [{web: {uri, title}}] are the sources (title is the
 *  site's domain; uri a vertexaisearch redirect, resolved below to the
 *  real page), groundingSupports [{segment: {text}, groundingChunkIndices}]
 *  are the answer sentences each source backs — joined as its snippet. */
export function geminiSearchProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "gemini",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiToolModel()}:generateContent`;
			const resp = await fetchFn(url, {
				method: "POST",
				headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
				body: JSON.stringify({
					contents: [
						{
							role: "user",
							parts: [
								{
									text:
										`Search the web for: ${query}\n\n` +
										"Report what the most relevant sources say, a short factual paragraph per source.",
								},
							],
						},
					],
					tools: [{ google_search: {} }],
				}),
				signal: AbortSignal.timeout(45_000),
			});
			if (!resp.ok) throw new Error(await geminiErrorMessage(resp, "search"));
			const data = (await resp.json()) as {
				candidates?: Array<{
					groundingMetadata?: {
						groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>;
						groundingSupports?: Array<{ segment?: { text?: string }; groundingChunkIndices?: number[] }>;
					};
				}>;
			};
			const meta = data.candidates?.[0]?.groundingMetadata;
			const chunks = meta?.groundingChunks ?? [];
			const snippets = chunks.map(() => [] as string[]);
			for (const support of meta?.groundingSupports ?? []) {
				const text = support.segment?.text?.trim();
				if (!text) continue;
				for (const i of support.groundingChunkIndices ?? []) {
					const list = snippets[i];
					if (list && !list.includes(text)) list.push(text);
				}
			}
			const rows = chunks
				.map((c, i) => ({ uri: c.web?.uri ?? "", title: c.web?.title ?? "", snippet: (snippets[i] ?? []).join(" ") }))
				.filter((r) => r.uri)
				.slice(0, count);
			const urls = await Promise.all(rows.map((r) => resolveRedirect(r.uri, fetchFn)));
			return rows.map((r, i) => ({
				title: r.title || (urls[i] ?? r.uri),
				url: urls[i] ?? r.uri,
				snippet: r.snippet.replace(/\n/g, " ").slice(0, 500),
			}));
		},
	};
}

/** Grounding sources arrive as vertexaisearch.cloud.google.com redirect
 *  links — follow ONE hop (HEAD, manual redirect) so the agent sees and
 *  fetches the real page. Best-effort: any failure keeps the redirect
 *  link, which still works in web_fetch (fetch follows redirects). */
async function resolveRedirect(uri: string, fetchFn: FetchLike): Promise<string> {
	try {
		const resp = await fetchFn(uri, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(5_000) });
		const location = resp.headers.get("location");
		return location && /^https?:\/\//.test(location) ? location : uri;
	} catch {
		return uri;
	}
}

/** The env var holding the search engine's key. */
const SEARCH_KEY_VAR = "GEMINI_API_KEY";

/** Resolve the search state PURELY from the live key (testable): present =
 *  Gemini search is live, absent = honestly unavailable. Never throws. */
export function resolveSearchEngineFor(geminiKey: string | undefined): SearchStatus & { key: string | null } {
	if (geminiKey) return { available: true, engine: "gemini", reason: "search engine: gemini", key: geminiKey };
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — set a Gemini (Google) model key",
		key: null,
	};
}

/** The live search state (the honest availability signal): reads the auth
 *  store fresh each call, so a key saved mid-session activates on the next
 *  check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(keyValue(SEARCH_KEY_VAR));
	return { available, engine, reason };
}

/** Search available at all? (the settings UI's gray-out signal + the
 *  researcher's enable/disable pin.) */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer calls this once per search, so key rotations take effect
 *  immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(keyValue(SEARCH_KEY_VAR));
	return resolved.key ? geminiSearchProvider(resolved.key) : null;
}
