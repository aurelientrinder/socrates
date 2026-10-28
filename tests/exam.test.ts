/**
 * MOCK EXAMS (src/core/exam.ts, src/agent/subagents/examiner.ts,
 * src/server/exams.ts), under an isolated LH_DATA_DIR:
 *
 * - the authoring laws: problem count, 2-5 parts, rubric sums, the
 *   multiple-choice cap, numeric final-value criteria;
 * - the independent check: fixed references replace the draft's, dropped
 *   parts go, a problem left with one part goes, ids renumber;
 * - numbers and quotes: what the code accepts as the learner's value and
 *   as a quote of their words;
 * - grading: choice and blank by code, unquoted credit withheld, the
 *   numeric final value decided by code, carry-forward only after an
 *   earlier loss;
 * - what the browser may see before and after grading;
 * - the whole pipeline on a scripted model: write → check → sit → mark,
 *   the server-owned clock, and the results reaching the memory model and
 *   the calibration fold.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "@earendil-works/pi-ai";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-exam-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const exam = await import("../src/core/exam.ts");
const {
	applyAudit,
	examCalibrationAnswers,
	examDraftProblems,
	examRecallEvents,
	examView,
	finalizeRubricGrades,
	gradeByCode,
	numberMatches,
	parseNumber,
	partGrade,
	problemsFromDraft,
	quoteFound,
	rubricSubmissionProblems,
	sanitizeAnswers,
	sessionHref,
	unquotedCredit,
} = exam;
type ExamDraft = import("../src/core/exam.ts").ExamDraft;
type ExamRecord = import("../src/core/exam.ts").ExamRecord;
type ExamProblem = import("../src/core/exam.ts").ExamProblem;
const { GRADE_AGAIN, GRADE_GOOD, GRADE_HARD } = await import("../src/core/retention.ts");

// ─── fixtures ───────────────────────────────────────────────────────────────

const SCENARIO =
	"A rigid, sealed 2.0 L steel tank holds 0.10 mol of an ideal monatomic gas at 300 K. The tank is heated on a hot plate until the gas reaches 450 K. Take R = 8.314 J/(mol K).";

function draft(overrides: Partial<ExamDraft["problems"][number]["parts"][number]>[] = []): ExamDraft {
	const parts: ExamDraft["problems"][number]["parts"] = [
		{
			prompt: "Explain why no work is done on or by the gas.",
			kind: "written",
			points: 2,
			solution: "The tank is rigid, so the volume is constant: W = -∫p dV = 0.",
			finalAnswer: "W = 0 because V is constant.",
			rubric: [
				{ criterion: "States the volume is constant (rigid tank)", points: 1 },
				{ criterion: "Concludes W = 0", points: 1 },
			],
			topicKeys: ["prop:n_first_law", "prop:unknown"],
		},
		{
			prompt: "Calculate the heat absorbed by the gas, in J.",
			kind: "numeric",
			points: 4,
			solution: "Q = ΔU = n (3/2) R ΔT = 0.10 × 1.5 × 8.314 × 150 = 187.1 J",
			finalAnswer: "187 J",
			numeric: { value: 187.1, tolerance: 0.01, unit: "J" },
			rubric: [
				{ criterion: "Uses Q = ΔU at constant volume", points: 1 },
				{ criterion: "Uses ΔU = (3/2) n R ΔT", points: 2 },
				{ criterion: "Correct final value", points: 1, final: true },
			],
			topicKeys: ["prop:n_first_law"],
		},
		{
			prompt: "Which quantity stays constant?",
			kind: "choice",
			points: 1,
			options: ["Pressure", "Volume", "Temperature"],
			correctOption: 1,
			solution: "The rigid tank keeps the volume fixed.",
			finalAnswer: "Volume",
		},
		{
			prompt: "Using your answer to (b), find the final pressure, in kPa.",
			kind: "numeric",
			points: 3,
			solution: "p = nRT/V = 0.10 × 8.314 × 450 / 0.002 = 187 065 Pa = 187 kPa",
			finalAnswer: "187 kPa",
			numeric: { value: 187.1, tolerance: 0.01, unit: "kPa" },
			rubric: [
				{ criterion: "Uses p = nRT/V with V in m^3", points: 2 },
				{ criterion: "Correct final value", points: 1, final: true },
			],
		},
	];
	return {
		title: "Thermodynamics mock exam",
		problems: [{ title: "A heated rigid tank", scenario: SCENARIO, sources: ["Thermo.pdf, p. 4"], parts: parts.map((p, i) => ({ ...p, ...overrides[i] })) }],
	};
}

const TOPICS = new Set(["prop:n_first_law"]);

function problem(): ExamProblem {
	return problemsFromDraft(draft(), TOPICS)[0]!;
}

function answer(text: string, extra: Partial<import("../src/core/exam.ts").ExamAnswer> = {}) {
	return { text, updatedAt: "2026-10-27T10:00:00.000Z", ...extra };
}

// ─── authoring ──────────────────────────────────────────────────────────────

describe("exam authoring laws", () => {
	it("accepts a sound draft", () => {
		assert.deepEqual(examDraftProblems(draft(), 1), []);
	});

	it("names every broken law", () => {
		const bad = draft([
			{ rubric: [{ criterion: "x", points: 1 }] }, // sums to 1, part is worth 2
			{ rubric: [{ criterion: "method", points: 4 }] }, // numeric without a final item
		]);
		const problems = examDraftProblems(bad, 2);
		assert.ok(problems.some((p) => p.includes("exactly 2 problems")));
		assert.ok(problems.some((p) => p.includes("add up to 1")));
		assert.ok(problems.some((p) => p.includes("final: true")));
	});

	it("caps multiple choice at a quarter of the parts", () => {
		const choice = { kind: "choice" as const, options: ["a", "b", "c"], correctOption: 0, rubric: undefined, numeric: undefined };
		const problems = examDraftProblems(draft([choice, {}, {}, {}]), 1);
		assert.ok(problems.some((p) => p.includes("2 of 4 parts are multiple choice; at most 1")));
	});

	it("needs a scenario and at least two parts per problem", () => {
		const d = draft();
		d.problems[0]!.scenario = "Short.";
		d.problems[0]!.parts = d.problems[0]!.parts.slice(0, 1);
		const problems = examDraftProblems(d, 1);
		assert.ok(problems.some((p) => p.includes("scenario")));
		assert.ok(problems.some((p) => p.includes("2 to 5 parts")));
	});

	it("assigns ids, keeps only known topics, and gives choice parts their one-line rubric", () => {
		const p = problem();
		assert.deepEqual(p.parts.map((x) => x.id), ["1a", "1b", "1c", "1d"]);
		assert.deepEqual(p.parts[0]!.topicKeys, ["prop:n_first_law"]);
		assert.deepEqual(p.parts[1]!.rubric.map((r) => [r.id, r.final === true]), [["1b.1", false], ["1b.2", false], ["1b.3", true]]);
		assert.deepEqual(p.parts[2]!.rubric, [{ id: "1c.1", criterion: "The right option is picked.", points: 1 }]);
		assert.equal(p.parts[1]!.numeric?.unit, "J");
	});
});

describe("the independent check", () => {
	it("fixes, drops, renumbers, and drops a problem left with one part", () => {
		const problems = [problem(), { ...problem(), id: "2", parts: problem().parts.slice(0, 2).map((p, i) => ({ ...p, id: `2${"ab"[i]}` })) }];
		const out = applyAudit(problems, [
			{ partId: "1a", verdict: "drop", reason: "ambiguous" },
			{ partId: "1b", verdict: "fix", reason: "arithmetic", solution: "fixed", finalAnswer: "190 J", numericValue: 190 },
			{ partId: "2b", verdict: "drop", reason: "gives away 2a" },
		]);
		assert.equal(out.problems.length, 1);
		assert.deepEqual(out.problems[0]!.parts.map((p) => p.id), ["1a", "1b", "1c"]);
		assert.equal(out.problems[0]!.parts[0]!.numeric?.value, 190);
		assert.equal(out.problems[0]!.parts[0]!.rubric[0]!.id, "1a.1");
		assert.equal(out.fixed, 1);
		assert.equal(out.dropped, 3); // 1a, 2b, then 2a with its problem
	});
});

// ─── numbers and quotes ─────────────────────────────────────────────────────

describe("numbers", () => {
	it("reads the forms students type", () => {
		const cases: Array<[string, number | null]> = [
			["187", 187],
			["Q = 187.1 J", 187.1],
			["-0,45", -0.45],
			["1.5e-3 m", 0.0015],
			["1.5 × 10^-3", 0.0015],
			["1.5\\times10^{-3}", 0.0015],
			["187 065 Pa", 187065],
			["1/4", 0.25],
			["−3", -3],
			["no number", null],
		];
		for (const [text, want] of cases) {
			const got = parseNumber(text);
			if (want === null) assert.equal(got, null, text);
			else assert.ok(got !== null && Math.abs(got - want) < 1e-9, `${text} → ${got}`);
		}
	});

	it("compares within a relative tolerance", () => {
		assert.ok(numberMatches(187, { value: 187.1, tolerance: 0.01 }));
		assert.ok(!numberMatches(170, { value: 187.1, tolerance: 0.01 }));
		assert.ok(numberMatches(0.0005, { value: 0, tolerance: 0.001 }));
	});
});

describe("quotes", () => {
	const text = "The tank is rigid,\nso V is constant and $W = 0$.\n\nThen **Q = ΔU**.";
	it("survives case, spacing, line breaks, markdown and LaTeX", () => {
		assert.ok(quoteFound(text, "the tank is rigid, so V is constant"));
		assert.ok(quoteFound(text, "W = 0"));
		assert.ok(quoteFound(text, "Q = ΔU"));
		assert.ok(quoteFound(text, "The tank is rigid ... W = 0"));
	});
	it("refuses words the learner did not write", () => {
		assert.ok(!quoteFound(text, "the volume is constant"));
		assert.ok(!quoteFound(text, "W = 0 ... the tank is rigid")); // pieces must be in order
		assert.ok(!quoteFound(text, ""));
	});
});

// ─── grading ────────────────────────────────────────────────────────────────

describe("grading", () => {
	it("grades choice and blank parts by code", () => {
		const p = problem();
		assert.equal(gradeByCode(p.parts[2]!, answer("", { choice: 1 }))!.earned, 1);
		assert.equal(gradeByCode(p.parts[2]!, answer("", { choice: 0 }))!.earned, 0);
		assert.equal(gradeByCode(p.parts[0]!, answer("   "))!.method, "blank");
		assert.equal(gradeByCode(p.parts[0]!, answer("W is zero")), null);
	});

	it("sends back structural slips and unquoted credit", () => {
		const p = problem();
		const answers = { "1a": answer("The tank is rigid so nothing moves.") };
		const sub = {
			grades: [
				{
					partId: "1a",
					criteria: [
						{ id: "1a.1", awarded: 1, evidence: "The tank is rigid" },
						{ id: "1a.2", awarded: 1, evidence: "so W = 0" },
					],
					feedback: "ok",
				},
			],
		};
		assert.deepEqual(rubricSubmissionProblems([p.parts[0]!], sub), []);
		assert.match(rubricSubmissionProblems([p.parts[0]!, p.parts[1]!], sub).join("\n"), /missing 1b/);
		const unquoted = unquotedCredit([p.parts[0]!], answers, sub);
		assert.equal(unquoted.length, 1);
		assert.match(unquoted[0]!, /1a\.2/);
	});

	it("withholds credit it cannot quote, and lets code decide the final value", () => {
		const p = problem();
		const answers = {
			"1a": answer("The tank is rigid so nothing moves."),
			"1b": answer("Q = ΔU = 1.5 n R ΔT", { final: "190 J" }),
			"1c": answer("", { choice: 1 }),
			"1d": answer("p = nRT/V", { final: "187 kPa" }),
		};
		const code = { "1c": gradeByCode(p.parts[2]!, answers["1c"])! };
		const grades = finalizeRubricGrades(p, answers, {
			grades: [
				{ partId: "1a", criteria: [{ id: "1a.1", awarded: 1, evidence: "tank is rigid" }, { id: "1a.2", awarded: 1, evidence: "W = 0" }], feedback: "f" },
				{
					partId: "1b",
					criteria: [
						{ id: "1b.1", awarded: 1, evidence: "Q = ΔU" },
						{ id: "1b.2", awarded: 2, evidence: "1.5 n R ΔT" },
						{ id: "1b.3", awarded: 0, evidence: "" }, // the model says wrong; code agrees (190 is outside 1%)
					],
					feedback: "f",
				},
				{ partId: "1d", criteria: [{ id: "1d.1", awarded: 2, evidence: "p = nRT/V" }, { id: "1d.2", awarded: 0, evidence: "" }], feedback: "f" },
			],
		}, code);
		const by = Object.fromEntries(grades.map((g) => [g.partId, g]));
		assert.equal(by["1a"]!.earned, 1);
		assert.equal(by["1a"]!.withheld, 1);
		assert.equal(by["1b"]!.earned, 3);
		// 187 kPa matches: code awards the final point the model withheld.
		assert.equal(by["1d"]!.earned, 3);
		assert.equal(by["1c"], undefined, "code-graded parts are not regraded");
	});

	it("honours a carry-forward only after an earlier part lost points", () => {
		const p = problem();
		const sub = (carry: boolean) => ({
			grades: [
				{ partId: "1a", criteria: [{ id: "1a.1", awarded: 1, evidence: "rigid" }, { id: "1a.2", awarded: 1, evidence: "W = 0" }], feedback: "" },
				{
					partId: "1b",
					criteria: [
						{ id: "1b.1", awarded: 1, evidence: "Q = ΔU" },
						{ id: "1b.2", awarded: 2, evidence: "1.5 n R ΔT" },
						{ id: "1b.3", awarded: 1, evidence: "200 J" },
					],
					carriedForward: carry,
					feedback: "",
				},
			],
		});
		const answers = { "1a": answer("rigid, so W = 0"), "1b": answer("Q = ΔU = 1.5 n R ΔT", { final: "200 J" }) };
		const two = { ...p, parts: p.parts.slice(0, 2) };
		// 1a was full marks: there is no earlier error to carry, so code's verdict on 200 J stands.
		const g = finalizeRubricGrades(two, answers, sub(true), {});
		assert.equal(g[1]!.earned, 3);
		assert.equal(g[1]!.carriedForward, undefined);
		// 1a lost a point: the quoted carry-forward is honoured.
		const answers2 = { ...answers, "1a": answer("rigid") };
		const g2 = finalizeRubricGrades(two, answers2, sub(true), {});
		assert.equal(g2[0]!.earned, 1);
		assert.equal(g2[1]!.earned, 4);
		assert.equal(g2[1]!.carriedForward, true);
	});
});

// ─── views, answers, folds ──────────────────────────────────────────────────

function record(status: ExamRecord["status"], extra: Partial<ExamRecord> = {}): ExamRecord {
	return {
		id: "exam_test_0123abcd",
		title: "Thermo",
		createdAt: "2026-10-27T09:00:00.000Z",
		updatedAt: "2026-10-27T09:00:00.000Z",
		scope: { text: "thermo", noteIds: [] },
		minutes: 20,
		status,
		topics: [{ key: "prop:n_first_law", title: "First law" }],
		problems: [problem()],
		answers: {},
		grades: {},
		...extra,
	};
}

describe("what the browser sees", () => {
	it("hides the paper before it starts and the solutions until graded", () => {
		const ready = examView(record("ready"), 0);
		assert.equal(ready.problems.length, 0);
		assert.equal(ready.problemCount, 1);
		assert.equal(ready.partCount, 4);
		assert.equal(ready.totalPoints, 10);
		const running = JSON.stringify(examView(record("running"), 0));
		assert.ok(running.includes("A heated rigid tank"));
		for (const secret of ["187.1", "Uses Q = ΔU", "rigid tank keeps", "correctOption"]) assert.ok(!running.includes(secret), secret);
		const graded = examView(record("graded"), 0);
		assert.equal(graded.problems[0]!.parts[1]!.finalAnswer, "187 J");
	});

	it("keeps only known parts and sane shapes from an answer patch", () => {
		const out = sanitizeAnswers([problem()], { "1a": { text: "x", choice: 2, confidence: 70 }, "1c": { choice: 9 }, "9z": { text: "y" } }, "t");
		assert.deepEqual(Object.keys(out).sort(), ["1a", "1c"]);
		assert.equal(out["1a"]!.choice, undefined);
		assert.equal(out["1a"]!.confidence, 70);
		assert.equal(out["1c"]!.choice, undefined);
	});

	it("links exams to the exam page", () => {
		assert.equal(sessionHref("exam_abc_0123abcd"), "/exam/exam_abc_0123abcd");
		assert.equal(sessionHref("chat_abc_123"), "/chat/chat_abc_123");
	});
});

describe("into the memory model and calibration", () => {
	it("grades a part by its share of the points; confidence only lowers", () => {
		assert.equal(partGrade({ earned: 4, points: 4 }, 90), GRADE_GOOD);
		assert.equal(partGrade({ earned: 4, points: 4 }, 30), GRADE_HARD);
		assert.equal(partGrade({ earned: 2.5, points: 4 }, 100), GRADE_HARD);
		assert.equal(partGrade({ earned: 1, points: 4 }, 100), GRADE_AGAIN);
	});

	it("turns a graded exam into review events and calibration answers", () => {
		const graded = record("graded", {
			submittedAt: "2026-10-27T09:30:00.000Z",
			answers: { "1a": answer("rigid", { confidence: 90 }), "1b": answer("…", { confidence: 90 }) },
			grades: {
				"1a": { partId: "1a", earned: 2, points: 2, criteria: [], feedback: "", method: "rubric" },
				"1b": { partId: "1b", earned: 1, points: 4, criteria: [], feedback: "", method: "rubric" },
			},
		});
		const events = examRecallEvents(graded);
		assert.deepEqual(events.map((e) => [e.topicKey, e.grade, e.review]), [
			["prop:n_first_law", GRADE_GOOD, true],
			["prop:n_first_law", GRADE_AGAIN, true],
		]);
		const cal = examCalibrationAnswers(graded);
		assert.deepEqual(cal.map((c) => [c.confidence, c.correct]), [[90, true], [90, false]]);
		assert.deepEqual(examRecallEvents(record("running")), []);
	});
});

// ─── the pipeline on a scripted model ───────────────────────────────────────

function submit(name: string, input: unknown) {
	return fauxAssistantMessage([fauxToolCall(name, input as ToolCall["arguments"], { id: `${name}-${Math.random().toString(36).slice(2)}` })], {
		stopReason: "toolUse",
	});
}

function firstUserText(messages: Array<{ role: string; content: unknown }>): string {
	const first = messages.find((m) => m.role === "user");
	if (!first) return "";
	return typeof first.content === "string"
		? first.content
		: (first.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
}

/** One scripted examiner: answers each agent by what its prompt asks for. */
function router(log: string[]): FauxResponseStep {
	return (context) => {
		const messages = context.messages as unknown as Array<{ role: string; content: unknown; isError?: boolean }>;
		const prompt = firstUserText(messages);
		const retry = messages.at(-1)?.role === "toolResult";
		if (prompt.startsWith("Write a")) {
			log.push(retry ? "author-retry" : "author");
			// First submission breaks a law (3 problems wanted? no: rubric sum) and is sent back.
			const d = draft();
			if (!retry) d.problems[0]!.parts[0]!.points = 3;
			const two = { ...d.problems[0]!, title: "Second tank" };
			return submit("submit_exam", { ...d, problems: [d.problems[0], two] });
		}
		if (prompt.startsWith("<exam>")) {
			log.push("solve");
			return submit("submit_answers", {
				answers: ["1a", "1b", "1c", "1d", "2a", "2b", "2c", "2d"].map((partId) => ({ partId, answer: "worked", finalAnswer: "187", choice: 1 })),
			});
		}
		if (prompt.includes("<independent>")) {
			log.push("audit");
			assert.match(prompt, /final results agree/);
			return submit("submit_audit", {
				verdicts: ["1a", "1b", "1c", "1d", "2a", "2b", "2c"]
					.map((partId) => ({ partId, verdict: "ok", reason: "checked" }))
					.concat([{ partId: "2d", verdict: "drop", reason: "needs data the scenario lacks" }]),
			});
		}
		if (prompt.includes("<to-grade>")) {
			log.push(retry ? "grade-retry" : "grade");
			// Every part of the problem with its scenario, references and answers in one context.
			assert.match(prompt, /<scenario>[\s\S]*rigid, sealed/);
			assert.match(prompt, /<reference>/);
			const second = prompt.includes("Second tank");
			const ids = second ? ["2a", "2b"] : ["1a", "1b", "1d"];
			const toGrade = /<to-grade>(.*)<\/to-grade>/.exec(prompt)![1]!.split(", ");
			assert.deepEqual(toGrade, ids.filter((id) => toGrade.includes(id)));
			// First try invents a quote; the retry quotes the answer honestly.
			const quoteOf = (partId: string) => new RegExp(`<answer part="${partId}">\\n([^\\n]{5})`).exec(prompt)![1]!;
			return submit("submit_grades", {
				grades: toGrade.map((partId) => {
					const evidence = retry ? quoteOf(partId) : "the volume never changes";
					const rubric = { "1a": 2, "1b": 3, "1d": 2, "2a": 2, "2b": 3 }[partId]!;
					return {
						partId,
						feedback: "Marked.",
						criteria: Array.from({ length: rubric }, (_, k) => ({
							id: `${partId}.${k + 1}`,
							awarded: k === 0 ? 1 : 0,
							evidence: k === 0 ? evidence : "",
						})),
					};
				}),
			});
		}
		throw new Error(`unexpected prompt: ${prompt.slice(0, 80)}`);
	};
}

