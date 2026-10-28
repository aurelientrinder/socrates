/**
 * WARM-UP RECALL (src/core/review.ts warm-up section, the answer and
 * dismissal appends, the chat handler's agent choice, the session
 * birth in POST /api/chats), under an isolated LH_DATA_DIR:
 *
 * - a new learn or practice session opens with the weakest due topics
 *   (at most WARMUP_SIZE) as a warm-up queue; nothing due, or
 *   warmup: false, means no warm-up;
 * - the review agent takes the turns while the warm-up runs; the answer
 *   that finishes it appends the warmup-done marker in the same write,
 *   and that very turn already runs the session's own agent, which reads
 *   the marker as its go-ahead;
 * - skipping a warm-up question ends the whole warm-up and owes the
 *   session's opening (needsContinuation);
 * - warm-up answers feed the retention fold like review answers.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, type FauxResponseStep } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-warmup-"));
process.env.LH_DATA_DIR = TMP_DATA;
process.env.OPENROUTER_API_KEY ??= "test-key-presence-gate";

const { chatStore } = await import("../src/store/chats.ts");
const { warmupContextMessage, reviewStatus } = await import("../src/server/review.ts");
const { handleChatRequest } = await import("../src/server/chat-handler.ts");
const { runningTurn } = await import("../src/server/turn-runs.ts");
const { createReviewAgent, createTeacherAgent } = await import("../src/agent/teacher-agent.ts");
const { composeInstructions } = await import("../src/agent/teacher-agent.ts");
const { newAnswerResult, needsContinuation, toLlmMessages, nativeInputCause } = await import("../src/core/native-messages.ts");
const { dismissAppends, inputAppends } = await import("../src/core/input-events.ts");
const { dismissedAnswer } = await import("../src/core/question-core.ts");
const { projectView } = await import("../src/core/view.ts");
const {
	hasWarmup,
	newReviewContextMessage,
	newWarmupContextMessage,
	reviewTopicsOf,
	warmupActive,
	warmupDoneAppends,
	WARMUP_SIZE,
} = await import("../src/core/review.ts");
const { recallEvents } = await import("../src/core/retention.ts");
const chatsRoute = await import("../app/api/chats/route.ts");

type LhMessage = import("../src/core/native-messages.ts").LhMessage;
type QuestionAnswerData = import("../src/core/question-core.ts").QuestionAnswerData;
type ReviewTopic = import("../src/core/review.ts").ReviewTopic;
type PiEngine = import("../src/agent/models.ts").PiEngine;

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;

const TOPICS: ReviewTopic[] = [
	{ key: "prop:n_a", title: "Chain rule", summary: "d/dx f(g(x)) = f'(g(x)) g'(x)", sourceTitle: "Calculus", retention: 0.6 },
	{ key: "prop:n_b", title: "Limits", sourceTitle: "Calculus", retention: 0.7 },
];

let seq = 0;
function reviewCall(topicId: string): LhMessage {
	const id = `call_w${++seq}`;
	return {
		id: `m_${id}`,
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id,
				name: "review",
				arguments: {
					topicId,
					question: "q?",
					options: [{ label: "A" }, { label: "B" }],
					explanation: "because",
					correctAnswer: "A",
				},
			},
		],
		timestamp: 1,
	} as never;
}
const callIdOf = (m: LhMessage) => (m as { content: Array<{ id: string }> }).content[0]!.id;

function answer(correct: boolean, confidence = 90): QuestionAnswerData {
	return { kind: "quiz", questionText: "q?", dontKnow: false, answers: [], correct, confidence, answeredAt: new Date().toISOString() };
}

describe("the warm-up queue marker", () => {
	it("is a review-context marker flagged warm-up, with the learner's request coming after", () => {
		const marker = newWarmupContextMessage(TOPICS) as LhMessage;
		assert.equal(hasWarmup([marker]), true);
		assert.equal(warmupActive([marker]), true);
		assert.deepEqual(reviewTopicsOf([marker]).map((t) => t.key), ["prop:n_a", "prop:n_b"]);
		const [wire] = toLlmMessages([marker as never]);
		const text = JSON.stringify(wire);
		assert.match(text, /warm-up recall before this session's own work/);
		assert.match(text, /\[prop:n_a\] Chain rule/);
	});

	it("a review session's own queue is not a warm-up", () => {
		const marker = newReviewContextMessage(TOPICS) as LhMessage;
		assert.equal(hasWarmup([marker]), false);
		assert.equal(warmupActive([marker]), false);
		const call = reviewCall("prop:n_a");
		const appends = inputAppends({ kind: "review", messages: [marker, call] }, { type: "answer", toolCallId: callIdOf(call), answer: answer(true) });
		assert.equal(appends.length, 1, "no warmup-done marker in a review session");
	});
});

describe("ending the warm-up", () => {
	it("appends warmup-done with the answer to the last question, not before", () => {
		const marker = newWarmupContextMessage(TOPICS) as LhMessage;
		const user = { id: "u1", role: "user", content: "Teach me integrals", timestamp: 1 } as LhMessage;
		const c1 = reviewCall("prop:n_a");
		const first = inputAppends({ messages: [marker, user, c1] }, { type: "answer", toolCallId: callIdOf(c1), answer: answer(true) });
		assert.equal(first.length, 1, "one question in: the warm-up goes on");
		const c2 = reviewCall("prop:n_b");
		const record = [marker, user, c1, ...first, c2];
		const second = inputAppends({ messages: record }, { type: "answer", toolCallId: callIdOf(c2), answer: answer(false) });
		assert.equal(second.length, 2);
		const done = second[1] as { role: string; customType: string; details: unknown; content: string };
		assert.equal(done.customType, "warmup-done");
		assert.deepEqual(done.details, { total: 2, recalled: 1, shaky: 0, missed: 1, skipped: false });
		assert.match(done.content, /1 of 2 recalled cleanly, 1 missed/);
		assert.match(done.content, /start the session itself on the learner's request/);
		const after = [...record, ...second];
		assert.equal(warmupActive(after), false);
		assert.equal(nativeInputCause(done as never, after as never), "learner");
		// The transcript renders it as a divider part.
		const view = projectView(after);
		assert.ok(view.some((m) => m.parts.some((p) => p.type === "data-warmup-done")));
	});

	it("a skip (dismissal) ends the whole warm-up and owes the session's opening", () => {
		const marker = newWarmupContextMessage(TOPICS) as LhMessage;
		const user = { id: "u1", role: "user", content: "Teach me integrals", timestamp: 1 } as LhMessage;
		const c1 = reviewCall("prop:n_a");
		const record = { messages: [marker, user, c1] };
		const appends = dismissAppends(record, { type: "dismiss", toolCallId: callIdOf(c1), answer: dismissedAnswer("quiz", "q?") });
		assert.equal(appends.length, 2);
		const done = appends[1] as { customType: string; details: { skipped: boolean }; content: string };
		assert.equal(done.customType, "warmup-done");
		assert.equal(done.details.skipped, true);
		assert.match(done.content, /skipped the rest of the warm-up/);
		assert.equal(needsContinuation([...record.messages, ...appends]), true, "the session's agent still owes its opening");
	});

	it("never fires for an answer to anything but a review call", () => {
		const marker = newWarmupContextMessage(TOPICS) as LhMessage;
		const result = newAnswerResult("x", "quiz", answer(true)) as LhMessage;
		assert.deepEqual(warmupDoneAppends([marker, result]), []);
	});

	it("feeds the retention fold: a warm-up answer reschedules its topic", () => {
		const marker = newWarmupContextMessage(TOPICS) as LhMessage;
		const c1 = reviewCall("prop:n_a");
		const [result] = inputAppends({ messages: [marker, c1] }, { type: "answer", toolCallId: callIdOf(c1), answer: answer(true) });
		const events = recallEvents({ id: "chat_learn", title: "Integrals", messages: [marker, c1, result!], tree: undefined } as never);
		assert.equal(events.length, 1);
		assert.equal(events[0]!.topicKey, "prop:n_a");
		assert.equal(events[0]!.review, true);
	});
});

describe("the reviewer's warm-up doctrine", () => {
	it("composes into the review prompt only", () => {
		assert.match(composeInstructions("review"), /A session's warm-up/);
		assert.doesNotMatch(composeInstructions("teacher"), /A session's warm-up/);
		assert.doesNotMatch(composeInstructions("prober"), /A session's warm-up/);
	});
});

// ─── the server side: session birth + the handler's agent choice ─────────────

const NOW = Date.now();

/** A finished lesson whose check answer decayed long ago: one due topic. */
function seedDueLesson(nodeId: string, title: string): void {
	const lesson = chatStore.createChat(`Lesson ${title}`);
	chatStore.saveTree(lesson.id, { nodes: [{ id: nodeId, title, summary: `${title} in one line.` }], edges: [], version: 1 });
	const callId = `call_seed_${nodeId}`;
	chatStore.saveMessages(lesson.id, [
		{
			id: `m_${callId}`,
			role: "assistant",
			content: [{ type: "toolCall", id: callId, name: "quiz", arguments: { type: "check", nodeId, question: "q", options: [], explanation: "e", correctAnswer: "a" } }],
			timestamp: NOW - 60 * DAY,
		} as never,
		newAnswerResult(callId, "quiz", {
			kind: "quiz",
			questionText: "q",
			dontKnow: false,
			answers: [],
			correct: true,
			confidence: 90,
			answeredAt: new Date(NOW - 60 * DAY).toISOString(),
		}),
	]);
}

