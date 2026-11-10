import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	catalogDefaultsFor,
	catalogProviders,
	catalogRolePins,
	catalogSlots,
	clampChatLevel,
	clampModelsLevels,
	modelCatalog,
	rolePinsFor,
	toModelDto,
	validateChatSettings,
	validateModelsSettings,
} from "../src/server/model-catalog.ts";
import type { EffectiveSlot } from "../src/core/settings-resolution.ts";
import type { SettingsValidation } from "../src/server/model-catalog.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/llm/index.ts";
import { DEFAULT_THINKING_ORDER } from "../src/core/settings.ts";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";
import { BACKGROUND_MODEL_ROLES } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { readSettings } from "../src/store/settings.ts";
import { effectiveSettings } from "../src/server/stores.ts";

// The model-control wave (2026-09-12): pi-ai owns the registry — these pins
// hold our projection + validation honest against the shipped catalog, and
// pin pi's per-model thinking truth so a pi-ai upgrade can't silently change
// what we send. BYOK wave (2026-09-22): no factory pins — unset surfaces
// are NULL/undefined, never phantom defaults.

// The picker federates only providers with a PRESENT key (model slots
// wave, 2026-09-20): pin openrouter's env key so its full catalog
// federates in tests regardless of the developer shell's exports.
process.env.GEMINI_API_KEY ??= "test-key-openrouter-catalog";

/** The catalog's glm entry — the old factory pin's model, still the
 *  best-known thinking-truth specimen (low|high|max). */
function glmModel() {
	const glm = piModels().getModel("google", "gemini-3.8-flash");
	assert.ok(glm, "gemini-3.8-flash in catalog");
	return glm!;
}

/** Another reasoning specimen with a different supported set. */
function qwenModel() {
	const qwen = piModels().getModel("google", "gemini-3.5-flash");
	assert.ok(qwen, "gemini-3.5-flash in catalog");
	return qwen!;
}

describe("the model catalog projection", () => {
	it("serves the keyed providers' catalogs with the picker's DTO shape", () => {
		const { models, defaults, providers, slots } = modelCatalog();
		// The Gemini list is small and curated; pin the shape and presence.
		assert.ok(models.length >= 10, `expected the Gemini catalog, got ${models.length}`);
		assert.ok(models.every((m) => m.provider === "google"), "Gemini is the only provider");
		for (const m of models.slice(0, 25)) {
			assert.equal(typeof m.id, "string");
			assert.equal(typeof m.name, "string");
			assert.ok(Array.isArray(m.supportedLevels));
			assert.ok(typeof m.cost.input === "number" && typeof m.cost.output === "number");
			assert.ok(m.contextWindow > 0);
		}
		const glm = models.find((m) => m.id === "gemini-3.8-flash");
		assert.ok(glm, "gemini-3.8-flash in catalog");
		assert.deepEqual(glm!.supportedLevels, ["low", "medium", "high"]);
		assert.deepEqual(glm!.input, ["text", "image"]);
		assert.deepEqual(glm!.cost, { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0 });
		// model slots wave: the providers surface + the resolved slot pins
		const google = providers.find((p) => p.id === "google");
		assert.ok(google && google.keyPresent, "google federated (key pinned above)");
		assert.deepEqual(providers.map((p) => p.id), ["google"]);
		assert.deepEqual(Object.keys(slots), ["strong", "cheap", "vision"]);
		// a keyless provider's models never reach the picker
		const keyless = providers.filter((p) => !p.keyPresent).map((p) => p.id);
		for (const id of keyless) {
			assert.ok(!models.some((m) => m.provider === id), `keyless ${id} must not federate`);
		}
		// BYOK: the payload carries ONLY what the machine's record actually
		// says — never a phantom id. data/settings.json belongs to
		// settings-store.test.ts (the one-fs-owner discipline), so READ the
		// resolved truth here instead of pinning it: on a scratch worktree
		// the record is empty (defaults/slots NULL), on the owner's machine
		// configured slots must surface exactly as configured.
		const record = readSettings();
		const strong = effectiveSettings().models.strong;
		if (strong) {
			assert.ok(defaults, "a configured strong slot yields a default");
			assert.deepEqual(defaults!.model, { provider: strong.provider, id: strong.id });
		} else {
			assert.equal(defaults, null);
		}
		for (const name of ["strong", "cheap", "vision"] as const) {
			const stored = record?.models?.[name];
			if (stored?.model) {
				assert.ok(slots[name], name);
				assert.deepEqual(slots[name]!.model, stored.model);
			} else {
				assert.equal(slots[name], null, name);
			}
		}
	});

	it("defaults: the strong slot verbatim; null when unset (BYOK, per-session models 2026-09-28)", () => {
		assert.equal(catalogDefaultsFor(null), null);
		const strong = { provider: "google", id: "gemini-3.8-flash", thinkingLevel: "low" as const };
		const d = catalogDefaultsFor(strong);
		assert.deepEqual(d, { model: { provider: "google", id: "gemini-3.8-flash" }, thinkingLevel: "low" });
		// No level stored → the model alone reports (the level resolves at
		// engine build from DEFAULT_THINKING_ORDER).
		const bare = catalogDefaultsFor({ provider: "google", id: "gemini-3.5-flash-lite" });
		assert.deepEqual(bare, { model: { provider: "google", id: "gemini-3.5-flash-lite" } });
	});

	it("toModelDto projects the raw catalog model verbatim", () => {
		const raw = glmModel();
		const dto = toModelDto(raw);
		assert.equal(dto.id, raw.id);
		assert.equal(dto.name, raw.name);
		assert.deepEqual(dto.supportedLevels, getSupportedThinkingLevels(raw));
		assert.equal(dto.cost.input, raw.cost.input);
		assert.equal(dto.contextWindow, raw.contextWindow);
	});
});

