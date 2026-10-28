/**
 * THE DAILY BRIEFING (src/core/briefing.ts), its providers' parsers
 * (src/server/integrations/), and its view (components/today-view.tsx):
 *
 * - events classify as exam / deadline / class from their titles (EN + FR);
 * - course keys survive lecture numbers and subtitles;
 * - ranking projects recall to the exam day, so an exam soon on a fading
 *   topic beats a far one, and a confident miss boosts its session;
 * - an exam with nothing studied for it becomes a "learn" item;
 * - a topic that still looks solid but is stale before an exam gets a check;
 * - the plan never exceeds MAX_ITEMS or (after the first item) the budget;
 * - free slots skip busy time and stay inside waking hours;
 * - Google and Todoist payloads map to study events;
 * - the view renders items, readiness and the connection prompts.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import {
	MAX_ITEMS,
	briefingDay,
	classifyEvent,
	courseOf,
	fallbackNote,
	findFreeSlot,
	planBriefing,
	quickPrompt,
	startPrompt,
	suggestSessions,
	type BriefingInput,
	type StudyEvent,
} from "../src/core/briefing.ts";
import type { TopicRetention } from "../src/core/retention.ts";
import { validateKeyShape } from "../src/core/auth-keys.ts";
import { toStudyEvent } from "../src/server/integrations/google-calendar.ts";
import { todoistDueAt, todoistToStudyEvent } from "../src/server/integrations/todoist.ts";
import { TodayShell, formatStudyTotal, streakMessage, type BriefingData, type IntegrationsData } from "../components/today-view.tsx";

const DAY = 24 * 60 * 60 * 1000;
// A Monday, 09:00 local.
const NOW = new Date(2026, 9, 26, 9, 0, 0).getTime();

function topic(over: Partial<TopicRetention> & { key: string; title: string; chatId: string }): TopicRetention {
	return {
		kind: "plan",
		chatTitle: "Linear algebra",
		answers: 3,
		reviews: 2,
		lapses: 0,
		lastReviewedAt: NOW - 2 * DAY,
		lastGrade: 3,
		stability: 10,
		difficulty: 5,
		retention: 0.95,
		dueAt: NOW + 8 * DAY,
		due: false,
		...over,
	};
}

function event(over: Partial<StudyEvent> & { id: string; title: string; start: number }): StudyEvent {
	return { end: over.start + 2 * 60 * 60 * 1000, allDay: false, source: "calendar", ...over };
}

function input(over: Partial<BriefingInput>): BriefingInput {
	return { now: NOW, events: [], topics: [], sessions: [], links: {}, confidentMissChats: new Set(), ...over };
}

describe("classifyEvent", () => {
	it("reads exams, deadlines and classes in English and French", () => {
		assert.equal(classifyEvent("Linear Algebra Midterm"), "exam");
		assert.equal(classifyEvent("Partiel de physique"), "exam");
		assert.equal(classifyEvent("Physics lab report due"), "deadline");
		assert.equal(classifyEvent("Projet de programmation : rendu"), "deadline");
		assert.equal(classifyEvent("MATH201 Lecture 7"), "class");
		assert.equal(classifyEvent("TD analyse"), "class");
		assert.equal(classifyEvent("Dentist"), "other");
	});

	it("exam beats class, and an undated cue on a to-do still reads as due", () => {
		assert.equal(classifyEvent("Final exam (lecture hall B)"), "exam");
		assert.equal(classifyEvent("Read chapter 4", "todo"), "deadline");
	});
});

describe("courseOf", () => {
	it("prefers a course code", () => {
		assert.deepEqual(courseOf("MATH201 Lecture 7: Eigenvalues"), { key: "math201", label: "MATH201" });
		assert.equal(courseOf("Exam MATH 201").key, "math201");
	});

	it("strips kind words, numbers and subtitles", () => {
		assert.equal(courseOf("Linear Algebra - Lecture 7: Eigenvalues").key, "linear algebra");
		assert.equal(courseOf("Linear Algebra Exam").key, "linear algebra");
	});

	it("suggests sessions sharing a meaningful word", () => {
		const sessions = [
			{ id: "a", title: "Eigenvalues and linear maps" },
			{ id: "b", title: "French history" },
		];
		assert.deepEqual(suggestSessions("Linear Algebra", sessions), ["a"]);
	});
});

describe("planBriefing", () => {
	const sessions = [
		{ id: "la", title: "Linear algebra basics" },
		{ id: "ph", title: "Physics: waves" },
	];
	const eigen = topic({ key: "plan:la:eigen", title: "Eigenvalues", chatId: "la", stability: 3, lastReviewedAt: NOW - 3 * DAY });
	const solid = topic({ key: "plan:la:det", title: "Determinants", chatId: "la", stability: 200, lastReviewedAt: NOW - DAY });
	const waves = topic({ key: "plan:ph:waves", title: "Standing waves", chatId: "ph", chatTitle: "Physics: waves", stability: 3, lastReviewedAt: NOW - 3 * DAY });

	it("ranks a near exam on a fading topic first and leaves solid topics out", () => {
		const plan = planBriefing(
			input({
				sessions,
				topics: [eigen, solid, waves],
				events: [
					event({ id: "e1", title: "Linear Algebra Exam", start: NOW + 3 * DAY }),
					event({ id: "e2", title: "Physics exam", start: NOW + 12 * DAY }),
				],
			}),
		);
		assert.equal(plan.items[0]!.eventId, "e1");
		assert.equal(plan.items[0]!.action, "review");
		assert.deepEqual(plan.items[0]!.topicTitles, ["Eigenvalues"], "a topic still solid on the day is not listed");
		assert.match(plan.items[0]!.reason, /Linear Algebra Exam is in 3 days/);
		assert.ok(plan.items.some((i) => i.eventId === "e2"));
		const la = plan.upcoming.find((u) => u.event.id === "e1")!;
		assert.ok(la.readiness !== null && la.readiness < 1 && la.topicCount === 2, "the mean over both linked topics");
	});

	it("an exam with nothing studied becomes a learn item", () => {
		const plan = planBriefing(input({ sessions, topics: [eigen], events: [event({ id: "c", title: "Chemistry partiel", start: NOW + 2 * DAY })] }));
		assert.equal(plan.items[0]!.action, "learn");
		assert.match(plan.items[0]!.reason, /nothing has been studied/);
		assert.equal(plan.upcoming[0]!.readiness, null);
	});

	it("a solid but stale topic gets a quick check before a near exam", () => {
		const stale = topic({ key: "plan:la:rank", title: "Rank", chatId: "la", stability: 400, lastReviewedAt: NOW - 20 * DAY });
		const plan = planBriefing(input({ sessions, topics: [stale], events: [event({ id: "e1", title: "Linear Algebra Exam", start: NOW + 4 * DAY })] }));
		assert.equal(plan.items[0]!.action, "check");
	});

	it("a confident miss lifts its session above an otherwise equal one", () => {
		const a = topic({ key: "plan:la:x", title: "X", chatId: "la", due: true, retention: 0.8 });
		const b = topic({ key: "plan:ph:y", title: "Y", chatId: "ph", due: true, retention: 0.8 });
		const plan = planBriefing(input({ sessions, topics: [a, b], confidentMissChats: new Set(["ph"]) }));
		assert.equal(plan.items[0]!.chatId, "ph");
	});

	it("confirmed links override word matching", () => {
		const plan = planBriefing(
			input({
				sessions,
				topics: [eigen, waves],
				links: { "linear algebra": { label: "Linear Algebra", chatIds: ["ph"] } },
				events: [event({ id: "e1", title: "Linear Algebra Exam", start: NOW + 3 * DAY })],
			}),
		);
		assert.deepEqual(plan.items[0]!.topicTitles, ["Standing waves"]);
		assert.equal(plan.upcoming[0]!.linked, true);
	});

	it("never exceeds MAX_ITEMS and respects the budget after the first item", () => {
		const topics = Array.from({ length: 8 }, (_, i) => topic({ key: `plan:c${i}:t`, title: `T${i}`, chatId: `c${i}`, due: true, retention: 0.5 }));
		assert.equal(planBriefing(input({ topics })).items.length, MAX_ITEMS);
		const tight = planBriefing(input({ topics, budgetMinutes: 15 }));
		assert.equal(tight.items.length, 1);
	});

	it("lists today's classes and ignores past events", () => {
		const plan = planBriefing(
			input({
				sessions,
				events: [
					event({ id: "k1", title: "Physics lecture", start: NOW + 2 * 60 * 60 * 1000 }),
					event({ id: "old", title: "Physics exam", start: NOW - 3 * DAY }),
				],
			}),
		);
		assert.deepEqual(plan.todayClasses.map((c) => c.event.id), ["k1"]);
		assert.equal(plan.upcoming.length, 0);
	});

	it("the briefing day starts at 5 am", () => {
		assert.equal(briefingDay(new Date(2026, 9, 26, 4, 0).getTime()), "2026-10-25");
		assert.equal(briefingDay(new Date(2026, 9, 26, 6, 0).getTime()), "2026-10-26");
	});

	it("the fallback note and start prompts read plainly", () => {
		const plan = planBriefing(input({ sessions, topics: [eigen], events: [event({ id: "e1", title: "Linear Algebra Exam", start: NOW + 3 * DAY })] }));
		assert.match(fallbackNote(plan), /about 15 minutes/);
		assert.match(startPrompt(plan.items[0]!), /quiz me on Eigenvalues/);
		assert.match(quickPrompt(plan.items[0]!), /^I only have 5 minutes: ask me two or three quick questions on Eigenvalues/);
		assert.match(quickPrompt(plan.items[0]!), /stop there\. I have Linear Algebra Exam /);
	});

	it("the five-minute prompt for new material asks for one idea and one check", () => {
		const plan = planBriefing(input({ events: [event({ id: "e2", title: "Chemistry Exam", start: NOW + 4 * DAY })] }));
		assert.equal(plan.items[0]!.action, "learn");
		assert.match(quickPrompt(plan.items[0]!), /single most important idea for Chemistry Exam, then ask me one question/);
	});
});

describe("findFreeSlot", () => {
	it("skips busy time and lands on the next quarter hour", () => {
		const busy = [event({ id: "b", title: "Lecture", start: NOW, end: NOW + 90 * 60 * 1000 })];
		assert.equal(findFreeSlot(busy, NOW + 5 * 60 * 1000, 15), NOW + 90 * 60 * 1000);
	});

	it("moves to the next morning after waking hours and ignores all-day events", () => {
		const late = new Date(2026, 9, 26, 20, 55).getTime();
		const allDay = [event({ id: "h", title: "Holiday", start: late - DAY, end: late + DAY, allDay: true })];
		assert.equal(findFreeSlot(allDay, late, 15), new Date(2026, 9, 27, 8, 0).getTime());
	});

	it("returns null when no slot fits before the deadline", () => {
		assert.equal(findFreeSlot([], NOW, 30, { before: NOW + 20 * 60 * 1000 }), null);
	});
});

describe("provider payloads", () => {
	it("maps Google events, all-day dates and cancellations", () => {
		const timed = toStudyEvent({ id: "1", summary: "Exam", start: { dateTime: "2026-11-03T09:00:00+01:00" }, end: { dateTime: "2026-11-03T11:00:00+01:00" } }, "primary");
		assert.equal(timed?.start, Date.parse("2026-11-03T08:00:00Z"));
		assert.equal(timed?.allDay, false);
		const allDay = toStudyEvent({ id: "2", summary: "Project due", start: { date: "2026-11-05" }, end: { date: "2026-11-06" } }, "primary");
		assert.equal(allDay?.start, new Date(2026, 10, 5).getTime());
		assert.equal(allDay?.allDay, true);
		assert.equal(toStudyEvent({ id: "3", status: "cancelled", summary: "x", start: { date: "2026-11-05" } }, "primary"), null);
	});

	it("maps Todoist due dates to the end of the day or the exact time", () => {
		assert.deepEqual(todoistDueAt({ date: "2026-11-03" }), { at: new Date(2026, 10, 3, 23, 59).getTime(), allDay: true });
		assert.equal(todoistDueAt({ date: "2026-11-03T14:00:00Z" })?.at, Date.parse("2026-11-03T14:00:00Z"));
		assert.equal(todoistToStudyEvent({ id: "9", content: "Essay", due: null }), null);
		assert.equal(todoistToStudyEvent({ id: "9", content: "Essay", due: { date: "2026-11-03" } })?.source, "todo");
	});

	it("key shapes catch wrong pastes", () => {
		assert.ok(validateKeyShape("GOOGLE_OAUTH_CLIENT_ID", "1234567890-abcdefghijklmnop.apps.googleusercontent.com").ok);
		assert.ok(!validateKeyShape("GOOGLE_OAUTH_CLIENT_ID", "GOCSPX-not-an-id-at-all-really").ok);
		assert.ok(validateKeyShape("GOOGLE_OAUTH_CLIENT_SECRET", "GOCSPX-abcdefghijklmnopqrstuv").ok);
		assert.ok(validateKeyShape("TODOIST_API_TOKEN", "0123456789abcdef0123456789abcdef01234567").ok);
		assert.ok(!validateKeyShape("TODOIST_API_TOKEN", "0123456789abcdef").ok);
	});
});

describe("TodayShell", () => {
	const noop = () => {};
	const handlers = {
		onStart: noop,
		onQuick: noop,
		onPrimer: noop,
		onPush: noop,
		onRefresh: noop,
		onBudget: noop,
		onConnectGoogle: noop,
		onDisconnectGoogle: noop,
		onOpenKeys: noop,
		onLinkCourse: noop,
	};
	const disconnected: IntegrationsData = {
		google: { configured: false, connected: false, pending: false },
		todo: [{ id: "todoist", label: "Todoist", configured: false }],
	};

	it("asks for the OAuth client and token before anything is connected", () => {
		const html = renderToStaticMarkup(
			<TodayShell briefing={null} integrations={disconnected} budgetMinutes={45} sessions={[]} busy={true} pushing={null} error={null} handlers={handlers} />,
		);
		assert.match(html, /today-connections/);
		assert.match(html, /Add client ID/);
		assert.match(html, /Add token/);
		assert.match(html, /Putting today/);
	});

	it("renders items with push buttons when connected", () => {
		const eigen = topic({ key: "plan:la:eigen", title: "Eigenvalues", chatId: "la", stability: 3, lastReviewedAt: NOW - 3 * DAY });
		const plan = planBriefing(
			input({ sessions: [{ id: "la", title: "Linear algebra" }], topics: [eigen], events: [event({ id: "e1", title: "Linear Algebra Exam", start: NOW + 3 * DAY })] }),
		);
		const briefing: BriefingData = {
			plan,
			note: "Eigenvalues first.",
			noteSource: "fallback",
			sources: { calendar: { connected: true, count: 1 }, todo: { provider: "Todoist", connected: true, count: 0 } },
			events: [],
			pushed: {},
		};
		const connected: IntegrationsData = {
			google: { configured: true, connected: true, email: "me@example.com", pending: false },
			todo: [{ id: "todoist", label: "Todoist", configured: true }],
		};
		const html = renderToStaticMarkup(
			<TodayShell briefing={briefing} integrations={connected} budgetMinutes={45} sessions={[]} busy={false} pushing={null} error={null} handlers={handlers} />,
		);
		assert.doesNotMatch(html, /today-connections/);
		assert.match(html, /Eigenvalues first\./);
		assert.match(html, /Add to Todoist/);
		assert.match(html, /Block time/);
		assert.match(html, /today-upcoming/);
		// One primary button starts the first step of the plan (redesign wave).
		assert.match(html, /data-testid="today-start-first"/);
		// …and a five-minute way in for a low day.
		assert.match(html, /data-testid="today-quick"[^>]*>.*Only 5 minutes/);
		assert.match(html, /today-plan/);
		assert.doesNotMatch(html, /today-honesty/);
	});

	it("calls out overconfidence only when the page passes it in", () => {
		const html = renderToStaticMarkup(
			<TodayShell
				briefing={null}
				integrations={disconnected}
				budgetMinutes={45}
				sessions={[]}
				busy={false}
				pushing={null}
				error={null}
				handlers={handlers}
				honesty={{ points: 18 }}
			/>,
		);
		assert.match(html, /today-honesty/);
		assert.match(html, /about 18 points surer/);
		assert.match(html, /href="\/progress\?tab=calibration"/);
	});

	it("shows this week's minutes per day, today outlined", () => {
		const html = renderToStaticMarkup(
			<TodayShell
				briefing={null}
				integrations={disconnected}
				budgetMinutes={45}
				sessions={[]}
				busy={false}
				pushing={null}
				error={null}
				handlers={handlers}
				week={{ minutes: [25, 0, 30, 20, 25, 0, 0], today: 4 }}
			/>,
		);
		assert.match(html, /data-testid="today-week"/);
		assert.match(html, /1 h 40 min/);
		assert.match(html, /Monday 25, Tuesday 0, Wednesday 30/);
		assert.equal(html.match(/data-testid="today-week-bar"/g)?.length, 7);
		assert.equal(html.match(/outline-dashed/g)?.length, 1);
		assert.equal(formatStudyTotal(25), "25 min");
		assert.equal(formatStudyTotal(120), "2 h");
	});

	it("marks the chosen time budget", () => {
		const html = renderToStaticMarkup(
			<TodayShell briefing={null} integrations={disconnected} budgetMinutes={30} sessions={[]} busy={false} pushing={null} error={null} handlers={handlers} />,
		);
		assert.equal(html.match(/aria-pressed="true"/g)?.length, 1);
		assert.match(html, /aria-pressed="true"[^>]*>30 min</);
	});

	it("shows a gentle streak in the week card, with five minutes to keep it", () => {
		const render = (streak: { days: number; studiedToday: boolean; atRisk: boolean }) =>
			renderToStaticMarkup(
				<TodayShell
					briefing={null}
					integrations={disconnected}
					budgetMinutes={45}
					sessions={[]}
					busy={false}
					pushing={null}
					error={null}
					handlers={handlers}
					week={{ minutes: [25, 0, 30, 20, 25, 0, 0], today: 4 }}
					streak={streak}
				/>,
			);
		const done = render({ days: 4, studiedToday: true, atRisk: false });
		assert.match(done, /data-testid="today-streak"/);
		assert.match(done, /4-day streak\. Today counts\./);
		assert.doesNotMatch(done, /today-streak-quick/);
		const risk = render({ days: 3, studiedToday: false, atRisk: true });
		assert.match(risk, /3-day streak\. 5 minutes today keeps it going\./);
		assert.match(risk, /data-testid="today-streak-quick"/);
		assert.equal(streakMessage({ days: 0, studiedToday: false, atRisk: false }), "Start a streak today. Even 5 minutes counts.");
		assert.equal(streakMessage({ days: 2, studiedToday: false, atRisk: false }), "2-day streak. Study today to add a day.");
	});
});
