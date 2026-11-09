/**
 * THE CLASS PAGE (QoL pass, 2026-11-08): the pure shell renders the class's
 * exam verdict, what you know, its plan and its sessions and notes, and the
 * empty states read plainly.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClassShell, type ClassHandlers } from "../components/class-view.tsx";
import type { BriefingItem, ClassPageData } from "../src/core/index.ts";

const NOW = new Date(2026, 10, 8, 10, 0);
const noop: ClassHandlers = { onStart: () => {}, onQuick: () => {}, onMockExam: () => {}, onLearn: () => {}, onOpenSession: () => {} };

const item = (over: Partial<BriefingItem> = {}): BriefingItem => ({
	id: "i1",
	action: "review",
	title: "Review Diagonalization",
	reason: "fading",
	minutes: 3,
	score: 1,
	topicKeys: ["t1"],
	topicTitles: ["Diagonalization"],
	...over,
});

const data = (over: Partial<ClassPageData> = {}): ClassPageData => ({
	key: "linear algebra",
	label: "Linear Algebra",
	color: 0,
	notes: [{ id: "n1", name: "CM 6 Diagonalisation.pdf" }],
	sessions: [
		{
			id: "la",
			title: "Diagonalization",
			kind: "teach",
			createdAt: "2026-11-08T08:00:00Z",
			updatedAt: "2026-11-08T09:00:00Z",
			messageCount: 4,
			phase: "probe",
			pendingQuestion: false,
			pendingProblem: false,
			busy: false,
			compacting: false,
		} as never,
	],
	exam: {
		title: "Linear Algebra Midterm",
		start: new Date(2026, 10, 14, 9).getTime(),
		kind: "exam",
		plan: {
			eventId: "e1",
			title: "Linear Algebra Midterm",
			kind: "exam",
			start: 0,
			sessions: 3,
			minutes: 36,
			readinessNow: 0.77,
			readinessPlanned: 0.97,
			unscheduledMinutes: 0,
			status: "on-track",
			topicKeys: ["t1"],
		},
	},
	topics: [
		{ key: "t1", title: "Diagonalization", retention: 0.62, due: true },
		{ key: "t2", title: "Determinants", retention: 0.95, due: false },
	],
	plan: [
		{ date: "2026-11-08", item: item() },
		{ date: "2026-11-10", item: item({ id: "i2", action: "prep", title: "Before the tutorial", minutes: 10 }) },
	],
	classes: [{ title: "TD Linear Algebra", start: new Date(2026, 10, 10, 10).getTime(), tough: true }],
	next: null,
	...over,
});

describe("ClassShell", () => {
	it("leads with the exam verdict and starts the class's next plan step", () => {
		const html = renderToStaticMarkup(<ClassShell data={data()} handlers={noop} now={NOW} />).replace(/<!-- -->/g, "");
		assert.ok(html.includes("Linear Algebra Midterm"));
		assert.ok(html.includes("On track"));
		assert.ok(html.includes("in 6 days"));
		assert.ok(html.includes("77% recall on the day as things stand, 97% if you follow the plan: 3 sessions, 36 min."));
		assert.ok(html.includes('data-testid="class-start"'));
		assert.ok(html.includes("Review Diagonalization · 3 min"));
		assert.ok(html.includes('data-testid="class-mock-exam"'), "notes make a mock exam possible");
	});

	it("shows fading topics, the plan by day, sessions, notes and this week's classes", () => {
		const html = renderToStaticMarkup(<ClassShell data={data()} handlers={noop} now={NOW} />).replace(/<!-- -->/g, "");
		assert.ok(html.includes("62% · fading"));
		assert.ok(!html.includes("95% · fading"));
		assert.ok(html.includes(">Today<"));
		assert.ok(html.includes(">Tuesday<"));
		assert.ok(html.includes("Class prep"));
		assert.ok(html.includes(">13 min<"), "the plan total");
		assert.ok(html.includes('data-testid="session-row"') || html.includes(">Diagonalization<"));
		assert.ok(html.includes("CM 6 Diagonalisation.pdf"));
		assert.ok(html.includes("TD Linear Algebra"));
		assert.ok(html.includes(">tough<"));
	});

	it("with nothing planned or tested it says so and offers a learn session", () => {
		const html = renderToStaticMarkup(
			<ClassShell data={data({ exam: null, plan: [], topics: [], notes: [], sessions: [], classes: [] })} handlers={noop} now={NOW} />,
		);
		assert.ok(html.includes("Nothing planned"));
		assert.ok(html.includes('data-testid="class-learn"'));
		assert.ok(!html.includes('data-testid="class-mock-exam"'), "no notes, no mock exam");
		assert.ok(html.includes("Nothing tested yet"));
		assert.ok(html.includes("No sessions filed here yet."));
		assert.ok(!html.includes('data-testid="class-week"'));
	});
});
