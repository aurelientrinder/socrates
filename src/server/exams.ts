import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { notesToolFor } from "../agent/tools/notes.ts";
import { auditExam, authorExam, gradeProblem, solveBlind, type ExaminerRun } from "../agent/subagents/examiner.ts";
import {
	applyAudit,
	DEADLINE_GRACE_MS,
	EXAM_LENGTHS,
	examSummary,
	examView,
	finalizeRubricGrades,
	gradeByCode,
	problemCountFor,
	sanitizeAnswers,
	type ExamProblem,
	type ExamRecord,
	type ExamSummary,
	type ExamTopic,
	type ExamView,
	type PartGrade,
} from "../core/exam.ts";
import { replyLanguageInstruction } from "../core/reply-language.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured } from "../core/settings.ts";
import { examStore, newExamId } from "../store/exams.ts";
import { notesLibrary } from "../store/notes.ts";
import { retentionAcrossSessions } from "./chats.ts";
import { providerKeyPresent } from "./keys.ts";
import { effectiveSettings, stores } from "./stores.ts";

/**
 * MOCK EXAMS, the server side (core/exam.ts has the laws, agent/subagents/
 * examiner.ts the prompts). Generation and grading run in the background
 * in this process; the record carries the status and a progress line the
 * exam page polls. Both run on the STRONG model slot: an exam is only as
 * good as its reference solutions and its marking.
 *
 * Generation: notes + topics → author → blind solve → audit → ready.
 * The clock starts only when the learner opens the paper (beginExam), and
 * the server owns it: answers after the deadline (plus a short grace) are
 * refused, and an exam whose time ran out with the page closed is
 * submitted on the next read.
 */

/** Test seam: a scripted engine replaces the strong slot's. */
export const examEngineOverride: { current?: PiEngine } = {};

/** Notes text sent to the author, per file and in total. */
const NOTE_CHARS = 30_000;
const MATERIAL_CHARS = 60_000;
/** Topics offered to the author for tagging. */
const MAX_TOPICS = 60;

interface LhExamGlobal {
	__lhExamRuns?: Map<string, AbortController>;
}

/** In-flight runs, on globalThis so every route's module instance sees the same map. */
function runs(): Map<string, AbortController> {
	const g = globalThis as typeof globalThis & LhExamGlobal;
	return (g.__lhExamRuns ??= new Map());
}

export class ExamError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly body?: unknown,
	) {
		super(message);
	}
}

function examinerRun(signal: AbortSignal): ExaminerRun {
	if (examEngineOverride.current) return { engine: examEngineOverride.current, signal };
	const spec = resolveRoleSpec("teacher", stores.settingsStore.readSettings());
	if (!spec) throw new ExamError("Choose a model first (Settings, Models).", 503, modelsNotConfigured(["strong"]));
	if (!providerKeyPresent(spec.provider)) throw new ExamError(`The ${spec.provider} key is missing (Settings, Keys).`, 503);
	return {
		engine: piEngineForSpec(spec),
		signal,
		languageLine: replyLanguageInstruction(effectiveSettings().agent.replyLanguage),
	};
}

// ─── material and topics ────────────────────────────────────────────────────

function examMaterial(noteIds: readonly string[]): string {
	let budget = MATERIAL_CHARS;
	const out: string[] = [];
	for (const id of noteIds) {
		const meta = notesLibrary.get(id);
		const text = meta ? notesLibrary.text(id) : null;
		if (!meta || !text || budget <= 0) continue;
		const cap = Math.min(NOTE_CHARS, budget);
		const body = text.length > cap ? `${text.slice(0, cap)}\n[… cut here; search the notes tool for the rest]` : text;
		budget -= body.length;
		out.push(`=== ${meta.name} ===\n${body}`);
	}
	return out.join("\n\n");
}

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "what", "exam", "chapter", "chapitre", "des", "les", "une", "sur", "pour"]);

function words(text: string): string[] {
	return [...new Set(text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w)))];
}

function score(text: string, wanted: readonly string[]): number {
	const hay = text.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
	return wanted.filter((w) => hay.includes(w)).length;
}

