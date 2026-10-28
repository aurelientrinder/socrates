/**
 * FREE-RECALL REVIEW ("explain from memory" — src/core/recall-review.ts,
 * the review_recall / review_mark tools in src/agent/tools/review.ts):
 *
 * - key points must quote the topic's source material (no invented rubric);
 * - marks must quote the learner's answer, corrections the source;
 * - the grade is computed from the marks, pessimistic like the fold;
 * - the format each topic takes is set by the queue and enforced;
 * - an answer waits for its marking before the next question, within one
 *   turn too (the gate);
 * - the marking and "I don't remember" feed the retention fold, an
 *   unmarked answer does not;
 * - the tally and the source read-back from a teaching session.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	assignReviewFormats,
	buildRecallMark,
	composeSource,
	MAX_SOURCE_CHARS,
	normalizeQuote,
	planNodeTeaching,
	quotedIn,
	recallMarkGrade,
	recallMarkProblems,
	recallReviewProblems,
	type KeyPoint,
	type RecallMarkInput,
} from "../src/core/recall-review.ts";
import { newReviewContextMessage, reviewResults, reviewTally, unmarkedRecallOf, type ReviewTopic } from "../src/core/review.ts";
import { inputAppends } from "../src/core/input-events.ts";
import { isQuestionTool } from "../src/core/input-events.ts";
import { toolQuestionKind } from "../src/core/pending.ts";
import { toLlmMessages, type LhMessage } from "../src/core/native-messages.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import { GRADE_AGAIN, GRADE_GOOD, GRADE_HARD, recallEvents } from "../src/core/retention.ts";
import { parseRecallReviewInput } from "../src/core/tool-parts.ts";
import { recallMarkTool, recallReviewTool, reviewTool, reviewTools, createReviewGate } from "../src/agent/tools/review.ts";
import { composeInstructions } from "../src/agent/teacher-agent.ts";

const SOURCE =
	"The chain rule differentiates a composition: the derivative of f(g(x)) is f'(g(x)) times g'(x).\n\n" +
	"Intuition: rates multiply — if g changes twice as fast as x, and f three times as fast as g, f changes six times as fast as x.";

const TOPICS: ReviewTopic[] = [
	{ key: "prop:n_chain", title: "Chain rule", sourceTitle: "Calculus", retention: 0.6, format: "recall", source: SOURCE },
	{ key: "plan:chat_x:limits", title: "Limits", sourceTitle: "Calculus", retention: 0.8, format: "choice" },
];

const KEY_POINTS: KeyPoint[] = [
	{ point: "The derivative of f(g(x)) is f'(g(x)) · g'(x)", source: "the derivative of f(g(x)) is f'(g(x)) times g'(x)" },
	{ point: "Rates of change multiply along the composition", source: "rates multiply" },
];

let seq = 0;
function call(name: string, args: Record<string, unknown>): LhMessage {
	const id = `call_${++seq}`;
	return { id: `m_${id}`, role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], timestamp: 1 } as never;
}
const idOf = (m: LhMessage) => ((m as { content: Array<{ id: string }> }).content[0]!).id;

function recallCall(topicId = "prop:n_chain"): LhMessage {
	return call("review_recall", { topicId, question: "Explain the chain rule from memory.", keyPoints: KEY_POINTS });
}

function recallAnswer(text: string | undefined, extra: Partial<QuestionAnswerData> = {}): QuestionAnswerData {
	return {
		kind: "explain",
		tool: "review_recall",
		questionText: "Explain the chain rule from memory.",
		dontKnow: false,
		answers: [],
		...(text ? { text } : {}),
		answeredAt: new Date(Date.UTC(2026, 9, 27, 12)).toISOString(),
		...extra,
	};
}

const ANSWER = "You take the derivative of the outside, f'(g(x)), and multiply by g'(x), the inside's derivative.";

/** A review record with the free-recall question answered (stamped like the server does). */
function answeredRecord(answer: QuestionAnswerData) {
	const pose = recallCall();
	const record = { kind: "review" as const, messages: [newReviewContextMessage(TOPICS) as LhMessage, pose] };
	record.messages.push(...inputAppends(record, { type: "answer", toolCallId: idOf(pose), answer }));
	return record;
}

