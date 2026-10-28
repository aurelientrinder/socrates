/**
 * FREE-RECALL REVIEW ("explain this from memory"): the second question
 * format of a spaced-repetition review session, next to the multiple-
 * choice `review` question. Recognition is the easy half of memory — an
 * option list hands back the cue the learner is supposed to produce — so
 * a recall topic asks him to explain the idea in his own words, and the
 * tutor marks which key points came back and which were left out.
 *
 * Two calls per topic, both checked at the call boundary so the marking
 * stays tied to the material and to what he actually wrote:
 *
 *   1. `review_recall` (the pose, a question tool): the prompt plus the
 *      KEY POINTS a complete answer covers, committed BEFORE he answers.
 *      Every key point quotes the topic's SOURCE MATERIAL (what he was
 *      taught: the plan node's teaching, the proposition's statement) —
 *      a point the source does not say is rejected, so the rubric cannot
 *      drift into facts the session never covered.
 *   2. `review_mark` (server-executed, after his answer): one mark per
 *      key point — covered / partial / missed — where covered and partial
 *      must QUOTE his answer as evidence, plus any wrong claims he made,
 *      each quoting his answer and corrected by a quote from the source.
 *      The grade is NOT the model's to choose: it is computed here from
 *      the marks (recallMarkGrade), on the retention fold's scale.
 *
 * "I don't know" needs no marking: the answer itself grades Again.
 *
 * Pure and browser-safe. Types only from the retention fold (it imports
 * this module's names, so a value import back would be circular).
 */

import { Type, type Static } from "typebox";
import type { RecallGrade } from "./retention.ts";

/** The free-recall pose (a QUESTION_TOOLS entry, explain-shaped). */
export const RECALL_REVIEW_TOOL = "review_recall";
/** The marking call that grades a free-recall answer. */
export const RECALL_MARK_TOOL = "review_mark";

/** Key points per recall prompt: enough to cover a topic's core, few
 *  enough that a complete answer stays a short paragraph. */
export const MIN_KEY_POINTS = 1;
export const MAX_KEY_POINTS = 6;
/** A quote shorter than this (normalized) proves nothing — "the" is in
 *  every text. */
export const MIN_QUOTE_CHARS = 8;
/** The source material a recall topic carries, at most (the marker rides
 *  every turn's context). */
export const MAX_SOURCE_CHARS = 4000;
/** Below this much source text a topic is too thin to mark an
 *  explanation against — it stays multiple choice. */
export const MIN_RECALL_SOURCE_CHARS = 40;

// ─── the tool contracts ─────────────────────────────────────────────────────

const keyPointObject = Type.Object({
	point: Type.String({
		description: "One idea a complete answer must contain, as a short plain statement (LaTeX for math).",
	}),
	source: Type.String({
		description:
			"REQUIRED — a VERBATIM quote (a phrase or sentence, copied exactly) from this topic's source material in " +
			"the session context that states this point. Checked at call time: a quote the source does not contain " +
			"is rejected — a key point the material never taught cannot be marked.",
	}),
});

/** topicId LEADS (the drop-order ruling: fields generated first get
 *  dropped least); the key points come BEFORE the learner sees the
 *  question by construction — they ride the pose. */
export const recallReviewInputObject = Type.Object({
	topicId: Type.String({
		description:
			"REQUIRED — the topic this prompt tests: one topicId from the session context's [topicId] list marked " +
			"'explain from memory', copied exactly. Each topic takes exactly one question per session.",
	}),
	question: Type.String({
		description:
			"The prompt, asking him to explain the idea from memory in his own words (e.g. 'Explain, from memory, why …'). " +
			"Never list or hint at the key points.",
	}),
	keyPoints: Type.Array(keyPointObject, {
		minItems: MIN_KEY_POINTS,
		maxItems: MAX_KEY_POINTS,
		description:
			`REQUIRED — the ${MIN_KEY_POINTS}-${MAX_KEY_POINTS} key points a complete answer covers, most important first, ` +
			"each quoting the source material. COMMITTED before he answers: hidden from him until he submits, and " +
			"his answer is marked against exactly these.",
	}),
	details: Type.Optional(
		Type.String({ description: "Optional extra context shown under the prompt (never a hint at the key points)." }),
	),
});
export type RecallReviewInput = Static<typeof recallReviewInputObject>;
export type KeyPoint = RecallReviewInput["keyPoints"][number];