/** The topics a part may be tagged with: propositions learned from the
 *  chosen notes, then tracked topics and propositions that match the
 *  scope's words. Tagging is what feeds the memory model. */
export function examTopics(scope: string, noteIds: readonly string[]): ExamTopic[] {
	const nodes = new Map<string, { name: string; statement: string; sources: Set<string> }>();
	for (const line of stores.graphStore.readNodes()) {
		const node = nodes.get(line.id) ?? { name: line.name, statement: line.statement, sources: new Set<string>() };
		node.statement = line.statement || node.statement;
		for (const p of line.provenance) node.sources.add(p.chatId);
		nodes.set(line.id, node);
	}
	const out = new Map<string, ExamTopic>();
	const fromNotes = new Set(noteIds);
	for (const [id, n] of nodes) {
		if ([...n.sources].some((s) => fromNotes.has(s))) out.set(`prop:${id}`, { key: `prop:${id}`, title: n.name, summary: n.statement });
		if (out.size >= MAX_TOPICS) return [...out.values()];
	}
	const wanted = words(scope);
	if (wanted.length === 0) return [...out.values()];
	const scored: Array<{ topic: ExamTopic; score: number }> = [];
	for (const t of retentionAcrossSessions().topics) {
		const s = score(`${t.title} ${t.chatTitle}`, wanted);
		if (s > 0) scored.push({ topic: { key: t.key, title: t.title }, score: s + 0.5 });
	}
	for (const [id, n] of nodes) {
		const s = score(`${n.name} ${n.statement}`, wanted);
		if (s > 0) scored.push({ topic: { key: `prop:${id}`, title: n.name, summary: n.statement }, score: s });
	}
	for (const { topic } of scored.sort((a, b) => b.score - a.score)) {
		if (out.size >= MAX_TOPICS) break;
		if (!out.has(topic.key)) out.set(topic.key, topic);
	}
	return [...out.values()];
}

// ─── generation ─────────────────────────────────────────────────────────────

export function startExam(input: { scope?: unknown; noteIds?: unknown; minutes?: unknown }): { id: string } {
	const scope = typeof input.scope === "string" ? input.scope.trim().slice(0, 2000) : "";
	const noteIds = Array.isArray(input.noteIds)
		? [...new Set(input.noteIds.filter((id): id is string => typeof id === "string" && notesLibrary.get(id) !== null))].slice(0, 5)
		: [];
	const minutes = (EXAM_LENGTHS as readonly number[]).includes(input.minutes as number) ? (input.minutes as number) : 40;
	if (!scope && noteIds.length === 0) throw new ExamError("Say what the exam should cover, or pick notes to write it from.", 400);
	// Refuse before anything is written when no model can run it.
	examinerRun(new AbortController().signal);
	const now = new Date();
	const record: ExamRecord = {
		id: newExamId(now.getTime()),
		title: scope ? `Mock exam: ${scope.split("\n")[0]!.slice(0, 60)}` : "Mock exam",
		createdAt: now.toISOString(),
		updatedAt: now.toISOString(),
		scope: { text: scope, noteIds },
		minutes,
		status: "generating",
		phase: "Reading your notes",
		topics: [],
		problems: [],
		answers: {},
		grades: {},
	};
	examStore.save(record);
	void generate(record.id);
	return { id: record.id };
}

