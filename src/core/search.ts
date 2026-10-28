/**
 * The search-provider port.
 *
 * Search sits behind ONE seam so the agent-layer tool depends on this port
 * only. The one live engine is Gemini (Google Search grounding), riding the
 * model-provider GEMINI_API_KEY — an engine is live iff its key is present
 * (there is no engine setting). Nothing silently falls back: no key = search
 * is honestly unavailable (the tool says so; the researcher sub-agent is
 * disabled by the agent layer on the same signal).
 *
 * Pure types + protocol docs only (browser-safe, no node imports): the
 * adapter is server-side (src/server/search.ts) and arrives as an injected
 * dependency.
 */

/** One search result row — the shape every adapter must produce (the
 *  researcher's tool contract; same fields the old Google adapter emitted). */
export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}

/** The engine id. gemini rides the model-provider GEMINI_API_KEY —
 *  Google Search grounding (2026-10-26). */
export type SearchEngineId = "gemini";

/** A live search engine: an id (for status/labels) + one operation. The
 *  adapters own their wire protocol (fetch, timeouts, error mapping) —
 *  callers see only this. `search` throws on failure (adapters map HTTP
 *  errors to clear Error messages); the tool layer catches and reports. */
export interface SearchProvider {
	id: SearchEngineId;
	search(query: string, count: number): Promise<SearchHit[]>;
}

/** Why search is (un)available — the honest status the UI and the tool
 *  layer explain from. `engine` is the ACTIVE engine when live. */
export interface SearchStatus {
	available: boolean;
	/** The active engine (null when unavailable). */
	engine: SearchEngineId | null;
	/** The one-line reason for the state (status text for the UI). */
	reason: string;
}
