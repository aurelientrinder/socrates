/**
 * The app's ONE mermaid renderer (the chrome-melt wave, 2026-09-19): both the
 * in-chat block (components/md-blocks.tsx) and the session-scoped focus
 * overlay (components/session-overlay.tsx) render charts through this module
 * — one config, unique render ids. This REPLACES streamdown's internal
 * mermaid path entirely: its fullscreen portal was hard-wired `fixed inset-0`
 * (covering the window-drag bar, X landing in drag territory) with no styling
 * hook, which is what drove the custom component in the first place.
 *
 * Engine: Pele (owner request, 2026-10-26) — a small, dependency-free
 * Mermaid renderer that emits SVG themed by CSS variables (the `.pele`
 * palette in globals.css maps them onto the app's dark tokens). Loaded
 * through `pele/lazy` so each diagram type's parser is fetched on first use
 * instead of shipping every type up front.
 */

import { renderAsync } from "pele/lazy";

/** The chart's base font size (px) — the renderer sizes ALL text relative to
 *  this, so it's the number the display-width cap (md-blocks) divides by:
 *  a chart shown at its natural width renders text at exactly this size.
 *  Pinned explicitly so a renderer default change can't silently shift the
 *  cap (owner rule, chrome-melt tweaks wave, 2026-09-19: chart text must
 *  never render larger than the session's own text). */
export const MERMAID_FONT_SIZE = 16;

const FONT_FAMILY = "ui-sans-serif, system-ui, sans-serif";

/** Render one chart source to an svg string. The id prefix is unique per
 *  call — the inline block and the focus overlay can show the same chart at
 *  once, and shared ids (markers, clip paths) would cross-wire them. Parse
 *  failures reject with Pele's message (line + expectation), which the
 *  callers hand to MermaidError. */
export async function renderMermaid(chart: string): Promise<string> {
	const idPrefix = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const { svg } = await renderAsync(chart, {
		fontFamily: FONT_FAMILY,
		fontSize: MERMAID_FONT_SIZE,
		idPrefix,
	});
	return svg;
}
