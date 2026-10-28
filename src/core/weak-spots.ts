/**
 * WEAK SPOTS (the overconfidence report): the topics most worth drilling,
 * on one list. Two signals already exist, each on its own tab: the
 * retention fold says what is fading (retention.ts), the calibration fold
 * says how sure you felt vs how often you were right (calibration.ts) —
 * but calibration is per session, not per topic. This joins them on the
 * retention topic key: for each tested topic, how sure you said you were
 * on its recent answers vs how often those answers were right, plus how
 * much of it you are predicted to still recall.
 *
 * A topic is a weak spot when its recent answers show OVERCONFIDENCE (a
 * miss at CONFIDENT_MISS_FLOOR+ among them, and a confidence-accuracy gap
 * past CALIBRATED_WITHIN)
 * or when its LAST sitting was shaky or missed. A topic that was only
 * ever recalled cleanly is never a weak spot, however faded: that is the
 * Memory tab's job. Only the last RECENT_ANSWERS rated answers count, so
 * a topic drops off once you have actually fixed it.
 *
 * Pure and browser-safe: the server reads the records, this folds them.
 */

import { CALIBRATED_WITHIN, CONFIDENT_MISS_FLOOR } from "./calibration.ts";
import { GRADE_AGAIN, GRADE_GOOD, retentionReport, type RecallEvent, type TopicRetention } from "./retention.ts";

/** How many of a topic's latest rated answers its overconfidence reads. */
export const RECENT_ANSWERS = 5;
/** The report lists at most this many weak spots. */
export const WEAK_SPOT_LIMIT = 15;
/** How many missed questions a weak spot carries into a drill. */
export const MISSED_QUESTIONS = 2;

export type WeakSpotKind = "overconfident" | "shaky";

export interface WeakSpot extends TopicRetention {
	spot: WeakSpotKind;
	/** Rated quiz answers read (the topic's latest, up to RECENT_ANSWERS). */
	rated: number;
	/** 0-100 over those answers; null when the topic has none (practice only). */
	meanConfidence: number | null;
	accuracy: number | null;
	/** meanConfidence − accuracy in points; null without rated answers. */
	gap: number | null;
	/** Wrong answers given at ≥ CONFIDENT_MISS_FLOOR, among those read. */
	sureMisses: number;
	/** The questions of its latest misses (newest first, up to
	 *  MISSED_QUESTIONS): what a drill aims its fresh question at. */
	missedQuestions: string[];
	/** The rank: positive gap + predicted forgetting (100 × (1 − retention)). */
	score: number;
	/** One plain sentence on why it is listed. */
	reason: string;
}

export interface WeakSpotReport {
	now: number;
	/** Overconfident first, then by score; capped at WEAK_SPOT_LIMIT. */
	spots: WeakSpot[];
	/** Every tested topic (the denominator the headline reads). */
	tracked: number;
	overconfident: number;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

/** One topic's weak-spot reading; null when it is not a weak spot. */
export function weakSpotOf(topic: TopicRetention, events: readonly RecallEvent[]): WeakSpot | null {
	const recent = events
		.filter((e): e is RecallEvent & { confidence: number } => typeof e.confidence === "number")
		.sort((a, b) => a.at - b.at)
		.slice(-RECENT_ANSWERS);
	const rated = recent.length;
	const right = recent.filter((e) => e.grade !== GRADE_AGAIN).length;
	const meanConfidence = rated > 0 ? round1(recent.reduce((s, e) => s + e.confidence, 0) / rated) : null;
	const accuracy = rated > 0 ? round1((100 * right) / rated) : null;
	const gap = meanConfidence !== null && accuracy !== null ? round1(meanConfidence - accuracy) : null;
	const sureMisses = recent.filter((e) => e.grade === GRADE_AGAIN && e.confidence >= CONFIDENT_MISS_FLOOR).length;

	const missedQuestions = [...events]
		.sort((a, b) => b.at - a.at)
		.filter((e) => e.grade === GRADE_AGAIN && e.question)
		.map((e) => e.question!)
		.filter((q, i, all) => all.indexOf(q) === i)
		.slice(0, MISSED_QUESTIONS);

	// A miss at 30% is an honest guess, not overconfidence: it takes a miss
	// at CONFIDENT_MISS_FLOOR or more, on top of the overall gap.
	const overconfident = gap !== null && gap > CALIBRATED_WITHIN && sureMisses > 0;
	if (!overconfident && topic.lastGrade === GRADE_GOOD) return null;

	const spot: WeakSpotKind = overconfident ? "overconfident" : "shaky";
	return {
		...topic,
		spot,
		rated,
		meanConfidence,
		accuracy,
		gap,
		sureMisses,
		missedQuestions,
		score: round1(Math.max(0, gap ?? 0) + 100 * (1 - topic.retention)),
		reason: reasonOf({ spot, rated, right, meanConfidence, sureMisses, lastGrade: topic.lastGrade }),
	};
}

function reasonOf(r: {
	spot: WeakSpotKind;
	rated: number;
	right: number;
	meanConfidence: number | null;
	sureMisses: number;
	lastGrade: TopicRetention["lastGrade"];
}): string {
	if (r.spot === "overconfident") {
		return `You felt ${Math.round(r.meanConfidence!)}% sure on average but got ${r.right} of ${r.rated} right, and missed ${r.sureMisses === 1 ? "once" : `${r.sureMisses} times`} while at least ${CONFIDENT_MISS_FLOOR}% sure.`;
	}
	return r.lastGrade === GRADE_AGAIN ? "You missed it the last time it was tested." : "Right last time, but only just: unsure or with hints.";
}

export function weakSpotReport(events: readonly RecallEvent[], now: number): WeakSpotReport {
	const byTopic = new Map<string, RecallEvent[]>();
	for (const e of events) byTopic.set(e.topicKey, [...(byTopic.get(e.topicKey) ?? []), e]);
	const { topics } = retentionReport(events, now);
	const all = topics
		.map((t) => weakSpotOf(t, byTopic.get(t.key) ?? []))
		.filter((s): s is WeakSpot => s !== null)
		.sort(
			(a, b) =>
				Number(b.spot === "overconfident") - Number(a.spot === "overconfident") ||
				b.score - a.score ||
				a.retention - b.retention ||
				a.key.localeCompare(b.key),
		);
	return {
		now,
		spots: all.slice(0, WEAK_SPOT_LIMIT),
		tracked: topics.length,
		overconfident: all.filter((s) => s.spot === "overconfident").length,
	};
}

/** The one-line headline the view leads with. */
export function weakSpotHeadline(report: WeakSpotReport): string {
	if (report.tracked === 0) return "No tested topics yet.";
	const n = report.spots.length;
	if (n === 0) return `No weak spots: all ${report.tracked} tested ${report.tracked === 1 ? "topic" : "topics"} came back cleanly last time.`;
	const over = report.overconfident;
	const spots = `${n} weak ${n === 1 ? "spot" : "spots"}`;
	if (over === 0) return `${spots}, none of them overconfident.`;
	if (over === n) return `${spots}, and you felt surer than you were right on ${n === 1 ? "it" : n === 2 ? "both" : "all of them"}.`;
	return `${spots}, and you felt surer than you were right on ${over} of them.`;
}
