import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractDiagrams, stripDiagrams } from "../src/core/diagram.ts";
import { activeStreamingDiagram, projectView } from "../src/core/view.ts";
import { findPendingToolCall } from "../src/core/pending.ts";
import { sanitizeStreamingSvg } from "../components/artifacts/sanitize-svg.ts";
import { messageViewLines } from "../src/core/coverage.ts";
import { messageMarkdown } from "../src/core/session-markdown.ts";
import { replyCopyText } from "../components/reply-actions.tsx";
import type { LhMessage } from "../src/core/native-messages.ts";

function assistantTextAndCalls(
	id: string,
	blocks: Array<
		| { type: "text"; text: string }
		| { type: "toolCall"; id: string; name: string; arguments: unknown }
	>,
): LhMessage {
	return {
		id,
		role: "assistant",
		content: blocks,
		api: "faux",
		provider: "google",
		model: "gemini-3.8-flash",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	} as unknown as LhMessage;
}

describe("inline SVG diagrams (<diagram>)", () => {
	it("extracts completed and streaming diagrams while cleaning prose", () => {
		const raw =
			"Consider the two blocks below.\n\n" +
			'<diagram><svg viewBox="0 0 100 100"><rect x="1" y="1" width="10" height="10"/></svg></diagram>\n\n' +
			"Which mass accelerates faster?";
		const res = extractDiagrams(raw);
		assert.equal(res.complete.length, 1);
		assert.match(res.complete[0]!, /^<svg viewBox="0 0 100 100">/);
		assert.equal(res.streaming, null);
		assert.equal(res.cleanText, "Consider the two blocks below.\n\nWhich mass accelerates faster?");
		assert.equal(stripDiagrams(raw), res.cleanText);

		const partial = 'Setup:\n<diagram><svg viewBox="0 0 50 50"><circle cx="10"';
		const streamingRes = extractDiagrams(partial);
		assert.equal(streamingRes.complete.length, 0);
		assert.equal(streamingRes.streaming, '<svg viewBox="0 0 50 50"><circle cx="10"');
		assert.equal(streamingRes.cleanText, "Setup:");
	});

	it("sanitizeStreamingSvg handles partial tags, unclosed style, scripts, and closes open containers", () => {
		const partial =
			'<svg viewBox="0 0 100 100"><style>.a{stroke:currentColor}</style><g><circle cx="20" cy="20" r="5" onclick="alert(1)"/><rect x="1" y="2';
		const out = sanitizeStreamingSvg(partial);
		assert.match(out, /^<svg viewBox="0 0 100 100">/);
		assert.ok(out.includes("<circle"));
		assert.ok(!out.includes("onclick"));
		assert.ok(!out.includes("<rect"), "incomplete trailing rect should be trimmed");
		assert.ok(out.endsWith("</g></svg>"), `expected auto-closed tags, got: ${out}`);

		// Unclosed <style> should not leak CSS text into the streaming SVG.
		const unclosedStyle = '<svg viewBox="0 0 10 10"><style>.secret{fill:red';
		const styleOut = sanitizeStreamingSvg(unclosedStyle);
		assert.ok(!styleOut.includes("secret"));
		assert.equal(styleOut, '<svg viewBox="0 0 10 10"></svg>');

		// Dangerous tags stripped even before closing </svg>.
		const xss = '<svg viewBox="0 0 10 10"><script>alert(1)</script><circle r="3"';
		const xssOut = sanitizeStreamingSvg(xss);
		assert.ok(!/script|alert/i.test(xssOut));
	});

	it("projectView attaches preceding completed diagram onto quiz and problem parts, and findPendingToolCall preserves it", () => {
		const svg = '<svg viewBox="0 0 120 80"><line x1="0" y1="40" x2="120" y2="40"/></svg>';
		const msg = assistantTextAndCalls("a1", [
			{ type: "text", text: `Look at this pulley setup.\n<diagram>${svg}</diagram>` },
			{
				type: "toolCall",
				id: "call_q1",
				name: "quiz",
				arguments: { question: "What is T?", options: [{ label: "mg" }], correctAnswer: "mg", explanation: "eq" },
			},
		]);
		const view = projectView([msg]);
		const a = view[0]!;
		const textParts = a.parts.filter((p) => p.type === "text");
		assert.equal(textParts[0]!.text, "Look at this pulley setup.");
		assert.equal(a.parts.some((p) => p.type === "data-diagram"), false, "attached diagram must not duplicate inline");
		const quizPart = a.parts.find((p) => p.type === "tool-quiz");
		assert.equal(quizPart?.diagram, svg);

		const pending = findPendingToolCall(view);
		assert.equal(pending?.toolCallId, "call_q1");
		assert.equal(pending?.diagram, svg);

		// Same attachment works for practice `problem` calls.
		const practiceMsg = assistantTextAndCalls("p1", [
			{ type: "text", text: `<diagram>${svg}</diagram>` },
			{ type: "toolCall", id: "call_p1", name: "problem", arguments: { statement: "Find $a$." } },
		]);
		const practiceView = projectView([practiceMsg]);
		const problemPart = practiceView[0]!.parts.find((p) => p.type === "tool-problem");
		assert.equal(problemPart?.diagram, svg);
	});

	it("projectView emits data-diagram for unattached prose diagrams once settled, but withholds while streaming", () => {
		const svg = '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="10"/></svg>';
		const msg = assistantTextAndCalls("a1", [
			{ type: "text", text: `Before.\n<diagram>${svg}</diagram>\nAfter.` },
		]);
		const liveView = projectView([msg], { inFlight: true, streamingIds: new Set(["a1"]), executions: new Map() });
		assert.equal(liveView[0]!.parts.some((p) => p.type === "data-diagram"), false);

		const settledView = projectView([msg]);
		const diagPart = settledView[0]!.parts.find((p) => p.type === "data-diagram");
		assert.ok(diagPart);
		assert.deepEqual(diagPart.data, { svg });
	});

	it("activeStreamingDiagram tracks live open and freshly closed diagrams during a turn", () => {
		const livePartial = assistantTextAndCalls("a1", [
			{ type: "text", text: 'Let us draw:\n<diagram><svg viewBox="0 0 60 60"><rect width="10"' },
		]);
		assert.deepEqual(activeStreamingDiagram([livePartial], true), {
			svg: '<svg viewBox="0 0 60 60"><rect width="10"',
			streaming: true,
		});
		assert.equal(activeStreamingDiagram([livePartial], false), null);

		const closedBeforeTool = assistantTextAndCalls("a1", [
			{ type: "text", text: 'Here:\n<diagram><svg viewBox="0 0 60 60"><rect width="10"/></svg></diagram>' },
		]);
		assert.deepEqual(activeStreamingDiagram([closedBeforeTool], true), {
			svg: '<svg viewBox="0 0 60 60"><rect width="10"/></svg>',
			streaming: false,
		});
	});

	it("strips <diagram> markup from coverage, session markdown, and clipboard replyCopyText", () => {
		const msg = assistantTextAndCalls("a1", [
			{ type: "text", text: 'Intro.\n<diagram><svg><rect/></svg></diagram>\nQuestion lead.' },
		]);
		assert.deepEqual(messageViewLines(msg, "a1"), ["TEACHER [a1] Intro.\n\nQuestion lead."]);
		assert.equal(messageMarkdown(msg, "a1"), "### Teacher · a1\n\nIntro.\n\nQuestion lead.");
		assert.equal(
			replyCopyText([{ type: "text", text: 'Intro.\n<diagram><svg><rect/></svg></diagram>\nQuestion lead.' }]),
			"Intro.\n\nQuestion lead.",
		);
	});
});
