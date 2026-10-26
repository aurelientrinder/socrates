/**
 * THE START DIALOG (redesign wave, components/start-dialog.tsx): one door
 * for Learn, Practice and Review.
 *
 * - the chosen kind is pressed, and Review carries the due count;
 * - Learn and Practice ask for a topic and offer recent notes;
 * - Start stays disabled until there is a topic (or something due);
 * - a note becomes a first message that names it.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { StartDialogBody, notePrompt, type StartMode } from "../components/start-dialog.tsx";

const noop = () => {};

function render(mode: StartMode, opts: { topic?: string; due?: number | null; notes?: { id: string; name: string }[]; minutes?: number } = {}) {
	return renderToStaticMarkup(
		<StartDialogBody
			mode={mode}
			topic={opts.topic ?? ""}
			due={opts.due === undefined ? 3 : opts.due}
			notes={opts.notes ?? []}
			minutes={opts.minutes ?? 25}
			busy={false}
			error={null}
			onMode={noop}
			onMinutes={noop}
			onTopic={noop}
			onStart={noop}
			onNote={noop}
			onClose={noop}
		/>,
	);
}

describe("StartDialogBody", () => {
	it("presses the chosen kind and badges Review with what is due", () => {
		const html = render("learn");
		assert.match(html, /aria-pressed="true"[^>]*data-testid="start-mode-learn"/);
		assert.equal(html.match(/aria-pressed="true" data-testid="start-mode-/g)?.length, 1);
		assert.match(html, /3 due/);
	});

	it("asks for a topic and keeps Start disabled until one is typed", () => {
		const empty = render("practice");
		assert.match(empty, /What do you want to practise\?/);
		assert.match(empty, /data-testid="start-go" disabled=""/);
		const typed = render("practice", { topic: "entropy" });
		assert.doesNotMatch(typed, /data-testid="start-go" disabled=""/);
		assert.match(typed, /Start practice/);
	});

	it("offers recent notes as one-click starts", () => {
		const html = render("learn", { notes: [{ id: "n1", name: "Thermo lecture 4.pdf" }] });
		assert.match(html, /From your notes:/);
		assert.match(html, /Thermo lecture 4\.pdf/);
		assert.equal(notePrompt("learn", "Thermo lecture 4.pdf"), 'Teach me what is in my notes "Thermo lecture 4.pdf".');
		assert.match(notePrompt("practice", "x"), /^Give me practice problems/);
	});

	it("Review needs no topic and is disabled when nothing is due", () => {
		const some = render("review", { due: 7 });
		assert.doesNotMatch(some, /start-topic/);
		assert.match(some, /5 of your 7 due topics, weakest first/);
		assert.doesNotMatch(some, /data-testid="start-go" disabled=""/);
		const none = render("review", { due: 0 });
		assert.match(none, /Nothing is due right now/);
		assert.match(none, /data-testid="start-go" disabled=""/);
	});

	it("asks how long for Learn and Practice, not Review", () => {
		const learn = render("learn", { minutes: 45 });
		assert.match(learn, /data-testid="start-length"/);
		assert.match(learn, /aria-pressed="true"[^>]*>45 min/);
		assert.match(learn, /aria-pressed="false"[^>]*>25 min/);
		assert.doesNotMatch(render("review"), /start-length/);
	});
});
