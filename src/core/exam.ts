/**
 * MOCK EXAMS: a timed, no-hints written test that looks like the real
 * thing. An exam is a few PROBLEMS; each problem is one scenario with
 * several sub-questions (parts) that build on it. Most parts are written
 * or numeric answers; multiple choice is capped, because real exams are
 * not multiple choice.
 *
 * The anti-hallucination design, end to end:
 *   1. The examiner writes every part WITH a worked reference solution
 *      and a points rubric BEFORE the learner sees anything (the
 *      practice tool's commit-before-pose law).
 *   2. A second, BLIND pass solves the exam without the reference; an
 *      audit pass compares the two and fixes or drops any part whose
 *      reference does not hold up. Only checked parts reach the learner.
 *   3. Grading runs per PROBLEM, with the whole scenario, every part's
 *      reference and rubric, and every answer to that problem in one
 *      context, so a later part is judged with the scenario and the
 *      learner's earlier results in view (error carried forward).
 *   4. Every point the grader awards must quote the learner's own words;
 *      the quote is checked against the answer here, and credit it cannot
 *      point to is not given. Numbers and multiple choice are graded by
 *      code, not by the model.
 *
 * Results feed the memory model (retention.ts) and the calibration fold
 * (calibration.ts) through examRecallEvents / examCalibrationAnswers.
 *
 * Pure and browser-safe: the server generates, stores and grades; this
 * module validates, shapes and folds.
 */

import { CONFIDENT_MISS_FLOOR, type CalibrationAnswer } from "./calibration.ts";
import { GRADE_AGAIN, GRADE_GOOD, GRADE_HARD, parseTopicKey, SHAKY_CONFIDENCE, type RecallEvent, type RecallGrade } from "./retention.ts";

// ─── the record ─────────────────────────────────────────────────────────────

export type ExamStatus = "generating" | "ready" | "running" | "grading" | "graded" | "failed";
export type ExamPartKind = "written" | "numeric" | "choice";

export interface ExamRubricItem {
	id: string;
	criterion: string;
	points: number;
	/** Numeric parts: the final-value criterion, graded by code. */
	final?: boolean;
}

export interface ExamNumericAnswer {
	value: number;
	/** Relative tolerance (0.01 = within 1%); absolute when value is 0. */
	tolerance: number;
	unit?: string;
}

export interface ExamPart {
	/** "1a", "1b", … (problem number + letter). */
	id: string;
	prompt: string;
	points: number;
	kind: ExamPartKind;
	/** Choice parts: the option texts, shown A, B, C… */
	options?: string[];
	// ── hidden from the learner until the exam is graded ──
	/** The worked reference solution. */
	solution: string;
	/** The short final answer (what a marker checks first). */
	finalAnswer: string;
	numeric?: ExamNumericAnswer;
	/** Choice parts: index into options. */
	correctOption?: number;
	rubric: ExamRubricItem[];
	/** Retention topic keys this part tests (may be empty). */
	topicKeys: string[];
}

export interface ExamProblem {
	/** "1", "2", … */
	id: string;
	title: string;
	/** The situation every part refers to (markdown + LaTeX). */
	scenario: string;
	parts: ExamPart[];
	/** Where the material came from ("Thermo.pdf, p. 4"), when notes were used. */
	sources: string[];
}

export interface ExamAnswer {
	/** The written answer / working. */
	text: string;
	/** Numeric parts: the final value as typed. */
	final?: string;
	/** Choice parts: the picked option index. */
	choice?: number;
	/** The learner's stated chance this part is right (a CONFIDENCE_STOPS value). */
	confidence?: number;
	updatedAt: string;
}

export interface CriterionGrade {
	id: string;
	awarded: number;
	/** The learner's words that earned the points ("" when nothing was awarded). */
	evidence: string;
}

export interface PartGrade {
	partId: string;
	earned: number;
	points: number;
	criteria: CriterionGrade[];
	feedback: string;
	/** How it was graded: by the model against the rubric, by code (choice), or blank. */
	method: "rubric" | "exact" | "blank";
	/** A later part credited for correctly using the learner's own (wrong) earlier result. */
	carriedForward?: boolean;
	/** Credit withheld because the grader could not quote it from the answer. */
	withheld?: number;
}

export interface ExamScope {
	/** What the exam covers, in the learner's words. */
	text: string;
	/** Saved notes (notes library ids) to write it from. */
	noteIds: string[];
}

/** A retention topic the examiner may tag parts with. */
export interface ExamTopic {
	key: string;
	title: string;
	summary?: string;
}