describe("the background roles' resolved pins (rolePins)", () => {
	it("no record → every role is NULL (BYOK: no phantom defaults)", () => {
		const pins = rolePinsFor(resolveSettings(null).agent.models);
		assert.deepEqual(Object.keys(pins), [...BACKGROUND_MODEL_ROLES]);
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.equal(pins[role], null, role);
		}
	});

	it("a slot re-tiers its roles; overrides win for that role only", () => {
		const record = {
			version: 1,
			models: { cheap: { model: { provider: "google", id: "gemini-3.5-flash-lite" } } },
			agent: { models: { researcher: { model: { provider: "google", id: "gemini-3.8-flash" }, thinkingLevel: "high" as const } } },
		};
		const pins = rolePinsFor(resolveSettings(record).agent.models);
		assert.deepEqual(pins.researcher, { model: { provider: "google", id: "gemini-3.8-flash" }, thinkingLevel: "high" });
		assert.deepEqual(pins.auditor, { model: { provider: "google", id: "gemini-3.5-flash-lite" } }); // level unset
		assert.equal(pins.visualMaker, null, "vision tier untouched");
	});

	it("catalogRolePins matches the same resolution the engine wiring uses", () => {
		const pins = catalogRolePins();
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.ok(pins[role] === null || typeof pins[role]!.model.id === "string");
		}
	});
});

describe("the model slots surface (model slots wave, 2026-09-20)", () => {
	it("catalogSlots projects the record's tiers — NULL only where a tier holds no model", () => {
		// machine-aware (one-fs-owner: READ the record, never pin it)
		const record = readSettings();
		const slots = catalogSlots();
		for (const name of ["strong", "cheap", "vision"] as const) {
			const stored = record?.models?.[name];
			if (stored?.model) {
				assert.ok(slots[name], name);
				assert.deepEqual(slots[name]!.model, stored.model);
			} else {
				assert.equal(slots[name], null, name);
			}
		}
	});

	it("catalogProviders reads keys env-wins, fresh per call", () => {
		const saved = process.env.GEMINI_API_KEY;
		try {
			delete process.env.GEMINI_API_KEY;
			assert.equal(catalogProviders().find((p) => p.id === "google")?.keyPresent, false);
			process.env.GEMINI_API_KEY = "test-gemini-key-1234567890";
			assert.equal(catalogProviders().find((p) => p.id === "google")?.keyPresent, true);
		} finally {
			if (saved === undefined) delete process.env.GEMINI_API_KEY;
			else process.env.GEMINI_API_KEY = saved;
		}
	});
});