function storeOf(messages: LhMessage[]) {
	return { chatId: "c", chatStore: { getChat: () => ({ messages }) } };
}

const textOf = (r: { content: unknown }) => JSON.stringify(r.content);

describe("quoting", () => {
	it("matches across case, punctuation, LaTeX and line breaks, but not fragments or short words", () => {
		assert.equal(normalizeQuote("F'(g(x)) \\cdot g'(x)!"), "f g x cdot g x");
		assert.ok(quotedIn("Rates   MULTIPLY", SOURCE));
		assert.ok(quotedIn("the derivative of\nf(g(x))", SOURCE));
		assert.ok(!quotedIn("rates add up", SOURCE), "a claim the source does not make");
		assert.ok(!quotedIn("the", SOURCE), "too short to prove anything");
		assert.ok(!quotedIn("ates multipl", SOURCE), "word fragments never match");
		assert.ok(!quotedIn(undefined, SOURCE));
	});
});

describe("the pose's key points", () => {
	it("must each quote the topic's source material", () => {
		assert.deepEqual(recallReviewProblems({ keyPoints: KEY_POINTS }, SOURCE), []);
		const invented = [...KEY_POINTS, { point: "It was discovered by Leibniz", source: "discovered by Leibniz in 1676" }];
		const problems = recallReviewProblems({ keyPoints: invented }, SOURCE);
		assert.equal(problems.length, 1);
		assert.match(problems[0]!, /keyPoints\[2\]\.source is not a verbatim quote/);
	});

	it("cannot be posed on a topic with no source", () => {
		assert.match(recallReviewProblems({ keyPoints: KEY_POINTS }, undefined)[0]!, /no source material/);
	});
});

describe("the marking contract", () => {
	const good: RecallMarkInput = {
		topicId: "prop:n_chain",
		marks: [{ status: "covered", evidence: "multiply by g'(x)" }, { status: "missed" }],
	};

	it("accepts marks whose credits quote his answer", () => {
		assert.deepEqual(recallMarkProblems(good, KEY_POINTS, ANSWER, SOURCE), []);
	});

	it("needs exactly one mark per key point", () => {
		const short = { ...good, marks: [good.marks[0]!] };
		assert.match(recallMarkProblems(short, KEY_POINTS, ANSWER, SOURCE)[0]!, /exactly one mark per key point/);
	});

	it("rejects credit for words he never wrote", () => {
		const generous: RecallMarkInput = {
			...good,
			marks: [good.marks[0]!, { status: "partial", evidence: "rates multiply along the chain" }],
		};
		assert.match(recallMarkProblems(generous, KEY_POINTS, ANSWER, SOURCE)[0]!, /marks\[1\] is partial but its evidence/);
		const bare: RecallMarkInput = { ...good, marks: [{ status: "covered" }, { status: "missed" }] };
		assert.match(recallMarkProblems(bare, KEY_POINTS, ANSWER, SOURCE)[0]!, /marks\[0\] is covered/);
	});

	it("grounds every correction in his words and the source", () => {
		const ok = { ...good, errors: [{ claim: "derivative of the outside", correction: "…evaluated at g(x).", source: "f'(g(x)) times g'(x)" }] };
		assert.deepEqual(recallMarkProblems(ok, KEY_POINTS, ANSWER, SOURCE), []);
		const invented = { ...good, errors: [{ claim: "derivative of the outside", correction: "x", source: "Leibniz notation makes this obvious" }] };
		assert.match(recallMarkProblems(invented, KEY_POINTS, ANSWER, SOURCE)[0]!, /errors\[0\]\.source/);
		const putWords = { ...good, errors: [{ claim: "you add the derivatives", correction: "x", source: "rates multiply" }] };
		assert.match(recallMarkProblems(putWords, KEY_POINTS, ANSWER, SOURCE)[0]!, /errors\[0\]\.claim/);
	});
});