async function generate(id: string): Promise<void> {
	if (runs().has(id)) return;
	const controller = new AbortController();
	runs().set(id, controller);
	const phase = (text: string) => examStore.update(id, (r) => ({ ...r, phase: text }));
	try {
		const record = examStore.get(id);
		if (!record) return;
		const run = examinerRun(controller.signal);
		const topics = examTopics(record.scope.text, record.scope.noteIds);
		const material = examMaterial(record.scope.noteIds);
		const problems = problemCountFor(record.minutes);
		phase("Writing the problems and their solutions");
		const draft = await authorExam(run, {
			scope: record.scope.text,
			material,
			topics,
			minutes: record.minutes,
			problems,
			...(notesLibrary.list().length > 0 ? { notesTool: notesToolFor(notesLibrary) } : {}),
		});
		phase("Solving it independently");
		const blind = await solveBlind(run, draft.problems);
		phase("Checking every answer against the independent solution");
		const verdicts = await auditExam(run, draft.problems, blind);
		const audited = applyAudit(draft.problems, verdicts);
		if (audited.problems.length === 0) {
			throw new Error("No problem passed the answer check, so there is no exam to trust. Try again, or narrow what it covers.");
		}
		const parts = draft.problems.reduce((a, p) => a + p.parts.length, 0);
		examStore.update(id, (r) => ({
			...r,
			title: draft.title || r.title,
			topics,
			problems: audited.problems,
			checks: { parts, fixed: audited.fixed, dropped: audited.dropped },
			status: "ready",
			phase: undefined,
			error: undefined,
			failedDuring: undefined,
		}));
	} catch (err) {
		if (controller.signal.aborted && !examStore.get(id)) return; // deleted mid-run
		const message = err instanceof Error ? err.message : String(err);
		console.info(`[exam ${id}] generation failed: ${message}`);
		examStore.update(id, (r) => ({ ...r, status: "failed", failedDuring: "generating", phase: undefined, error: message }));
	} finally {
		runs().delete(id);
	}
}

// ─── sitting the exam ───────────────────────────────────────────────────────

function deadlinePassed(record: ExamRecord, now: number): boolean {
	return record.deadlineAt !== undefined && now > Date.parse(record.deadlineAt) + DEADLINE_GRACE_MS;
}

/** The exam as the page sees it. Also the clock's enforcement point: a
 *  run that died with the process is marked failed (retryable), and a
 *  paper whose time ran out while the page was closed is submitted. */
export function getExamView(id: string, now: number = Date.now()): ExamView | null {
	let record = examStore.get(id);
	if (!record) return null;
	if ((record.status === "generating" || record.status === "grading") && !runs().has(id)) {
		const during = record.status;
		record = examStore.save({
			...record,
			status: "failed",
			failedDuring: during,
			phase: undefined,
			error: during === "grading" ? "Grading was interrupted. Your answers are saved." : "Writing the exam was interrupted.",
		});
	}
	if (record.status === "running" && deadlinePassed(record, now)) {
		record = submitRecord(record, undefined, true, now);
	}
	return examView(record, now);
}

export function beginExam(id: string, now: number = Date.now()): ExamView {
	const record = examStore.get(id);
	if (!record) throw new ExamError("Exam not found.", 404);
	if (record.status === "ready") {
		examStore.save({
			...record,
			status: "running",
			startedAt: new Date(now).toISOString(),
			deadlineAt: new Date(now + record.minutes * 60_000).toISOString(),
		});
	} else if (record.status !== "running") {
		throw new ExamError("This exam cannot be started now.", 409);
	}
	return getExamView(id, now)!;
}

export function saveExamAnswers(id: string, patch: unknown, now: number = Date.now()): { savedAt: string } {
	const record = examStore.get(id);
	if (!record) throw new ExamError("Exam not found.", 404);
	if (record.status !== "running") throw new ExamError("This exam is closed.", 409);
	if (deadlinePassed(record, now)) {
		submitRecord(record, undefined, true, now);
		throw new ExamError("Time is up. The exam was submitted.", 409);
	}
	const savedAt = new Date(now).toISOString();
	const answers = sanitizeAnswers(record.problems, patch, savedAt);
	examStore.save({ ...record, answers: { ...record.answers, ...answers } });
	return { savedAt };
}

function submitRecord(record: ExamRecord, patch: unknown, timedOut: boolean, now: number): ExamRecord {
	const late = deadlinePassed(record, now);
	const answers = patch && !late ? { ...record.answers, ...sanitizeAnswers(record.problems, patch, new Date(now).toISOString()) } : record.answers;
	const saved = examStore.save({
		...record,
		answers,
		status: "grading",
		phase: "Grading",
		submittedAt: new Date(Math.min(now, record.deadlineAt ? Date.parse(record.deadlineAt) : now)).toISOString(),
		...(timedOut || late ? { timedOut: true } : {}),
	});
	void grade(record.id);
	return saved;
}