async function createSession(body: Record<string, unknown>): Promise<string> {
	const res = await chatsRoute.POST(
		new Request("http://test/api/chats", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
	);
	const { id } = (await res.json()) as { id: string };
	chatStore.saveSettings(id, { model: { provider: "openrouter", id: "z-ai/glm-5.3-flash" } });
	return id;
}

function post(chatId: string, input: unknown): Request {
	return new Request("http://test/api/chat", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ chatId, input }),
	});
}

async function runTurn(req: Request, factory: Parameters<typeof handleChatRequest>[1]): Promise<void> {
	const { chatId } = (await req.clone().json()) as { chatId: string };
	const ack = await handleChatRequest(req, factory);
	assert.equal(ack.status, 200, await ack.clone().text());
	const handle = runningTurn(chatId);
	if (handle) await new Response(handle.subscribe()).text();
}

describe("session birth", () => {
	it("no warm-up while nothing is due", async () => {
		assert.equal(warmupContextMessage(), null);
		const id = await createSession({ title: "Teach me integrals" });
		assert.deepEqual(chatStore.getChat(id)!.messages, []);
	});

	it("a learn session opens with at most WARMUP_SIZE due topics, weakest first", async () => {
		for (const [n, t] of [["a", "Alpha"], ["b", "Beta"], ["c", "Gamma"], ["d", "Delta"]] as const) seedDueLesson(n, t);
		const id = await createSession({ title: "Teach me integrals" });
		const messages = chatStore.getChat(id)!.messages;
		assert.equal(messages.length, 1);
		assert.equal(hasWarmup(messages), true);
		const topics = reviewTopicsOf(messages);
		assert.equal(topics.length, WARMUP_SIZE);
		assert.ok(topics.every((t) => t.summary?.endsWith("in one line.")), "each topic carries its material");
		assert.ok(topics.every((t) => t.format === undefined && t.source === undefined), "warm-up topics are multiple choice only");
	});

	it("warmup: false opens the session without one", async () => {
		const id = await createSession({ title: "Teach me integrals", warmup: false });
		assert.deepEqual(chatStore.getChat(id)!.messages, []);
	});

	it("a practice session keeps its map picks first, then the warm-up", async () => {
		const id = await createSession({
			title: "Practice",
			kind: "practice",
			graphContext: { propositions: [{ id: "p1", name: "P1", statement: "S1" }] },
		});
		const messages = chatStore.getChat(id)!.messages as Array<{ customType?: string }>;
		assert.deepEqual(messages.map((m) => m.customType), ["graph-context", "review-context"]);
	});
});