export interface ExamRecord {
	id: string;
	version?: number;
	title: string;
	createdAt: string;
	updatedAt: string;
	scope: ExamScope;
	/** The time limit. */
	minutes: number;
	status: ExamStatus;
	/** A short progress line while generating or grading. */
	phase?: string;
	error?: string;
	/** What failed: generation (no exam yet) or grading (answers are safe). */
	failedDuring?: "generating" | "grading";
	topics: ExamTopic[];
	problems: ExamProblem[];
	/** What the independent check did to the first draft. */
	checks?: { parts: number; fixed: number; dropped: number };
	startedAt?: string;
	/** startedAt + minutes; answers after it (plus a grace period) are refused. */
	deadlineAt?: string;
	submittedAt?: string;
	/** Submitted by the clock rather than by the learner. */
	timedOut?: boolean;
	gradedAt?: string;
	answers: Record<string, ExamAnswer>;
	grades: Record<string, PartGrade>;
}

export const CURRENT_EXAM_VERSION = 1;

/** Exam ids: never collide with chat ids ("chat_…"). */
export const EXAM_ID = /^exam_[a-z0-9]+_[0-9a-f]{8}$/;

export function isExamId(id: string): boolean {
	return EXAM_ID.test(id);
}

/** Where a session or exam id lives in the app. */
export function sessionHref(id: string): string {
	return isExamId(id) ? `/exam/${id}` : `/chat/${id}`;
}

// ─── sizing ─────────────────────────────────────────────────────────────────

/** The time limits on offer, in minutes. */
export const EXAM_LENGTHS = [20, 40, 60, 90] as const;
export const DEFAULT_EXAM_LENGTH = 40;

/** Problems per exam: about one per 15-20 minutes, like a written paper. */
export function problemCountFor(minutes: number): number {
	if (minutes <= 20) return 1;
	if (minutes <= 40) return 2;
	if (minutes <= 60) return 3;
	return 4;
}

/** Parts per problem. */
export const MIN_PARTS = 2;
export const MAX_PARTS = 5;
/** At most this share of all parts may be multiple choice. */
export const MAX_CHOICE_SHARE = 0.25;
/** Answers saved this long after the deadline still count (network, clock skew). */
export const DEADLINE_GRACE_MS = 30_000;
/** A part counts as RIGHT (for calibration and the memory model) from this share of its points. */
export const PART_RIGHT_SHARE = 0.8;
/** Below this share a part is a miss; between the two it is shaky. */
export const PART_MISS_SHARE = 0.5;

export const OPTION_LETTERS = "ABCDEFGH";

// ─── authoring validation (the examiner's submit seam) ──────────────────────

/** The examiner's draft, before ids are assigned. */
export interface ExamDraft {
	title: string;
	problems: Array<{
		title: string;
		scenario: string;
		sources?: string[];
		parts: Array<{
			prompt: string;
			kind: ExamPartKind;
			points: number;
			options?: string[];
			solution: string;
			finalAnswer: string;
			numeric?: { value: number; tolerance?: number; unit?: string };
			correctOption?: number;
			rubric?: Array<{ criterion: string; points: number; final?: boolean }>;
			topicKeys?: string[];
		}>;
	}>;
}

const DEFAULT_TOLERANCE = 0.01;
const MAX_TOLERANCE = 0.1;

/** Everything wrong with a draft, as messages the examiner can act on.
 *  Empty = the draft can become an exam. */
