/**
 * Viewport-lock and scroller-containment regression tests:
 *
 * KaTeX renders an absolutely positioned .katex-mathml copy of every formula.
 * If a page scroller (sheet-page, exam-page, PageFrame) is not `position: relative`,
 * or its overlay wrapper lacks `overflow-hidden`, or the app shell / body lets the
 * document grow past `100dvh`, the whole window (including the sidebar) scrolls.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { CheatSheetScreen } from "../components/cheatsheet-view.tsx";
import { ExamScreen } from "../components/exam-view.tsx";
import { PageFrame } from "../components/page-header.tsx";
import { SidebarProvider } from "../components/sidebar.tsx";
import type { ExamView, SheetRecord } from "../src/core/index.ts";

function sampleSheet(): SheetRecord {
	return {
		id: "sheet_test",
		title: "Dynamics cheat sheet",
		createdAt: "2026-11-16T00:00:00.000Z",
		updatedAt: "2026-11-16T00:00:00.000Z",
		scope: { text: "Dynamique des Structures", focus: "", noteIds: [] },
		status: "ready",
		topics: [],
		sections: [
			{
				title: "Amortissement modal",
				items: [
					{
						id: "item_1",
						term: "Taux d'amortissement modal",
						body: "Par identification: $\\ddot{q}_i + (a + b\\omega_i^2)\\dot{q}_i + \\omega_i^2 q_i = 0$.",
						topicKeys: [],
						sources: [],
						standing: "known",
						reason: "Tested and solid.",
					},
				],
			},
		],
	};
}

function sampleExam(): ExamView {
	return {
		id: "exam_test",
		title: "Dynamics exam",
		createdAt: "2026-11-16T00:00:00.000Z",
		scope: { text: "Dynamique", noteIds: [] },
		minutes: 30,
		status: "ready",
		topics: [],
		problems: [],
		problemCount: 0,
		partCount: 0,
		totalPoints: 0,
		answers: {},
		grades: {},
		serverNow: Date.now(),
	};
}

describe("viewport scroll lock", () => {
	it("locks CheatSheetScreen scroller with relative + overflow-hidden wrapper while rendering KaTeX math", () => {
		const html = renderToStaticMarkup(
			<CheatSheetScreen
				sheet={sampleSheet()}
				busy={false}
				error={null}
				filter="all"
				onFilter={() => {}}
				onRetry={() => {}}
				onAgain={() => {}}
				onDelete={() => {}}
				onLearn={() => {}}
				onPrint={() => {}}
				now={Date.parse("2026-11-16T00:05:00.000Z")}
			/>,
		);
		assert.match(html, /class="relative h-full overflow-hidden"><div data-testid="sheet-page"[^>]*class="lh-print-root relative h-full overflow-y-auto"/);
		assert.ok(html.includes("katex-mathml"), "KaTeX MathML copy renders inside the positioned scroller");
	});

	it("locks ExamScreen scroller with relative + overflow-hidden wrapper", () => {
		const html = renderToStaticMarkup(
			<ExamScreen
				view={sampleExam()}
				answers={{}}
				busy={false}
				error={null}
				saveState="saved"
				now={() => Date.now()}
				onStart={() => {}}
				onAnswer={() => {}}
				onSubmit={() => {}}
				onRetry={() => {}}
				onDelete={() => {}}
				onAgain={() => {}}
			/>,
		);
		assert.match(html, /class="relative h-full overflow-hidden"><div data-testid="exam-page"[^>]*class="relative h-full overflow-y-auto"/);
	});

	it("makes PageFrame a positioned scroll container", () => {
		const html = renderToStaticMarkup(
			<PageFrame title="Library" testId="library-page">
				<p>content</p>
			</PageFrame>,
		);
		assert.match(html, /data-testid="library-page" class="relative h-full overflow-y-auto"/);
	});

	it("locks SidebarProvider shell to the viewport with overflow-hidden", () => {
		const html = renderToStaticMarkup(
			<SidebarProvider>
				<main>inner</main>
			</SidebarProvider>,
		);
		assert.match(html, /class="lh-app-shell flex h-dvh overflow-hidden"/);
	});

	it("locks root body and AppShell main to viewport height and resets them in @media print", () => {
		const root = path.resolve(import.meta.dirname, "..");
		const layout = fs.readFileSync(path.join(root, "app/layout.tsx"), "utf8");
		const sidebar = fs.readFileSync(path.join(root, "components/sidebar.tsx"), "utf8");
		const css = fs.readFileSync(path.join(root, "app/globals.css"), "utf8");

		assert.match(layout, /<body className="h-dvh overflow-hidden antialiased">/);
		assert.match(sidebar, /<main className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">\{children\}<\/main>/);

		const printBlock = css.slice(css.indexOf("@media print"));
		assert.match(printBlock, /\.lh-app-shell,\s*\.lh-app-shell > main/);
		assert.match(printBlock, /height:\s*auto\s*!important;\s*overflow:\s*visible\s*!important;/);
	});
});
