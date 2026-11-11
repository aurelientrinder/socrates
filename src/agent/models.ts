import {
	clampThinkingLevel,
	getModel as catalogModel,
	getSupportedThinkingLevels,
	listModels,
	streamSimpleGemini,
	type Api,
	type Model,
	type StreamFunction,
	type ThinkingLevel,
} from "../llm/index.ts";
import { fillGeminiThoughtSignatures, GEMINI_SKIP_SIGNATURE } from "../llm/gemini.ts";
import { GOOGLE_PROVIDER } from "../llm/catalog.ts";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import { pacedStream } from "./rate-limit.ts";

/** App identity (user agent + attribution), shared by every native Agent. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `learnharness/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/**
 * The one engine factory every agent's model comes from. BYOK ALL THE WAY
 * DOWN (owner, 2026-09-22): there are no factory pins — every engine
 * resolves from a RESOLVED SPEC (the settings chain's output) and the one
 * builder here wires it to the Gemini catalog (src/llm/catalog.ts) and the
 * official Gemini SDK stream (src/llm/gemini.ts).
 *
 * An "engine" is the model + the stream function the agent loop runs on —
 * the two things a test fake replaces.
 */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	/** The resolved (config-or-settings, CLAMPED) thinking level —
	 *  observability + tests; the streamFn pins it anyway. */
	level?: ThinkingLevel;
}

export type { ThinkingLevel };
export { fillGeminiThoughtSignatures, GEMINI_SKIP_SIGNATURE };

/** The model catalog handle (Gemini only). Kept as a small facade so the
 *  picker, validation and engine builder share one lookup surface. */
export function piModels() {
	return {
		getProviders: () => [{ id: GOOGLE_PROVIDER, name: "Google" }],
		getModels: (provider: string) => (provider === GOOGLE_PROVIDER ? listModels() : []),
		getModel: (provider: string, id: string) => catalogModel(provider, id),
		streamSimple: streamSimpleGemini,
	};
}

/** A fully-resolved model pin — the shape every engine now comes from:
 *  the settings-resolution chain's output (role override → slot, or the
 *  chat's conversation chain). thinkingLevel is OPTIONAL: unset means
 *  the baked default resolves here (owner 2026-09-22) — the first entry
 *  of DEFAULT_THINKING_ORDER the model supports. */
export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

/** The first entry of the baked default order the model supports (owner,
 *  2026-09-22). A non-reasoning model reports exactly ["off"], so the
 *  order walk lands there naturally. */
function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

/** The production engine for a RESOLVED spec (model slots wave,
 *  2026-09-20): provider-aware catalog lookup + thinking clamp. The API
 *  key is resolved per request from the environment (the keys seam
 *  reflects file-saved keys into env). */
export function piEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true): PiEngine {
	const models = piModels();
	const model = models.getModel(spec.provider, spec.id);
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	// UNSET level → the baked default order (first entry the model
	// supports); SET level → pi's native nearest-clamp (model swaps keep
	// the user's intent and adapt honestly).
	const level = spec.thinkingLevel
		? clampThinkingLevel(model, spec.thinkingLevel)
		: defaultThinkingLevel(model);
	return {
		model,
		level,
		// The agent loop forwards state.thinkingLevel as `reasoning`
		// (undefined = off); the clamp above keeps the pin honest even when
		// config or settings drift off the map.
		// API-key providers go through the request pacer (rate-limit.ts):
		// free tiers cap requests per minute, and a paced request beats a
		// refused one.
		streamFn: (requestModel, context, options) => {
			const purpose = typeof background === "function" ? background : () => background;
			const stream = pacedStream(`${spec.provider}/${spec.id}`, purpose, models.streamSimple);
			const userOnPayload = options?.onPayload;
			return stream(requestModel, context, {
				...options,
				reasoning: level === "off" ? undefined : level,
				onPayload: async (payload: unknown, m: typeof requestModel) =>
					fillGeminiThoughtSignatures((await userOnPayload?.(payload, m)) ?? payload),
			});
		},
	};
}

/** The LEGACY role entry point — BYOK made it an honest THROWER (owner,
 *  2026-09-22): no factory pins exist to fall back to, and this module
 *  cannot read settings (architecture law — the agent layer never
 *  imports the server layer). Production resolves the chain in
 *  chat-handler and ALWAYS injects engines; reaching this means a
 *  wiring bug, so it fails loudly instead of guessing a model. */
export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
