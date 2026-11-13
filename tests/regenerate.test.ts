import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { PATHS } from "../config.ts";
import { createTeacherAgent } from "../src/agent/teacher-agent.ts";
import type { PiEngine } from "../src/agent/models.ts";
import type { GraphChain, GraphNode } from "../src/core/contracts/graph.ts";
import { deleteMessageTraces } from "../src/core/graph-deletion.ts";
import { ChatInputError, parseChatInput } from "../src/core/input-events.ts";
import { newUserMessage, regenerateSplit, type LhMessage } from "../src/core/native-messages.ts";
import type { GraphStore } from "../src/core/ports.ts";
import { createFauxCore, fauxAssistantMessage, fauxText, type FauxResponseStep } from "../src/llm/index.ts";
import { handleChatRequest } from "../src/server/chat-handler.ts";
import { runningTurn } from "../src/server/turn-runs.ts";
import { chatStore } from "../src/store/chats.ts";

process.env.GEMINI_API_KEY ??= "test-key-presence-gate";

function userMsg(id: string, text = "hi"): LhMessage {
	return { ...newUserMessage(text), id };
}

function assistantMsg(id: string, content: unknown[]): LhMessage {
	return {
		id,
		role: "assistant",
		content,
		api: "faux",
		provider: "google",
		model: "gemini-3.8-flash",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: 0,
	} as unknown as LhMessage;
}

function fakeGraphStore(seed: {
	nodes: GraphNode[];
	chains: GraphChain[];
	coverage: Array<{ chatId: string; fp: string; tokens: number; foldedAt: string }>;
	positions: Record<string, { x: number; y: number }>;
}): GraphStore & { state: typeof seed } {
	const state = {
		nodes: [...seed.nodes],
		chains: [...seed.chains],
		coverage: [...seed.coverage],
		positions: { ...seed.positions },
	};
	return {
		state,
		appendNode: (n) => state.nodes.push(n),
		readNodes: () => state.nodes,
		appendChain: (c) => state.chains.push(c),
		readChains: () => state.chains,
		appendCheckpoint: () => {},
		readCheckpoints: () => [],
		appendCoverage: (c) => state.coverage.push(c),
		readCoverage: () => state.coverage,
		upsertSource: () => {},
		readSources: () => [],
		appendSourceUsage: () => {},
		readPositions: () => state.positions,
		writePositions: (p) => {
			state.positions = { ...p };
		},
		rewriteLedgers: (next) => {
			if (next.nodes !== undefined) state.nodes = next.nodes;
			if (next.chains !== undefined) state.chains = next.chains;
			if (next.coverage !== undefined) state.coverage = next.coverage;
		},
	};
}

const createdChats: string[] = [];
after(() => {
	for (const id of createdChats) {
		try {
			fs.unlinkSync(path.join(PATHS.chats, `${id}.json`));
		} catch {
			/* ignore */
		}
	}
});

describe("regenerateSplit", () => {
	it("splits right before the target assistant reply and steps back across empty frames", () => {
		const history: LhMessage[] = [
			userMsg("u1", "first"),
			assistantMsg("empty0", []),
			assistantMsg("a1", [{ type: "text", text: "reply 1" }]),
			userMsg("u2", "second"),
			assistantMsg("a2", [{ type: "text", text: "reply 2" }]),
		];
		const split = regenerateSplit(history, "a1");
		assert.ok(split);
		assert.deepEqual(split.surviving.map((m) => m.id), ["u1"]);
		assert.deepEqual(split.discarded.map((m) => m.id), ["empty0", "a1", "u2", "a2"]);
	});

	it("drops orphaned compaction markers whose firstKeptMessageId was discarded", () => {
		const validCompaction = {
			id: "comp_keep",
			role: "custom",
			customType: "compaction",
			content: "old summary",
			display: false,
			details: { firstKeptMessageId: "u1" },
			timestamp: 0,
		} as unknown as LhMessage;
		const orphanedCompaction = {
			id: "comp_drop",
			role: "custom",
			customType: "compaction",
			content: "newer summary",
			display: false,
			details: { firstKeptMessageId: "a2" },
			timestamp: 1,
		} as unknown as LhMessage;

		const history: LhMessage[] = [
			userMsg("u0", "early"),
			validCompaction,
			userMsg("u1", "kept"),
			orphanedCompaction,
			assistantMsg("a2", [{ type: "text", text: "drop me" }]),
		];
		const split = regenerateSplit(history, "a2");
		assert.ok(split);
		assert.deepEqual(split.surviving.map((m) => m.id), ["u0", "comp_keep", "u1"]);
		assert.deepEqual(split.discarded.map((m) => m.id), ["a2"]);
	});

	it("returns null for missing or non-assistant ids", () => {
		const history: LhMessage[] = [userMsg("u1"), assistantMsg("a1", [{ type: "text", text: "hi" }])];
		assert.equal(regenerateSplit(history, "u1"), null);
		assert.equal(regenerateSplit(history, "missing"), null);
	});
});