export const KEY_POINT_STATUSES = ["covered", "partial", "missed"] as const;
export type KeyPointStatus = (typeof KEY_POINT_STATUSES)[number];

export const recallMarkInputObject = Type.Object({
	topicId: Type.String({
		description: "REQUIRED — the topicId of the free-recall question he just answered, copied exactly.",
	}),
	marks: Type.Array(
		Type.Object({
			status: Type.Union([Type.Literal("covered"), Type.Literal("partial"), Type.Literal("missed")], {
				description:
					"covered = his answer states this point correctly; partial = he gestures at it but leaves out or blurs " +
					"part of it; missed = it is not in his answer (bare words, no quotes).",
			}),
			evidence: Type.Optional(
				Type.String({
					description:
						"REQUIRED for covered and partial: a VERBATIM quote from his answer where he makes the point (checked " +
						"at call time). Omit for missed.",
				}),
			),
		}),
		{
			description:
				"REQUIRED — exactly one mark per key point of the question, in the same order as its keyPoints. Mark only " +
				"what he wrote — never credit what he probably meant.",
		},
	),
	errors: Type.Optional(
		Type.Array(
			Type.Object({
				claim: Type.String({ description: "A VERBATIM quote of the wrong claim from his answer." }),
				correction: Type.String({ description: "What is actually true, in one short sentence." }),
				source: Type.String({
					description: "A VERBATIM quote from the topic's source material that the correction rests on.",
				}),
			}),
			{
				description:
					"Claims in his answer the source material contradicts (not omissions — those are missed points). " +
					"Omit or pass [] when there are none.",
			},
		),
	),
});
export type RecallMarkInput = Static<typeof recallMarkInputObject>;

// ─── quoting ────────────────────────────────────────────────────────────────

/** The comparison form of a quote: lowercase letters and digits, every
 *  other run (spaces, punctuation, LaTeX backslashes and braces) one
 *  space — so a copied quote matches across formatting and line breaks. */