describe("the models-section validation gate", () => {
	it("accepts a valid slot and rejects unknown provider/model", () => {
		assert.equal(
			validateModelsSettings({ strong: { model: { provider: "google", id: "gemini-3.8-flash" } } }).ok,
			true,
		);
		assert.equal(
			validateModelsSettings({ cheap: { model: { provider: "nope", id: "x" } } }).ok,
			false,
		);
		assert.equal(
			validateModelsSettings({ vision: { model: { provider: "google", id: "nope/nope" } } }).ok,
			false,
		);
	});

	it("thinking levels never reject a slot write (owner, interlude 2026-09-22)", () => {
		// clamp, never reject: the model swap with a pinned level JUST
		// WORKS — validation accepts ANY level; the WRITE clamps to the
		// new model's nearest supported and stores the clamped result.
		assert.deepEqual(
			validateModelsSettings({ strong: { model: { provider: "google", id: "gemini-3.8-flash" }, thinkingLevel: "minimal" } }),
			{ ok: true },
		);
		assert.deepEqual(
			validateModelsSettings({ strong: { model: { provider: "google", id: "gemini-3.8-flash" }, thinkingLevel: "xhigh" } }),
			{ ok: true },
		);
	});

	it("clampModelsLevels: the slot's own model translates the pin (the owner's exact case)", () => {
		// xhigh → Gemini 3.8 Flash: the pin clamps to the nearest supported
		// (low|medium|high) and the CLAMPED value is stored.
		const glm = { model: { provider: "google", id: "gemini-3.8-flash" }, thinkingLevel: "xhigh" as const };
		assert.deepEqual(clampModelsLevels({ strong: glm }), {
			strong: { model: { provider: "google", id: "gemini-3.8-flash" }, thinkingLevel: "high" },
		});
		assert.deepEqual(clampModelsLevels({ strong: { ...glm, thinkingLevel: "minimal" as const } }).strong, {
			model: { provider: "google", id: "gemini-3.8-flash" },
			thinkingLevel: "low",
		});
		// Gemini 3.8 Flash cannot disable thinking: off clamps UP to low
		assert.equal(
			clampModelsLevels({ strong: { ...glm, thinkingLevel: "off" as const } }).strong?.thinkingLevel,
			"low",
		);
		// a supported level passes through untouched
		assert.deepEqual(clampModelsLevels({ strong: { ...glm, thinkingLevel: "high" as const } }).strong, {
			model: { provider: "google", id: "gemini-3.8-flash" },
			thinkingLevel: "high",
		});
		// a slot with no level rides as-is (client populates on fresh
		// picks per DEFAULT_THINKING_ORDER — the server never invents one)
		assert.deepEqual(clampModelsLevels({ strong: { model: glm.model } }), {
			strong: { model: { provider: "google", id: "gemini-3.8-flash" } },
		});
	});

	it("accepts empty settings (the clear-slots write)", () => {
		assert.deepEqual(validateModelsSettings({}), { ok: true });
	});
});

