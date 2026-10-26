/**
 * The search engines' server composition (search port + model slots wave,
 * 2026-09-20): the Tavily + Brave adapters behind the core port
 * (core/search.ts) + the live-engine resolution the settings UI and the
 * agent-layer tool both read.
 *
 * Owner decisions (2026-09-20) baked in:
 *  - NO default engine: an engine is live iff its key is present (auth
 *    store or env — env wins, keyed via server/keys.ts keyValue).
 *  - Setting a key is ALL the user does — auto-detection: explicit
 *    agent.search.engine pins the preference (when BOTH keys are present
 *    the preference order is Tavily → Brave); without a pin, whichever
 *    engine has a key is the engine.
 *  - An explicit choice does NOT silently fall back to the other engine:
 *    engine pinned but its key missing = honestly unavailable (reason
 *    says so) — no guessing what the user meant.
 *
 * The adapters are injected dependencies (fetch-shaped) so the agent-layer
 * tool depends on the PORT only and tests never touch the network.
 */

import type { SearchEngineId, SearchHit, SearchProvider, SearchStatus } from "../core/search.ts";
import { keyValue } from "./keys.ts";
import { effectiveSettings } from "./stores.ts";

/** The wire-callable shape the adapters close over (tests inject a stub). */
type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Tavily: POST https://api.tavily.com/search — Bearer auth in the
 *  Authorization header (the current documented scheme; the legacy
 *  api_key-in-body form is retired), query + max_results (0–20) in the
 *  JSON body. VERIFIED against docs.tavily.com's OpenAPI, 2026-09-20:
 *  response {results: [{title, url, content, score, …}]}, errors
 *  {detail: {error}}. */