export function examDraftProblems(draft: ExamDraft, expectedProblems: number): string[] {
	const out: string[] = [];
	if (!draft.title?.trim()) out.push("title is empty.");
	if (draft.problems.length !== expectedProblems) {
		out.push(`Write exactly ${expectedProblems} problem${expectedProblems === 1 ? "" : "s"} (got ${draft.problems.length}).`);
	}
	let parts = 0;
	let choice = 0;
	draft.problems.forEach((p, i) => {
		const at = `problems[${i}]`;
		if (!p.title?.trim()) out.push(`${at}.title is empty.`);
		if ((p.scenario?.trim().length ?? 0) < 60) out.push(`${at}.scenario is missing or too short: every problem opens with a concrete situation.`);
		if (p.parts.length < MIN_PARTS || p.parts.length > MAX_PARTS) {
			out.push(`${at} has ${p.parts.length} parts: give each problem ${MIN_PARTS} to ${MAX_PARTS} parts.`);
		}
		const kinds = new Set(p.parts.map((x) => x.kind));
		if (kinds.size === 1 && kinds.has("choice")) out.push(`${at} is all multiple choice: most parts must be written or numeric.`);
		p.parts.forEach((part, j) => {
			parts++;
			const pat = `${at}.parts[${j}]`;
			if (!part.prompt?.trim()) out.push(`${pat}.prompt is empty.`);
			if (!part.solution?.trim()) out.push(`${pat}.solution is empty: work the full reference solution.`);
			if (!part.finalAnswer?.trim()) out.push(`${pat}.finalAnswer is empty.`);
			if (!Number.isInteger(part.points) || part.points < 1 || part.points > 20) out.push(`${pat}.points must be a whole number from 1 to 20.`);
			if (part.kind === "choice") {
				choice++;
				const options = part.options ?? [];
				if (options.length < 3 || options.length > 6) out.push(`${pat}: a choice part needs 3 to 6 options.`);
				if (new Set(options.map((o) => o.trim().toLowerCase())).size !== options.length || options.some((o) => !o.trim())) {
					out.push(`${pat}.options must be distinct and non-empty.`);
				}
				if (!Number.isInteger(part.correctOption) || part.correctOption! < 0 || part.correctOption! >= options.length) {
					out.push(`${pat}.correctOption must be the 0-based index of the right option.`);
				}
				return;
			}
			const rubric = part.rubric ?? [];
			if (rubric.length === 0) out.push(`${pat}.rubric is empty: list what earns the points.`);
			if (rubric.some((r) => !r.criterion?.trim() || !(r.points > 0) || !Number.isInteger(r.points * 2))) {
				out.push(`${pat}.rubric: every item needs a criterion and positive points (whole or half).`);
			}
			const sum = rubric.reduce((a, r) => a + (r.points || 0), 0);
			if (rubric.length > 0 && sum !== part.points) out.push(`${pat}.rubric points add up to ${sum}, but the part is worth ${part.points}.`);
			const finals = rubric.filter((r) => r.final).length;
			if (part.kind === "numeric") {
				const n = part.numeric;
				if (!n || !Number.isFinite(n.value)) out.push(`${pat}: a numeric part needs numeric.value (the reference number).`);
				if (n?.tolerance !== undefined && !(n.tolerance > 0 && n.tolerance <= MAX_TOLERANCE)) {
					out.push(`${pat}.numeric.tolerance must be between 0 and ${MAX_TOLERANCE} (relative).`);
				}
				if (finals !== 1) out.push(`${pat}: a numeric part needs exactly one rubric item with final: true (the final value).`);
			} else if (finals > 0) {
				out.push(`${pat}: only numeric parts have a final: true rubric item.`);
			}
		});
	});
	const allowed = Math.floor(parts * MAX_CHOICE_SHARE);
	if (choice > allowed) out.push(`${choice} of ${parts} parts are multiple choice; at most ${allowed} may be. Turn the rest into written or numeric parts.`);
	return out;
}

/** A checked draft → the exam's problems, with ids, defaults and only known topic keys. */
export function problemsFromDraft(draft: ExamDraft, topicKeys: ReadonlySet<string>): ExamProblem[] {
	return draft.problems.map((p, i) => {
		const pid = String(i + 1);
		return {
			id: pid,
			title: p.title.trim(),
			scenario: p.scenario.trim(),
			sources: (p.sources ?? []).map((s) => s.trim()).filter(Boolean),
			parts: p.parts.map((part, j) => {
				const id = `${pid}${String.fromCharCode(97 + j)}`;
				const rubric: ExamRubricItem[] =
					part.kind === "choice"
						? [{ id: `${id}.1`, criterion: "The right option is picked.", points: part.points }]
						: (part.rubric ?? []).map((r, k) => ({
								id: `${id}.${k + 1}`,
								criterion: r.criterion.trim(),
								points: r.points,
								...(part.kind === "numeric" && r.final ? { final: true } : {}),
							}));
				return {
					id,
					prompt: part.prompt.trim(),
					points: part.points,
					kind: part.kind,
					...(part.kind === "choice" ? { options: (part.options ?? []).map((o) => o.trim()), correctOption: part.correctOption } : {}),
					solution: part.solution.trim(),
					finalAnswer: part.finalAnswer.trim(),
					...(part.kind === "numeric" && part.numeric
						? {
								numeric: {
									value: part.numeric.value,
									tolerance: part.numeric.tolerance ?? DEFAULT_TOLERANCE,
									...(part.numeric.unit?.trim() ? { unit: part.numeric.unit.trim() } : {}),
								},
							}
						: {}),
					rubric,
					topicKeys: [...new Set((part.topicKeys ?? []).filter((k) => topicKeys.has(k)))],
				};
			}),
		};
	});
}

// ─── the independent check ──────────────────────────────────────────────────

export interface BlindAnswer {
	partId: string;
	answer: string;
	finalAnswer?: string;
	choice?: number;
}

export type AuditVerdict =
	| { partId: string; verdict: "ok"; reason: string }
	| { partId: string; verdict: "fix"; reason: string; solution: string; finalAnswer: string; numericValue?: number; correctOption?: number }
	| { partId: string; verdict: "drop"; reason: string };

