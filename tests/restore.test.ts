/**
 * RESTORE (src/server/restore.ts): an export file or a daily snapshot puts
 * the learner's data back; a copy of the current data is kept first, and a
 * bad file changes nothing.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-restore-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const { flashcardStore } = await import("../src/store/flashcards.ts");
const { exportData } = await import("../src/server/backup.ts");
const { restoreExport, restoreSnapshot, listSnapshots, RestoreError } = await import("../src/server/restore.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const deck = (noteId: string, front: string) => ({
	noteId,
	noteName: "Notes.txt",
	generatedAt: 1,
	cards: [{ id: "card_1", front, back: "b", quote: "q q q", createdAt: 1, reviews: [] }],
});

describe("restore", () => {
	it("brings back deleted sessions and replaced decks from an export, after keeping a safety copy", () => {
		const keep = chatStore.createChat("Kept session");
		flashcardStore.save(deck("src_aaaaaaaaaaaa", "Original?"));
		const bundle = JSON.parse(JSON.stringify(exportData()));

		chatStore.deleteChat(keep.id);
		const other = chatStore.createChat("Made after the export");
		flashcardStore.save(deck("src_aaaaaaaaaaaa", "Changed?"));
		flashcardStore.save(deck("src_bbbbbbbbbbbb", "Extra deck?"));

		const result = restoreExport(bundle);
		assert.ok(result.files >= 2);
		assert.ok(chatStore.getChat(keep.id), "the deleted session is back");
		assert.equal(chatStore.getChat(other.id), null, "what was made after the export is replaced");
		assert.equal(flashcardStore.get("src_aaaaaaaaaaaa")!.cards[0]!.front, "Original?");
		assert.equal(flashcardStore.get("src_bbbbbbbbbbbb"), null);

		// The state just before the restore can itself be restored.
		const copy = listSnapshots().find((s) => s.name === result.safetyCopy);
		assert.ok(copy && copy.kind === "before-restore");
		restoreSnapshot(copy.name, new Date(Date.now() + 2000));
		assert.ok(chatStore.getChat(other.id), "undo brings the newer session back");
		assert.equal(flashcardStore.get("src_aaaaaaaaaaaa")!.cards[0]!.front, "Changed?");
	});

	it("refuses a damaged or foreign file and changes nothing", () => {
		const before = chatStore.createChat("Stays put");
		const good = JSON.parse(JSON.stringify(exportData()));
		const cases: unknown[] = [
			null,
			{ app: "other", format: 1, files: {} },
			{ app: "socrates", format: 1, files: {} },
			{ ...good, files: { ...good.files, "chats/../../escape.json": "{}" } },
			{ ...good, files: { ...good.files, "exams/notes.txt": "x" } },
			{ ...good, files: { ...good.files, [`chats/${before.id}.json`]: "{ not json" } },
		];
		for (const bundle of cases) assert.throws(() => restoreExport(bundle), RestoreError);
		assert.ok(chatStore.getChat(before.id));
		assert.equal(fs.existsSync(path.join(TMP_DATA, "..", "escape.json")), false);
		assert.deepEqual(fs.readdirSync(TMP_DATA).filter((n) => n.startsWith(".restore-")), []);
	});

	it("only accepts snapshot names from the list", () => {
		assert.throws(() => restoreSnapshot("../chats"), RestoreError);
		assert.throws(() => restoreSnapshot("2020-01-01"), /gone/);
	});
});
