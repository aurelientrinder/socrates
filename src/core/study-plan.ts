/**
 * THE STUDY PLAN (calendar + measured memory → a day-by-day plan up to
 * each exam). The daily briefing (core/briefing.ts) matches calendar
 * events to topics; this module turns those matches into sessions on
 * days, and today's day becomes the briefing's list. Plain code, like the
 * briefing: the same inputs always give the same plan, and tests pin it.
 *
 * How a plan is made:
 * - every topic linked to an exam or deadline is simulated forward with
 *   the FSRS model (core/retention.ts): it gets a review on the last day
 *   before its predicted recall would fall under TARGET_RETENTION, so it
 *   is still above target on the exam day. Topics with a past lapse or a
 *   recent confident miss are simulated as shaky (Hard), which plans more
 *   reviews — the model leans pessimistic on purpose;
 * - a topic that looks solid but has not been tested for CHECK_STALE_DAYS
 *   gets one quick check in the last week instead of being trusted;
 * - an exam with nothing studied for it gets "learn" sessions spread up to
 *   the day; an exam with studied topics gets one exam rehearsal two days
 *   before (exam-style problems, no hints);
 * - a TOUGH CLASS (a course whose measured recall is low, whose reviews
 *   often lapse, or with a recent confident miss) gets a short prep on the
 *   day of each class this week, on its weakest topics;
 * - topics due with no event attached keep their normal review day;
 * - days are filled inside the daily minute budget and MAX_ITEMS; work
 *   that does not fit rolls to the next day, and work that cannot fit
 *   before its exam is reported, never silently dropped.
 *
 * Adapting: the plan is rebuilt every morning from the latest recall, so a
 * missed answer brings a topic back sooner and a held-up one drops out on
 * its own. planChanges() compares with the last saved plan to say so in
 * plain words (missed sessions, slipped topics, new exams, dropped reviews).
 */

import { GRADE_GOOD, GRADE_HARD, TARGET_RETENTION, nextState, retentionAt, retrievability, type TopicRetention } from "./retention.ts";
import type { BriefingItem, StudyEvent } from "./briefing.ts";
import { sessionTypeOf, type SessionType } from "./session-type.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** How far ahead exams are planned for (deadlines and classes use less). */
export const EXAM_HORIZON_DAYS = 35;
/** Days shown in the week view, and the reach of class prep and plain due reviews. */
export const WEEK_DAYS = 7;
export const MAX_ITEMS = 3;
/** Before an exam, a topic untested this long gets a quick check. */
export const CHECK_STALE_DAYS = 14;
export const ITEM_MINUTES = {
	review: 15,
	check: 10,
	learn: 25,
	rehearse: 30,
	prep: 10,
} as const;
/** "Learn" sessions planned at most per exam with nothing studied yet. */
export const MAX_LEARN_SESSIONS = 6;
/** A course is tough when its mean recall now is under this… */
export const TOUGH_RECALL = 0.8;
/** …or at least this share of its reviews were lapses. */
export const TOUGH_LAPSE_RATE = 0.25;
/** An exam later today still gets a last session when it is at least this far off. */
const SAME_DAY_LEAD_MS = 2 * HOUR_MS;
/** Planned study on a later day is assumed to happen at this local hour. */
const STUDY_HOUR = 10;
/** Topics listed per item (the rest ride along unnamed). */
export const TOPICS_PER_ITEM = 3;

// ─── Days ───────────────────────────────────────────────────────────────────

function startOfDay(t: number): number {
	const d = new Date(t);
	d.setHours(0, 0, 0, 0);
	return d.getTime();
}

/** Calendar days from now's day to t's day (0 = today). */
export function dayIndex(at: number, now: number): number {
	return Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
}