/** Does the blind solver's answer match the reference, where code can tell? */
export function blindAgreement(part: ExamPart, blind: BlindAnswer | undefined): "agrees" | "disagrees" | "unknown" {
	if (!blind) return "unknown";
	if (part.kind === "choice") return blind.choice === part.correctOption ? "agrees" : "disagrees";
	if (part.kind === "numeric" && part.numeric) {
		const value = parseNumber(blind.finalAnswer ?? blind.answer);
		if (value === null) return "unknown";
		return numberMatches(value, part.numeric) ? "agrees" : "disagrees";
	}
	return "unknown";
}

/** Apply the audit: fixed references replace the draft's, dropped parts go,
 *  and a problem left with fewer than MIN_PARTS parts goes too. Problems
 *  and parts are renumbered so ids stay "1", "1a", … */
export function applyAudit(
	problems: readonly ExamProblem[],
	verdicts: readonly AuditVerdict[],
): { problems: ExamProblem[]; fixed: number; dropped: number } {
	const byPart = new Map(verdicts.map((v) => [v.partId, v]));
	let fixed = 0;
	let dropped = 0;
	const kept: ExamProblem[] = [];
	for (const problem of problems) {
		const parts: ExamPart[] = [];
		for (const part of problem.parts) {
			const v = byPart.get(part.id);
			if (v?.verdict === "drop") {
				dropped++;
				continue;
			}
			if (v?.verdict === "fix") {
				const next: ExamPart = { ...part, solution: v.solution.trim() || part.solution, finalAnswer: v.finalAnswer.trim() || part.finalAnswer };
				if (part.kind === "numeric" && part.numeric && typeof v.numericValue === "number" && Number.isFinite(v.numericValue)) {
					next.numeric = { ...part.numeric, value: v.numericValue };
				}
				if (part.kind === "choice" && Number.isInteger(v.correctOption) && v.correctOption! >= 0 && v.correctOption! < (part.options?.length ?? 0)) {
					next.correctOption = v.correctOption;
				}
				fixed++;
				parts.push(next);
				continue;
			}
			parts.push(part);
		}
		if (parts.length < MIN_PARTS) {
			dropped += parts.length;
			continue;
		}
		kept.push({ ...problem, parts });
	}
	return { problems: renumber(kept), fixed, dropped };
}

function renumber(problems: ExamProblem[]): ExamProblem[] {
	return problems.map((p, i) => {
		const pid = String(i + 1);
		return {
			...p,
			id: pid,
			parts: p.parts.map((part, j) => {
				const id = `${pid}${String.fromCharCode(97 + j)}`;
				return { ...part, id, rubric: part.rubric.map((r, k) => ({ ...r, id: `${id}.${k + 1}` })) };
			}),
		};
	});
}

// ─── numbers ────────────────────────────────────────────────────────────────

/** The first number in a typed answer: "3.2", "-0,45" (decimal comma),
 *  "1.5e-3", "1.5 × 10^-3", "1.5\times10^{-3}", "2 500", "1/4". null when
 *  there is none. Units after the number are ignored. */
export function parseNumber(text: string | undefined): number | null {
	if (!text) return null;
	let s = text
		.replace(/[−–—]/g, "-")
		.replace(/\\(?:,|;|!|\s)/g, "")
		.replace(/\\(?:times|cdot)/g, "×")
		.replace(/[{}$]/g, "")
		.trim();
	// Thousands separators written as spaces (or thin spaces) between digit groups.
	s = s.replace(/(\d)[\s   ](?=\d{3}(?!\d))/g, "$1");
	const m = /(-?\d+(?:[.,]\d+)?)(?:\s*\/\s*(\d+(?:[.,]\d+)?))?(?:\s*(?:[eE]\s*([-+]?\d+)|\s*[×x*]\s*10\s*\^\s*\(?\s*([-+]?\d+)\s*\)?))?/.exec(s);
	if (!m) return null;
	const num = (v: string) => Number(v.replace(",", "."));
	let value = num(m[1]!);
	if (m[2]) {
		const den = num(m[2]);
		if (den === 0) return null;
		value /= den;
	}
	const exp = m[3] ?? m[4];
	if (exp) value *= 10 ** Number(exp);
	return Number.isFinite(value) ? value : null;
}

export function numberMatches(value: number, ref: ExamNumericAnswer): boolean {
	if (ref.value === 0) return Math.abs(value) <= ref.tolerance;
	return Math.abs(value - ref.value) <= Math.abs(ref.value) * ref.tolerance;
}

// ─── grading ────────────────────────────────────────────────────────────────

/** Quote matching that survives what models do to a quote: case, spacing,
 *  line breaks, markdown and LaTeX punctuation. A quote may skip text with
 *  "..." or "…"; each piece must appear, in order. */
