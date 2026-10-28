import { abortExtraction, extractionStatuses } from "../agent/subagents/extraction.ts";
import { coverageOf } from "../core/coverage.ts";
import { deleteChatTraces, type ChatDeleteMode, type ChatDeletionStats } from "../core/graph-deletion.ts";
import { titleFromPrompt } from "../core/contracts.ts";
import { calibrationAnswers, calibrationReport, type CalibrationReport } from "../core/calibration.ts";
import { propositionNames, recallEvents, retentionReport, type RecallEvent, type RetentionReport } from "../core/retention.ts";
import { weakSpotReport, type WeakSpotReport } from "../core/weak-spots.ts";
import { STREAK_LOOKBACK_DAYS, daysBackStart, studyMinutesByDay, studyStreak, weekStartOf, type StudyStreak } from "../core/study-time.ts";
import { examCalibrationAnswers, examRecallEvents } from "../core/exam.ts";
import { chatDigests, forgetChatDigest } from "./chat-digests.ts";
import { examStore } from "../store/exams.ts";
import { flashcardStore } from "../store/flashcards.ts";
import { graphRevision } from "./graph.ts";
import { stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/**
 * Server-side chat entries for the transport layer (app/api/chats*,
 * app/chat/[id]). Today these delegate straight to the ChatStore port; the
 * services stage carves the real orchestration behind this same surface.
 *
 * deleteChatSession (wave 6, session deletion — the FIRST destructive
 * operation on the graph ledgers) is the one real orchestration here:
 * gates → extraction wind-down → one synchronous deletion block. See
 * core/graph-deletion.ts for the ledger semantics and the atomicity
 * argument.
 */

export const { createChat, getChat, listChats } = stores.chatStore;
export { titleFromPrompt };
export type { ChatDeleteMode, ChatDeletionStats } from "../core/graph-deletion.ts";

/** How long the wind-down wait may take before the caller gets a retryable
 *  503 (an aborted extraction ends at its next model-call boundary —
 *  provider cancellation is normally sub-second, but a wedged provider
 *  must never wedge deletion). */
const WIND_DOWN_TIMEOUT_MS = 10_000;
const WIND_DOWN_POLL_MS = 50;

/** What deleteChatSession did — the route maps it straight to HTTP. */
export type ChatDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "turn_in_flight" | "jobs_running"; error: string; jobIds: string[] }
	| { ok: false; status: 503; code: "extraction_winding_down"; error: string }
	| {
			ok: true;
			mode: ChatDeleteMode;
			stats: ChatDeletionStats;
			jobsRemoved: number;
			graphRevision: number;
	  };

/**
 * Delete a session (owner rulings 2026-09-22/23): gates first, then the
 * purge. The owner-locked choreography:
 *
 *   1. GATES — a turn in flight or a running background job refuses with
 *      409 (they write the chat record and steer into it; deleting
 *      mid-flight would corrupt the write-ahead flow). The UI retries once
 *      work drains.
 *   2. EXTRACTION WIND-DOWN — the chat's own pipeline run is TRUE-
 *      CANCELLED (abortExtraction: spend stops, nothing merges), then
 *      awaited off the registry. A timeout is a retryable 503, never a
 *      forced race.
 *   3. THE SYNC BLOCK — everything below runs without a single await:
 *      no extraction append can interleave (the event loop never yields
 *      mid-block), so the read-filter-write of the ledger rewrites is
 *      atomic against the pipeline. Ledgers first, jobs next, the chat
 *      record LAST (a crash mid-block leaves a deletable chat with a
 *      purged graph — re-running DELETE fixes it — never a deleted chat
 *      with live traces). The pipeline's per-batch liveness guard
 *      (extraction.ts) closes the last window: a run that slipped past
 *      the wind-down finds the chat gone at its merge and aborts with
 *      nothing merged.
 */
export async function deleteChatSession(chatId: string, mode: ChatDeleteMode): Promise<ChatDeleteOutcome> {
	if (!stores.chatStore.getChat(chatId)) {
		return { ok: false, status: 404, code: "not_found", error: "No such session" };
	}
	if (isTurnRunning(chatId)) {
		return {
			ok: false,
			status: 409,
			code: "turn_in_flight",
			error: "A turn is running in this session — try again when it finishes",
			jobIds: [],
		};
	}
	const runningJobs = stores.jobStore.listJobs(chatId).filter((job) => job.status === "running");
	if (runningJobs.length > 0) {
		return {
			ok: false,
			status: 409,
			code: "jobs_running",
			error: "Background jobs are still running in this session — try again when they finish",
			jobIds: runningJobs.map((job) => job.id),
		};
	}
	if (extractionStatuses().some((run) => run.chatId === chatId)) {
		abortExtraction(chatId); // true cancellation — spend stops, nothing merges
		const deadline = Date.now() + WIND_DOWN_TIMEOUT_MS;
		while (extractionStatuses().some((run) => run.chatId === chatId)) {
			if (Date.now() > deadline) {
				return {
					ok: false,
					status: 503,
					code: "extraction_winding_down",
					error: "The session's extraction is still winding down — try again in a moment",
				};
			}
			await new Promise((resolve) => setTimeout(resolve, WIND_DOWN_POLL_MS));
		}
	}

	// THE SYNC BLOCK — no awaits below (see the doc comment). Order:
	// ledgers → jobs → the chat record.
	const stats = deleteChatTraces(stores.graphStore, chatId, mode);
	const jobsRemoved = stores.jobStore.deleteJobsForChat(chatId);
	stores.chatStore.deleteChat(chatId);
	// "preserve-graph" keeps what the session proved about the learner's
	// memory (see chat-digests.ts); erasing the topics erases it too.
	if (mode === "delete-nodes") forgetChatDigest(chatId);
	return { ok: true, mode, stats, jobsRemoved, graphRevision: graphRevision() };
}