export function submitExam(id: string, input: { answers?: unknown; timedOut?: unknown }, now: number = Date.now()): ExamView {
	const record = examStore.get(id);
	if (!record) throw new ExamError("Exam not found.", 404);
	if (record.status === "running") submitRecord(record, input.answers, input.timedOut === true, now);
	else if (record.status !== "grading" && record.status !== "graded") throw new ExamError("This exam has not started.", 409);
	return getExamView(id, now)!;
}

// ─── grading ────────────────────────────────────────────────────────────────

async function grade(id: string): Promise<void> {
	if (runs().has(id)) return;
	const controller = new AbortController();
	runs().set(id, controller);
	try {
		const record = examStore.get(id);
		if (!record) return;
		// Only a part the code cannot grade (written work) needs a model, so a
		// paper of choice and numeric questions is graded even without one.
		let run: ExaminerRun | undefined;
		const getRun = () => (run ??= examinerRun(controller.signal));
		const grades: Record<string, PartGrade> = { ...record.grades };
		for (const [i, problem] of record.problems.entries()) {
			if (problem.parts.every((p) => grades[p.id])) continue; // graded before a retry
			examStore.update(id, (r) => ({ ...r, phase: `Grading problem ${i + 1} of ${record.problems.length}` }));
			Object.assign(grades, await gradeOne(getRun, problem, record.answers));
			examStore.update(id, (r) => ({ ...r, grades: { ...grades } }));
		}
		examStore.update(id, (r) => ({
			...r,
			grades,
			status: "graded",
			gradedAt: new Date().toISOString(),
			phase: undefined,
			error: undefined,
			failedDuring: undefined,
		}));
	} catch (err) {
		if (controller.signal.aborted && !examStore.get(id)) return;
		const message = err instanceof Error ? err.message : String(err);
		console.info(`[exam ${id}] grading failed: ${message}`);
		examStore.update(id, (r) => ({ ...r, status: "failed", failedDuring: "grading", phase: undefined, error: `${message} Your answers are saved.` }));
	} finally {
		runs().delete(id);
	}
}

async function gradeOne(getRun: () => ExaminerRun, problem: ExamProblem, answers: ExamRecord["answers"]): Promise<Record<string, PartGrade>> {
	const code: Record<string, PartGrade> = {};
	for (const part of problem.parts) {
		const g = gradeByCode(part, answers[part.id]);
		if (g) code[part.id] = g;
	}
	const toGrade = problem.parts.filter((p) => !code[p.id]);
	if (toGrade.length === 0) return code;
	const submission = await gradeProblem(getRun(), problem, answers, toGrade, code);
	const out: Record<string, PartGrade> = { ...code };
	for (const g of finalizeRubricGrades(problem, answers, submission, code)) out[g.partId] = g;
	return out;
}

/** Try again after a failure: rewrite the exam, or finish grading (parts
 *  already graded keep their grades). */
export function retryExam(id: string): ExamView {
	const record = examStore.get(id);
	if (!record) throw new ExamError("Exam not found.", 404);
	if (record.status !== "failed") throw new ExamError("Nothing to retry.", 409);
	if (record.failedDuring === "grading") {
		const needsModel = record.problems.some((p) => p.parts.some((part) => !record.grades[part.id] && !gradeByCode(part, record.answers[part.id])));
		if (needsModel) examinerRun(new AbortController().signal); // refuse up front when no model can
		examStore.save({ ...record, status: "grading", phase: "Grading", error: undefined });
		void grade(id);
	} else {
		examinerRun(new AbortController().signal); // refuse before rewriting when no model can
		examStore.save({ ...record, status: "generating", phase: "Reading your notes", error: undefined, problems: [] });
		void generate(id);
	}
	return getExamView(id)!;
}

export function listExams(): ExamSummary[] {
	return examStore.list().map(examSummary);
}

export function deleteExam(id: string): boolean {
	const removed = examStore.remove(id);
	runs().get(id)?.abort();
	return removed;
}