export function normalizeForQuote(text: string): string {
	return text
		.toLowerCase()
		.replace(/\\(?:left|right|displaystyle|text|mathrm|mathbf)\b/g, "")
		.replace(/[\s$\\{}*_`"'“”‘’«»]/g, "")
		.replace(/[−–—]/g, "-");
}

export function quoteFound(answer: string, quote: string): boolean {
	const haystack = normalizeForQuote(answer);
	const pieces = quote
		.split(/\.\.\.|…|\[\.\.\.\]/)
		.map(normalizeForQuote)
		.filter((p) => p.length > 0);
	if (pieces.length === 0) return false;
	let from = 0;
	for (const piece of pieces) {
		const at = haystack.indexOf(piece, from);
		if (at < 0) return false;
		from = at + piece.length;
	}
	return true;
}

/** What the grader can quote from: the working plus the typed final value. */
export function answerText(answer: ExamAnswer | undefined): string {
	if (!answer) return "";
	return [answer.text, answer.final ? `Final answer: ${answer.final}` : ""].filter((s) => s.trim()).join("\n");
}

export function isBlank(part: ExamPart, answer: ExamAnswer | undefined): boolean {
	if (!answer) return true;
	if (part.kind === "choice") return answer.choice === undefined;
	return !answer.text.trim() && !answer.final?.trim();
}

/** A choice part, or a blank one: no model needed. null = the rubric grader's job. */
export function gradeByCode(part: ExamPart, answer: ExamAnswer | undefined): PartGrade | null {
	if (isBlank(part, answer)) {
		return {
			partId: part.id,
			earned: 0,
			points: part.points,
			criteria: part.rubric.map((r) => ({ id: r.id, awarded: 0, evidence: "" })),
			feedback: "No answer was given.",
			method: "blank",
		};
	}
	if (part.kind !== "choice") return null;
	const right = answer!.choice === part.correctOption;
	return {
		partId: part.id,
		earned: right ? part.points : 0,
		points: part.points,
		criteria: part.rubric.map((r) => ({ id: r.id, awarded: right ? r.points : 0, evidence: right ? optionLabel(part, answer!.choice!) : "" })),
		feedback: right
			? "Right option."
			: `You picked ${optionLabel(part, answer!.choice!)}; the answer is ${optionLabel(part, part.correctOption ?? 0)}.`,
		method: "exact",
	};
}

export function optionLabel(part: ExamPart, index: number): string {
	return `${OPTION_LETTERS[index] ?? "?"} (${part.options?.[index] ?? ""})`;
}

/** The grader's submission for one problem. */
export interface RubricSubmission {
	grades: Array<{
		partId: string;
		criteria: Array<{ id: string; awarded: number; evidence: string }>;
		carriedForward?: boolean;
		feedback: string;
	}>;
}

/** Structural problems with a grader submission (the retry messages). */
export function rubricSubmissionProblems(parts: readonly ExamPart[], sub: RubricSubmission): string[] {
	const out: string[] = [];
	const expected = new Map(parts.map((p) => [p.id, p]));
	const seen = new Set<string>();
	for (const g of sub.grades) {
		const part = expected.get(g.partId);
		if (!part) {
			out.push(`partId "${g.partId}" is not one of the parts to grade: ${[...expected.keys()].map((k) => `"${k}"`).join(", ")}.`);
			continue;
		}
		if (seen.has(g.partId)) out.push(`part ${g.partId} is graded twice.`);
		seen.add(g.partId);
		const rubric = new Map(part.rubric.map((r) => [r.id, r]));
		const ids = new Set<string>();
		for (const c of g.criteria) {
			const item = rubric.get(c.id);
			if (!item) {
				out.push(`part ${g.partId}: criterion "${c.id}" is not in its rubric (${[...rubric.keys()].join(", ")}).`);
				continue;
			}
			ids.add(c.id);
			if (!(c.awarded >= 0 && c.awarded <= item.points) || !Number.isInteger(c.awarded * 2)) {
				out.push(`part ${g.partId}, ${c.id}: awarded must be from 0 to ${item.points}, in steps of 0.5.`);
			}
		}
		const missing = [...rubric.keys()].filter((id) => !ids.has(id));
		if (missing.length > 0) out.push(`part ${g.partId}: grade every rubric criterion (missing ${missing.join(", ")}).`);
	}
	const absent = [...expected.keys()].filter((id) => !seen.has(id));
	if (absent.length > 0) out.push(`grade every part (missing ${absent.join(", ")}).`);
	return out;
}

/** Awarded points the grader could not ground in the learner's words. */
export function unquotedCredit(parts: readonly ExamPart[], answers: Readonly<Record<string, ExamAnswer>>, sub: RubricSubmission): string[] {
	const out: string[] = [];
	const byId = new Map(parts.map((p) => [p.id, p]));
	for (const g of sub.grades) {
		const part = byId.get(g.partId);
		if (!part) continue;
		const text = answerText(answers[part.id]);
		for (const c of g.criteria) {
			const item = part.rubric.find((r) => r.id === c.id);
			if (!item || item.final || c.awarded <= 0) continue;
			if (!c.evidence.trim() || !quoteFound(text, c.evidence)) {
				out.push(
					`part ${g.partId}, ${c.id}: the evidence ${JSON.stringify(c.evidence)} is not in the learner's answer. ` +
						"Quote their exact words (use ... to skip text), or award 0 if the answer does not contain it.",
				);
			}
		}
	}
	return out;
}

