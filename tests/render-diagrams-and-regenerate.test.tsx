import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DiagramFigure } from "../components/diagram-figure.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { PracticeDock } from "../components/practice-dock.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import { ProblemCard } from "../components/practice-cards.tsx";
import { ReplyActions } from "../components/reply-actions.tsx";
import { RegenerateDialogBody } from "../components/regenerate-dialog.tsx";
import type { ArtifactPartProps, QuestionAnswerData } from "../src/core";

const SVG = '<svg viewBox="0 0 100 60"><rect x="10" y="10" width="80" height="40"/></svg>';

describe("DiagramFigure & dock/card placement", () => {
	it("DiagramFigure renders sanitized SVG and live streaming indicator", () => {
		const liveHtml = renderToStaticMarkup(
			<DiagramFigure svg='<svg viewBox="0 0 50 50"><circle cx="25" cy="25" r="10"/><rect x="1"' streaming={true} />,
		);
		assert.match(liveHtml, /data-testid="diagram-figure"/);
		assert.match(liveHtml, /data-streaming="true"/);
		assert.match(liveHtml, /Drawing diagram…/);
		assert.match(liveHtml, /<circle cx="25" cy="25" r="10"/);
		assert.ok(!liveHtml.includes("<rect"), "incomplete trailing tag should be trimmed");

		const settledHtml = renderToStaticMarkup(<DiagramFigure svg={SVG} />);
		assert.match(settledHtml, /data-testid="diagram-figure"/);
		assert.ok(!settledHtml.includes("Drawing diagram…"));
		assert.match(settledHtml, /viewBox="0 0 100 60"/);
	});

	it("QuestionDock places diagram between question statement and answer options", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="quiz"
				toolCallId="call_q"
				input={{
					question: "Which force acts upward?",
					options: [{ label: "Normal force" }, { label: "Gravity" }],
					correctAnswer: "Normal force",
					explanation: "Surface reaction.",
				}}
				diagram={SVG}
				expanded={true}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		const qAt = html.indexOf("Which force acts upward?");
		const dAt = html.indexOf('data-testid="diagram-figure"');
		const optAt = html.indexOf("Normal force");
		assert.ok(qAt > -1 && dAt > qAt && optAt > dAt, "order must be statement -> diagram -> options");
	});

	it("PracticeDock places diagram between statement and Your thinking", () => {
		const html = renderToStaticMarkup(
			<PracticeDock
				problemCallId="call_p"
				input={{ statement: "Two blocks connected by a massless string." }}
				diagram={SVG}
				expanded={true}
				onExpand={() => {}}
				onSubmit={() => {}}
			/>,
		);
		const sAt = html.indexOf("Two blocks connected by a massless string.");
		const dAt = html.indexOf('data-testid="diagram-figure"');
		const thinkAt = html.indexOf("Your thinking");
		assert.ok(sAt > -1 && dAt > sAt && thinkAt > dAt, "order must be statement -> diagram -> Your thinking");
	});

	it("AnsweredCard and ProblemCard render attached diagrams", () => {
		const answer: QuestionAnswerData = {
			kind: "quiz",
			questionText: "Find the tension.",
			correct: true,
			dontKnow: false,
			options: [{ index: 1, label: "T = mg" }],
			answers: [{ index: 1, label: "T = mg", value: "T = mg" }],
			correctIndices: [1],
			explanation: "Equilibrium.",
			answeredAt: "2026-01-01T00:00:00Z",
		};
		const answeredHtml = renderToStaticMarkup(<AnsweredCard answer={answer} diagram={SVG} />);
		const qAt = answeredHtml.indexOf("Find the tension.");
		const dAt = answeredHtml.indexOf('data-testid="diagram-figure"');
		const ansAt = answeredHtml.indexOf("T = mg");
		assert.ok(qAt > -1 && dAt > qAt && ansAt > dAt);

		const part = {
			type: "tool-problem",
			state: "input-available",
			toolCallId: "call_p",
			input: { statement: "Find acceleration." },
			diagram: SVG,
		} as ArtifactPartProps["part"];
		const problemHtml = renderToStaticMarkup(<ProblemCard part={part} />);
		assert.match(problemHtml, /Find acceleration\./);
		assert.match(problemHtml, /data-testid="diagram-figure"/);
	});
});

describe("ReplyActions & RegenerateDialogBody", () => {
	it("ReplyActions renders Copy and Regenerate with subtle resting opacity", () => {
		const html = renderToStaticMarkup(
			<ReplyActions
				parts={[{ type: "text", text: "Answer prose" }]}
				onRegenerate={() => {}}
			/>,
		);
		assert.match(html, /data-testid="reply-retry"/);
		assert.match(html, /Regenerate/);
		assert.match(html, /opacity-60/);
		assert.match(html, /Copy/);
	});

	it("RegenerateDialogBody renders warning copy and Cancel/Regenerate controls", () => {
		const html = renderToStaticMarkup(
			<RegenerateDialogBody onClose={() => {}} onConfirm={() => {}} />,
		);
		assert.match(html, /data-testid="regenerate-dialog"/);
		assert.match(html, /Regenerate from here\?/);
		assert.match(html, /Everything after this response/);
		assert.match(html, /data-testid="regenerate-cancel"/);
		assert.match(html, /data-testid="regenerate-confirm"/);
	});
});