describe("parseChatInput — regenerate & retry settings", () => {
	it("parses valid regenerate and retry events with optional settings", () => {
		assert.deepEqual(parseChatInput({ type: "regenerate", messageId: "m1" }), {
			type: "regenerate",
			messageId: "m1",
		});
		assert.deepEqual(
			parseChatInput({
				type: "regenerate",
				messageId: "m1",
				settings: { model: { provider: "google", id: "gemini-4-pro" }, thinkingLevel: "high" },
			}),
			{
				type: "regenerate",
				messageId: "m1",
				settings: { model: { provider: "google", id: "gemini-4-pro" }, thinkingLevel: "high" },
			},
		);
		assert.deepEqual(
			parseChatInput({
				type: "retry",
				settings: { thinkingLevel: "medium" },
			}),
			{
				type: "retry",
				settings: { thinkingLevel: "medium" },
			},
		);
	});

	it("rejects malformed regenerate inputs and invalid settings", () => {
		assert.throws(() => parseChatInput({ type: "regenerate", messageId: "" }), ChatInputError);
		assert.throws(
			() => parseChatInput({ type: "regenerate", messageId: "m1", settings: { thinkingLevel: "turbo" } }),
			ChatInputError,
		);
		assert.throws(
			() => parseChatInput({ type: "retry", settings: { model: { provider: "", id: "x" } } }),
			ChatInputError,
		);
	});
});

describe("deleteMessageTraces", () => {
	it("removes only nodes, chains, positions, and coverage exclusive to discarded messages", () => {
		const store = fakeGraphStore({
			nodes: [
				{
					id: "n_keep",
					name: "Keep",
					statement: "Surviving concept",
					aliases: [],
					createdAt: "2026-01-01T00:00:00Z",
					provenance: [
						{ chatId: "c1", messageId: "a1" },
						{ chatId: "c1", messageId: "a2" },
					],
				},
				{
					id: "n_drop",
					name: "Drop",
					statement: "Discarded concept",
					aliases: ["disc"],
					createdAt: "2026-01-01T00:00:00Z",
					provenance: [{ chatId: "c1", messageId: "a2" }],
				},
				{
					id: "n_other_chat",
					name: "Other",
					statement: "From c2",
					aliases: [],
					createdAt: "2026-01-01T00:00:00Z",
					provenance: [{ chatId: "c2", messageId: "a2" }],
				},
			],
			chains: [
				{
					id: "arg_keep",
					premises: ["n_keep"],
					conclusion: "n_other_chat",
					provenance: [{ chatId: "c1", messageId: "a1" }],
					createdAt: "2026-01-01T00:00:00Z",
				},
				{
					id: "arg_drop",
					premises: ["n_keep"],
					conclusion: "n_drop",
					provenance: [{ chatId: "c1", messageId: "a2" }],
					createdAt: "2026-01-01T00:00:00Z",
				},
			],
			coverage: [
				{ chatId: "c1", fp: "fp_a1", tokens: 10, foldedAt: "2026-01-01T00:00:00Z" },
				{ chatId: "c1", fp: "fp_a2", tokens: 10, foldedAt: "2026-01-01T00:00:00Z" },
				{ chatId: "c2", fp: "fp_a2", tokens: 10, foldedAt: "2026-01-01T00:00:00Z" },
			],
			positions: {
				n_keep: { x: 1, y: 1 },
				n_drop: { x: 2, y: 2 },
				arg_drop: { x: 3, y: 3 },
				n_other_chat: { x: 4, y: 4 },
			},
		});

		const stats = deleteMessageTraces(store, "c1", new Set(["a2"]), new Set(["fp_a2"]));
		assert.equal(stats.nodesRemoved, 1);
		assert.equal(stats.chainsRemoved, 1);
		assert.equal(stats.coverageRemoved, 1);

		assert.deepEqual(store.state.nodes.map((n) => n.id), ["n_keep", "n_other_chat"]);
		assert.deepEqual(store.state.nodes[0]!.provenance, [{ chatId: "c1", messageId: "a1" }]);
		assert.deepEqual(store.state.chains.map((c) => c.id), ["arg_keep"]);
		assert.deepEqual(
			store.state.coverage.map((c) => `${c.chatId}:${c.fp}`),
			["c1:fp_a1", "c2:fp_a2"],
		);
		assert.deepEqual(Object.keys(store.state.positions), ["n_keep", "n_other_chat"]);
	});
});