export function normalizeQuote(text: string): string {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

/** Does `text` contain `quote` (normalized), and is the quote long
 *  enough to mean something? */
export function quotedIn(quote: string | undefined, text: string): boolean {
	if (typeof quote !== "string") return false;
	const q = normalizeQuote(quote);
	if (q.length < MIN_QUOTE_CHARS) return false;
	return ` ${normalizeQuote(text)} `.includes(` ${q} `);
}

// ─── the call-boundary checks ───────────────────────────────────────────────

/** The pose's authoring contract against the topic's source material.
 *  Empty = a prompt whose rubric is grounded in what was taught. */
export function recallReviewProblems(input: Pick<RecallReviewInput, "keyPoints">, source: string | undefined): string[] {
	if (!source || source.trim().length === 0) {
		return ["this topic has no source material to mark against — ask it with the multiple-choice `review` tool."];
	}
	const problems: string[] = [];
	input.keyPoints.forEach((kp, i) => {
		if (kp.point.trim().length === 0) problems.push(`keyPoints[${i}].point is empty.`);
		if (!quotedIn(kp.source, source)) {
			problems.push(
				`keyPoints[${i}].source is not a verbatim quote of the topic's source material (at least ${MIN_QUOTE_CHARS} ` +
					"letters, copied exactly). Quote the sentence that states the point — or drop the point if the source " +
					"does not state it.",
			);
		}
	});
	return problems;
}

/** The marking contract: one mark per key point, every credit and every
 *  error quoted from his answer, every correction quoted from the source.
 *  Empty = marks the card can show and the grade can rest on. */
export function recallMarkProblems(
	input: RecallMarkInput,
	keyPoints: readonly KeyPoint[],
	answerText: string,
	source: string,
): string[] {
	const problems: string[] = [];
	if (input.marks.length !== keyPoints.length) {
		problems.push(
			`marks has ${input.marks.length} entries but the question has ${keyPoints.length} key points — give exactly ` +
				"one mark per key point, in order.",
		);
		return problems;
	}
	input.marks.forEach((m, i) => {
		if (m.status === "missed") return;
		if (!quotedIn(m.evidence, answerText)) {
			problems.push(
				`marks[${i}] is ${m.status} but its evidence is not a verbatim quote of his answer (at least ` +
					`${MIN_QUOTE_CHARS} letters). Quote where he makes the point — if he never does, mark it missed.`,
			);
		}
	});
	(input.errors ?? []).forEach((e, i) => {
		if (!quotedIn(e.claim, answerText)) problems.push(`errors[${i}].claim is not a verbatim quote of his answer.`);
		if (!quotedIn(e.source, source)) {
			problems.push(
				`errors[${i}].source is not a verbatim quote of the topic's source material — a correction must rest on ` +
					"what was taught; drop the error if the source does not settle it.",
			);
		}
		if (e.correction.trim().length === 0) problems.push(`errors[${i}].correction is empty.`);
	});
	return problems;
}

// ─── the grade ──────────────────────────────────────────────────────────────

/** Right-but-unsure line, the retention fold's own (SHAKY_CONFIDENCE). */
const SHAKY_BELOW = 50;

/** Coverage 0-1: covered counts whole, partial half. */
export function recallCoverage(statuses: readonly KeyPointStatus[]): number {
	if (statuses.length === 0) return 0;
	const score = statuses.reduce((s, x) => s + (x === "covered" ? 1 : x === "partial" ? 0.5 : 0), 0);
	return score / statuses.length;
}

/**
 * The grade of a marked answer, on the fold's scale and with its bias
 * (pessimistic on purpose, never Easy):
 *   - under half the key points back → Again (a lapse);
 *   - anything left out or blurred, any wrong claim, or stated
 *     confidence under 50% → Hard;
 *   - every point covered, nothing wrong, confident → Good.
 */
export function recallMarkGrade(input: {
	statuses: readonly KeyPointStatus[];
	errors: number;
	confidence?: number;
}): RecallGrade {
	const coverage = recallCoverage(input.statuses);
	if (coverage < 0.5) return 1;
	if (coverage < 1 || input.errors > 0) return 2;
	if (typeof input.confidence === "number" && input.confidence < SHAKY_BELOW) return 2;
	return 3;
}

/** One marked key point, as the card shows it. */
export interface MarkedKeyPoint {
	point: string;
	source: string;
	status: KeyPointStatus;
	evidence?: string;
}

/** The marking result's details: what the card renders and the
 *  retention fold reads (grade + markedAt, keyed by topicId). */
export interface RecallMarkData {
	kind: "recall-mark";
	topicId: string;
	points: MarkedKeyPoint[];
	errors: { claim: string; correction: string; source: string }[];
	/** 0-1, covered whole + partial half. */
	coverage: number;
	grade: RecallGrade;
	confidence?: number;
	/** The session the topic was learned in (the card's "marked against"). */
	sourceTitle?: string;
	markedAt: string;
}

export function isRecallMarkData(details: unknown): details is RecallMarkData {
	if (!details || typeof details !== "object") return false;
	const d = details as Partial<RecallMarkData>;
	return (
		d.kind === "recall-mark" &&
		typeof d.topicId === "string" &&
		(d.grade === 1 || d.grade === 2 || d.grade === 3) &&
		typeof d.markedAt === "string" &&
		Array.isArray(d.points)
	);
}

/** Build the marking result from validated marks. */
export function buildRecallMark(input: {
	mark: RecallMarkInput;
	keyPoints: readonly KeyPoint[];
	confidence?: number;
	sourceTitle?: string;
	at?: number;
}): RecallMarkData {
	const points = input.keyPoints.map((kp, i) => {
		const m = input.mark.marks[i]!;
		return {
			point: kp.point,
			source: kp.source,
			status: m.status,
			...(m.status !== "missed" && m.evidence ? { evidence: m.evidence } : {}),
		};
	});
	const errors = (input.mark.errors ?? []).map((e) => ({ claim: e.claim, correction: e.correction, source: e.source }));
	const statuses = points.map((p) => p.status);
	return {
		kind: "recall-mark",
		topicId: input.mark.topicId,
		points,
		errors,
		coverage: recallCoverage(statuses),
		grade: recallMarkGrade({ statuses, errors: errors.length, confidence: input.confidence }),
		...(typeof input.confidence === "number" ? { confidence: input.confidence } : {}),
		...(input.sourceTitle ? { sourceTitle: input.sourceTitle } : {}),
		markedAt: new Date(input.at ?? Date.now()).toISOString(),
	};
}

/** What the model reads back from a marking: the computed outcome, so
 *  its next words match the card. */
export function recallMarkForModel(mark: RecallMarkData): Record<string, unknown> {
	const count = (s: KeyPointStatus) => mark.points.filter((p) => p.status === s).length;
	return {
		marked: true,
		outcome: mark.grade === 3 ? "recalled" : mark.grade === 2 ? "shaky" : "missed",
		covered: count("covered"),
		partial: count("partial"),
		missed: count("missed"),
		errors: mark.errors.length,
	};
}

/** The key points as one revealable text (the answered card's "what a
 *  full answer covers", shown when he could not recall it). */
export function keyPointsText(keyPoints: readonly Pick<KeyPoint, "point">[]): string {
	return keyPoints.map((k) => `- ${k.point}`).join("\n");
}

// ─── the topic's source material ────────────────────────────────────────────

interface SourceBlock {
	type?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
}

/**
 * What a plan node was TAUGHT, read back out of its own session: the
 * tutor's prose leading up to each question tagged with the node (the
 * teaching precedes its check), plus those questions' own explanations
 * and committed answers. Empty when the session never tagged the node
 * (or the teaching was compacted away).
 */
export function planNodeTeaching(messages: readonly unknown[], nodeId: string): string {
	const out: string[] = [];
	let pending: string[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as SourceBlock[]) {
			if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
				pending.push(block.text.trim());
				continue;
			}
			if (block?.type !== "toolCall" || (block.name !== "quiz" && block.name !== "explain")) continue;
			const args = (block.arguments ?? {}) as { nodeId?: unknown; explanation?: unknown; correctAnswer?: unknown };
			if (args.nodeId === nodeId) {
				out.push(...pending);
				if (typeof args.explanation === "string" && args.explanation.trim()) out.push(args.explanation.trim());
				if (block.name === "explain" && typeof args.correctAnswer === "string" && args.correctAnswer.trim()) {
					out.push(args.correctAnswer.trim());
				}
			}
			pending = [];
		}
	}
	return out.join("\n\n");
}