/** The final grades for one problem's rubric-graded parts. Code has the last
 *  word on: the numeric final value (unless an honest carry-forward applies),
 *  credit with no verifiable quote (withheld), and the point bounds. */
export function finalizeRubricGrades(
	problem: ExamProblem,
	answers: Readonly<Record<string, ExamAnswer>>,
	sub: RubricSubmission,
	codeGrades: Readonly<Record<string, PartGrade>>,
): PartGrade[] {
	const out: PartGrade[] = [];
	const earnedSoFar = new Map<string, PartGrade>(Object.entries(codeGrades));
	for (const part of problem.parts) {
		if (codeGrades[part.id]) continue;
		const g = sub.grades.find((x) => x.partId === part.id);
		if (!g) continue;
		const answer = answers[part.id];
		const text = answerText(answer);
		// A carry-forward is only honest when an EARLIER part of this
		// problem lost points: there must be a wrong result to carry.
		const earlierWrong = problem.parts
			.slice(0, problem.parts.indexOf(part))
			.some((p) => {
				const pg = earnedSoFar.get(p.id);
				return pg !== undefined && pg.earned < pg.points;
			});
		const carriedForward = g.carriedForward === true && earlierWrong;
		let withheld = 0;
		const criteria: CriterionGrade[] = part.rubric.map((item) => {
			const c = g.criteria.find((x) => x.id === item.id);
			let awarded = Math.min(item.points, Math.max(0, Math.round((c?.awarded ?? 0) * 2) / 2));
			const evidence = c?.evidence.trim() ?? "";
			if (item.final && part.numeric) {
				const value = parseNumber(answer?.final?.trim() ? answer.final : undefined) ?? lastNumberIn(answer?.text);
				const exact = value !== null && numberMatches(value, part.numeric);
				// Code decides the final value; the model's award only stands
				// for a carried-forward error it could quote.
				const modelOk = carriedForward && awarded > 0 && evidence !== "" && quoteFound(text, evidence);
				awarded = exact ? item.points : modelOk ? awarded : 0;
				return { id: item.id, awarded, evidence: exact ? (answer?.final?.trim() || String(value)) : modelOk ? evidence : "" };
			}
			if (awarded > 0 && (evidence === "" || !quoteFound(text, evidence))) {
				withheld += awarded;
				awarded = 0;
			}
			return { id: item.id, awarded, evidence: awarded > 0 ? evidence : "" };
		});
		const earned = criteria.reduce((a, c) => a + c.awarded, 0);
		const grade: PartGrade = {
			partId: part.id,
			earned,
			points: part.points,
			criteria,
			feedback: g.feedback.trim(),
			method: "rubric",
			...(carriedForward ? { carriedForward: true } : {}),
			...(withheld > 0 ? { withheld } : {}),
		};
		earnedSoFar.set(part.id, grade);
		out.push(grade);
	}
	return out;
}

/** The last number in a working, when no final value was typed separately. */
function lastNumberIn(text: string | undefined): number | null {
	if (!text) return null;
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	for (let i = lines.length - 1; i >= 0; i--) {
		const n = parseNumber(lines[i]!.replace(/^.*=/, ""));
		if (n !== null) return n;
	}
	return null;
}

// ─── what the learner sees ──────────────────────────────────────────────────

/** A part as the learner sees it before grading: no solution, no rubric. */
export interface ExamPartView {
	id: string;
	prompt: string;
	points: number;
	kind: ExamPartKind;
	options?: string[];
	unit?: string;
	/** Present only once graded. */
	solution?: string;
	finalAnswer?: string;
	correctOption?: number;
	rubric?: ExamRubricItem[];
	topicKeys?: string[];
}

export interface ExamProblemView {
	id: string;
	title: string;
	scenario: string;
	parts: ExamPartView[];
	sources: string[];
}

