import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeFlashcardDecks, mergeJsonl, mergeSyncFiles, type SyncBundlePayload } from "../src/core/sync-merge.ts";
import { SyncError, decryptSyncBundle, encryptSyncBundle } from "../src/server/sync.ts";
import type { FlashcardDeck } from "../src/core/flashcards.ts";

describe("local-first encrypted sync & per-domain merge", () => {
	it("unions append-only JSONL graph ledgers without duplicates", () => {
		const local = `{"id":"n1","name":"A"}\n{"id":"n2","name":"B"}\n`;
		const remote = `{"id":"n2","name":"B"}\n{"id":"n3","name":"C"}\n`;
		const merged = mergeJsonl(local, remote);
		assert.deepEqual(merged.trim().split("\n"), [
			`{"id":"n1","name":"A"}`,
			`{"id":"n2","name":"B"}`,
			`{"id":"n3","name":"C"}`,
		]);
	});

	it("unions flashcard decks and deduplicates per-card review histories while preserving nodeId", () => {
		const deckA: FlashcardDeck = {
			noteId: "src_1",
			noteName: "Notes",
			generatedAt: 1000,
			cards: [
				{
					id: "c1",
					front: "Q1",
					back: "A1",
					quote: "q1",
					nodeId: "n_1",
					createdAt: 1000,
					reviews: [
						{ at: 2000, grade: 3 },
						{ at: 4000, grade: 2 },
					],
				},
			],
		};
		const deckB: FlashcardDeck = {
			noteId: "src_1",
			noteName: "Notes",
			generatedAt: 1500,
			cards: [
				{
					id: "c1",
					front: "Q1",
					back: "A1 refined",
					quote: "q1",
					createdAt: 1000,
					reviews: [
						{ at: 2000, grade: 3 }, // duplicate
						{ at: 5000, grade: 3 }, // from other device
					],
				},
				{
					id: "c2",
					front: "Q2",
					back: "A2",
					quote: "q2",
					createdAt: 1500,
					reviews: [],
				},
			],
		};

		const mergedRaw = mergeFlashcardDecks(JSON.stringify(deckA), JSON.stringify(deckB));
		assert.ok(mergedRaw !== null);
		const merged = JSON.parse(mergedRaw) as FlashcardDeck;
		assert.equal(merged.cards.length, 2);
		const c1 = merged.cards.find((c) => c.id === "c1")!;
		assert.equal(c1.back, "A1 refined");
		assert.equal(c1.nodeId, "n_1", "preserves nodeId link");
		assert.deepEqual(c1.reviews, [
			{ at: 2000, grade: 3 },
			{ at: 4000, grade: 2 },
			{ at: 5000, grade: 3 },
		]);
	});

	it("merges full file snapshots across domains and skips rebuildable digests", () => {
		const local: Record<string, string> = {
			"graph/nodes.jsonl": `{"id":"n1"}\n`,
			"chats/c1.json": JSON.stringify({ id: "c1", updatedAt: "2026-11-10T10:00:00Z", messages: [1] }),
			"fsrs-weights.json": JSON.stringify({ version: 1, fittedAt: 1000, weights: [] }),
			"digests/c1.json": `{"stale":true}`,
		};
		const remote: Record<string, string> = {
			"graph/nodes.jsonl": `{"id":"n2"}\n`,
			"chats/c1.json": JSON.stringify({ id: "c1", updatedAt: "2026-11-11T10:00:00Z", messages: [1, 2] }),
			"chats/c2.json": JSON.stringify({ id: "c2", updatedAt: "2026-11-11T11:00:00Z", messages: [1] }),
			"fsrs-weights.json": JSON.stringify({ version: 1, fittedAt: 2000, weights: [] }),
		};

		const res = mergeSyncFiles(local, remote);
		assert.equal(res.files["digests/c1.json"], undefined, "digests skipped");
		assert.equal(res.stats.added, 1);
		assert.equal(res.stats.updated, 2);
		assert.equal(res.stats.mergedLedgers, 1);
		assert.ok(res.files["chats/c2.json"]);
		assert.equal(JSON.parse(res.files["chats/c1.json"]!).updatedAt, "2026-11-11T10:00:00Z");
		assert.equal(JSON.parse(res.files["fsrs-weights.json"]!).fittedAt, 2000);
	});

	it("encrypts and decrypts SyncBundlePayload with AES-256-GCM and rejects wrong passphrases", () => {
		const payload: SyncBundlePayload = {
			app: "socrates",
			format: 1,
			exportedAt: "2026-11-20T00:00:00.000Z",
			deviceId: "dev_test123",
			files: { "graph/nodes.jsonl": `{"id":"n1"}\n` },
		};
		const encrypted = encryptSyncBundle(payload, "correct-horse-battery");
		assert.ok(!encrypted.includes("dev_test123"), "ciphertext hides payload metadata");

		const decrypted = decryptSyncBundle(encrypted, "correct-horse-battery");
		assert.deepEqual(decrypted, payload);

		assert.throws(() => decryptSyncBundle(encrypted, "wrong-passphrase"), SyncError);
		assert.throws(() => encryptSyncBundle(payload, "123"), SyncError);
	});
});