/** Local YYYY-MM-DD of day `d` from today. */
export function dayDate(d: number, now: number): string {
	const t = new Date(startOfDay(now));
	t.setDate(t.getDate() + d);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function dateStart(date: string): number {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(y!, m! - 1, d!).getTime();
}

/** When study on day `d` is assumed to happen: now for today, mid-morning later. */
function studyAt(d: number, now: number): number {
	if (d <= 0) return now;
	const t = new Date(startOfDay(now));
	t.setDate(t.getDate() + d);
	return t.setHours(STUDY_HOUR, 0, 0, 0);
}

/** "today", "tomorrow", "in 4 days", "Mon 3 Nov" past a week. */
export function whenLabel(at: number, now: number): string {
	const days = dayIndex(at, now);
	if (days <= 0) return "today";
	if (days === 1) return "tomorrow";
	if (days < 7) return `in ${days} days`;
	return new Date(at).toLocaleDateString("en-GB", {
		weekday: "short",
		day: "numeric",
		month: "short",
	});
}

/** "Today", "Tomorrow", "Wednesday", then "Mon 3 Nov" — a plan day's heading. */
export function dayLabel(date: string, now: number): string {
	const at = dateStart(date);
	const days = dayIndex(at, now);
	if (days === 0) return "Today";
	if (days === 1) return "Tomorrow";
	if (days === -1) return "Yesterday";
	if (days > 1 && days < 7) return new Date(at).toLocaleDateString("en-GB", { weekday: "long" });
	return new Date(at).toLocaleDateString("en-GB", {
		weekday: "short",
		day: "numeric",
		month: "short",
	});
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** How a class meets, in a plan step's title ("Before the tutorial: …"). */
const SESSION_NOUN: Record<SessionType, string> = { lecture: "the lecture", tutorial: "the tutorial", lab: "the lab" };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** 1 today, 0.5 in 3 days, ~0.18 in two weeks. */
function urgency(daysAway: number): number {
	return 1 / (1 + Math.max(0, daysAway) / 3);
}

// ─── Input / output ─────────────────────────────────────────────────────────

/** An exam or deadline with the topics it covers (matched by the briefing). */
export interface PlanTarget {
	event: StudyEvent;
	kind: "exam" | "deadline";
	/** Course label, or the event title when none. */
	label: string;
	topics: TopicRetention[];
	/** Sessions linked or suggested for its course. */
	chatIds: string[];
	/** The course group's notes. */
	notes?: { id: string; name: string }[];
}

/** A class this week with its course's topics. */
export interface PlanClass {
	event: StudyEvent;
	course: { key: string; label: string };
	topics: TopicRetention[];
	chatIds: string[];
	notes?: { id: string; name: string }[];
}

export interface StudyPlanInput {
	now: number;
	budgetMinutes: number;
	targets: readonly PlanTarget[];
	classes: readonly PlanClass[];
	/** Every tracked topic (the ones with no event keep their due day). */
	topics: readonly TopicRetention[];
	confidentMissChats: ReadonlySet<string>;
}

export interface PlanDay {
	/** Local YYYY-MM-DD. */
	date: string;
	items: BriefingItem[];
	minutes: number;
}

export type ExamPlanStatus = "not-started" | "tight" | "on-track" | "ready";

export interface ExamPlan {
	eventId: string;
	title: string;
	kind: "exam" | "deadline";
	start: number;
	url?: string;
	/** Planned sessions and minutes from today to the day before. */
	sessions: number;
	minutes: number;
	/** Mean predicted recall of its topics on the day: as things stand, and if the plan is followed. */
	readinessNow: number | null;
	readinessPlanned: number | null;
	/** Minutes of planned work that do not fit the daily budget before it. */
	unscheduledMinutes: number;
	status: ExamPlanStatus;
	topicKeys: string[];
}

export interface ToughCourse {
	key: string;
	label: string;
	/** Mean predicted recall now of the course's topics. */
	recall: number;
	/** Lapsed reviews / reviews. */
	lapseRate: number;
	confidentMiss: boolean;
	/** The next class of it this week. */
	nextClass: { eventId: string; title: string; start: number };
	reason: string;
}

export interface StudyPlan {
	/** Today first, then every day up to the last planned exam (at least WEEK_DAYS). */
	days: PlanDay[];
	exams: ExamPlan[];
	tough: ToughCourse[];
	/** Work that cannot fit before its exam at the current budget. */
	unscheduled: BriefingItem[];
}

// ─── Building ───────────────────────────────────────────────────────────────

/** One topic-level piece of work before grouping into sessions. */
interface Task {
	day: number;
	/** Last day it may move to (Infinity = flexible). */
	latest: number;
	action: BriefingItem["action"];
	score: number;
	topic?: TopicRetention;
	target?: PlanTarget;
	klass?: PlanClass;
	/** Recall on the event day without this review (for the reason line). */
	projected?: number;
}

interface Session extends BriefingItem {
	day: number;
	latest: number;
}

/** The last day index (exclusive) work for a target can happen on. */
function studyEnd(target: PlanTarget, now: number): number {
	const d = dayIndex(target.event.start, now);
	if (d <= 0) return target.event.start - now >= SAME_DAY_LEAD_MS ? 1 : 0;
	return d;
}

const weightOf = (t: PlanTarget) => (t.kind === "exam" ? 1 : 0.8);

function courseStats(topics: readonly TopicRetention[], misses: ReadonlySet<string>) {
	const recall = topics.reduce((a, t) => a + t.retention, 0) / Math.max(1, topics.length);
	const reviews = topics.reduce((a, t) => a + t.reviews, 0);
	const lapses = topics.reduce((a, t) => a + t.lapses, 0);
	const lapseRate = reviews > 0 ? lapses / reviews : 0;
	const confidentMiss = topics.some((t) => misses.has(t.chatId));
	const tough = topics.length > 0 && (recall < TOUGH_RECALL || lapseRate >= TOUGH_LAPSE_RATE || confidentMiss);
	return { recall, lapses, reviews, lapseRate, confidentMiss, tough };
}

/**
 * Review days for one topic across every target it belongs to (soonest
 * first): simulate forward and review on day d whenever recall would be
 * under target at the next checkpoint (tomorrow's study, or the exam if
 * that comes first). Returns the tasks and the planned recall at each
 * target.
 */
function simulateTopic(
	topic: TopicRetention,
	targets: readonly PlanTarget[],
	now: number,
	shaky: boolean,
): { tasks: Task[]; planned: Map<string, number>; reviewed: Set<string> } {
	const tasks: Task[] = [];
	const planned = new Map<string, number>();
	const reviewed = new Set<string>();
	let state = { stability: topic.stability, difficulty: topic.difficulty };
	let last = topic.lastReviewedAt;
	const grade = shaky ? GRADE_HARD : GRADE_GOOD;
	const ends = targets.map((t) => studyEnd(t, now));
	const lastDay = Math.max(0, ...ends);
	let ti = 0;
	for (let d = 0; d < lastDay; d++) {
		while (ti < targets.length && ends[ti]! <= d) {
			planned.set(targets[ti]!.event.id, retrievability((targets[ti]!.event.start - last) / DAY_MS, state.stability));
			ti++;
		}
		const target = targets[ti];
		if (!target) break;
		const at = studyAt(d, now);
		const checkpoint = Math.min(studyAt(d + 1, now), target.event.start);
		if (retrievability((checkpoint - last) / DAY_MS, state.stability) >= TARGET_RETENTION) continue;
		const projected = retrievability((target.event.start - last) / DAY_MS, state.stability);
		const gap = Math.max(0, TARGET_RETENTION - projected) / TARGET_RETENTION;
		tasks.push({
			day: d,
			latest: ends[ti]! - 1,
			action: "review",
			score: weightOf(target) * urgency((target.event.start - now) / DAY_MS) * (0.2 + 2 * gap),
			topic,
			target,
			projected,
		});
		reviewed.add(target.event.id);
		state = nextState(state, grade, Math.max(0, (at - last) / DAY_MS));
		last = at;
	}
	for (; ti < targets.length; ti++) {
		planned.set(targets[ti]!.event.id, retrievability((targets[ti]!.event.start - last) / DAY_MS, state.stability));
	}
	return { tasks, planned, reviewed };
}

/** Spread `count` sessions over days [0, end): first today, last the day before. */
function spreadDays(count: number, end: number): number[] {
	if (count <= 1) return [0];
	return Array.from({ length: count }, (_, i) => Math.round((i * (end - 1)) / (count - 1)));
}

export function planStudy(input: StudyPlanInput): StudyPlan {
	const { now, targets, classes, confidentMissChats: misses } = input;
	const tasks: Task[] = [];
	const sortedTargets = [...targets].sort((a, b) => a.event.start - b.event.start);

	// Topic → the targets it counts for, soonest first.
	const byTopic = new Map<string, { topic: TopicRetention; targets: PlanTarget[] }>();
	for (const target of sortedTargets) {
		for (const topic of target.topics) {
			const entry = byTopic.get(topic.key) ?? { topic, targets: [] };
			entry.targets.push(target);
			byTopic.set(topic.key, entry);
		}
	}

	const plannedRecall = new Map<string, number[]>();
	for (const { topic, targets: ts } of byTopic.values()) {
		const shaky = topic.lapses > 0 || misses.has(topic.chatId);
		const sim = simulateTopic(topic, ts, now, shaky);
		tasks.push(...sim.tasks);
		for (const [eventId, r] of sim.planned) plannedRecall.set(eventId, [...(plannedRecall.get(eventId) ?? []), r]);
		// Solid on paper but untested for a while: one quick check in the last week.
		const first = ts.find((t) => studyEnd(t, now) > 0 && !sim.reviewed.has(t.event.id));
		if (first && !sim.tasks.some((k) => k.target === first)) {
			const end = studyEnd(first, now);
			const day = Math.max(0, end - WEEK_DAYS);
			if (studyAt(day, now) - topic.lastReviewedAt > CHECK_STALE_DAYS * DAY_MS) {
				tasks.push({
					day,
					latest: end - 1,
					action: "check",
					score: weightOf(first) * urgency((first.event.start - now) / DAY_MS) * 0.4,
					topic,
					target: first,
				});
			}
		}
	}

	for (const target of sortedTargets) {
		const end = studyEnd(target, now);
		if (end === 0) continue;
		const daysAway = (target.event.start - now) / DAY_MS;
		if (target.topics.length === 0 && target.chatIds.length === 0) {
			// Nothing studied for it in Socrates: start now and keep going.
			const count = end <= 3 ? end : Math.min(MAX_LEARN_SESSIONS, Math.ceil(end / 2));
			for (const day of spreadDays(count, end)) {
				tasks.push({
					day,
					latest: end - 1,
					action: "learn",
					score: weightOf(target) * urgency(daysAway) * 1.5,
					target,
				});
			}
		} else if (target.topics.length === 0) {
			// Sessions exist but nothing has been measured: find out where it stands.
			tasks.push({
				day: 0,
				latest: end - 1,
				action: "check",
				score: weightOf(target) * urgency(daysAway) * 1.2,
				target,
			});
		} else if (target.kind === "exam" && end >= 3) {
			tasks.push({
				day: end - 2,
				latest: end - 1,
				action: "rehearse",
				score: urgency(daysAway) * 1.2,
				target,
			});
		}
	}

	// Tough classes: a short prep on the day of each class this week.
	const tough: ToughCourse[] = [];
	const prepped = new Set<string>();
	for (const klass of [...classes].sort((a, b) => a.event.start - b.event.start)) {
		if (klass.event.start <= now || klass.topics.length === 0) continue;
		const day = dayIndex(klass.event.start, now);
		if (day >= WEEK_DAYS) continue;
		const stats = courseStats(klass.topics, misses);
		if (!stats.tough) continue;
		const key = klass.course.key || klass.event.title;
		if (!tough.some((t) => t.key === key)) {
			const why = [`recall averages ${pct(stats.recall)}`];
			if (stats.lapses > 0) why.push(`${stats.lapses} of ${plural(stats.reviews, "review")} slipped`);
			if (stats.confidentMiss) why.push("you recently missed a question here while feeling sure");
			tough.push({
				key,
				label: klass.course.label || klass.event.title,
				recall: stats.recall,
				lapseRate: stats.lapseRate,
				confidentMiss: stats.confidentMiss,
				nextClass: {
					eventId: klass.event.id,
					title: klass.event.title,
					start: klass.event.start,
				},
				reason: `${why.join(", ")}.`,
			});
		}
		if (prepped.has(`${key}:${day}`)) continue;
		prepped.add(`${key}:${day}`);
		tasks.push({
			day,
			latest: day,
			action: "prep",
			score: 0.6 + (1 - stats.recall),
			klass,
		});
	}

	// Topics with no event keep their own review day.
	for (const topic of input.topics) {
		if (byTopic.has(topic.key)) continue;
		const day = topic.due ? 0 : dayIndex(topic.dueAt, now);
		if (day >= WEEK_DAYS) continue;
		const r = day === 0 ? topic.retention : retentionAt(topic, studyAt(day, now));
		tasks.push({
			day,
			latest: Infinity,
			action: "review",
			score: 0.25 * Math.max(0, TARGET_RETENTION - r) + (misses.has(topic.chatId) ? 0.3 : 0),
			topic,
		});
	}

	const sessions = groupSessions(tasks, now, misses);
	const { days, unscheduled } = fillDays(sessions, input.budgetMinutes, now);

	const exams: ExamPlan[] = sortedTargets.map((target) => {
		const placed = days.flatMap((d) => d.items).filter((i) => i.eventId === target.event.id);
		const left = unscheduled.filter((i) => i.eventId === target.event.id);
		const readinessNow =
			target.topics.length > 0 ? target.topics.reduce((a, t) => a + retentionAt(t, target.event.start), 0) / target.topics.length : null;
		const planned = plannedRecall.get(target.event.id);
		const readinessPlanned = planned && planned.length > 0 ? planned.reduce((a, b) => a + b, 0) / planned.length : null;
		const unscheduledMinutes = left.reduce((a, i) => a + i.minutes, 0);
		const status: ExamPlanStatus =
			target.topics.length === 0 && target.chatIds.length === 0
				? "not-started"
				: unscheduledMinutes > 0
					? "tight"
					: placed.length === 0 && readinessNow !== null && readinessNow >= TARGET_RETENTION
						? "ready"
						: "on-track";
		return {
			eventId: target.event.id,
			title: target.event.title,
			kind: target.kind,
			start: target.event.start,
			...(target.event.url ? { url: target.event.url } : {}),
			sessions: placed.length,
			minutes: placed.reduce((a, i) => a + i.minutes, 0),
			readinessNow,
			readinessPlanned,
			unscheduledMinutes,
			status,
			topicKeys: target.topics.map((t) => t.key),
		};
	});

	return { days, exams, tough, unscheduled };
}

/** Topic tasks → sessions: one per day, action, session and event. */
function groupSessions(tasks: readonly Task[], now: number, misses: ReadonlySet<string>): Session[] {
	const groups = new Map<string, Task[]>();
	for (const task of tasks) {
		const anchor = task.topic?.chatId ?? task.target?.event.id ?? task.klass?.event.id ?? "";
		const event = task.target?.event.id ?? task.klass?.event.id ?? "due";
		const key = `${task.action}:${anchor}:${event}:${dayDate(task.day, now)}`;
		groups.set(key, [...(groups.get(key) ?? []), task]);
	}

	// A topic reviewed for an exam that day is not also prepped for a class.
	const reviewedOn = new Set<string>();
	for (const task of tasks) if (task.action === "review" && task.topic && task.target) reviewedOn.add(`${task.day}:${task.topic.key}`);

	const out: Session[] = [];
	for (const [id, group] of groups) {
		const task = group[0]!;
		const score = Math.max(...group.map((t) => t.score));
		const latest = Math.min(...group.map((t) => t.latest));
		const base = { id, day: task.day, latest, score };
		const target = task.target;
		const when = target ? `${target.event.title} is ${whenLabel(target.event.start, now)}` : "";
		const notes = target?.notes ?? task.klass?.notes ?? [];
		const material = notes.length > 0 ? { noteIds: notes.map((n) => n.id), noteNames: notes.map((n) => n.name) } : {};
		const event = target
			? {
					eventId: target.event.id,
					eventTitle: target.event.title,
					eventStart: target.event.start,
					...material,
				}
			: material;
		const topics = group.flatMap((t) => (t.topic ? [t.topic] : []));
		const at = target ? target.event.start : studyAt(task.day, now);
		topics.sort((a, b) => retentionAt(a, at) - retentionAt(b, at));
		const named = topics.slice(0, TOPICS_PER_ITEM).map((t) => t.title);
		const list = `${named.join(", ")}${topics.length > named.length ? ` +${topics.length - named.length}` : ""}`;
		const first = topics[0];
		const miss = first && misses.has(first.chatId) ? " You recently missed a question here while feeling sure." : "";
		const home = first ? { chatId: first.chatId, chatTitle: first.chatTitle } : {};
		const keys = {
			topicKeys: topics.map((t) => t.key),
			topicTitles: topics.map((t) => t.title),
		};

		switch (task.action) {
			case "review": {
				const worst = Math.min(...group.map((t) => t.projected ?? 1));
				out.push({
					...base,
					...home,
					...keys,
					...event,
					action: "review",
					title: `Review ${list}`,
					reason: target
						? `${when}. Recall on the day would be about ${pct(worst)} without a review.${miss}`
						: `Recall has dropped to ${pct(Math.min(...topics.map((t) => retentionAt(t, at))))}.${miss}`,
					minutes: ITEM_MINUTES.review,
				});
				break;
			}
			case "check":
				out.push({
					...base,
					...home,
					...keys,
					...event,
					action: "check",
					title: topics.length > 0 ? `Quick check: ${list}` : `Quick check: ${target!.label}`,
					reason:
						topics.length > 0
							? `${when}. Not tested for over ${CHECK_STALE_DAYS} days, so a short check before trusting it.${miss}`
							: `${when}. You have sessions for it but nothing measured yet, so find out where you stand.`,
					minutes: ITEM_MINUTES.check,
					...(topics.length === 0 && target!.chatIds[0] ? { chatId: target!.chatIds[0] } : {}),
				});
				break;
			case "learn":
				out.push({
					...base,
					...keys,
					...event,
					action: "learn",
					title: `Start on ${target!.label}`,
					reason:
						notes.length > 0
							? `${when} and nothing has been studied for it here yet. The tutor works from your ${plural(notes.length, "course file")}.`
							: `${when} and nothing has been studied for it here yet.`,
					minutes: ITEM_MINUTES.learn,
				});
				break;
			case "rehearse": {
				const all = target!.topics;
				const chat = mostCommon(all.map((t) => t.chatId));
				out.push({
					...base,
					...event,
					action: "rehearse",
					title: `Exam rehearsal: ${target!.label}`,
					reason: `${when}. Exam-style problems from memory, no hints, to see what holds up before the day.`,
					minutes: ITEM_MINUTES.rehearse,
					chatId: chat,
					chatTitle: all.find((t) => t.chatId === chat)?.chatTitle,
					topicKeys: all.map((t) => t.key),
					topicTitles: all.map((t) => t.title),
				});
				break;
			}
			case "prep": {
				const klass = task.klass!;
				const course = klass.topics
					.filter((t) => !reviewedOn.has(`${task.day}:${t.key}`))
					.sort((a, b) => retentionAt(a, klass.event.start) - retentionAt(b, klass.event.start))
					.slice(0, TOPICS_PER_ITEM);
				if (course.length === 0) break;
				const stats = courseStats(klass.topics, misses);
				const session = sessionTypeOf(klass.event.title);
				const time = klass.event.allDay
					? ""
					: ` at ${new Date(klass.event.start).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
				out.push({
					...base,
					action: "prep",
					title: `Before ${session ? SESSION_NOUN[session] : "class"}: ${course.map((t) => t.title).join(", ")}`,
					reason: `${klass.event.title} is ${whenLabel(klass.event.start, now)}${time}. ${klass.course.label || "This course"} is a tough one: recall averages ${pct(stats.recall)}${stats.lapses > 0 ? `, ${stats.lapses} of ${plural(stats.reviews, "review")} slipped` : ""}.`,
					minutes: ITEM_MINUTES.prep,
					chatId: course[0]!.chatId,
					chatTitle: course[0]!.chatTitle,
					topicKeys: course.map((t) => t.key),
					topicTitles: course.map((t) => t.title),
					eventId: klass.event.id,
					eventTitle: klass.event.title,
					eventStart: klass.event.start,
					...(session ? { session } : {}),
					...material,
				});
				break;
			}
		}
	}
	return out;
}

function mostCommon(values: readonly string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/**
 * Sessions onto days: each day takes what is planned for it plus what
 * rolled over, work that must happen that day first, then the highest
 * score, until MAX_ITEMS or the budget (the first item always fits). What
 * cannot move past its last day is unscheduled.
 */
function fillDays(sessions: readonly Session[], budget: number, now: number): { days: PlanDay[]; unscheduled: BriefingItem[] } {
	const finite = sessions.map((s) => s.latest).filter((l) => Number.isFinite(l));
	const lastDay = Math.max(WEEK_DAYS - 1, ...finite, ...sessions.filter((s) => Number.isFinite(s.latest)).map((s) => s.day));
	const days: PlanDay[] = [];
	const unscheduled: BriefingItem[] = [];
	const strip = ({ day: _day, latest: _latest, ...item }: Session): BriefingItem => ({
		...item,
		score: Math.round(item.score * 1000) / 1000,
	});
	let pool: Session[] = [];
	for (let d = 0; d <= lastDay; d++) {
		pool.push(...sessions.filter((s) => s.day === d));
		pool.sort((a, b) => Number(b.latest <= d) - Number(a.latest <= d) || b.score - a.score || a.id.localeCompare(b.id));
		const items: BriefingItem[] = [];
		const rest: Session[] = [];
		let used = 0;
		const covered = new Set<string>();
		for (const s of pool) {
			// A session whose topics another one that day already covers (a due
			// review that rolled onto a class prep) is done with it.
			if (s.topicKeys.length > 0 && s.topicKeys.every((k) => covered.has(k))) continue;
			if (items.length < MAX_ITEMS && (items.length === 0 || used + s.minutes <= budget)) {
				items.push(strip(s));
				used += s.minutes;
				for (const k of s.topicKeys) covered.add(k);
			} else if (s.latest <= d) {
				unscheduled.push(strip(s));
			} else {
				rest.push(s);
			}
		}
		pool = rest;
		days.push({ date: dayDate(d, now), items, minutes: used });
	}
	return { days, unscheduled };
}

// ─── Adapting ───────────────────────────────────────────────────────────────

/** What is kept of each day's plan, to compare with the next one. */
export interface PlanSnapshot {
	/** The briefing day it was made on (YYYY-MM-DD). */
	day: string;
	sessions: {
		id: string;
		date: string;
		action: BriefingItem["action"];
		title: string;
		topicKeys: string[];
		eventId?: string;
	}[];
	/** Lapses per topic when it was made. */
	lapses: Record<string, number>;
	exams: string[];
}

export function planSnapshot(day: string, plan: StudyPlan, topics: readonly TopicRetention[]): PlanSnapshot {
	return {
		day,
		sessions: plan.days.slice(0, WEEK_DAYS).flatMap((d) =>
			d.items.map((i) => ({
				id: i.id,
				date: d.date,
				action: i.action,
				title: i.title,
				topicKeys: i.topicKeys,
				...(i.eventId ? { eventId: i.eventId } : {}),
			})),
		),
		lapses: Object.fromEntries(topics.map((t) => [t.key, t.lapses])),
		exams: plan.exams.filter((e) => e.kind === "exam").map((e) => e.eventId),
	};
}

/**
 * Plain-words changes since the last plan (most useful first, at most four):
 * planned days that passed (done or not), topics that slipped in a review
 * since, new exams on the calendar, and reviews no longer needed.
 */
export function planChanges(
	prev: PlanSnapshot | null | undefined,
	plan: StudyPlan,
	topics: readonly TopicRetention[],
	now: number,
): string[] {
	if (!prev) return [];
	const today = plan.days[0]?.date ?? dayDate(0, now);
	const byKey = new Map(topics.map((t) => [t.key, t]));
	const exams = new Map(plan.exams.map((e) => [e.eventId, e]));
	const out: string[] = [];

	// Planned days that have passed.
	const past = prev.sessions.filter((s) => s.date < today && s.date >= prev.day);
	if (past.length > 0) {
		const isDone = (s: PlanSnapshot["sessions"][number]) => {
			const from = dateStart(s.date);
			const keys = s.topicKeys.length > 0 ? s.topicKeys : s.eventId ? (exams.get(s.eventId)?.topicKeys ?? []) : [];
			return keys.some((k) => (byKey.get(k)?.lastReviewedAt ?? 0) >= from);
		};
		const done = past.filter(isDone).length;
		const missed = past.length - done;
		const since = dayLabel(past[0]!.date, now).toLowerCase();
		if (missed === 0) out.push(done === 1 ? `You did the planned session since ${since}.` : `You did all ${done} planned sessions since ${since}.`);
		else if (done > 0)
			out.push(`You did ${done} of ${past.length} planned sessions since ${since}; the rest ${missed === 1 ? "is" : "are"} spread over the coming days.`);
		else
			out.push(
				`${missed === 1 ? "The planned session" : `The ${missed} planned sessions`} since ${since} ${missed === 1 ? "was" : "were"} not done, so the plan spreads ${missed === 1 ? "it" : "them"} over the coming days.`,
			);
	}

	// Topics that lapsed since: they come back sooner.
	const upcoming = plan.days.flatMap((d) => d.items.map((i) => ({ date: d.date, item: i })));
	let slipped = 0;
	for (const t of topics) {
		if (slipped >= 2) break;
		const before = prev.lapses[t.key];
		if (before === undefined || t.lapses <= before) continue;
		const next = upcoming.find((u) => u.item.topicKeys.includes(t.key));
		if (!next) continue;
		slipped++;
		out.push(`${t.title} slipped in your last check, so it comes back ${dayLabel(next.date, now).toLowerCase()}.`);
	}

	// New exams.
	for (const exam of plan.exams) {
		if (exam.kind !== "exam" || prev.exams.includes(exam.eventId)) continue;
		out.push(
			`New on your calendar: ${exam.title} (${whenLabel(exam.start, now)}). ${exam.sessions > 0 ? `${plural(exam.sessions, "session")} planned for it.` : "Nothing needed for it yet."}`,
		);
	}

	// Reviews planned before that are no longer needed because answers held up.
	const planned = new Set(upcoming.flatMap((u) => u.item.topicKeys));
	const dropped = prev.sessions.filter(
		(s) =>
			s.date >= today &&
			s.action === "review" &&
			s.topicKeys.length > 0 &&
			s.topicKeys.every((k) => {
				const t = byKey.get(k);
				return t && !planned.has(k) && t.lapses <= (prev.lapses[k] ?? t.lapses) && t.lastReviewedAt >= dateStart(prev.day);
			}),
	).length;
	if (dropped > 0) out.push(`${plural(dropped, "review")} dropped from the plan because your answers held up.`);

	return out.slice(0, 4);
}