async function until(check: () => boolean, label: string): Promise<void> {
	for (let i = 0; i < 400; i++) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error(`timed out waiting for ${label}`);
}

describe("the exam pipeline", () => {
	it("writes, checks, sits, marks, and reaches the memory model", async () => {
		const server = await import("../src/server/exams.ts");
		const { retentionAcrossSessions, calibrationAcrossSessions } = await import("../src/server/chats.ts");
		// One proposition in the map that the scope matches: the only topic a part may be tagged with.
		fs.mkdirSync(path.join(TMP_DATA, "graph"), { recursive: true });
		fs.writeFileSync(
			path.join(TMP_DATA, "graph", "nodes.jsonl"),
			JSON.stringify({ id: "n_first_law", name: "First law", statement: "The first law of thermodynamics: ΔU = Q − W.", aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [] }) + "\n",
		);
		assert.deepEqual(server.examTopics("Thermodynamics: first law", []).map((t) => t.key), ["prop:n_first_law"]);
		const log: string[] = [];
		const faux = createFauxCore({});
		faux.setResponses(Array.from({ length: 30 }, () => router(log)));
		server.examEngineOverride.current = { model: faux.getModel(), streamFn: faux.streamSimple };

		assert.throws(() => server.startExam({ scope: "", noteIds: [] }), /cover/);
		const { id } = server.startExam({ scope: "Thermodynamics: first law", minutes: 40 });
		await until(() => server.getExamView(id)?.status !== "generating", "generation");
		const ready = server.getExamView(id)!;
		assert.equal(ready.status, "ready", ready.error);
		assert.deepEqual(log, ["author", "author-retry", "solve", "audit"]);
		assert.equal(ready.problemCount, 2);
		assert.equal(ready.partCount, 7, "2d was dropped by the audit");
		assert.deepEqual(ready.checks, { parts: 8, fixed: 0, dropped: 1 });
		assert.equal(ready.problems.length, 0, "nothing is shown before the clock starts");

		// Answers before the start are refused; the clock starts on begin.
		assert.throws(() => server.saveExamAnswers(id, {}), /closed/);
		const t0 = Date.now();
		const running = server.beginExam(id, t0);
		assert.equal(running.status, "running");
		assert.equal(Date.parse(running.deadlineAt!) - t0, 40 * 60_000);
		assert.equal(running.problems[0]!.parts[0]!.solution, undefined);

		server.saveExamAnswers(id, { "1a": { text: "The tank is rigid.", confidence: 90 }, "1c": { choice: 1, confidence: 100 } }, t0 + 1000);
		server.saveExamAnswers(id, { "1b": { text: "Q = ΔU", final: "187 J", confidence: 70 } }, t0 + 2000);
		const after = server.submitExam(id, { answers: { "2a": { text: "rigid again", confidence: 50 } } }, t0 + 3000);
		assert.equal(after.status, "grading");
		await until(() => server.getExamView(id)?.status !== "grading", "grading");
		const graded = server.getExamView(id)!;
		assert.equal(graded.status, "graded", graded.error);
		assert.deepEqual(log.slice(4), ["grade", "grade-retry", "grade", "grade-retry"]);

		const g = graded.grades;
		assert.equal(g["1a"]!.earned, 1); // one honest quote
		assert.equal(g["1b"]!.earned, 2, "one quoted method point + the final value, checked by code");
		assert.equal(g["2a"]!.earned, 1);
		assert.equal(g["1c"]!.method, "exact");
		assert.equal(g["1c"]!.earned, 1);
		assert.equal(g["1d"]!.method, "blank");
		assert.equal(g["2b"]!.method, "blank");
		assert.ok(graded.problems[0]!.parts[1]!.solution, "solutions are shown once graded");

		// The memory model and calibration see the exam.
		const topic = retentionAcrossSessions().topics.find((t) => t.key === "prop:n_first_law");
		assert.ok(topic, "the tagged topic is now tracked");
		assert.equal(topic!.chatId, id);
		assert.ok(calibrationAcrossSessions().answered >= 3);
	});

	it("grades choice parts and blanks without any model", async () => {
		const server = await import("../src/server/exams.ts");
		const { examStore } = await import("../src/store/exams.ts");
		server.examEngineOverride.current = undefined; // no model set up
		const id = "exam_nomodel_0123abcd";
		const part = { rubric: [], solution: "", topicKeys: [] as string[] };
		examStore.save(record("ready", {
			id,
			problems: [{
				id: "1", title: "Quick", scenario: "s", sources: [],
				parts: [
					{ ...part, id: "1a", prompt: "2+2", points: 2, kind: "numeric", finalAnswer: "4", numeric: { value: 4, tolerance: 0.01 }, rubric: [{ id: "r", criterion: "final", points: 2, final: true }] },
					{ ...part, id: "1b", prompt: "pick", points: 1, kind: "choice", options: ["a", "b"], correctOption: 0, finalAnswer: "a" },
				],
			}],
		}));
		server.beginExam(id);
		server.submitExam(id, { answers: { "1b": { choice: 0, confidence: 70 } } }); // 1a left blank
		await until(() => server.getExamView(id)?.status !== "grading", "grading");
		const done = server.getExamView(id)!;
		assert.equal(done.status, "graded", done.error);
		assert.equal(done.grades["1a"]!.method, "blank");
		assert.equal(done.grades["1b"]!.earned, 1);
	});

	it("hands the paper in when the time runs out, even with the page closed", async () => {
		const server = await import("../src/server/exams.ts");
		const { examStore } = await import("../src/store/exams.ts");
		const id = "exam_late_0123abcd";
		examStore.save(record("ready", { id }));
		const t0 = Date.now();
		server.beginExam(id, t0);
		const end = t0 + 20 * 60_000 + exam.DEADLINE_GRACE_MS + 1;
		assert.throws(() => server.saveExamAnswers(id, { "1a": { text: "late" } }, end), /Time is up/);
		const view = server.getExamView(id, end)!;
		assert.ok(view.status === "grading" || view.status === "graded" || view.status === "failed");
		assert.equal(view.timedOut, true);
		assert.equal(view.answers["1a"], undefined, "a late answer never lands");
		server.deleteExam(id);
	});
});