describe("the settings validation gate", () => {
	it("thinking levels never reject a chat write (owner, interlude 2026-09-22)", () => {
		assert.deepEqual(
			validateChatSettings({ model: { provider: "google", id: "gemini-3.8-flash" }, thinkingLevel: "minimal" }),
			{ ok: true },
		);
		assert.deepEqual(validateChatSettings({ thinkingLevel: "xhigh" }), { ok: true });
	});

	it("clampChatLevel: the body's model, else the strong slot, translates the pin", () => {
		const glm = { provider: "google", id: "gemini-3.8-flash" };
		const strong: EffectiveSlot = { provider: "google", id: "gemini-3.8-flash" };
		// the body's own model wins
		assert.deepEqual(
			clampChatLevel({ model: { provider: "google", id: "gemini-3.5-flash" }, thinkingLevel: "xhigh" as const }, strong),
			{ model: { provider: "google", id: "gemini-3.5-flash" }, thinkingLevel: clampThinkingLevel(qwenModel(), "xhigh") },
		);
		// no body model → the record's strong slot is the fallback
		assert.equal(clampChatLevel({ thinkingLevel: "xhigh" as const }, strong).thinkingLevel, "high");
		// no model anywhere → rides unchecked (runtime clamps; the turn
		// gate refuses the model-less chat anyway)
		assert.deepEqual(clampChatLevel({ thinkingLevel: "minimal" as const }, null), { thinkingLevel: "minimal" });
		// no pinned level → untouched
		assert.deepEqual(clampChatLevel({ model: { ...glm } }, strong), { model: { ...glm } });
	});

	it("rejects unknown providers and models", () => {
		assert.equal(validateChatSettings({ model: { provider: "nope", id: "x/y" } }).ok, false);
		assert.equal(validateChatSettings({ model: { provider: "google", id: "nope/nope" } }).ok, false);
	});

	it("accepts empty settings (the clear-overrides write)", () => {
		assert.deepEqual(validateChatSettings({}), { ok: true });
	});
});

describe("thinking truth (pinned against the baked Gemini catalog)", () => {
	it("gemini-3.8-flash: low|medium|high; anything else clamps to the nearest", () => {
		const glm = glmModel();
		assert.deepEqual(getSupportedThinkingLevels(glm), ["low", "medium", "high"]);
		assert.equal(clampThinkingLevel(glm, "minimal"), "low");
		assert.equal(clampThinkingLevel(glm, "off"), "low", "Gemini 3.8 Flash cannot disable thinking (map: off → null)");
		assert.equal(clampThinkingLevel(glm, "xhigh"), "high");
		assert.equal(clampThinkingLevel(glm, "high"), "high");
	});

	it("the engine factory clamps explicit levels; unknown models throw honestly", () => {
		const over = piEngineForSpec({ provider: "google", id: "gemini-3.5-flash-lite", thinkingLevel: "high" });
		assert.equal(over.model.id, "gemini-3.5-flash-lite");
		assert.equal(over.level, "high");
		const clamped = piEngineForSpec({ provider: "google", id: "gemini-3.8-flash", thinkingLevel: "minimal" });
		assert.equal(clamped.level, "low");
		assert.throws(() => piEngineForSpec({ provider: "google", id: "nope/nope", thinkingLevel: "low" }), /catalog has no model/);
	});

	it("UNSET levels resolve from the baked DEFAULT_THINKING_ORDER (owner, 2026-09-22)", () => {
		assert.deepEqual([...DEFAULT_THINKING_ORDER], ["medium", "low", "high", "minimal", "xhigh", "max"]);
		// 3.8 flash supports low|medium|high → first supported in the order is "medium"
		const glm = piEngineForSpec({ provider: "google", id: "gemini-3.8-flash" });
		assert.equal(glm.level, "medium");
		// explicit levels never consult the order — the catalog clamps nearest
		assert.equal(piEngineForSpec({ provider: "google", id: "gemini-3.8-flash", thinkingLevel: "max" }).level, "high");
		// a non-reasoning model reports exactly ["off"] → the order lands there
		const flat = piModels()
			.getProviders()
			.flatMap((p) => piModels().getModels(p.id))
			.find((m) => !m.reasoning);
		if (flat) {
			const engine = piEngineForSpec({ provider: flat.provider, id: flat.id });
			assert.deepEqual(getSupportedThinkingLevels(flat), ["off"]);
			assert.equal(engine.level, "off");
		}
	});

	it("the legacy piEngineFor role entry point throws honestly (BYOK: no pins)", async () => {
		const { piEngineFor } = await import("../src/agent/models.ts");
		assert.throws(() => piEngineFor("prober"), /no configured model for role "prober"/);
	});
});