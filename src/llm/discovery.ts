/**
 * Live model discovery: asks Google which models THIS API key can use
 * (`models.list`) and adds any the baked catalog does not know yet, so a
 * newly released Gemini model shows up in Settings without an app update.
 * A model Google keeps restricted (not returned for the key) never appears.
 * Costs for discovered-only models are unknown, so they price at zero.
 */
import { GoogleGenAI } from "@google/genai";
import { GOOGLE_API, GOOGLE_BASE_URL, GOOGLE_PROVIDER, listModels, setDiscoveredModels } from "./catalog.ts";
import { geminiApiKey } from "./gemini.ts";
import type { Api, Model } from "./types.ts";

const TTL_MS = 10 * 60 * 1000;
let lastKey: string | undefined;
let lastAt = 0;

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

/** Refresh the discovered set from Google (cached 10 min per key; failures keep the baked list). */
export async function refreshDiscoveredModels(force = false): Promise<void> {
	const apiKey = geminiApiKey();
	if (!apiKey) {
		setDiscoveredModels([]);
		lastKey = undefined;
		return;
	}
	if (!force && lastKey === apiKey && Date.now() - lastAt < TTL_MS) return;
	try {
		const client = new GoogleGenAI({ apiKey });
		const known = new Set(listModels().map((m) => m.id));
		const found: Model<Api>[] = [];
		const pager = await client.models.list({ config: { pageSize: 100, queryBase: true } });
		for await (const entry of pager) {
			const model = modelFromListing(entry as never);
			if (model && !known.has(model.id)) found.push(model);
		}
		setDiscoveredModels(found);
		lastKey = apiKey;
		lastAt = Date.now();
	} catch {
		// Offline or a bad key: the baked catalog still works.
		lastAt = Date.now();
		lastKey = apiKey;
	}
}
