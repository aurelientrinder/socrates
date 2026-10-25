/**
 * CALIBRATION (the cross-session fold of quiz confidence): every graded
 * quiz answer already records the learner's stated probability that the
 * answer is right (question-core.ts, `confidence`) and the verdict
 * (`correct`). This folds them across sessions into one honest picture:
 * when you said 90%, how often were you right? The gap between the two
 * is the overconfidence signal no single session can show.
 *
 * Pure and browser-safe: the server reads the records, this folds them.
 */

import type { ChatRecord } from "./contracts/chat.ts";
import { CONFIDENCE_STOPS, type QuestionAnswerData } from "./question-core.ts";

/** One graded quiz answer, lifted out of its session. */
export interface CalibrationAnswer {
	chatId: string;
	chatTitle: string;
	questionText: string;
	/** Absent on "I don't know" (no answer, no probability). */
	confidence?: number;
	correct: boolean;
	dontKnow: boolean;
	answeredAt: string;
}

/** One confidence stop: what you said vs how often you were right. */
export interface CalibrationBin {
	confidence: number;
	count: number;
	correct: number;
	/** 0-100, null when the bin is empty. */
	accuracy: number | null;
}

export interface SessionCalibration {
	chatId: string;
	title: string;
	answered: number;
	meanConfidence: number;
	accuracy: number;
	lastAnsweredAt: string;
}

export interface CalibrationReport {
	/** Answers that carry a confidence (the calibration sample). */
	answered: number;
	dontKnow: number;
	/** 0-100 means over the sample; null when it is empty. */
	meanConfidence: number | null;
	accuracy: number | null;
	/** meanConfidence − accuracy in points: positive = overconfident. */
	gap: number | null;
	/** Mean squared error of the stated probability (0 = perfect, 0.25 = always 50%). */
	brier: number | null;
	bins: CalibrationBin[];
	/** Wrong answers given at ≥ CONFIDENT_MISS_FLOOR, newest first — the
	 *  "I was sure" gaps worth reviewing first. */
	confidentMisses: CalibrationAnswer[];
	/** Per session, newest activity first. */
	sessions: SessionCalibration[];
}

export const CONFIDENT_MISS_FLOOR = 70;
const CONFIDENT_MISS_LIMIT = 25;

/** Within this many points the learner reads as well calibrated. */
export const CALIBRATED_WITHIN = 5;

function isQuizAnswer(details: unknown): details is QuestionAnswerData {
	if (!details || typeof details !== "object") return false;
	const d = details as Partial<QuestionAnswerData>;
	return d.kind === "quiz" && d.dismissed !== true && typeof d.answeredAt === "string";
}

/** Every graded quiz answer in one record, in transcript order. */
export function calibrationAnswers(record: Pick<ChatRecord, "id" | "title" | "messages">): CalibrationAnswer[] {
	const out: CalibrationAnswer[] = [];
	for (const m of record.messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const details = (m as { details?: unknown }).details;
		if (!isQuizAnswer(details)) continue;
		out.push({
			chatId: record.id,
			chatTitle: record.title,
			questionText: details.questionText,
			confidence: details.dontKnow ? undefined : details.confidence,
			correct: details.correct === true,
			dontKnow: details.dontKnow === true,
			answeredAt: details.answeredAt,
		});
	}
	return out;
}

/** The slider's stop nearest a recorded confidence (the record accepts any integer). */
export function nearestStop(confidence: number): number {
	let best = CONFIDENCE_STOPS[0]!;
	for (const stop of CONFIDENCE_STOPS) {
		if (Math.abs(stop - confidence) < Math.abs(best - confidence)) best = stop;
	}
	return best;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const round1 = (x: number): number => Math.round(x * 10) / 10;

export function calibrationReport(answers: readonly CalibrationAnswer[]): CalibrationReport {
	const rated = answers.filter((a) => a.confidence !== undefined) as (CalibrationAnswer & { confidence: number })[];
	const bins: CalibrationBin[] = CONFIDENCE_STOPS.map((confidence) => ({ confidence, count: 0, correct: 0, accuracy: null }));
	for (const a of rated) {
		const bin = bins.find((b) => b.confidence === nearestStop(a.confidence))!;
		bin.count++;
		if (a.correct) bin.correct++;
	}
	for (const bin of bins) bin.accuracy = bin.count > 0 ? round1((100 * bin.correct) / bin.count) : null;

	const meanConfidence = rated.length > 0 ? round1(mean(rated.map((a) => a.confidence))) : null;
	const accuracy = rated.length > 0 ? round1((100 * rated.filter((a) => a.correct).length) / rated.length) : null;
	const brier =
		rated.length > 0 ? Math.round(mean(rated.map((a) => (a.confidence / 100 - (a.correct ? 1 : 0)) ** 2)) * 1000) / 1000 : null;

	const confidentMisses = rated
		.filter((a) => !a.correct && a.confidence >= CONFIDENT_MISS_FLOOR)
		.sort((a, b) => b.answeredAt.localeCompare(a.answeredAt))
		.slice(0, CONFIDENT_MISS_LIMIT);

	const byChat = new Map<string, (CalibrationAnswer & { confidence: number })[]>();
	for (const a of rated) byChat.set(a.chatId, [...(byChat.get(a.chatId) ?? []), a]);
	const sessions: SessionCalibration[] = [...byChat.values()]
		.map((xs) => ({
			chatId: xs[0]!.chatId,
			title: xs[0]!.chatTitle,
			answered: xs.length,
			meanConfidence: round1(mean(xs.map((a) => a.confidence))),
			accuracy: round1((100 * xs.filter((a) => a.correct).length) / xs.length),
			lastAnsweredAt: xs.map((a) => a.answeredAt).sort().at(-1)!,
		}))
		.sort((a, b) => b.lastAnsweredAt.localeCompare(a.lastAnsweredAt));

	return {
		answered: rated.length,
		dontKnow: answers.filter((a) => a.dontKnow).length,
		meanConfidence,
		accuracy,
		gap: meanConfidence !== null && accuracy !== null ? round1(meanConfidence - accuracy) : null,
		brier,
		bins,
		confidentMisses,
		sessions,
	};
}

/** The one-line verdict the view leads with. */
export function calibrationVerdict(report: CalibrationReport): string {
	if (report.gap === null) return "No rated quiz answers yet.";
	const points = Math.round(Math.abs(report.gap));
	if (points <= CALIBRATED_WITHIN) return "Well calibrated: your confidence matches how often you are right.";
	return report.gap > 0
		? `Overconfident by ${points} points: you feel surer than your answers justify.`
		: `Underconfident by ${points} points: you know more than you give yourself credit for.`;
}