describe("the handler's agent choice", () => {
	it("the reviewer asks the warm-up, then the last answer's own turn is the teacher's", async () => {
		const id = await createSession({ title: "Teach me integrals" });
		const topics = reviewTopicsOf(chatStore.getChat(id)!.messages);
		const seen: Array<{ warmingUp: boolean | undefined; lastText: string }> = [];
		const steps: FauxResponseStep[] = [
			...topics.map(
				(t, i) => () =>
					fauxAssistantMessage(
						[
							fauxText(i === 0 ? "Quick warm-up first." : "Good."),
							fauxToolCall(
								"review",
								{ topicId: t.key, question: `About ${t.title}?`, options: [{ label: "Yes" }, { label: "No" }], correctAnswer: "Yes", explanation: "Because." },
								{ id: `call_rev_${i}` },
							),
						],
						{ stopReason: "toolUse" },
					),
			),
			() => fauxAssistantMessage([fauxText("Now, integrals.")]),
		];
		const faux = createFauxCore({});
		faux.setResponses(steps);
		const engine: PiEngine = { model: faux.getModel(), streamFn: faux.streamSimple };
		const factory: Parameters<typeof handleChatRequest>[1] = (opts) => {
			const msgs = opts.messages ?? [];
			const last = msgs[msgs.length - 1] as { content?: unknown } | undefined;
			seen.push({ warmingUp: opts.warmingUp, lastText: JSON.stringify(last?.content ?? "") });
			return opts.warmingUp
				? createReviewAgent({ chatId: id, chatStore }, { engine, messages: opts.messages })
				: createTeacherAgent(undefined, { engine, messages: opts.messages });
		};

		await runTurn(post(id, { type: "text", text: "Teach me integrals" }), factory);
		for (let i = 0; i < topics.length; i++) {
			await runTurn(post(id, { type: "answer", toolCallId: `call_rev_${i}`, answer: answer(i !== 1) }), factory);
		}

		assert.deepEqual(
			seen.map((s) => s.warmingUp),
			[true, true, true, false],
			"three reviewer turns (opening + two reactions), then the teacher on the last answer",
		);
		assert.match(seen.at(-1)!.lastText, /Warm-up done/);
		const record = chatStore.getChat(id)!;
		assert.equal(warmupActive(record.messages), false);
		const last = record.messages.at(-1) as { role: string; content: unknown };
		assert.equal(last.role, "assistant");
		assert.match(JSON.stringify(last.content), /Now, integrals/);
		// The warm-up's answers count toward today's reviews.
		assert.ok(reviewStatus().reviewedToday >= topics.length);
	});
});
