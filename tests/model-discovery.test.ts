import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import {
	listBakedModels,
	listDiscoveredModels,
	listModels,
	setDiscoveredModels,
} from "../src/llm/catalog.ts";
import {
	refreshDiscoveredModels,
	resetDiscoveryCache,
} from "../src/llm/discovery.ts";
import {
	ensureDiscoveredHydrated,
	hydrateServerModelCatalog,
	resetDiscoveredDiskHydration,
	validateChatSettingsLive,
} from "../src/server/model-catalog.ts";

const SAVED_KEY = process.env.GEMINI_API_KEY;
const SAVED_DISCOVERED = listDiscoveredModels();

after(() => {
	resetDiscoveryCache();
	resetDiscoveredDiskHydration();
	setDiscoveredModels(SAVED_DISCOVERED);
	if (SAVED_KEY === undefined) delete process.env.GEMINI_API_KEY;
	else process.env.GEMINI_API_KEY = SAVED_KEY;
});

async function* asyncItems<T>(items: T[]): AsyncIterable<T> {
	for (const item of items) yield item;
}

describe("live model discovery durability", () => {
	it("preserves baked models even when discovered cache is replaced or cleared", () => {
		const baked = listBakedModels();
		assert.ok(baked.length >= 10);
		setDiscoveredModels([]);
		assert.equal(listBakedModels().length, baked.length);
		assert.ok(listModels().length >= baked.length);
	});

	it("discovers new Gemini 4 models and preserves them when subsequent refresh fails or streams empty", async () => {
		resetDiscoveryCache();
		process.env.GEMINI_API_KEY = "test-discovery-key-1";

		await refreshDiscoveredModels(true, async () =>
			asyncItems([
				{
					name: "models/gemini-4-pro-preview",
					displayName: "Gemini 4 Pro Preview",
					supportedActions: ["generateContent"],
					inputTokenLimit: 1_000_000,
					outputTokenLimit: 65_536,
					thinking: true,
				},
			]),
		);

		assert.ok(
			listModels().some((m) => m.id === "gemini-4-pro-preview"),
			"Gemini 4 Pro should appear in merged catalog",
		);

		// Forced refresh returning an error must preserve previously discovered models.
		await refreshDiscoveredModels(true, async () => {
			throw new Error("network unavailable");
		});
		assert.ok(
			listDiscoveredModels().some((m) => m.id === "gemini-4-pro-preview"),
			"transient error must not wipe discovered models",
		);

		// Forced refresh returning an empty stream must not wipe previously discovered models.
		await refreshDiscoveredModels(true, async () => asyncItems([]));
		assert.ok(
			listDiscoveredModels().some((m) => m.id === "gemini-4-pro-preview"),
			"anomalous empty listing must not wipe discovered models",
		);
	});

	it("deduplicates concurrent in-flight discovery requests per key", async () => {
		resetDiscoveryCache();
		setDiscoveredModels([]);
		process.env.GEMINI_API_KEY = "test-discovery-key-dedup";

		let calls = 0;
		const remote = async () => {
			calls++;
			await new Promise((r) => setTimeout(r, 20));
			return asyncItems([
				{
					name: "models/gemini-4-flash",
					displayName: "Gemini 4 Flash",
					supportedActions: ["generateContent"],
				},
			]);
		};

		await Promise.all([
			refreshDiscoveredModels(false, remote),
			refreshDiscoveredModels(false, remote),
			refreshDiscoveredModels(false, remote),
		]);

		assert.equal(calls, 1);
		assert.ok(listDiscoveredModels().some((m) => m.id === "gemini-4-flash"));
	});

	it("clears discovered models when switching to a different API key", async () => {
		resetDiscoveryCache();
		process.env.GEMINI_API_KEY = "test-discovery-key-a";
		await refreshDiscoveredModels(true, async () =>
			asyncItems([
				{
					name: "models/gemini-4-ultra",
					displayName: "Gemini 4 Ultra",
					supportedActions: ["generateContent"],
				},
			]),
		);
		assert.ok(listDiscoveredModels().some((m) => m.id === "gemini-4-ultra"));

		process.env.GEMINI_API_KEY = "test-discovery-key-b";
		await refreshDiscoveredModels(false, async () => asyncItems([]));
		assert.equal(listDiscoveredModels().length, 0);
	});

	it("persists discovered models to disk cache and hydrates matching key hash on cold start", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-discovery-"));
		const cacheFile = path.join(dir, "discovered-models.json");
		try {
			resetDiscoveryCache();
			resetDiscoveredDiskHydration();
			setDiscoveredModels([]);
			process.env.GEMINI_API_KEY = "test-discovery-disk-key-1";

			await hydrateServerModelCatalog(true, {
				cacheFile,
				listRemote: async () =>
					asyncItems([
						{
							name: "models/gemini-4-carbon",
							displayName: "Gemini 4 Carbon",
							supportedActions: ["generateContent"],
						},
					]),
			});
			assert.ok(fs.existsSync(cacheFile), "cache file should be written");

			// Simulate cold restart with empty in-memory discovered set.
			resetDiscoveryCache();
			resetDiscoveredDiskHydration();
			setDiscoveredModels([]);
			ensureDiscoveredHydrated(cacheFile);
			assert.ok(
				listDiscoveredModels().some((m) => m.id === "gemini-4-carbon"),
				"matching key should hydrate cached models from disk",
			);

			// Key mismatch must NOT hydrate another key's models.
			resetDiscoveryCache();
			resetDiscoveredDiskHydration();
			setDiscoveredModels([]);
			process.env.GEMINI_API_KEY = "test-discovery-disk-key-other";
			ensureDiscoveredHydrated(cacheFile);
			assert.equal(listDiscoveredModels().length, 0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("validates a live-discovered Gemini model in validateChatSettingsLive", async () => {
		resetDiscoveryCache();
		setDiscoveredModels([
			{
				id: "gemini-4-live-test",
				name: "Gemini 4 Live Test",
				api: "google-generative-ai",
				provider: "google",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				reasoning: true,
				thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 65_536,
			},
		]);
		process.env.GEMINI_API_KEY = "test-discovery-live-val";
		const verdict = await validateChatSettingsLive({
			model: { provider: "google", id: "gemini-4-live-test" },
			thinkingLevel: "high",
		});
		assert.deepEqual(verdict, { ok: true });
	});
});