describe("the grade", () => {
	it("is computed from the marks, leaning pessimistic and never Easy", () => {
		assert.equal(recallMarkGrade({ statuses: ["covered", "covered"], errors: 0, confidence: 90 }), GRADE_GOOD);
		assert.equal(recallMarkGrade({ statuses: ["covered", "covered"], errors: 0 }), GRADE_GOOD);
		assert.equal(recallMarkGrade({ statuses: ["covered", "covered"], errors: 0, confidence: 30 }), GRADE_HARD, "unsure");
		assert.equal(recallMarkGrade({ statuses: ["covered", "covered"], errors: 1, confidence: 90 }), GRADE_HARD, "a wrong claim");
		assert.equal(recallMarkGrade({ statuses: ["covered", "partial"], errors: 0, confidence: 90 }), GRADE_HARD, "a blurred point");
		assert.equal(recallMarkGrade({ statuses: ["covered", "missed"], errors: 0, confidence: 100 }), GRADE_HARD, "half back");
		assert.equal(recallMarkGrade({ statuses: ["partial", "missed"], errors: 0, confidence: 100 }), GRADE_AGAIN, "under half");
		assert.equal(recallMarkGrade({ statuses: ["missed", "missed", "covered"], errors: 0 }), GRADE_AGAIN);
	});
});

