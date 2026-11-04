/**
 * ASIDES (2026-11-04): side questions asked while a quiz question waits.
 * The exchange lives in the record's asides log; the open question stays
 * the dangling tail; its answer result carries a digest for the tutor.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-asides-"));
process.env.LH_DATA_DIR = TMP_DATA;

const { chatStore } = await import("../src/store/chats.ts");
const core = await import("../src/core/index.ts");
const { handleAside, parseAsideInput } = await import("../src/server/aside.ts");
const { AsideBar, AsideThread } = await import("../components/aside.tsx");
const { newMessageId } = await import("../src/core/native-messages.ts");

after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const aside = (id: string, call: string, text: string, reply: string) => ({
	id,
	questionCallId: call,
	text,
	reply,
	at: "2026-11-04T21:00:00.000Z",
});

function chatWithQuiz(): { chatId: string; callId: string } {
	const chat = chatStore.createChat("asides");
	chatStore.saveMessages(chat.id, [
		{
			id: newMessageId(),
			role: "assistant",
			content: [
				{ type: "text", text: "A group is a set with an operation." },
				{ type: "toolCall", id: "call-q1", name: "quiz", arguments: { question: "What is a cyclic group?" } },
			],
		} as never,
	]);
	return { chatId: chat.id, callId: "call-q1" };
}

describe("aside digest", () => {
	it("only the asked question's asides reach its answer result", () => {
		const logs = [aside("a1", "call-q1", "why a set?", "Because…"), aside("a2", "call-other", "x", "y")];
		const result = core.newAnswerResult("call-q1", "quiz", { kind: "quiz", dontKnow: false, answers: [] }) as { content: { type: string; text?: string }[] };
		const digested = core.withAsideDigest(result as never, logs) as typeof result;
		assert.equal(digested.content.length, 2);
		const digest = (digested.content[1] as { text: string }).text;
		assert.match(digest, /why a set\?/);
		assert.match(digest, /Because…/);
		assert.doesNotMatch(digest, /Learner: x/);
		// The canonical answer block is untouched.
		assert.equal(digested.content[0], result.content[0]);
	});

	it("passes the result through when nothing was asked", () => {
		const result = core.newAnswerResult("call-q1", "quiz", { kind: "quiz", dontKnow: false, answers: [] }) as { content: { type: string; text?: string }[] };
		assert.equal(core.withAsideDigest(result as never, []), result);
		assert.equal(core.withAsideDigest(result as never, undefined), result);
	});

	it("inputAppends folds the digest into the answer and leaves the call open until then", () => {
		const { chatId, callId } = chatWithQuiz();
		chatStore.appendAside(chatId, aside("a1", callId, "what is a set?", "A collection."));
		const record = chatStore.getChat(chatId)!;
		assert.equal(core.danglingQuestionOf(record.messages)?.toolCallId, callId); // asides never close it
		const appends = core.inputAppends(record, {
			type: "answer",
			toolCallId: callId,
			answer: { kind: "quiz", questionText: "q", dontKnow: false, answers: [], answeredAt: "t" } as never,
		});
		const text = JSON.stringify(appends[0]);
		assert.match(text, /what is a set\?/);
	});
});

describe("aside store + route guards", () => {
	it("appendAside is idempotent per id and stays out of the list summary", () => {
		const { chatId, callId } = chatWithQuiz();
		chatStore.appendAside(chatId, aside("a1", callId, "q", "r"));
		chatStore.appendAside(chatId, aside("a1", callId, "q", "r"));
		assert.equal(chatStore.getChat(chatId)!.asides!.length, 1);
		const summary = chatStore.listChats().find((c) => c.id === chatId)!;
		assert.equal("asides" in summary, false);
	});

	it("parses input honestly", () => {
		assert.equal(typeof parseAsideInput({ id: "a", text: "  " }), "string");
		assert.equal(typeof parseAsideInput({ text: "hi" }), "string");
		assert.deepEqual(parseAsideInput({ id: "a", text: " hi " }), { id: "a", text: "hi" });
	});

	it("409s without an open question; 404s on an unknown chat", async () => {
		const chat = chatStore.createChat("no question");
		const none = await handleAside(chat.id, { id: "a", text: "hi" });
		assert.equal(none.status, 409);
		const unknown = await handleAside("chat_missing", { id: "a", text: "hi" });
		assert.equal(unknown.status, 404);
	});

	it("answers a re-sent id from the log without a model call", async () => {
		const { chatId, callId } = chatWithQuiz();
		chatStore.appendAside(chatId, aside("a1", callId, "q", "stored reply"));
		const res = await handleAside(chatId, { id: "a1", text: "q" });
		assert.equal(res.status, 200);
		assert.equal(((await res.json()) as { aside: { reply: string } }).aside.reply, "stored reply");
	});
});

describe("aside rendering", () => {
	it("renders the exchange, the in-flight question, and the bar", () => {
		const html = renderToStaticMarkup(
			<AsideThread
				asides={[aside("a1", "c", "why?", "Because it closes.")]}
				pending={{ id: "a2", questionCallId: "c", text: "and then?" }}
			/>,
		);
		assert.match(html, /why\?/);
		assert.match(html, /Because it closes\./);
		assert.match(html, /and then\?/);
		assert.match(html, /Thinking/);
		assert.match(html, /still open/);
		assert.equal(renderToStaticMarkup(<AsideThread asides={[]} />), "");
		assert.match(renderToStaticMarkup(<AsideBar onAsk={() => {}} />), /Ask the tutor/);
	});

	it("shows a failed aside with a retry", () => {
		const html = renderToStaticMarkup(
			<AsideThread asides={[]} pending={{ id: "a", questionCallId: "c", text: "q", error: "boom" }} onRetry={() => {}} />,
		);
		assert.match(html, /boom/);
		assert.match(html, /Try again/);
	});
});
