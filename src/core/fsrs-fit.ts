/**
 * PERSONAL FSRS-6 WEIGHT FITTING (pure, zero-dependency, browser-safe):
 * Evaluates and fits the 21-parameter FSRS-6 model to the learner's own
 * multi-sitting recall history using L2-regularized Adam toward the
 * published FSRS-6 defaults so small histories never overfit.
 *
 * Only follow-up sittings (the 2nd+ sitting of a topic) count as labeled
 * observations: each tests whether the model's predicted retrievability
 * R(t, S) matched actual recall (grade !== GRADE_AGAIN).
 */

import {
	FSRS_WEIGHTS,
	FSRS_WEIGHT_COUNT,
	GRADE_AGAIN,
	extractSittings,
	initialState,
	nextState,
	retrievability,
	type FsrsWeights,
	type RecallEvent,
	type Sitting,
} from "./retention.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Minimum follow-up review observations before personal fitting unlocks. */
export const FSRS_MIN_REVIEWS = 100;

/** Published FSRS-6 parameter bounds [min, max] for all 21 weights. */
export const FSRS_BOUNDS: readonly [number, number][] = [
	[0.01, 100], // w0: S0(Again)
	[0.01, 100], // w1: S0(Hard)
	[0.01, 100], // w2: S0(Good)
	[0.01, 100], // w3: S0(Easy — unused in Socrates)
	[1, 10], // w4: D0 base
	[0.001, 4], // w5: D0 exp slope
	[0.001, 4], // w6: difficulty delta
	[0.001, 0.75], // w7: mean reversion
	[0, 4.5], // w8: stability growth exp
	[0, 0.8], // w9: stability saturation
	[0.001, 3.5], // w10: retrievability factor
	[0.001, 5], // w11: lapse base
	[0.001, 0.25], // w12: lapse difficulty exp
	[0.001, 0.9], // w13: lapse stability exp
	[0, 4], // w14: lapse retrievability exp
	[0, 1], // w15: hard penalty
	[1, 6], // w16: easy bonus (unused in Socrates)
	[0, 2], // w17: same-day scale
	[0, 2], // w18: same-day offset
	[0, 0.8], // w19: same-day stability damping
	[0.05, 0.8], // w20: forgetting-curve decay
];

/** Active indices trained in Socrates (w3 & w16 are Easy-only). */
const ACTIVE_INDICES = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 20] as const;

export interface FsrsEval {
	/** Number of follow-up review observations evaluated. */
	reviews: number;
	/** Mean binary cross-entropy loss (lower is better). */
	logLoss: number;
	/** Mean squared probability error / Brier score (lower is better). */
	brier: number;
}

export interface FsrsFitResult {
	weights: number[];
	reviews: number;
	baselineLogLoss: number;
	fittedLogLoss: number;
	baselineBrier: number;
	fittedBrier: number;
	/** True when fitted weights strictly beat FSRS-6 defaults on log-loss. */
	improved: boolean;
	fittedAt: number;
}

export interface FsrsModelStatus {
	source: "default" | "personal";
	reviews: number;
	minReviews: number;
	fittedAt?: number;
	baselineLogLoss?: number;
	fittedLogLoss?: number;
	baselineBrier?: number;
	fittedBrier?: number;
}

export function isValidFsrsWeights(w: unknown): w is number[] {
	if (!Array.isArray(w) || w.length !== FSRS_WEIGHT_COUNT) return false;
	for (let i = 0; i < FSRS_WEIGHT_COUNT; i++) {
		const v = w[i];
		const [lo, hi] = FSRS_BOUNDS[i]!;
		if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) return false;
	}
	return true;
}

function clampWeight(i: number, v: number): number {
	const [lo, hi] = FSRS_BOUNDS[i]!;
	return Math.min(hi, Math.max(lo, v));
}

function buildSequences(events: readonly RecallEvent[]): Sitting[][] {
	const byTopic = new Map<string, RecallEvent[]>();
	for (const e of events) byTopic.set(e.topicKey, [...(byTopic.get(e.topicKey) ?? []), e]);
	const sequences: Sitting[][] = [];
	for (const xs of byTopic.values()) {
		const sittings = extractSittings([...xs].sort((a, b) => a.at - b.at));
		if (sittings.length >= 2) sequences.push(sittings);
	}
	return sequences;
}

