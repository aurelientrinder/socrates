/**
 * The chat list's summary index (2026-11-01): kept on disk so the first
 * list after a launch does not parse every transcript, and still checked
 * against each chat file's size and mtime.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, it } from "node:test";
import { PATHS } from "../config.ts";
import { chatStore } from "../src/store/chats.ts";

const indexFile = path.join(PATHS.data, "cache", "chat-summaries.json");
const created: string[] = [];
after(() => {
	for (const id of created) fs.rmSync(path.join(PATHS.chats, `${id}.json`), { force: true });
});

/** A second copy of the store module: a fresh process's view (empty
 *  in-memory cache, index not loaded yet). */
async function freshStore(tag: string) {
	const mod = (await import(`../src/store/chats.ts?fresh=${tag}`)) as typeof import("../src/store/chats.ts");
	return mod.chatStore;
}

it("the summary index is written and a fresh process lists from it", async () => {
	const chat = chatStore.createChat("Index test");
	created.push(chat.id);
	chatStore.listChats();
	const index = JSON.parse(fs.readFileSync(indexFile, "utf-8"));
	assert.equal(index.entries[chat.id].summary.title, "Index test");

	// Prove the fresh list READS the index: doctor the indexed title while
	// size and mtime still match the file.
	index.entries[chat.id].summary.title = "Served from the index";
	fs.writeFileSync(indexFile, JSON.stringify(index));
	const listed = (await freshStore("a")).listChats().find((c) => c.id === chat.id);
	assert.equal(listed?.title, "Served from the index");
});

it("a chat that changed since the index was written is re-read", async () => {
	const chat = chatStore.createChat("Before rename");
	created.push(chat.id);
	chatStore.listChats();
	chatStore.renameChat(chat.id, "After a much longer rename");
	const listed = (await freshStore("b")).listChats().find((c) => c.id === chat.id);
	assert.equal(listed?.title, "After a much longer rename");
});

it("an unreadable index is ignored, never fatal", async () => {
	const chat = chatStore.createChat("Damaged index");
	created.push(chat.id);
	fs.mkdirSync(path.dirname(indexFile), { recursive: true });
	fs.writeFileSync(indexFile, "{nope");
	const listed = (await freshStore("c")).listChats().find((c) => c.id === chat.id);
	assert.equal(listed?.title, "Damaged index");
});