describe("formats", () => {
	it("alternate recall / choice over topics with enough source, weakest first; thin topics stay choice", () => {
		const formats = assignReviewFormats([
			{ key: "a", source: SOURCE },
			{ key: "b", source: "short" },
			{ key: "c", source: SOURCE },
			{ key: "d", source: SOURCE },
			{ key: "e" },
		]).map((t) => t.format);
		assert.deepEqual(formats, ["recall", "choice", "choice", "recall", "choice"]);
	});

	it("are enforced at the call boundary in both directions", async () => {
		const messages = [newReviewContextMessage(TOPICS) as LhMessage];
		const mc = { question: "q?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], explanation: "e", correctAnswer: "a" };
		const wrongMc = await reviewTool(storeOf(messages)).execute("t", { topicId: "prop:n_chain", ...mc });
		assert.match(textOf(wrongMc), /explain-from-memory topic — pose it with review_recall/);
		const wrongRecall = await recallReviewTool(storeOf(messages)).execute("t", {
			topicId: "plan:chat_x:limits",
			question: "Explain limits.",
			keyPoints: KEY_POINTS,
		});
		assert.match(textOf(wrongRecall), /multiple-choice topic — pose it with review/);
	});

	it("default to multiple choice on queues from before free recall", async () => {
		const old = [newReviewContextMessage([{ key: "prop:n_a", title: "A", retention: 0.5 }]) as LhMessage];
		const mc = { question: "q?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], explanation: "e", correctAnswer: "a" };
		const ok = await reviewTool(storeOf(old)).execute("t", { topicId: "prop:n_a", ...mc });
		assert.equal((ok as { terminate?: boolean }).terminate, true);
	});
});

describe("the review-context marker", () => {
	it("hands the model each recall topic's source, and only theirs", () => {
		const text = JSON.stringify(toLlmMessages([newReviewContextMessage(TOPICS) as LhMessage]));
		assert.ok(text.includes("[prop:n_chain] Chain rule"));
		assert.ok(text.includes("EXPLAIN FROM MEMORY (review_recall)"));
		assert.ok(text.includes("> Intuition: rates multiply"), "the source rides the context");
		assert.ok(text.includes("[plan:chat_x:limits] Limits — multiple choice (review)"));
	});
});

describe("the free-recall pose", () => {
	it("is a question tool, explain-shaped", () => {
		assert.ok(isQuestionTool("review_recall"));
		assert.equal(toolQuestionKind("review_recall"), "explain");
		assert.ok(!isQuestionTool("review_mark"), "the marking is server-executed");
	});

	it("poses when its key points quote the source, and rejects invented ones", async () => {
		const messages = [newReviewContextMessage(TOPICS) as LhMessage];
		const tool = recallReviewTool(storeOf(messages));
		const ok = await tool.execute("t", { topicId: "prop:n_chain", question: "Explain the chain rule.", keyPoints: KEY_POINTS });
		assert.equal((ok as { terminate?: boolean }).terminate, true, "a posed question ends the turn");
		const bad = await tool.execute("t", {
			topicId: "prop:n_chain",
			question: "Explain the chain rule.",
			keyPoints: [{ point: "Newton proved it", source: "Newton proved it in the Principia" }],
		});
		assert.match(textOf(bad), /not a verbatim quote of the topic's source material/);
	});

	it("parses for the dock", () => {
		const input = parseRecallReviewInput({ topicId: "prop:n_chain", question: "Explain.", keyPoints: KEY_POINTS });
		assert.equal(input?.keyPoints.length, 2);
		assert.equal(parseRecallReviewInput({ topicId: "x", question: "Explain." }), undefined);
	});
});

describe("the marking flow", () => {
	it("stamps the answer with the call's topic and holds the next question until it is marked", async () => {
		const record = answeredRecord(recallAnswer(ANSWER, { confidence: 90 }));
		const answer = (record.messages.at(-1) as { details: QuestionAnswerData }).details;
		assert.equal(answer.topicId, "prop:n_chain");
		assert.equal(unmarkedRecallOf(record.messages)?.topicId, "prop:n_chain");

		const mc = { question: "q?", options: [{ label: "A", value: "a" }, { label: "B", value: "b" }], explanation: "e", correctAnswer: "a" };
		const tools = reviewTools(storeOf(record.messages));
		const blocked = await tools.review!.execute("t", { topicId: "plan:chat_x:limits", ...mc });
		assert.match(textOf(blocked), /not marked yet — call review_mark/);

		// The same turn: mark, then pose — the gate carries the marking
		// the stored record cannot hold yet.
		const marked = await tools.review_mark!.execute("t", {
			topicId: "prop:n_chain",
			marks: [{ status: "covered", evidence: "multiply by g'(x), the inside's derivative" }, { status: "missed" }],
		});
		assert.notEqual((marked as { isError?: boolean }).isError, true, textOf(marked));
		assert.match(textOf(marked), /\\"outcome\\":\\"shaky\\"/);
		const details = (marked as { details: { grade: number; coverage: number; sourceTitle?: string } }).details;
		assert.equal(details.grade, GRADE_HARD);
		assert.equal(details.coverage, 0.5);
		assert.equal(details.sourceTitle, "Calculus");

		const next = await tools.review!.execute("t", { topicId: "plan:chat_x:limits", ...mc });
		assert.equal((next as { terminate?: boolean }).terminate, true);
		const again = await tools.review_mark!.execute("t", { topicId: "prop:n_chain", marks: [{ status: "missed" }, { status: "missed" }] });
		assert.match(textOf(again), /no free-recall answer waiting/);
	});

	it("refuses to mark another topic, or with unquoted credit", async () => {
		const record = answeredRecord(recallAnswer(ANSWER));
		const tool = recallMarkTool(storeOf(record.messages));
		const other = await tool.execute("t", { topicId: "plan:chat_x:limits", marks: [] });
		assert.match(textOf(other), /waiting to be marked is on .*prop:n_chain/);
		const generous = await tool.execute("t", {
			topicId: "prop:n_chain",
			marks: [{ status: "covered", evidence: "multiply by g'(x)" }, { status: "covered", evidence: "rates multiply" }],
		});
		assert.match(textOf(generous), /marks\[1\] is covered but its evidence/);
	});

	it("needs no marking for a skip or 'I don't remember'", () => {
		assert.equal(unmarkedRecallOf(answeredRecord(recallAnswer(undefined, { dontKnow: true })).messages), null);
		assert.equal(unmarkedRecallOf(answeredRecord(recallAnswer(undefined, { dismissed: true })).messages), null);
		const gate = createReviewGate(storeOf(answeredRecord(recallAnswer(undefined, { dontKnow: true })).messages));
		assert.equal(gate.unmarked, null);
	});
});

describe("the retention fold", () => {
	function markedRecord(statuses: Array<"covered" | "partial" | "missed">, confidence?: number) {
		const record = answeredRecord(recallAnswer(ANSWER, confidence === undefined ? {} : { confidence }));
		const evidence = "multiply by g'(x)";
		const mark = buildRecallMark({
			mark: { topicId: "prop:n_chain", marks: statuses.map((status) => (status === "missed" ? { status } : { status, evidence })) },
			keyPoints: KEY_POINTS,
			confidence,
			at: Date.UTC(2026, 9, 27, 12, 1),
		});
		const markCall = call("review_mark", {});
		record.messages.push(markCall, {
			id: "r_mark",
			role: "toolResult",
			toolCallId: idOf(markCall),
			toolName: "review_mark",
			content: [],
			details: mark,
			isError: false,
			timestamp: 3,
		} as never);
		return record.messages;
	}

	it("reads the marking's computed grade as the topic's review", () => {
		const events = recallEvents({ id: "r", title: "Review", messages: markedRecord(["covered", "covered"], 90) });
		assert.deepEqual(events.map((e) => [e.topicKey, e.grade, e.review]), [["prop:n_chain", GRADE_GOOD, true]]);
		const lapse = recallEvents({ id: "r", title: "Review", messages: markedRecord(["missed", "partial"], 90) });
		assert.deepEqual(lapse.map((e) => e.grade), [GRADE_AGAIN]);
	});

	it("grades 'I don't remember' Again, and ignores an answer not yet marked", () => {
		const forgot = recallEvents({ id: "r", title: "Review", messages: answeredRecord(recallAnswer(undefined, { dontKnow: true })).messages });
		assert.deepEqual(forgot.map((e) => [e.topicKey, e.grade]), [["prop:n_chain", GRADE_AGAIN]]);
		assert.deepEqual(recallEvents({ id: "r", title: "Review", messages: answeredRecord(recallAnswer(ANSWER)).messages }), []);
		assert.deepEqual(recallEvents({ id: "r", title: "Review", messages: answeredRecord(recallAnswer(undefined, { dismissed: true })).messages }), []);
	});

	it("drives the tally: settled only once marked", () => {
		assert.equal(reviewTally(answeredRecord(recallAnswer(ANSWER)).messages).done, 0);
		const tally = reviewTally(markedRecord(["covered", "partial"], 90));
		assert.equal(tally.outcomes["prop:n_chain"], "shaky");
		assert.equal(tally.done, 1);
		assert.equal(reviewTally(markedRecord(["covered", "covered"], 90)).outcomes["prop:n_chain"], "recalled");
		assert.equal(reviewTally(answeredRecord(recallAnswer(undefined, { dontKnow: true })).messages).outcomes["prop:n_chain"], "missed");
		assert.deepEqual(reviewResults(markedRecord(["covered", "covered"], 90)).map((r) => r.outcome), ["recalled"]);
	});
});

describe("the source material", () => {
	it("reads a plan node's teaching back out of its session: prose before its questions, plus their explanations", () => {
		const text = (t: string) => ({ id: `m${++seq}`, role: "assistant", content: [{ type: "text", text: t }], timestamp: 1 }) as never;
		const quiz = (nodeId: string, explanation: string) =>
			call("quiz", { type: "check", nodeId, question: "q", options: [], explanation, correctAnswer: "a" });
		const messages = [
			text("Limits describe where a function heads."),
			quiz("limits", "A limit ignores the value at the point."),
			text("Continuity: the limit equals the value."),
			quiz("continuity", "Continuous means no jump."),
			text("Back to limits: one-sided limits must agree."),
			call("explain", { type: "check", nodeId: "limits", question: "q", correctAnswer: "Both one-sided limits exist and agree." }),
		];
		const source = planNodeTeaching(messages, "limits");
		assert.match(source, /Limits describe where a function heads/);
		assert.match(source, /A limit ignores the value/);
		assert.match(source, /one-sided limits must agree/);
		assert.match(source, /Both one-sided limits exist and agree/);
		assert.doesNotMatch(source, /Continuity|no jump/, "another node's teaching stays out");
		assert.equal(planNodeTeaching(messages, "never-taught"), "");
	});

	it("drops repeats and caps its length", () => {
		assert.equal(composeSource(["A summary line.", undefined, "a summary line", "More."]), "A summary line.\n\nMore.");
		assert.ok(composeSource(["x".repeat(MAX_SOURCE_CHARS * 2)]).length <= MAX_SOURCE_CHARS + 1);
	});
});

describe("the reviewer's prompt", () => {
	it("teaches the free-recall pair and grounds it in the source", () => {
		const prompt = composeInstructions("review");
		assert.match(prompt, /`review_recall`/);
		assert.match(prompt, /`review_mark`/);
		assert.match(prompt, /the source is their only ground/);
	});
});
