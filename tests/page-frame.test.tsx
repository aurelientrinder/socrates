/**
 * THE PAGE FRAME (redesign wave, components/page-header.tsx): the shared
 * header of Today, Progress and Library.
 *
 * - the title renders as the page's one h1, in the title face;
 * - actions sit beside it;
 * - tabs are links, and only the active one carries aria-current.
 */

import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "node:test";
import { PageFrame, PageTabs } from "../components/page-header.tsx";

describe("PageFrame", () => {
	it("renders the title as the only h1, with actions and children", () => {
		const html = renderToStaticMarkup(
			<PageFrame title="Progress" testId="progress-page" actions={<button type="button">Act</button>}>
				<p>body</p>
			</PageFrame>,
		);
		assert.equal(html.match(/<h1/g)?.length, 1);
		assert.match(html, /<h1 class="lh-page-title[^"]*">Progress<\/h1>/);
		assert.match(html, /data-testid="progress-page"/);
		assert.match(html, />Act<\/button>/);
		assert.match(html, /<p>body<\/p>/);
	});
});

describe("PageTabs", () => {
	it("links every tab and marks only the active one", () => {
		const html = renderToStaticMarkup(
			<PageTabs
				active="calibration"
				tabs={[
					{ id: "memory", label: "Memory", href: "/progress" },
					{ id: "calibration", label: "Calibration", href: "/progress?tab=calibration" },
				]}
			/>,
		);
		assert.match(html, /href="\/progress"/);
		assert.match(html, /href="\/progress\?tab=calibration"/);
		assert.equal(html.match(/aria-current="page"/g)?.length, 1);
		assert.match(html, /data-testid="tab-calibration" aria-current="page"/);
	});
});