/** One session's coverage read (extraction-UX redesign, owner dispatch
 *  2026-09-24): the chat view's ring meter + popover data, scoped to one
 *  chat (the all-sessions GET died with this redesign — nothing consumed
 *  it once the sidebar and ring read here; the Extract POST stays).
 *  Uncovered stays DERIVED per request (fingerprint the transcript,
 *  diff the coverage ledger — never dual-tracked).
 *
 *  lastFoldedAt: the newest coverage row's fold timestamp — a cheap single
 *  pass over the chat's ledger rows (the ring popover's "last extraction"
 *  line); null before the session's first fold. */
export interface SessionCoverage {
	totalMessages: number;
	coveredCount: number;
	uncoveredCount: number;
	coveredTokens: number;
	uncoveredTokens: number;
	/** True while a chat-kind extraction run is registered for this session. */
	running: boolean;
	/** ISO of the newest fold in this session's coverage rows; null before any. */
	lastFoldedAt: string | null;
}

/** The per-session coverage block (see SessionCoverage). Null when the
 *  chat doesn't exist — callers own the 404. */
export function sessionCoverage(chatId: string): SessionCoverage | null {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return null;
	const entries = stores.graphStore.readCoverage();
	// Wave B: the record is native history — coverage reads through the
	// projection (same view the extraction pipeline folds).
	const cov = coverageOf(record.messages, entries, chatId);
	let lastFoldedAt: string | null = null;
	for (const entry of entries) {
		if (entry.chatId !== chatId) continue;
		if (lastFoldedAt === null || entry.foldedAt > lastFoldedAt) lastFoldedAt = entry.foldedAt;
	}
	return {
		totalMessages: cov.slots.length,
		coveredCount: cov.coveredCount,
		uncoveredCount: cov.uncoveredCount,
		coveredTokens: cov.coveredTokens,
		uncoveredTokens: cov.uncoveredTokens,
		running: extractionStatuses().some((run) => run.kind === "chat" && run.chatId === chatId),
		lastFoldedAt,
	};
}

/** The calibration view's report: every session's graded quiz answers
 *  and every rated mock-exam part, folded into stated confidence vs
 *  actual accuracy. */
export function calibrationAcrossSessions(): CalibrationReport {
	const answers = chatDigests().flatMap((d) => d.calibration);
	return calibrationReport([...answers, ...examStore.list().flatMap(examCalibrationAnswers)]);
}

/** Today's "This week" (minutes studied each day of the current week,
 *  Monday first) and the study streak, from one read of the sessions active
 *  since the earlier of the week's start and the streak's lookback. */
export function studyRecord(now: Date = new Date()): { week: number[]; streak: StudyStreak } {
	const weekStart = weekStartOf(now);
	const streakStart = daysBackStart(now, STREAK_LOOKBACK_DAYS);
	const since = Math.min(weekStart.getTime(), streakStart.getTime());
	const sessions = chatDigests()
		.map((d) => d.stamps.filter((t) => t >= since))
		.filter((stamps) => stamps.length > 0);
	// Flashcard rounds (one deck = one session of answer times) and mock
	// exam sittings count as study too, not only chat messages.
	for (const deck of flashcardStore.list()) {
		const stamps = deck.cards.flatMap((c) => c.reviews.map((r) => r.at)).filter((t) => t >= since);
		if (stamps.length > 0) sessions.push(stamps);
	}
	const spans = examStore.list().flatMap((e): [number, number][] => {
		const from = e.startedAt ? Date.parse(e.startedAt) : NaN;
		const to = e.submittedAt ? Date.parse(e.submittedAt) : NaN;
		return from >= since && to > from ? [[from, to]] : [];
	});
	return {
		week: studyMinutesByDay(sessions, weekStart, 7, spans),
		streak: studyStreak(studyMinutesByDay(sessions, streakStart, STREAK_LOOKBACK_DAYS, spans)),
	};
}

/** The review view's report: every tested recall across sessions, folded
 *  into per-topic memory state, estimated retention, and what is due. */
export function retentionAcrossSessions(now: number = Date.now()): RetentionReport {
	return retentionReport(recallEventsAcrossSessions(), now);
}

/** The weak-spot tab's report: the same recalls, read per topic for
 *  overconfidence (stated confidence vs right) as well as fading. */
export function weakSpotsAcrossSessions(now: number = Date.now()): WeakSpotReport {
	return weakSpotReport(recallEventsAcrossSessions(), now);
}

function recallEventsAcrossSessions(): RecallEvent[] {
	const names = propositionNames(stores.graphStore.readNodes());
	const events = chatDigests().flatMap((d) =>
		// Practice targets are named by the graph, which can be renamed
		// after the digest was written.
		d.events.map((e) => (e.kind === "proposition" && !e.review && names.has(e.topicId) ? { ...e, title: names.get(e.topicId)! } : e)),
	);
	// Graded mock exams test topics too (as reviews: core/exam.ts).
	return [...events, ...examStore.list().flatMap(examRecallEvents)];
}
