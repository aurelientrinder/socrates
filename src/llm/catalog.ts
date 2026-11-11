/**
 * The Gemini model catalog: static metadata (cost, context, thinking levels)
 * for the models Google lists in its public docs, plus anything discovered
 * live from the user's own key (see discovery.ts). A model Google has not
 * published to the API (for example Gemini 4 Carbon, restricted to selected
 * partners) is simply absent until Google's `models.list` returns it for
 * the key in use.
 */
import baked from "./gemini-models.json" with { type: "json" };
import type { Api, Model, ModelThinkingLevel, Usage } from "./types.ts";

export const GOOGLE_PROVIDER = "google";
export const GOOGLE_API = "google-generative-ai";
export const GOOGLE_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

const bakedModels = baked as unknown as Model<Api>[];
/** Models learned at runtime from `models.list` (id → model). */
const discovered = new Map<string, Model<Api>>();

export function setDiscoveredModels(models: Model<Api>[]): void {
	discovered.clear();
	for (const m of models) discovered.set(m.id, m);
}

/** Every known model: the baked list, with live-discovered ones layered on. */
export function listModels(): Model<Api>[] {
	const byId = new Map<string, Model<Api>>();
	for (const m of bakedModels) byId.set(m.id, m);
	for (const m of discovered.values()) if (!byId.has(m.id)) byId.set(m.id, m);
	return [...byId.values()];
}

export function getModel(provider: string, id: string): Model<Api> | undefined {
	if (provider !== GOOGLE_PROVIDER) return undefined;
	return listModels().find((m) => m.id === id);
}

export function calculateCost(model: Model<Api>, usage: Usage): Usage["cost"] {
	const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
	let rates: { input: number; output: number; cacheRead: number; cacheWrite: number } = model.cost;
	let matched = -1;
	for (const tier of model.cost.tiers ?? []) {
		if (inputTokens > tier.inputTokensAbove && tier.inputTokensAbove > matched) {
			rates = tier;
			matched = tier.inputTokensAbove;
		}
	}
	usage.cost.input = (rates.input / 1_000_000) * usage.input;
	usage.cost.output = (rates.output / 1_000_000) * usage.output;
	usage.cost.cacheRead = (rates.cacheRead / 1_000_000) * usage.cacheRead;
	// 1h cache writes (only some providers report the split) bill at 2x input.
	const longWrite = usage.cacheWrite1h ?? 0;
	const shortWrite = usage.cacheWrite - longWrite;
	usage.cost.cacheWrite = (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1_000_000;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

const LEVELS: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export function getSupportedThinkingLevels(model: Model<Api>): ModelThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return LEVELS.filter((level) => {
		const mapped = model.thinkingLevelMap?.[level];
		if (mapped === null) return false;
		if (level === "xhigh" || level === "max") return mapped !== undefined;
		return true;
	});
}

export function clampThinkingLevel(model: Model<Api>, level: ModelThinkingLevel): ModelThinkingLevel {
	const available = getSupportedThinkingLevels(model);
	if (available.includes(level)) return level;
	const requested = LEVELS.indexOf(level);
	if (requested === -1) return available[0] ?? "off";
	for (let i = requested; i < LEVELS.length; i++) {
		const candidate = LEVELS[i]!;
		if (available.includes(candidate)) return candidate;
	}
	for (let i = requested - 1; i >= 0; i--) {
		const candidate = LEVELS[i]!;
		if (available.includes(candidate)) return candidate;
	}
	return available[0] ?? "off";
}