export function tavilyProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "tavily",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const resp = await fetchFn("https://api.tavily.com/search", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({ query, max_results: Math.min(count, 20) }),
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				// Their error body is {detail: {error: "…"}} — surface the
				// message when present, else the raw slice.
				let detail = body.slice(0, 200);
				try {
					const parsed = JSON.parse(body) as { detail?: { error?: string } };
					if (parsed.detail?.error) detail = parsed.detail.error.slice(0, 200);
				} catch {
					/* keep the raw slice */
				}
				throw new Error(`Tavily search API ${resp.status}: ${detail}`);
			}
			const data = (await resp.json()) as {
				results?: Array<{ title?: string; url?: string; content?: string }>;
			};
			return (data.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.content ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** Brave: GET https://api.search.brave.com/res/v1/web/search with the
 *  key in the X-Subscription-Token header. VERIFIED against Brave's
 *  dashboard docs, 2026-09-20: count max 20; response
 *  {web: {results: [{title, url, description, …}]}}. */
export function braveProvider(apiKey: string, fetchFn: FetchLike = fetch): SearchProvider {
	return {
		id: "brave",
		async search(query: string, count: number): Promise<SearchHit[]> {
			const url = new URL("https://api.search.brave.com/res/v1/web/search");
			url.searchParams.set("q", query);
			url.searchParams.set("count", String(Math.min(count, 20)));
			const resp = await fetchFn(url.toString(), {
				headers: {
					accept: "application/json",
					"x-subscription-token": apiKey,
				},
				signal: AbortSignal.timeout(30_000),
			});
			if (!resp.ok) {
				const body = await resp.text();
				throw new Error(`Brave search API ${resp.status}: ${body.slice(0, 200)}`);
			}
			const data = (await resp.json()) as {
				web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
			};
			return (data.web?.results ?? [])
				.filter((r) => typeof r.url === "string" && r.url)
				.map((r) => ({
					title: r.title ?? r.url ?? "",
					url: r.url ?? "",
					snippet: (r.description ?? "").replace(/\n/g, " ").slice(0, 500),
				}));
		},
	};
}

/** The Gemini model the tool engines (search grounding, batch dictation)
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

/** The engines, in PREFERENCE order (several keys present, no explicit
 *  pin → the first live engine wins; owner decision 2026-09-20: Tavily
 *  first — the AI-native search API the wave chose). Gemini comes LAST:
 *  its key is usually there for the models, so it is the free fallback
 *  rather than a choice that would shadow a dedicated search key. */
const ENGINE_ORDER: ReadonlyArray<{ id: SearchEngineId; envVar: string }> = [
	{ id: "tavily", envVar: "TAVILY_API_KEY" },
	{ id: "brave", envVar: "BRAVE_API_KEY" },
	{ id: "gemini", envVar: "GEMINI_API_KEY" },
];

/** The env var holding an engine's key (the reason lines name it). */
export function searchEngineEnvVar(id: SearchEngineId): string {
	return ENGINE_ORDER.find((e) => e.id === id)?.envVar ?? "";
}

/** The engine's key (env-or-file; env wins) — null when the engine is
 *  not keyed, which by owner decision means NOT LIVE. */
function engineKey(id: SearchEngineId): string | null {
	const envVar = ENGINE_ORDER.find((e) => e.id === id)?.envVar;
	const value = envVar ? keyValue(envVar) : undefined;
	return value ? value : null;
}

/** Every engine's live key (absent = not keyed). */
function liveEngineKeys(): Partial<Record<SearchEngineId, string>> {
	const keys: Partial<Record<SearchEngineId, string>> = {};
	for (const { id } of ENGINE_ORDER) {
		const key = engineKey(id);
		if (key) keys[id] = key;
	}
	return keys;
}

/** Resolve the search state PURELY from the given pins (testable): the
 *  explicit engine (if pinned) wins but must be keyed; absent pin → first
 *  keyed engine in preference order. Never throws. */
export function resolveSearchEngineFor(
	pinned: SearchEngineId | undefined,
	/** Per-engine live keys (absent engine = absent property is fine). */
	keys: Partial<Record<SearchEngineId, string | undefined>>,
): SearchStatus & { key: string | null } {
	const pinnedKey = pinned ? keys[pinned] ?? null : null;
	if (pinned) {
		if (!pinnedKey) {
			return {
				available: false,
				engine: null,
				reason: `search engine is set to "${pinned}" but its API key is missing — set the ${searchEngineEnvVar(pinned)} key`,
				key: null,
			};
		}
		return { available: true, engine: pinned, reason: `search engine: ${pinned} (chosen)`, key: pinnedKey };
	}
	for (const { id } of ENGINE_ORDER) {
		const key = keys[id] ?? null;
		if (key) return { available: true, engine: id, reason: `search engine: ${id} (auto)`, key };
	}
	return {
		available: false,
		engine: null,
		reason: "no search engine configured — set a Tavily or Brave search API key, or a Gemini (Google) model key",
		key: null,
	};
}

/** The live search state (the honest availability signal): reads the
 *  settings record's pin + the auth store fresh each call, so a key saved
 *  mid-session activates on the next check (no restart). */
export function searchStatus(): SearchStatus {
	const { available, engine, reason } = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, liveEngineKeys());
	return { available, engine, reason };
}

/** Search available at all? (the settings UI's gray-out signal + the
 *  researcher's enable/disable pin — Teacher stream's rewiring reads this.) */
export function searchAvailable(): boolean {
	return searchStatus().available;
}

/** The LIVE adapter, or null when unavailable. Composed fresh each call —
 *  the tool layer (Teacher stream) calls this once per search, so key
 *  rotations take effect immediately. */
export function searchProvider(): SearchProvider | null {
	const resolved = resolveSearchEngineFor(effectiveSettings().agent.search?.engine, liveEngineKeys());
	if (!resolved.available || !resolved.key) return null;
	if (resolved.engine === "tavily") return tavilyProvider(resolved.key);
	if (resolved.engine === "gemini") return geminiSearchProvider(resolved.key);
	return braveProvider(resolved.key);
}