/** Join source pieces (summary first), dropping repeats, capped. */
export function composeSource(pieces: readonly (string | undefined)[]): string {
	const seen = new Set<string>();
	const kept: string[] = [];
	for (const p of pieces) {
		const t = p?.trim();
		if (!t) continue;
		const key = normalizeQuote(t);
		if (seen.has(key)) continue;
		seen.add(key);
		kept.push(t);
	}
	const joined = kept.join("\n\n");
	return joined.length > MAX_SOURCE_CHARS ? `${joined.slice(0, MAX_SOURCE_CHARS).trimEnd()}…` : joined;
}

/** Question formats a review topic can take. */
export type ReviewFormat = "choice" | "recall";

/** The session's format mix: topics with enough source material to mark
 *  an explanation against alternate recall / choice in queue order,
 *  starting with recall on the weakest; thin topics stay choice. */
export function assignReviewFormats<T extends { source?: string }>(topics: readonly T[]): (T & { format: ReviewFormat })[] {
	let eligible = 0;
	return topics.map((t) => {
		const ok = (t.source?.trim().length ?? 0) >= MIN_RECALL_SOURCE_CHARS;
		const format: ReviewFormat = ok && eligible++ % 2 === 0 ? "recall" : "choice";
		return { ...t, format };
	});
}
