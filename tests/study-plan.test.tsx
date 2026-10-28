/**
 * THE STUDY PLAN (src/core/study-plan.ts) and its card
 * (components/study-plan-card.tsx):
 *
 * - every topic of an exam gets spaced reviews up to the day, so planned
 *   recall on the day reaches the target, and nothing lands on or after it;
 * - shaky topics (past lapses, confident misses) get more reviews;
 * - an exam with nothing studied gets learn sessions spread up to the day;
 *   one with studied topics gets a rehearsal two days before;
 * - a tough class gets a short prep on its day; a solid one does not;
 * - days stay inside the budget and MAX_ITEMS; what cannot fit before an
 *   exam is reported and the exam reads as tight;
 * - today's briefing list is the plan's first day;
 * - planChanges says what was missed, what slipped, and what is new;
 * - the card renders exams, the week, tough classes and the changes.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { planBriefing, type BriefingInput, type StudyEvent } from "../src/core/briefing.ts";
import {
	MAX_ITEMS,
	dayDate,
	dayIndex,
	planChanges,
	planSnapshot,
	planStudy,
	type PlanClass,
	type PlanTarget,
	type StudyPlanInput,
} from "../src/core/study-plan.ts";
import { TARGET_RETENTION, type TopicRetention } from "../src/core/retention.ts";
import { StudyPlanCard } from "../components/study-plan-card.tsx";

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
		stability: 4,
		difficulty: 5,
		retention: 0.92,
		dueAt: NOW + 2 * DAY,
		due: false,
		...over,
	};
}

function event(over: Partial<StudyEvent> & { id: string; title: string; start: number }): StudyEvent {
	return { end: over.start + 2 * 60 * 60 * 1000, allDay: false, source: "calendar", ...over };
}

function exam(id: string, days: number, topics: TopicRetention[], over: Partial<PlanTarget> = {}): PlanTarget {
	return { event: event({ id, title: `${id} exam`, start: NOW + days * DAY }), kind: "exam", label: id, topics, chatIds: [], ...over };
}

function input(over: Partial<StudyPlanInput>): StudyPlanInput {
	return { now: NOW, budgetMinutes: 45, targets: [], classes: [], topics: [], confidentMissChats: new Set(), ...over };
}

const allItems = (plan: ReturnType<typeof planStudy>) => plan.days.flatMap((d, i) => d.items.map((item) => ({ day: i, item })));

describe("planStudy: exams", () => {
	const eigen = topic({ key: "plan:la:eigen", title: "Eigenvalues", chatId: "la" });

	it("spaces reviews up to the exam so recall on the day reaches the target", () => {
		const plan = planStudy(input({ targets: [exam("la", 21, [eigen])], topics: [eigen] }));
		const reviews = allItems(plan).filter((x) => x.item.action === "review");
		assert.ok(reviews.length >= 2, "more than one review over three weeks");
		assert.ok(reviews.every((x) => x.day < 21), "never on the exam day");
		const gaps = reviews.slice(1).map((x, i) => x.day - reviews[i]!.day);
		assert.ok(gaps.every((g) => g >= 1), "one review per day at most");
		const la = plan.exams[0]!;
		assert.ok(la.readinessNow !== null && la.readinessNow < TARGET_RETENTION, "fading as things stand");
		assert.ok(la.readinessPlanned !== null && la.readinessPlanned >= TARGET_RETENTION, "above target with the plan");
		assert.equal(la.status, "on-track");
		assert.match(reviews[0]!.item.reason, /la exam is/);
	});

	it("plans more reviews for a topic that has lapsed", () => {
		const shaky = topic({ key: "plan:x:s", title: "Shaky", chatId: "x", lapses: 2 });
		const clean = topic({ key: "plan:y:c", title: "Clean", chatId: "y" });
		const plan = planStudy(input({ budgetMinutes: 90, targets: [exam("x", 21, [shaky]), exam("y", 21, [clean])], topics: [shaky, clean] }));
		const count = (key: string) => allItems(plan).filter((x) => x.item.action === "review" && x.item.topicKeys.includes(key)).length;
		assert.ok(count("plan:x:s") > count("plan:y:c"), `${count("plan:x:s")} vs ${count("plan:y:c")}`);
	});

	it("an exam with nothing studied gets learn sessions from today up to the day", () => {
		const plan = planStudy(input({ targets: [exam("chem", 10, [])] }));
		const learn = allItems(plan).filter((x) => x.item.action === "learn");
		assert.equal(learn.length, 5);
		assert.equal(learn[0]!.day, 0);
		assert.ok(learn.at(-1)!.day <= 9);
		assert.equal(plan.exams[0]!.status, "not-started");
	});

	it("sessions linked but nothing measured: a check today", () => {
		const plan = planStudy(input({ targets: [exam("bio", 6, [], { chatIds: ["bio-chat"] })] }));
		const first = plan.days[0]!.items[0]!;
		assert.equal(first.action, "check");
		assert.equal(first.chatId, "bio-chat");
	});

	it("a rehearsal two days before an exam with studied topics, none when it is too close", () => {
		const far = planStudy(input({ targets: [exam("la", 10, [eigen])], topics: [eigen] }));
		const rehearsal = allItems(far).find((x) => x.item.action === "rehearse");
		assert.equal(rehearsal?.day, 8);
		assert.deepEqual(rehearsal?.item.topicTitles, ["Eigenvalues"]);
		const near = planStudy(input({ targets: [exam("la", 2, [eigen])], topics: [eigen] }));
		assert.equal(allItems(near).filter((x) => x.item.action === "rehearse").length, 0);
	});

	it("a solid topic untested for weeks gets one quick check in the last week", () => {
		const stale = topic({ key: "plan:la:rank", title: "Rank", chatId: "la", stability: 400, lastReviewedAt: NOW - 20 * DAY, retention: 0.98 });
		const plan = planStudy(input({ targets: [exam("la", 12, [stale])], topics: [stale] }));
		const checks = allItems(plan).filter((x) => x.item.action === "check");
		assert.equal(checks.length, 1);
		assert.equal(checks[0]!.day, 5, "a week before the exam");
	});

	it("an exam later today gets a last session only when it is hours away", () => {
		const weak = topic({ key: "plan:la:w", title: "W", chatId: "la", stability: 1, retention: 0.6 });
		const later = planStudy(input({ targets: [exam("la", 0.3, [weak])], topics: [weak] }));
		assert.equal(later.days[0]!.items[0]?.action, "review");
		const soon = planStudy(input({ targets: [exam("la", 0.03, [weak])], topics: [weak] }));
		assert.equal(soon.days[0]!.items.length, 0);
	});
});

describe("planStudy: classes, budget, due topics", () => {
	const weakA = topic({ key: "plan:ph:a", title: "Standing waves", chatId: "ph", retention: 0.55, stability: 1.5 });
	const weakB = topic({ key: "plan:ph:b", title: "Doppler", chatId: "ph", retention: 0.7, lapses: 1 });
	const solid = topic({ key: "plan:hi:a", title: "Treaties", chatId: "hi", retention: 0.97, stability: 60, dueAt: NOW + 40 * DAY });

	function klass(id: string, label: string, days: number, topics: TopicRetention[]): PlanClass {
		return { event: event({ id, title: `${label} lecture`, start: NOW + days * DAY }), course: { key: label.toLowerCase(), label }, topics, chatIds: [] };
	}

	it("a tough class gets a prep on its day, a solid one does not", () => {
		const plan = planStudy(
			input({
				classes: [klass("k1", "Physics", 1, [weakA, weakB]), klass("k2", "History", 1, [solid])],
				topics: [weakA, weakB, solid],
			}),
		);
		const prep = allItems(plan).filter((x) => x.item.action === "prep");
		assert.equal(prep.length, 1);
		assert.equal(prep[0]!.day, 1);
		assert.deepEqual(prep[0]!.item.topicTitles, ["Standing waves", "Doppler"], "weakest first");
		assert.match(prep[0]!.item.reason, /Physics is a tough one: recall averages 63%/);
		assert.deepEqual(
			plan.tough.map((t) => t.label),
			["Physics"],
		);
	});

	it("a class already started or past the week gets no prep", () => {
		const plan = planStudy(input({ classes: [klass("k0", "Physics", -0.01, [weakA]), klass("k9", "Physics", 9, [weakA])] }));
		assert.equal(allItems(plan).filter((x) => x.item.action === "prep").length, 0);
	});

	it("a due review that lands on a prep day for the same topics is folded into it", () => {
		const due = topic({ key: "plan:ph:a", title: "Standing waves", chatId: "ph", retention: 0.55, stability: 1.5, due: true });
		const plan = planStudy(input({ classes: [klass("k1", "Physics", 0.2, [due])], topics: [due] }));
		const today = plan.days[0]!.items;
		assert.deepEqual(
			today.map((i) => i.action),
			["prep"],
		);
	});

	it("days stay inside the budget and MAX_ITEMS; what cannot fit before the exam is reported", () => {
		const topics = Array.from({ length: 9 }, (_, i) =>
			topic({ key: `plan:c${i}:t`, title: `T${i}`, chatId: `c${i}`, retention: 0.5, stability: 1, lastReviewedAt: NOW - 3 * DAY }),
		);
		const plan = planStudy(input({ budgetMinutes: 30, targets: [exam("big", 2, topics)], topics }));
		for (const d of plan.days) {
			assert.ok(d.items.length <= MAX_ITEMS);
			assert.ok(d.items.length <= 1 || d.minutes <= 30);
		}
		assert.ok(plan.unscheduled.length > 0);
		assert.equal(plan.exams[0]!.status, "tight");
		assert.ok(plan.exams[0]!.unscheduledMinutes > 0);
	});

	it("topics with no event keep their own due day within the week", () => {
		const later = topic({ key: "plan:z:t", title: "Later", chatId: "z", dueAt: NOW + 3 * DAY + 3600_000 });
		const plan = planStudy(input({ topics: [later, solid] }));
		const found = allItems(plan).filter((x) => x.item.topicKeys.includes("plan:z:t"));
		assert.deepEqual(
			found.map((x) => x.day),
			[3],
		);
		assert.equal(allItems(plan).filter((x) => x.item.topicKeys.includes("plan:hi:a")).length, 0, "not due this week");
	});
});

describe("planBriefing uses the plan", () => {
	const eigen = topic({ key: "plan:la:eigen", title: "Eigenvalues", chatId: "la" });
	const base: BriefingInput = {
		now: NOW,
		events: [],
		topics: [eigen],
		sessions: [{ id: "la", title: "Linear algebra basics" }],
		links: {},
		confidentMissChats: new Set(),
	};

	it("today's list is the plan's first day, and exams four weeks out are planned", () => {
		const plan = planBriefing({ ...base, events: [event({ id: "e1", title: "Linear Algebra Exam", start: NOW + 28 * DAY })] });
		assert.deepEqual(plan.items, plan.study!.days[0]!.items);
		assert.equal(plan.upcoming[0]!.event.id, "e1");
		assert.ok(plan.study!.exams[0]!.sessions > 0);
	});

	it("deadlines past two weeks and classes past one are left out", () => {
		const plan = planBriefing({
			...base,
			events: [
				event({ id: "d1", title: "Linear algebra homework due", start: NOW + 20 * DAY }),
				event({ id: "k1", title: "Linear algebra lecture", start: NOW + 9 * DAY }),
			],
		});
		assert.equal(plan.upcoming.length, 0);
		assert.equal(plan.study!.tough.length, 0);
	});
});

describe("planChanges", () => {
	const eigen = topic({ key: "plan:la:eigen", title: "Eigenvalues", chatId: "la", stability: 2, lastReviewedAt: NOW - 3 * DAY, retention: 0.8 });
	const det = topic({ key: "plan:la:det", title: "Determinants", chatId: "la" });
	const yesterday = dayDate(-1, NOW);

	it("says nothing on the first plan", () => {
		const plan = planStudy(input({ targets: [exam("la", 10, [eigen])], topics: [eigen] }));
		assert.deepEqual(planChanges(null, plan, [eigen], NOW), []);
	});

	it("reports a missed session and a slipped topic", () => {
		const plan = planStudy(input({ targets: [exam("la", 10, [eigen, det])], topics: [eigen, det] }));
		const prev = {
			day: yesterday,
			sessions: [
				{ id: "a", date: yesterday, action: "review" as const, title: "Review Determinants", topicKeys: [det.key], eventId: "la" },
				{ id: "b", date: yesterday, action: "review" as const, title: "Review Eigenvalues", topicKeys: [eigen.key], eventId: "la" },
			],
			lapses: { [eigen.key]: 0, [det.key]: 0 },
			exams: ["la"],
		};
		// Eigenvalues was reviewed yesterday and lapsed; Determinants was not touched.
		const eigenNow = { ...eigen, lapses: 1, lastReviewedAt: NOW - 14 * 3600_000 };
		const detNow = { ...det, lastReviewedAt: NOW - 5 * DAY };
		const changes = planChanges(prev, planStudy(input({ targets: [exam("la", 10, [eigenNow, detNow])], topics: [eigenNow, detNow] })), [eigenNow, detNow], NOW);
		assert.match(changes[0]!, /You did 1 of 2 planned sessions since yesterday; the rest is spread over the coming days\./);
		assert.ok(changes.some((c) => /Eigenvalues slipped in your last check, so it comes back (today|tomorrow)\./.test(c)), changes.join(" / "));
		assert.ok(plan.days.length > 0);
	});

	it("reports a new exam and a fully done day", () => {
		const reviewed = { ...eigen, lastReviewedAt: NOW - 14 * 3600_000 };
		const prev = {
			day: yesterday,
			sessions: [{ id: "a", date: yesterday, action: "review" as const, title: "Review Eigenvalues", topicKeys: [eigen.key] }],
			lapses: { [eigen.key]: 0 },
			exams: [],
		};
		const plan = planStudy(input({ targets: [exam("la", 10, [reviewed])], topics: [reviewed] }));
		const changes = planChanges(prev, plan, [reviewed], NOW);
		assert.equal(changes[0], "You did the planned session since yesterday.");
		assert.ok(changes.some((c) => c.startsWith("New on your calendar: la exam")));
	});

	it("a snapshot keeps the week's sessions and lapses", () => {
		const plan = planStudy(input({ targets: [exam("la", 10, [eigen])], topics: [eigen] }));
		const snap = planSnapshot(dayDate(0, NOW), plan, [eigen]);
		assert.equal(snap.exams[0], "la");
		assert.equal(snap.lapses[eigen.key], 0);
		assert.ok(snap.sessions.every((s) => dayIndex(new Date(s.date + "T12:00").getTime(), NOW) < 7));
	});
});

describe("StudyPlanCard", () => {
	it("renders exams with readiness, the rest of the week, tough classes and changes", () => {
		const weak = topic({ key: "plan:ph:a", title: "Standing waves", chatId: "ph", retention: 0.55, stability: 1.5, lastReviewedAt: NOW - 3 * DAY });
		const plan = planBriefing({
			now: NOW,
			topics: [weak],
			sessions: [{ id: "ph", title: "Physics waves" }],
			links: {},
			confidentMissChats: new Set(),
			events: [event({ id: "e1", title: "Physics exam", start: NOW + 12 * DAY }), event({ id: "k1", title: "Physics lecture", start: NOW + 2 * DAY })],
		});
		plan.changes = ["New on your calendar: Physics exam (Sat 7 Nov)."];
		const html = renderToStaticMarkup(<StudyPlanCard plan={plan} onStart={() => {}} />);
		assert.match(html, /Study plan/);
		assert.match(html, /Physics exam/);
		assert.match(html, /On track/);
		assert.match(html, /if you follow the plan/);
		assert.match(html, /Rest of the week/);
		assert.match(html, /Class prep/);
		assert.match(html, /Tough classes/);
		assert.match(html, /New on your calendar/);
	});

	it("renders nothing for a briefing saved before the plan existed", () => {
		const html = renderToStaticMarkup(
			<StudyPlanCard
				plan={{ day: "2026-10-26", generatedAt: NOW, budgetMinutes: 45, items: [], upcoming: [], todayClasses: [], trackedTopics: 0 }}
				onStart={() => {}}
			/>,
		);
		assert.equal(html, "");
	});
});
