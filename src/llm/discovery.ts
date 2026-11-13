/**
 * Live model discovery: asks Google which models THIS API key can use
 * (`models.list`) and adds any the baked catalog does not know yet, so a
 * newly released Gemini model shows up in Settings without an app update.
 * A model Google keeps restricted (not returned for the key) never appears.
 * Costs for discovered-only models are unknown, so they price at zero.
 */
import { GoogleGenAI } from "@google/genai";
import {
	GOOGLE_API,
	GOOGLE_BASE_URL,
	GOOGLE_PROVIDER,
	listBakedModels,
	listDiscoveredModels,
	setDiscoveredModels,
} from "./catalog.ts";
import { geminiApiKey } from "./gemini.ts";
import type { Api, Model } from "./types.ts";

const TTL_MS = 10 * 60 * 1000;
const ERROR_RETRY_MS = 5_000;
const DISCOVERY_STATE_KEY = Symbol.for("lh.discoveryCache");

interface DiscoveryCacheState {
	lastKey?: string;
	lastAt: number;
	lastErrorAt: number;
	inFlight?: Promise<void>;
	inFlightKey?: string;
}

function cacheState(): DiscoveryCacheState {
	const g = globalThis as Record<symbol, DiscoveryCacheState | undefined>;
	if (!g[DISCOVERY_STATE_KEY]) g[DISCOVERY_STATE_KEY] = { lastAt: 0, lastErrorAt: 0 };
	return g[DISCOVERY_STATE_KEY];
}

/** Test-only reset for discovery cache state. */
export function resetDiscoveryCache(): void {
	const s = cacheState();
	s.lastKey = undefined;
	s.lastAt = 0;
	s.lastErrorAt = 0;
	s.inFlight = undefined;
	s.inFlightKey = undefined;
}

const EXCLUDE = /(image|live|tts|audio|embedding|embed|aqa|imagen|veo|computer-use|robotics|customtools|deep-research|native-audio|nano-banana)/i;

/** Pure: project one `models.list` entry to a catalog model, or null when it is not a chat model. */
export function modelFromListing(entry: {
	name?: string;
	displayName?: string;
	inputTokenLimit?: number;
	outputTokenLimit?: number;
	supportedActions?: string[];
	thinking?: boolean;
}): Model<Api> | null {
	const id = (entry.name ?? "").replace(/^models\//, "");
	if (!id.startsWith("gemini-") || EXCLUDE.test(id)) return null;
	if (entry.supportedActions && !entry.supportedActions.includes("generateContent")) return null;
	const major = Number.parseInt(id.match(/^gemini-(\d+)/)?.[1] ?? "0", 10);
	const reasoning = entry.thinking ?? major >= 2;
	return {
		id,
		name: entry.displayName || id,
		api: GOOGLE_API,
		provider: GOOGLE_PROVIDER,
		baseUrl: GOOGLE_BASE_URL,
		reasoning,
		...(reasoning && major >= 3
			? { thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null } }
			: {}),
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: entry.inputTokenLimit ?? 1_048_576,
		maxTokens: entry.outputTokenLimit ?? 65_536,
	};
}

export type RemoteListingFn = (apiKey: string) => AsyncIterable<unknown> | Promise<AsyncIterable<unknown>>;

async function defaultListRemote(apiKey: string): Promise<AsyncIterable<unknown>> {
	const client = new GoogleGenAI({ apiKey });
	return client.models.list({ config: { pageSize: 100, queryBase: true } });
}

/** Refresh the discovered set from Google (cached 10 min per key; failures keep existing/baked models and allow quick retry). */
export async function refreshDiscoveredModels(
	force = false,
	listRemote: RemoteListingFn = defaultListRemote,
): Promise<void> {
	const state = cacheState();
	const apiKey = geminiApiKey();
	if (!apiKey) {
		setDiscoveredModels([]);
		state.lastKey = undefined;
		state.lastAt = 0;
		state.lastErrorAt = 0;
		return;
	}
	if (state.lastKey && state.lastKey !== apiKey) {
		setDiscoveredModels([]);
		state.lastAt = 0;
		state.lastErrorAt = 0;
	}
	const now = Date.now();
	if (!force && state.lastKey === apiKey) {
		if (state.lastAt > 0 && now - state.lastAt < TTL_MS) return;
		if (state.lastErrorAt > 0 && now - state.lastErrorAt < ERROR_RETRY_MS) return;
	}
	if (state.inFlight && state.inFlightKey === apiKey) {
		return state.inFlight;
	}

	let run!: Promise<void>;
	run = (async () => {
		try {
			const bakedIds = new Set(listBakedModels().map((m) => m.id));
			const foundById = new Map<string, Model<Api>>();
			let entriesSeen = 0;
			const pager = await listRemote(apiKey);
			for await (const entry of pager) {
				entriesSeen++;
				const model = modelFromListing(entry as never);
				if (model && !bakedIds.has(model.id) && !foundById.has(model.id)) {
					foundById.set(model.id, model);
				}
			}
			// Guard against an anomalous empty stream from a proxy/startup glitch wiping valid discovered models.
			if (entriesSeen > 0 || listDiscoveredModels().length === 0 || force) {
				if (entriesSeen > 0 || listDiscoveredModels().length === 0) {
					setDiscoveredModels([...foundById.values()]);
				}
			}
			state.lastKey = apiKey;
			state.lastAt = Date.now();
			state.lastErrorAt = 0;
		} catch {
			// Offline or transient error: preserve any already-discovered models for this key and retry soon.
			state.lastKey = apiKey;
			state.lastErrorAt = Date.now();
		} finally {
			if (state.inFlight === run) {
				state.inFlight = undefined;
				state.inFlightKey = undefined;
			}
		}
	})();

	state.inFlight = run;
	state.inFlightKey = apiKey;
	return run;
}