export interface ExamView {
	id: string;
	title: string;
	createdAt: string;
	scope: ExamScope;
	minutes: number;
	status: ExamStatus;
	phase?: string;
	error?: string;
	failedDuring?: "generating" | "grading";
	problems: ExamProblemView[];
	/** The exam's shape, known before the problems are shown. */
	problemCount: number;
	partCount: number;
	totalPoints: number;
	checks?: ExamRecord["checks"];
	startedAt?: string;
	deadlineAt?: string;
	submittedAt?: string;
	timedOut?: boolean;
	gradedAt?: string;
	answers: Record<string, ExamAnswer>;
	grades: Record<string, PartGrade>;
	topics: ExamTopic[];
	/** The server's clock when this view was made (the timer's anchor). */
	serverNow: number;
}

export function totalPoints(problems: readonly { parts: readonly { points: number }[] }[]): number {
	return problems.reduce((a, p) => a + p.parts.reduce((b, x) => b + x.points, 0), 0);
}

/** The record as the browser may see it. Solutions, final answers and
 *  rubrics never leave the server before the exam is graded. Before the
 *  exam starts, not even the problems do: the clock starts when they
 *  are first shown. */
export function examView(record: ExamRecord, now: number): ExamView {
	const graded = record.status === "graded";
	const shown = record.status !== "generating" && record.status !== "ready" && !(record.status === "failed" && record.failedDuring === "generating");
	const problems: ExamProblemView[] = shown
		? record.problems.map((p) => ({
				id: p.id,
				title: p.title,
				scenario: p.scenario,
				sources: p.sources,
				parts: p.parts.map((part) => ({
					id: part.id,
					prompt: part.prompt,
					points: part.points,
					kind: part.kind,
					...(part.options ? { options: part.options } : {}),
					...(part.numeric?.unit ? { unit: part.numeric.unit } : {}),
					...(graded
						? {
								solution: part.solution,
								finalAnswer: part.finalAnswer,
								...(part.correctOption !== undefined ? { correctOption: part.correctOption } : {}),
								rubric: part.rubric,
								topicKeys: part.topicKeys,
							}
						: {}),
				})),
			}))
		: [];
	return {
		id: record.id,
		title: record.title,
		createdAt: record.createdAt,
		scope: record.scope,
		minutes: record.minutes,
		status: record.status,
		...(record.phase ? { phase: record.phase } : {}),
		...(record.error ? { error: record.error } : {}),
		...(record.failedDuring ? { failedDuring: record.failedDuring } : {}),
		problems,
		problemCount: record.problems.length,
		partCount: record.problems.reduce((a, p) => a + p.parts.length, 0),
		totalPoints: totalPoints(record.problems),
		...(record.checks ? { checks: record.checks } : {}),
		...(record.startedAt ? { startedAt: record.startedAt } : {}),
		...(record.deadlineAt ? { deadlineAt: record.deadlineAt } : {}),
		...(record.submittedAt ? { submittedAt: record.submittedAt } : {}),
		...(record.timedOut ? { timedOut: true } : {}),
		...(record.gradedAt ? { gradedAt: record.gradedAt } : {}),
		answers: record.answers,
		grades: graded ? record.grades : {},
		topics: graded ? record.topics : [],
		serverNow: now,
	};
}

/** The list row for the Library. */
export interface ExamSummary {
	id: string;
	title: string;
	createdAt: string;
	status: ExamStatus;
	minutes: number;
	earned?: number;
	total: number;
}

export function examSummary(record: ExamRecord): ExamSummary {
	return {
		id: record.id,
		title: record.title,
		createdAt: record.createdAt,
		status: record.status,
		minutes: record.minutes,
		total: totalPoints(record.problems),
		...(record.status === "graded" ? { earned: examScore(record).earned } : {}),
	};
}

export function examScore(record: Pick<ExamRecord, "problems" | "grades">): { earned: number; total: number } {
	const total = totalPoints(record.problems);
	const earned = record.problems.reduce((a, p) => a + p.parts.reduce((b, part) => b + (record.grades[part.id]?.earned ?? 0), 0), 0);
	return { earned, total };
}

/** Accept a learner's answer patch: only known parts, sane shapes, bounded size. */
export function sanitizeAnswers(
	problems: readonly ExamProblem[],
	raw: unknown,
	now: string,
): Record<string, ExamAnswer> {
	const out: Record<string, ExamAnswer> = {};
	if (!raw || typeof raw !== "object") return out;
	const parts = new Map(problems.flatMap((p) => p.parts).map((p) => [p.id, p]));
	for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
		const part = parts.get(id);
		if (!part || !value || typeof value !== "object") continue;
		const v = value as Record<string, unknown>;
		const answer: ExamAnswer = { text: typeof v.text === "string" ? v.text.slice(0, 20_000) : "", updatedAt: now };
		if (part.kind === "numeric" && typeof v.final === "string") answer.final = v.final.slice(0, 200);
		if (part.kind === "choice" && Number.isInteger(v.choice) && (v.choice as number) >= 0 && (v.choice as number) < (part.options?.length ?? 0)) {
			answer.choice = v.choice as number;
		}
		if (typeof v.confidence === "number" && v.confidence >= 0 && v.confidence <= 100) answer.confidence = Math.round(v.confidence);
		out[id] = answer;
	}
	return out;
}

