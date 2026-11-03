/**
 * Session-row render tests (sidebar refine, 2026-11-03): the subject
 * leads, a kind tile says what sort of session it is, drills and reviews
 * carry a count chip, the braille spinner shows only while a turn runs,
 * and a small dot marks a session waiting on you. Pure function of the
 * list item, so SSR of <SessionRow> pins every visible state. Same tsx
 * classic-JSX shim as render-cards.test.tsx.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionRow, timeAgo } from "../components/sidebar.tsx";
import { dateGroup, sessionDisplay, shortAgo } from "../components/session-display.ts";
import type { ChatListItem } from "../src/core/index.ts";

function item(overrides: Partial<ChatListItem>): ChatListItem {
	return {
		id: "c1",
		title: "Test session",
		kind: "teach",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-02T00:00:00.000Z",
		messageCount: 4,
		phase: "probe",
		pendingQuestion: false,
		pendingProblem: false,
		busy: false,
		compacting: false,
		...overrides,
	};
}

function render(chat: ChatListItem, active = false) {
	return renderToStaticMarkup(<SessionRow chat={chat} active={active} onOpen={() => {}} />);
}

describe("SessionRow", () => {
	it("no phase strips, no phase colors — the retired decoration", () => {
		const html = render(item({ phase: "teach" }));
		assert.ok(!html.includes("phase-strip"));
		assert.ok(!html.includes("bg-phase-"));
		assert.ok(!html.includes("border-phase-"));
	});

	it("the subject leads: 'Teach me' is dropped from the row, the full title stays as the tooltip", () => {
		const html = render(item({ title: "Teach me Aéronautique" }));
		assert.match(html, />Aéronautique</);
		assert.match(html, /title="Teach me Aéronautique"/);
		assert.match(html, /data-testid="session-kind-learn"/);
		assert.match(html, /Learn · /);
	});

	it("a weak-spot drill gets the amber tile and its count chip", () => {
		const html = render(item({ kind: "review", title: "Drill · 1 weak spot" }));
		assert.match(html, /data-testid="session-kind-drill"/);
		assert.match(html, />Weak spot drill</);
		assert.match(html, /data-testid="session-chip"[^>]*>1 weak spot</);
		assert.match(html, /bg-warn-soft/);
	});

	it("a review gets its own tile and a topic chip", () => {
		const html = render(item({ kind: "review", title: "Review · 3 topics" }));
		assert.match(html, /data-testid="session-kind-review"/);
		assert.match(html, /data-testid="session-chip"[^>]*>3 topics</);
		assert.match(html, /Spaced review · /);
	});

	it("idle session: no spinner, no waiting dot", () => {
		const html = render(item({}));
		assert.ok(!html.includes("braille-spinner"));
		assert.ok(!html.includes("session-waiting"));
	});

	it("a pending question shows the waiting dot and says so in the meta line", () => {
		const html = render(item({ pendingQuestion: true }));
		assert.ok(html.includes("session-waiting"));
		assert.ok(!html.includes("braille-spinner"), "motion is reserved for working");
		assert.ok(html.includes("Learn · Waiting for input"));
	});

	it("a working session renders the braille spinner and the Working meta", () => {
		const html = render(item({ phase: "plan", busy: true }));
		assert.ok(html.includes('data-testid="braille-spinner"'));
		assert.ok((html.match(/class="braille-frame"/g) ?? []).length === 10, "all ten frames");
		assert.ok(html.includes("Working…"));
		assert.ok(!html.includes("session-waiting"), "the spinner replaces the dot");
	});

	it("compacting retains priority over pending input", () => {
		const html = render(item({ compacting: true, pendingQuestion: true }));
		assert.match(html, /Compacting context/);
		assert.doesNotMatch(html, /Waiting for input/);
	});

	it("idle meta is the kind and the compact age", () => {
		const html = render(item({ updatedAt: "2025-06-02T12:00:00.000Z" }));
		assert.match(html, /Learn · 2 Jun 2025/);
		assert.ok(!html.includes("messages"));
	});

	it("active row is marked by the background alone", () => {
		const html = render(item({}), true);
		assert.ok(html.includes("bg-ink-soft"));
	});
});

describe("sessionDisplay", () => {
	it("reads every title shape the app creates", () => {
		assert.deepEqual(sessionDisplay({ kind: "teach", title: "Teach me Thermo, starting from what I already know. Notes: a.pdf" }), {
			variant: "learn",
			name: "Thermo",
			kindLabel: "Learn",
			chip: null,
		});
		assert.equal(sessionDisplay({ kind: "teach", title: 'Teach me what is in my notes "Méca".' }).variant, "notes");
		assert.equal(sessionDisplay({ kind: "teach", title: 'Teach me what is in my notes "Méca".' }).name, "Méca");
		assert.equal(sessionDisplay({ kind: "practice", title: 'Give me practice problems on my notes "Méca".' }).name, "Méca");
		assert.equal(sessionDisplay({ kind: "review", title: "Chapitre 3 · révision" }).name, "Chapitre 3 · révision");
		assert.equal(sessionDisplay({ kind: "teach", title: "Partial derivatives" }).name, "Partial derivatives", "renamed sessions read as typed");
	});
});

describe("shortAgo / dateGroup", () => {
	const now = new Date("2026-11-03T12:00:00");
	it("compact ages", () => {
		assert.equal(shortAgo("2026-11-03T11:59:30", now), "now");
		assert.equal(shortAgo("2026-11-03T11:55:00", now), "5m");
		assert.equal(shortAgo("2026-11-03T09:00:00", now), "3h");
		assert.equal(shortAgo("2026-11-01T12:00:00", now), "2d");
		assert.equal(shortAgo("2026-10-27T12:00:00", now), "27 Oct");
		assert.equal(shortAgo("2025-10-27T12:00:00", now), "27 Oct 2025");
	});
	it("groups by last activity", () => {
		assert.equal(dateGroup("2026-11-03T00:30:00", now), "Today");
		assert.equal(dateGroup("2026-10-29T08:00:00", now), "This week");
		assert.equal(dateGroup("2026-10-20T08:00:00", now), "Earlier");
	});
});

describe("timeAgo", () => {
	const now = new Date("2026-01-02T12:00:00.000Z");

	it("just now / minutes / hours / days, then the ISO date (owner, round 5)", () => {
		assert.equal(timeAgo("2026-01-02T11:59:30.000Z", now), "just now");
		assert.equal(timeAgo("2026-01-02T11:55:00.000Z", now), "5m ago");
		assert.equal(timeAgo("2026-01-02T09:00:00.000Z", now), "3h ago");
		assert.equal(timeAgo("2025-12-31T12:00:00.000Z", now), "2d ago");
		assert.equal(timeAgo("2025-06-02T12:00:00.000Z", now), "2025-06-02", "beyond a week: ISO — unambiguous, sortable");
	});

	it("negative drift (clock skew) reads as just now, never a future date", () => {
		assert.equal(timeAgo("2026-01-02T12:01:00.000Z", now), "just now");
	});
});

describe("SessionRow practice sessions (2026-10-04)", () => {
	it("a practice row carries the dumbbell tile and the unified Working meta while busy", () => {
		const html = render(item({ kind: "practice", busy: true }));
		assert.match(html, /Working…/);
		assert.match(html, /data-testid="session-kind-practice"/);
	});

	it("a practice row with a posed problem says the problem is waiting", () => {
		const html = render(item({ kind: "practice", pendingProblem: true }));
		assert.match(html, /Practice · Problem waiting/);
	});
});