describe("handleChatRequest regenerate integration", () => {
	it("rewinds history, applies updated model settings, prunes orphaned asides/tree, and streams replacement reply", async () => {
		const chat = chatStore.createChat("Test: regenerate");
		createdChats.push(chat.id);
		chatStore.saveSettings(chat.id, { model: { provider: "google", id: "gemini-3.8-flash" } });
		chatStore.saveTree(chat.id, { nodes: [{ id: "n1", title: "Temp node" }], edges: [], version: 1 });
		chatStore.saveMessages(chat.id, [
			userMsg("u1", "Explain torques"),
			assistantMsg("a1", [
				{ type: "toolCall", id: "q1", name: "quiz", arguments: { question: "Q1?", options: [{ label: "A" }], correctAnswer: "A", explanation: "because" } },
			]),
			assistantMsg("a2", [{ type: "text", text: "Later follow-up" }]),
		]);
		chatStore.appendAside(chat.id, {
			id: "aside_drop",
			questionCallId: "q1",
			text: "Hint?",
			reply: "Sure",
			at: new Date().toISOString(),
		});

		const faux = createFauxCore({});
		const seenContexts: string[][] = [];
		const step: FauxResponseStep = (ctx) => {
			seenContexts.push(ctx.messages.map((m) => String((m as { role?: string }).role)));
			return fauxAssistantMessage([fauxText("Fresh explanation with new model.")]);
		};
		faux.setResponses([step]);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };

		const req = new Request("http://test/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				chatId: chat.id,
				input: {
					type: "regenerate",
					messageId: "a1",
					settings: { model: { provider: "google", id: "gemini-3.5-flash-lite" }, thinkingLevel: "medium" },
				},
			}),
		});

		const res = await handleChatRequest(req, (opts) => createTeacherAgent(undefined, { engine, messages: opts.messages }));
		assert.equal(res.status, 200);
		await res.arrayBuffer();
		const handle = runningTurn(chat.id);
		if (handle) {
			await new Response(handle.subscribe()).text();
		}

		const updated = chatStore.getChat(chat.id)!;
		assert.equal(updated.settings?.model?.id, "gemini-3.5-flash-lite");
		assert.equal(updated.settings?.thinkingLevel, "medium");
		assert.equal(updated.tree, undefined, "plan tree from discarded portion should be cleared");
		assert.deepEqual(updated.asides ?? [], [], "aside targeting discarded question should be pruned");
		assert.equal(seenContexts.length, 1);
		assert.deepEqual(seenContexts[0], ["system", "user"]);
		assert.equal(updated.messages.length, 2);
		assert.equal(updated.messages[0]!.id, "u1");
		const replyText = ((updated.messages[1] as { content: Array<{ type: string; text?: string }> }).content.find((b) => b.type === "text"))?.text;
		assert.equal(replyText, "Fresh explanation with new model.");
	});
});
