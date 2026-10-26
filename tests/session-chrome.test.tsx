/**
 * THE SESSION CHROME (redesign wave, components/session-rail.tsx and
 * session-timer.tsx): the plan rail, the progress line and the timer.
 *
 * - the rail lists the plan in teaching order, prerequisites first;
 * - progress counts covered steps, the current one as half;
 * - the timer reads "X of Y min", then "Y min done";
 * - a start target's chat id is what the budget is keyed by.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { PlanRail, railProgress, railSteps } from "../components/session-rail.tsx";
import { chatIdOf, timerLabel } from "../components/session-timer.tsx";

const tree = {
	nodes: [
		{ id: "c", title: "Calvin cycle" },
		{ id: "a", title: "Light reactions" },
		{ id: "b", title: "ATP and NADPH" },
	],
	edges: [
		{ from: "a", to: "b" },
		{ from: "b", to: "c" },
	],
	version: 1,
};

describe("railSteps", () => {
	it("orders prerequisites first and keeps statuses", () => {
		const status = { a: "visited", b: "current", c: "upcoming" } as const;
		const steps = railSteps(tree, (id) => status[id as keyof typeof status]);
		assert.deepEqual(
			steps.map((s) => [s.id, s.status]),
			[
				["a", "visited"],
				["b", "current"],
				["c", "upcoming"],
			],
		);
	});

	it("keeps tree order for independent nodes and survives a cycle", () => {
		const free = railSteps({ ...tree, edges: [] }, () => "upcoming");
		assert.deepEqual(free.map((s) => s.id), ["c", "a", "b"]);
		const cyc = railSteps({ ...tree, edges: [{ from: "a", to: "c" }, { from: "c", to: "a" }] }, () => "upcoming");
		assert.equal(cyc.length, 3);
	});
});

describe("railProgress", () => {
	it("counts covered steps and half the current one", () => {
		const steps = railSteps(tree, (id) => (id === "a" ? "visited" : id === "b" ? "current" : "upcoming"));
		assert.equal(railProgress(steps), 0.5);
		assert.equal(railProgress([]), 0);
	});

	it("renders the rail with the current step marked", () => {
		const steps = railSteps(tree, (id) => (id === "a" ? "visited" : id === "b" ? "current" : "upcoming"));
		const html = renderToStaticMarkup(<PlanRail steps={steps} onOpenPlan={() => {}} />);
		assert.match(html, /data-status="current" aria-current="step"[^>]*>.*ATP and NADPH/);
		assert.match(html, /\(covered\)/);
	});
});

describe("session timer", () => {
	it("labels time spent against the budget", () => {
		assert.equal(timerLabel(12, 25), "12 of 25 min");
		assert.equal(timerLabel(25, 25), "25 min done");
		assert.equal(timerLabel(40, 25), "25 min done");
	});

	it("reads the chat id from a start target", () => {
		assert.equal(chatIdOf("/chat/abc123?prompt=hi"), "abc123");
		assert.equal(chatIdOf("/chat/abc123"), "abc123");
		assert.equal(chatIdOf("/today"), null);
	});
});