function evalSequences(sequences: readonly Sitting[][], w: FsrsWeights): FsrsEval {
	let reviews = 0;
	let logLossSum = 0;
	let brierSum = 0;
	for (const sittings of sequences) {
		let state = initialState(sittings[0]!.grade, w);
		let prevAt = sittings[0]!.at;
		for (let i = 1; i < sittings.length; i++) {
			const s = sittings[i]!;
			const elapsedDays = Math.max(0, (s.at - prevAt) / DAY_MS);
			const rawR = retrievability(elapsedDays, state.stability, w);
			const r = Math.min(1 - 1e-6, Math.max(1e-6, rawR));
			const y = s.grade === GRADE_AGAIN ? 0 : 1;
			logLossSum += -(y * Math.log(r) + (1 - y) * Math.log(1 - r));
			brierSum += (r - y) ** 2;
			reviews++;
			state = nextState(state, s.grade, elapsedDays, w);
			prevAt = s.at;
		}
	}
	if (reviews === 0) return { reviews: 0, logLoss: 0, brier: 0 };
	return { reviews, logLoss: logLossSum / reviews, brier: brierSum / reviews };
}

/** Count follow-up review observations available for fitting. */
export function countFitReviews(events: readonly RecallEvent[]): number {
	let n = 0;
	for (const seq of buildSequences(events)) n += seq.length - 1;
	return n;
}

/** Evaluate any FSRS-6 weight vector against a recall history. */
export function evaluateFsrs(events: readonly RecallEvent[], weights: FsrsWeights = FSRS_WEIGHTS): FsrsEval {
	return evalSequences(buildSequences(events), weights);
}

/**
 * Fit personal FSRS-6 weights to `events` via L2-regularized Adam starting
 * from FSRS-6 defaults. Returns null when fewer than `minReviews` follow-up
 * observations exist.
 */
export function fitFsrsWeights(
	events: readonly RecallEvent[],
	opts: { minReviews?: number; steps?: number; lr?: number; l2?: number; now?: number } = {},
): FsrsFitResult | null {
	const minReviews = opts.minReviews ?? FSRS_MIN_REVIEWS;
	const sequences = buildSequences(events);
	const baseline = evalSequences(sequences, FSRS_WEIGHTS);
	if (baseline.reviews < minReviews) return null;

	const steps = opts.steps ?? 60;
	const baseLr = opts.lr ?? 0.04;
	const l2 = opts.l2 ?? 0.002;
	const now = opts.now ?? Date.now();

	const w = [...FSRS_WEIGHTS];
	const m = new Array<number>(FSRS_WEIGHT_COUNT).fill(0);
	const v = new Array<number>(FSRS_WEIGHT_COUNT).fill(0);
	const beta1 = 0.9;
	const beta2 = 0.999;
	const eps = 1e-8;
	const fd = 1e-3;

	const objective = (cand: readonly number[]): number => {
		const ev = evalSequences(sequences, cand);
		let reg = 0;
		for (const i of ACTIVE_INDICES) {
			const scale = Math.max(0.1, Math.abs(FSRS_WEIGHTS[i]!));
			const diff = (cand[i]! - FSRS_WEIGHTS[i]!) / scale;
			reg += diff * diff;
		}
		return ev.logLoss + l2 * (reg / ACTIVE_INDICES.length);
	};

	let bestW = [...w];
	let bestEval = baseline;

	for (let t = 1; t <= steps; t++) {
		const lr = baseLr * 0.5 * (1 + Math.cos((Math.PI * (t - 1)) / steps));
		const grads = new Array<number>(FSRS_WEIGHT_COUNT).fill(0);
		for (const i of ACTIVE_INDICES) {
			const orig = w[i]!;
			const h = Math.max(fd, Math.abs(orig) * 1e-3);
			const hi = clampWeight(i, orig + h);
			const lo = clampWeight(i, orig - h);
			if (hi === lo) continue;
			w[i] = hi;
			const fHi = objective(w);
			w[i] = lo;
			const fLo = objective(w);
			w[i] = orig;
			grads[i] = (fHi - fLo) / (hi - lo);
		}
		for (const i of ACTIVE_INDICES) {
			const g = grads[i]!;
			m[i] = beta1 * m[i]! + (1 - beta1) * g;
			v[i] = beta2 * v[i]! + (1 - beta2) * g * g;
			const mHat = m[i]! / (1 - beta1 ** t);
			const vHat = v[i]! / (1 - beta2 ** t);
			w[i] = clampWeight(i, w[i]! - (lr * mHat) / (Math.sqrt(vHat) + eps));
		}
		const cur = evalSequences(sequences, w);
		if (cur.logLoss < bestEval.logLoss) {
			bestEval = cur;
			bestW = [...w];
		}
	}

	const rounded = bestW.map((x, i) => clampWeight(i, Math.round(x * 10000) / 10000));
	const finalEval = evalSequences(sequences, rounded);
	const improved = finalEval.logLoss + 1e-5 < baseline.logLoss;

	return {
		weights: improved ? rounded : [...FSRS_WEIGHTS],
		reviews: baseline.reviews,
		baselineLogLoss: baseline.logLoss,
		fittedLogLoss: improved ? finalEval.logLoss : baseline.logLoss,
		baselineBrier: baseline.brier,
		fittedBrier: improved ? finalEval.brier : baseline.brier,
		improved,
		fittedAt: now,
	};
}
