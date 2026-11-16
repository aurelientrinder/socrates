/**
 * EXAM CHEAT SHEETS (src/core/cheatsheet.ts, src/agent/subagents/
 * sheet-writer.ts, src/server/cheatsheets.ts), under an isolated
 * LH_DATA_DIR:
 *
 * - standing: only a tested answer makes a topic known; a miss, an unsure
 *   answer or fading recall makes it shaky; never tested is not seen;
 * - an item's standing: the weakest tagged topic wins, untagged is not seen;
 * - the draft laws and the check (fix replaces, drop removes);
 * - the whole pipeline on a scripted model, and the marks following new
 *   answers after the sheet was written.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type FauxResponseStep, type ToolCall } from "../src/llm/index.ts";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-sheet-"));
process.env.LH_DATA_DIR = TMP_DATA;
after(() => fs.rmSync(TMP_DATA, { recursive: true, force: true }));

const core = await import("../src/core/cheatsheet.ts");
const { GRADE_AGAIN, GRADE_GOOD, GRADE_HARD } = await import("../src/core/retention.ts");
type TopicRetention = import("../src/core/retention.ts").TopicRetention;
type SheetTopic = import("../src/core/cheatsheet.ts").SheetTopic;

function tracked(key: string, over: Partial<TopicRetention> = {}): TopicRetention {
	return {
		key,
		kind: "proposition",
		title: key,
		chatId: "c",
		chatTitle: "c",
		answers: 2,
		reviews: 2,
		lapses: 0,
		lastReviewedAt: 0,
		lastGrade: GRADE_GOOD,
		stability: 10,
		difficulty: 5,
		retention: 0.95,
		dueAt: 0,
		due: false,
		...over,
	};
}

describe("standing", () => {
	it("is known only on a clean, still-remembered tested answer", () => {
		assert.equal(core.standingOf(undefined, undefined).standing, "unseen");
		assert.equal(core.standingOf(tracked("a"), undefined).standing, "known");
		assert.match(core.standingOf(tracked("a"), undefined).reason, /2 of 2 times.*95%/);
		assert.equal(core.standingOf(tracked("a", { lastGrade: GRADE_AGAIN }), undefined).standing, "shaky");
		assert.equal(core.standingOf(tracked("a", { lastGrade: GRADE_HARD }), undefined).standing, "shaky");
		const fading = core.standingOf(tracked("a", { retention: 0.6 }), undefined);
		assert.equal(fading.standing, "shaky");
		assert.match(fading.reason, /fading: about 60%/);
		// An overconfident weak spot is shaky even when the last answer was right.
		const spot = { ...tracked("a"), spot: "overconfident", reason: "You felt 90% sure…", missedQuestions: ["Q?"] } as never;
		assert.equal(core.standingOf(tracked("a"), spot).standing, "shaky");
		const [t] = core.sheetTopics([{ key: "a", title: "A" }], [tracked("a")], [spot]);
		assert.deepEqual(t!.missed, ["Q?"]);
	});

	it("marks an item by its weakest tested topic", () => {
		const topics = new Map<string, SheetTopic>([
			["k", { key: "k", title: "K", standing: "known", reason: "ok", retention: 0.95 }],
			["s", { key: "s", title: "S", standing: "shaky", reason: "missed", retention: 0.5 }],
			["u", { key: "u", title: "U", standing: "unseen", reason: "Never tested yet." }],
		]);
		assert.equal(core.itemStanding([], topics).standing, "unseen");
		assert.equal(core.itemStanding(["u"], topics).standing, "unseen");
		assert.equal(core.itemStanding(["k"], topics).standing, "known");
		assert.equal(core.itemStanding(["k", "s"], topics).standing, "shaky");
		assert.match(core.itemStanding(["k", "s"], topics).reason, /^S: missed/);
		assert.equal(core.itemStanding(["k", "u"], topics).standing, "shaky", "half known, half never tested is not known");
	});
});

describe("the draft and the check", () => {
	const topics: SheetTopic[] = [{ key: "prop:a", title: "A", standing: "known", reason: "ok", retention: 0.9 }];
	const draft = {
		title: "T",
		sections: [
			{ title: "One", items: [{ term: "First law", body: "$\\Delta U = Q - W$", topicKeys: ["prop:a", "prop:invented"] }, { term: "", body: "dropped" }] },
			{ title: "Two", items: [{ term: "Heat", body: "Q = mcΔT", watch: " ΔT in K or °C, same step ", figure: "fig1" }] },
		],
	};

	it("states the shape laws in words the model can act on", () => {
		assert.deepEqual(core.sheetDraftProblems(draft), ["section 1, item 2: give it a term."]);
		assert.match(core.sheetDraftProblems({ title: "", sections: [draft.sections[0]!] }).join(), /2 to 10 sections/);
		const long = { title: "", sections: [{ title: "a", items: [{ term: "x", body: "y".repeat(2000) }] }, draft.sections[1]!] };
		assert.match(core.sheetDraftProblems(long).join(), /Cut it down/);
	});

	it("keeps only offered topic keys, resolves figures and applies the check", () => {
		const sections = core.sectionsFromDraft(draft, topics, new Map([["fig1", "<svg viewBox='0 0 1 1'></svg>"]]));
		assert.deepEqual(sections.map((s) => s.items.map((i) => i.id)), [["i1"], ["i2"]]);
		assert.deepEqual(sections[0]!.items[0]!.topicKeys, ["prop:a"]);
		assert.equal(sections[0]!.items[0]!.standing, "known");
		assert.equal(sections[1]!.items[0]!.standing, "unseen");
		assert.equal(sections[1]!.items[0]!.watch, "ΔT in K or °C, same step");
		assert.ok(sections[1]!.items[0]!.figure?.startsWith("<svg"));
		const checked = core.applySheetCheck(sections, [
			{ id: "i1", verdict: "fix", reason: "sign", body: "$\\Delta U = Q + W$ (work done on the gas)" },
			{ id: "i2", verdict: "drop", reason: "off focus" },
			{ id: "i9", verdict: "drop", reason: "no such item" },
		]);
		assert.equal(checked.fixed, 1);
		assert.equal(checked.dropped, 1);
		assert.equal(checked.sections.length, 1, "an emptied section goes");
		assert.match(checked.sections[0]!.items[0]!.body, /Q \+ W/);
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
	return typeof first.content === "string" ? first.content : (first.content as Array<{ text?: string }>).map((c) => c.text ?? "").join("");
}

function router(log: string[], prompts: string[]): FauxResponseStep {
	return (context) => {
		const messages = context.messages as unknown as Array<{ role: string; content: unknown }>;
		const prompt = firstUserText(messages);
		prompts.push(prompt);
		if (prompt.startsWith("Write the cheat sheet")) {
			const retry = messages.some((m) => m.role === "assistant");
			log.push(retry ? "writer-retry" : "writer");
			// First draft has one section only (sent back), then a good one.
			const sections = [
				{
					title: "First law",
					items: [
						{ term: "First law", body: "$\\Delta U = Q - W$", topicKeys: ["prop:n_first"] },
						{ term: "Enthalpy", body: "$H = U + pV$", topicKeys: ["prop:n_enthalpy"], watch: "ΔH = Q only at constant p." },
					],
				},
				{ title: "Methods", items: [{ term: "Calorimetry", body: "Q = mcΔT", topicKeys: [] }, { term: "Wrong one", body: "W = pV²" }] },
			];
			return submit("submit_sheet", { title: "Thermo: cheat sheet", sections: retry ? sections : sections.slice(0, 1) });
		}
		if (prompt.includes("<sheet>")) {
			log.push("check");
			return submit("submit_check", { verdicts: [{ id: "i4", verdict: "drop", reason: "W = pV² is wrong" }] });
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

describe("the cheat sheet pipeline", () => {
	it("writes, checks, marks from tested answers, and follows new answers", async () => {
		const server = await import("../src/server/cheatsheets.ts");
		const exams = await import("../src/server/exams.ts");
		const { examStore } = await import("../src/store/exams.ts");
		fs.mkdirSync(path.join(TMP_DATA, "graph"), { recursive: true });
		const node = (id: string, name: string, statement: string) =>
			JSON.stringify({ id, name, statement, aliases: [], createdAt: "2026-10-01T00:00:00.000Z", provenance: [] });
		fs.writeFileSync(
			path.join(TMP_DATA, "graph", "nodes.jsonl"),
			[node("n_first", "First law thermodynamics", "ΔU = Q − W."), node("n_enthalpy", "Enthalpy thermodynamics", "H = U + pV.")].join("\n") + "\n",
		);

		// One graded mock exam: the first law answered right, enthalpy missed.
		const now = Date.now();
		const part = (id: string, key: string) => ({
			id, prompt: "p", kind: "written", points: 2, solution: "s", finalAnswer: "f", topicKeys: [key],
			rubric: [{ id: `${id}.1`, criterion: "c", points: 2 }],
		});
		examStore.save({
			id: "exam_sheet_0123abcd", title: "E", createdAt: new Date(now - 3600_000).toISOString(), updatedAt: "", scope: { text: "", noteIds: [] },
			minutes: 20, status: "graded", topics: [], gradedAt: new Date(now - 3600_000).toISOString(),
			problems: [{ id: "1", title: "t", scenario: "s", sources: [], parts: [part("1a", "prop:n_first"), part("1b", "prop:n_enthalpy")] }],
			answers: { "1a": { text: "x", confidence: 80, updatedAt: "" }, "1b": { text: "y", confidence: 90, updatedAt: "" } },
			grades: {
				"1a": { partId: "1a", earned: 2, points: 2, method: "rubric", criteria: [], feedback: "" },
				"1b": { partId: "1b", earned: 0, points: 2, method: "rubric", criteria: [], feedback: "" },
			},
		} as never);
		assert.ok(exams.examTopics("thermodynamics", []).length >= 2);

		const log: string[] = [];
		const prompts: string[] = [];
		const faux = createFauxCore({});
		faux.setResponses(Array.from({ length: 10 }, () => router(log, prompts)));
		server.sheetEngineOverride.current = { model: faux.getModel(), streamFn: faux.streamSimple };

		assert.throws(() => server.startSheet({ scope: " ", noteIds: [] }), /which exam/);
		const { id } = server.startSheet({ scope: "Thermodynamics", focus: "first law and enthalpy" });
		await until(() => server.getSheet(id)?.status !== "generating", "generation");
		const sheet = server.getSheet(id)!;
		assert.equal(sheet.status, "ready", sheet.error);
		assert.deepEqual(log, ["writer", "writer-retry", "check"]);
		assert.match(prompts[0]!, /<focus>\nfirst law and enthalpy/);
		assert.match(prompts[0]!, /\[prop:n_first\] KNOWN/);
		assert.match(prompts[0]!, /\[prop:n_enthalpy\] SHAKY/);
		assert.equal(sheet.title, "Thermo: cheat sheet");
		assert.deepEqual(sheet.checks, { items: 4, fixed: 0, dropped: 1 });
		const items = sheet.sections.flatMap((s) => s.items);
		assert.deepEqual(items.map((i) => [i.term, i.standing]), [
			["First law", "known"],
			["Enthalpy", "shaky"],
			["Calorimetry", "unseen"],
		]);
		assert.deepEqual(core.shakyKeys(sheet), ["prop:n_enthalpy"]);
		assert.deepEqual(server.listSheets()[0]!.counts, { known: 1, shaky: 1, unseen: 1 });

		// Missing the first law later turns that line shaky on the next read.
		examStore.save({
			...(examStore.get("exam_sheet_0123abcd") as object),
			id: "exam_sheet_4567abcd",
			createdAt: new Date(now + 86_400_000 * 2).toISOString(),
			gradedAt: new Date(now + 86_400_000 * 2).toISOString(),
			grades: {
				"1a": { partId: "1a", earned: 0, points: 2, method: "rubric", criteria: [], feedback: "" },
				"1b": { partId: "1b", earned: 0, points: 2, method: "rubric", criteria: [], feedback: "" },
			},
		} as never);
		const later = server.getSheet(id, now + 86_400_000 * 2 + 1000)!;
		assert.equal(later.sections[0]!.items[0]!.standing, "shaky");

		assert.ok(server.deleteSheet(id));
		assert.equal(server.getSheet(id), null);
		server.sheetEngineOverride.current = undefined;
	});
});