// ─── into the memory model and calibration ──────────────────────────────────

/** A graded part's share of its points → a recall grade. Confidence can
 *  lower a right answer to Hard, never raise anything. */
export function partGrade(grade: Pick<PartGrade, "earned" | "points">, confidence: number | undefined): RecallGrade {
	const share = grade.points > 0 ? grade.earned / grade.points : 0;
	if (share < PART_MISS_SHARE) return GRADE_AGAIN;
	if (share < PART_RIGHT_SHARE) return GRADE_HARD;
	return typeof confidence === "number" && confidence < SHAKY_CONFIDENCE ? GRADE_HARD : GRADE_GOOD;
}

/** Every topic an exam tested, one event per (part, topic). Exam events
 *  are reviews: they schedule a topic but never become its home session,
 *  unless the exam is the only place it was ever tested. */
export function examRecallEvents(record: ExamRecord): RecallEvent[] {
	if (record.status !== "graded") return [];
	const at = Date.parse(record.submittedAt ?? record.gradedAt ?? record.updatedAt);
	if (Number.isNaN(at)) return [];
	const titles = new Map(record.topics.map((t) => [t.key, t.title]));
	const out: RecallEvent[] = [];
	for (const problem of record.problems) {
		for (const part of problem.parts) {
			const grade = record.grades[part.id];
			if (!grade) continue;
			for (const key of part.topicKeys) {
				const parsed = parseTopicKey(key);
				if (!parsed) continue;
				out.push({
					...parsed,
					title: titles.get(key) ?? parsed.topicId,
					chatId: record.id,
					chatTitle: record.title,
					at,
					grade: partGrade(grade, record.answers[part.id]?.confidence),
					review: true,
					// The weak-spot report reads these: a sure miss on an exam part
					// is overconfidence on its topics too.
					...(typeof record.answers[part.id]?.confidence === "number" ? { confidence: record.answers[part.id]!.confidence } : {}),
					question: part.prompt,
				});
			}
		}
	}
	return out;
}

/** What the calibration fold reads off a graded exam: the record, or the
 *  learner's view of it (both carry the same shape). */
export interface GradedPaper {
	id: string;
	title: string;
	status: ExamStatus;
	problems: ReadonlyArray<{ title: string; parts: ReadonlyArray<{ id: string; prompt: string }> }>;
	grades: Readonly<Record<string, PartGrade>>;
	answers: Readonly<Record<string, ExamAnswer>>;
	submittedAt?: string;
	gradedAt?: string;
	updatedAt?: string;
}

/** Every rated part, as calibration answers: what you said vs what you scored. */
export function examCalibrationAnswers(record: GradedPaper): CalibrationAnswer[] {
	if (record.status !== "graded") return [];
	const answeredAt = record.submittedAt ?? record.gradedAt ?? record.updatedAt ?? "";
	const out: CalibrationAnswer[] = [];
	for (const problem of record.problems) {
		for (const part of problem.parts) {
			const grade = record.grades[part.id];
			const answer = record.answers[part.id];
			if (!grade || !answer || grade.method === "blank" || typeof answer.confidence !== "number") continue;
			out.push({
				chatId: record.id,
				chatTitle: record.title,
				questionText: `${problem.title} (${part.id}): ${part.prompt}`,
				confidence: answer.confidence,
				correct: grade.points > 0 && grade.earned / grade.points >= PART_RIGHT_SHARE,
				dontKnow: false,
				answeredAt,
			});
		}
	}
	return out;
}

/** The results' calibration line: how sure you were vs how you did. */
export function examCalibrationSummary(record: GradedPaper): { rated: number; meanConfidence: number; right: number; confidentMisses: number } | null {
	const answers = examCalibrationAnswers(record);
	if (answers.length === 0) return null;
	const mean = answers.reduce((a, x) => a + (x.confidence ?? 0), 0) / answers.length;
	return {
		rated: answers.length,
		meanConfidence: Math.round(mean),
		right: answers.filter((a) => a.correct).length,
		confidentMisses: answers.filter((a) => !a.correct && (a.confidence ?? 0) >= CONFIDENT_MISS_FLOOR).length,
	};
}

/** Remaining whole seconds on the clock (0 once past the deadline). */
export function secondsLeft(deadlineAt: string | undefined, now: number): number {
	if (!deadlineAt) return 0;
	return Math.max(0, Math.ceil((Date.parse(deadlineAt) - now) / 1000));
}

export function clockText(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
