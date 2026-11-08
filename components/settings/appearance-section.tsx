"use client";
/**
 * The Appearance + Graph sections (thin settings wave).
 *
 * Appearance controls resolve against the factory in the provider; writes
 * PUT the whole appearance section and hand the delta back so the CSS
 * variables move IMMEDIATELY (the section's whole point — it must DO
 * something). Hex inputs commit on blur/Enter; the background derives the
 * raised/accent/edge palette in code (components/settings/appearance.tsx).
 * Mode (light theme wave, 2026-10-26): Light (the default) / Dark / System;
 * the app uses one font (Source Sans 3); the reading font can override prose.
 *
 * Graph graying (owner, 2026-09-20) follows the graph viewer's render-panel
 * convention: the whole row dims when a parent is off (stored values
 * persist but resolve inert — the switch shows stored, the dim effective).
 *
 * Reading font (appearance wave, 2026-09-26, owner ruling): a searchable
 * dropdown of the user's INSTALLED fonts (FontMenuList over model-menu's
 * machine) fed by window.queryLocalFonts() in the desktop shell — the
 * enumeration is click-bound (the API requires user activation), deduped
 * to unique families, the factory family excluded (the DEFAULT row is
 * it). In a plain dev browser the API is absent → a small curated list
 * + a footer that says exactly that — never a fabricated system list.
 * The custom-family input inside the menu is the manual escape path.
 * Empty/unset keeps meaning Source Sans 3.
 *
 * Emphasis inks (same wave): the factory tokens default to the regular
 * text color now (globals.css); the rows' empty-state labels say "same
 * as text".
 */

import { useEffect, useRef, useState } from "react";
import {
	EXTRACTION_CHUNK_TOKENS_FLOOR,
	resolveSettings,
	type AppearanceSettings,
	type GraphSettings,
} from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { backgroundMode, DEFAULT_READING_FONT_FOR, useAppearance } from "./appearance.tsx";
import { FontMenuList } from "./model-menu";
import { CommitInput, Segmented, SettingsAdvanced, SettingsGroup, SettingsRow, Toggle } from "./controls.tsx";
import { cn } from "@/lib/utils";

/** The classic set's reading family (the claude set's is in
 *  DEFAULT_READING_FONT_FOR). Exported for tests. */
export const DEFAULT_READING_FONT = "Source Sans 3";

/** The dev-browser fallback list (queryLocalFonts is absent there):
 *  the app's own knowns plus a handful of ubiquitous macOS families,
 *  honestly LABELED as common — never presented as the system's real
 *  list. The factory family is absent: the DEFAULT row is it. Exported
 *  for tests. */
export const CURATED_FALLBACK_FONTS: readonly string[] = [
	"Arial",
	"CMU Serif",
	"Courier New",
	"Georgia",
	"Helvetica",
	"Helvetica Neue",
	"Menlo",
	"Times New Roman",
	"Trebuchet MS",
	"Verdana",
];

const THEMES: readonly { value: AppearanceSettings["mode"] & string; label: string; picture: string }[] = [
	{ value: "system", label: "System", picture: "linear-gradient(90deg,#faf9f5 50%,#1a1a1a 50%)" },
	{ value: "light", label: "Light", picture: "#faf9f5" },
	{ value: "dark", label: "Dark", picture: "#1a1a1a" },
];

/** Paper swatches per mode; the first is the factory page colour. */
const PAPER_SWATCHES: Record<"light" | "dark", readonly string[]> = {
	light: ["#faf9f5", "#f5f1e8", "#ffffff", "#eef0ea"],
	dark: ["#141414", "#1c1a17", "#181a1d", "#0d0d0d"],
};

const TEXT_SIZES = [
	{ value: "s", label: "Small", px: 14 },
	{ value: "m", label: "Default", px: 16 },
	{ value: "l", label: "Large", px: 18 },
	{ value: "xl", label: "Larger", px: 20 },
] as const;

const HEADING_WEIGHTS = [
	{ value: "regular", label: "Regular", weight: 500 },
	{ value: "semibold", label: "Semibold", weight: 600 },
	{ value: "bold", label: "Bold", weight: 800 },
] as const;

/** Each mode's factory page color (globals.css :root / .dark). A custom
 *  background only shows in the mode it suits (appearanceVars). */
function defaultBackground(mode: "light" | "dark"): string {
	return mode === "dark" ? "#141414" : "#faf9f5";
}

/** window.queryLocalFonts' shape as this section consumes it (family is
 *  the only field used; the API returns one FontData per FACE — the
 *  caller dedupes). */
type LocalFontsApi = () => Promise<Array<{ family: string }>>;

/** The Local Font Access seam — read lazily (SSR has no window, and
 *  render-time access would evaluate the API on the server). */
function localFontsApi(): LocalFontsApi | null {
	if (typeof window === "undefined") return null;
	return (window as unknown as { queryLocalFonts?: LocalFontsApi }).queryLocalFonts ?? null;
}

/** Compose the reading-font pick: null (or blank) = the factory
 *  Source Sans 3; otherwise the family verbatim (trimmed — the
 *  sanitizer trims again server-side). Pure — exported for tests. */
export function composeFontFamily(
	appearance: AppearanceSettings | undefined,
	family: string | null,
): AppearanceSettings {
	const value = family?.trim() ?? "";
	return { ...appearance, fontFamily: value === "" ? null : value };
}

export function AppearanceSection({
	appearance,
	onSectionChange,
}: {
	/** The record's appearance delta (absent = factory). */
	appearance: AppearanceSettings | undefined;
	/** PUT the whole appearance section; the page re-applies on success. */
	onSectionChange: (next: AppearanceSettings) => void;
}) {
	const { appearance: resolved, effectiveMode } = useAppearance();
	const md = appearance?.mdRendering;
	const typeface = appearance?.typeface ?? resolved.typeface;
	const readingDefault = DEFAULT_READING_FONT_FOR[typeface];

	// The font dropdown's open state + its enumeration cache. undefined =
	// not enumerated yet (desktop: click-bound queryLocalFonts pending);
	// null = enumeration UNAVAILABLE (the API is absent in a plain
	// browser, rejected, or resolved EMPTY — Electron 44's local-fonts
	// grant passes and the enumeration still yields zero fonts,
	// reproduced 2026-09-26) → the curated fallback; a list = the deduped
	// families. enumEmpty distinguishes WHY it fell back, for the footer.
	const [fontMenuOpen, setFontMenuOpen] = useState(false);
	const [localFonts, setLocalFonts] = useState<string[] | null | undefined>(undefined);
	const [enumEmpty, setEnumEmpty] = useState(false);
	const menuAnchorRef = useRef<HTMLSpanElement>(null);

	// The enumeration runs INSIDE the trigger click — queryLocalFonts
	// requires user activation, so it cannot be a mount effect. First
	// open only: the families are cached for the section's life (font
	// installs mid-dialog are not a case); ANY unavailable enumeration
	// (absent / rejected / empty) falls back to the curated list rather
	// than an empty picker.
	const openFontMenu = () => {
		setFontMenuOpen((open) => {
			if (!open && localFonts === undefined) {
				const api = localFontsApi();
				if (api === null) {
					setLocalFonts(null);
					setEnumEmpty(false);
				} else {
					void api()
						.then((fonts) => {
							const families = [...new Set(fonts.map((f) => f.family))]
								.filter((f) => f !== readingDefault)
								.sort((a, b) => a.localeCompare(b));
							if (families.length === 0) {
								// Resolved-but-empty: not a failure the catch sees —
								// an honest unavailable (this Electron 44 build
								// enumerates nothing even granted).
								setLocalFonts(null);
								setEnumEmpty(true);
							} else {
								setLocalFonts(families);
							}
						})
						.catch(() => {
							setLocalFonts(null);
							setEnumEmpty(false);
						});
				}
			}
			return !open;
		});
	};

	const pickFont = (family: string | null) => {
		setFontMenuOpen(false);
		onSectionChange(composeFontFamily(appearance, family));
	};

	// The dropdown contract (agent-section's, mirrored): any click
	// outside the open menu — or an Esc — closes it. Esc is CLAIMED with
	// stopPropagation so the settings dialog behind does NOT also close.
	useEffect(() => {
		if (!fontMenuOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (menuAnchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) {
				setFontMenuOpen(false);
			}
			// else: outside the dialog — the dialog's own close handles it.
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setFontMenuOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [fontMenuOpen]);

	const setMode = (mode: AppearanceSettings["mode"]) => onSectionChange({ ...appearance, mode });
	const paper = PAPER_SWATCHES[effectiveMode];
	const currentBackground = (appearance?.background ?? null)?.toLowerCase() ?? null;
	const sizeChoice = TEXT_SIZES.find((t) => t.px === resolved.proseFontSize)?.value ?? null;
	const weightChoice = HEADING_WEIGHTS.find((w) => w.weight === resolved.mdRendering.headingWeight)?.value ?? null;

	return (
		<>
			<SettingsGroup label="Theme" testid="group-theme">
				<div role="radiogroup" aria-label="mode" data-testid="row-mode" className="grid grid-cols-3 gap-3 p-4">
					{THEMES.map((t) => {
						const on = resolved.mode === t.value;
						return (
							<button
								key={t.value}
								type="button"
								role="radio"
								aria-checked={on}
								data-testid={`mode-${t.value}`}
								onClick={() => setMode(t.value)}
								className={cn(
									"flex flex-col gap-2 rounded-xl border p-2 text-left transition-colors",
									on ? "border-foreground ring-1 ring-foreground" : "border-border hover:border-foreground/40",
								)}
							>
								<span aria-hidden="true" className="block h-14 overflow-hidden rounded-lg border border-border/60" style={{ background: t.picture }}>
									<span className="m-2 mb-1.5 block h-1.5 w-10 rounded bg-[#888]/45" />
									<span className="mx-2 block h-1.5 w-16 rounded bg-[#888]/25" />
								</span>
								<span className="px-1 text-[13px] font-medium">{t.label}</span>
							</button>
						);
					})}
				</div>
				{resolved.mode === "system" && (
					<p className="px-4 py-2.5 text-[13px] text-muted-foreground">Following your computer, {effectiveMode} right now.</p>
				)}
				<SettingsRow
					label="Paper colour"
					hint={
						resolved.background !== null && backgroundMode(resolved.background) !== effectiveMode
							? `This colour shows in ${backgroundMode(resolved.background)} mode only`
							: `The page background in ${effectiveMode} mode`
					}
					testid="row-background"
				>
					<span className="flex items-center gap-1.5">
						{paper.map((c, i) => {
							const on = i === 0 ? currentBackground === null : currentBackground === c;
							return (
								<button
									key={c}
									type="button"
									aria-label={i === 0 ? "Default paper" : `Paper ${c}`}
									aria-pressed={on}
									data-testid={`paper-${i}`}
									onClick={() => onSectionChange({ ...appearance, background: i === 0 ? null : c })}
									className={cn("size-6 rounded-full border border-border", on && "ring-2 ring-foreground ring-offset-2 ring-offset-surface")}
									style={{ background: c }}
								/>
							);
						})}
					</span>
				</SettingsRow>
			</SettingsGroup>

			<SettingsGroup label="Reading" testid="group-reading">
				<div className="px-4 pt-3 pb-1">
					<div
						data-testid="reading-preview"
						className="rounded-lg bg-accent/40 px-4 py-3 leading-relaxed"
						style={{ fontFamily: appearance?.fontFamily || undefined, fontSize: `${resolved.proseFontSize}px` }}
					>
						<span className="mb-1 block" style={{ fontWeight: resolved.mdRendering.headingWeight }}>Eigenvalues</span>
						A matrix is <strong style={md?.boldColor ? { color: md.boldColor } : undefined}>diagonalizable</strong> when it has a basis of{" "}
						<em style={md?.italicColor ? { color: md.italicColor } : undefined}>eigenvectors</em>.
					</div>
				</div>
			<SettingsRow
				label="Font"
				testid="row-font"
			>
				<span ref={fontMenuOpen ? menuAnchorRef : undefined} className="relative flex items-center gap-2">
					{/* The MenuTrigger look (agent-section's collapsed
					    select — it lives unexported there, so the
					    classes ride inline; the searchable machine is
					    the shared part). The tooltip rides the CLOSED
					    button ONLY (owner ruling 2026-09-26: never while
					    the dropdown is out — it popped over the open
					    menu when the wrap covered the whole anchor
					    span). */}
					{(() => {
						const triggerButton = (
							<button
								type="button"
								aria-label="Reading font"
								aria-expanded={fontMenuOpen}
								data-testid="font-trigger"
								onClick={openFontMenu}
								className="flex h-8 min-w-28 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 font-ui text-[13px] text-foreground transition-colors hover:border-muted-foreground/50"
							>
								<span className="min-w-0 flex-1 truncate">{appearance?.fontFamily || readingDefault}</span>
								<span aria-hidden className="text-muted-foreground">
									▾
								</span>
							</button>
						);
						return fontMenuOpen ? (
							triggerButton
						) : (
							<Hint label="Choose from your installed fonts" side="left">
								{triggerButton}
							</Hint>
						);
					})()}
					{fontMenuOpen && (
						<MenuShell
							preferredSide="down"
							anchorTestid="font-trigger"
							testid="font-menu"
							menuClass="flex w-[18rem] flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
						>
							<FontMenuList
								families={localFonts === undefined ? undefined : (localFonts ?? [...CURATED_FALLBACK_FONTS])}
								effectiveFamily={appearance?.fontFamily ?? null}
								defaultFamily={readingDefault}
								onPick={pickFont}
								footer={
									localFonts === undefined
										? undefined
										: localFonts === null
											? enumEmpty
												? "Common families — installed fonts could not be read"
												: "Common families — your installed list needs the desktop app"
											: "Your installed fonts"
								}
							/>
						</MenuShell>
					)}
				</span>
			</SettingsRow>
				<SettingsRow label="Text size" testid="row-text-size">
					<Segmented
						options={TEXT_SIZES}
						value={sizeChoice}
						ariaLabel="Text size"
						testid="text-size"
						onChange={(v) => onSectionChange({ ...appearance, proseFontSize: TEXT_SIZES.find((t) => t.value === v)!.px })}
					/>
				</SettingsRow>
				<SettingsRow label="Headings" testid="row-headings">
					<Segmented
						options={HEADING_WEIGHTS}
						value={weightChoice}
						ariaLabel="Heading weight"
						testid="heading-weight"
						onChange={(v) =>
							onSectionChange({ ...appearance, mdRendering: { ...md, headingWeight: HEADING_WEIGHTS.find((w) => w.value === v)!.weight } })
						}
					/>
				</SettingsRow>
			</SettingsGroup>

			<SettingsAdvanced testid="appearance-advanced">
				<SettingsGroup label="Exact values">
					<SettingsRow label="Custom paper colour" hint="Any hex colour. Empty uses the default" testid="row-background-hex">
						<CommitInput
							value={appearance?.background ?? ""}
							placeholder={defaultBackground(effectiveMode)}
							ariaLabel="background hex"
							testid="input-background"
							onCommit={(v) => onSectionChange({ ...appearance, background: v === "" ? null : v })}
						/>
					</SettingsRow>
					<SettingsRow label="Exact text size" hint="In pixels, 12 to 24" testid="row-prose-size">
						<CommitInput
							type="number"
							value={String(appearance?.proseFontSize ?? "")}
							placeholder="16"
							ariaLabel="prose font size"
							testid="input-prose-size"
							onCommit={(v) => {
								// Empty = factory default (owner, fix wave): omit the key so the record
								// UNSETS and the field stays empty (absence, not null, is the
								// unset for numbers). Number("") is 0, so the old clamp wrote 12.
								if (v === "") {
									onSectionChange({ ...appearance, proseFontSize: undefined });
									return;
								}
								const n = Number(v);
								if (!Number.isFinite(n)) return; // bad input: no write, factory stays
								onSectionChange({ ...appearance, proseFontSize: Math.min(24, Math.max(12, Math.round(n))) });
							}}
						/>
					</SettingsRow>
					<SettingsRow label="Exact heading weight" hint="100 to 900" testid="row-heading-weight">
						<CommitInput
							type="number"
							value={String(md?.headingWeight ?? "")}
							placeholder={String(resolved.mdRendering.headingWeight)}
							ariaLabel="heading weight"
							testid="input-heading-weight"
							onCommit={(v) => {
								// Empty = factory default (owner, fix wave): Number("") is 0, so
								// Absence is the unset representation — the old clamp wrote 100.
								if (v === "") {
									onSectionChange({ ...appearance, mdRendering: { ...md, headingWeight: undefined } });
									return;
								}
								const n = Number(v);
								if (!Number.isFinite(n)) return;
								onSectionChange({
									...appearance,
									mdRendering: { ...md, headingWeight: Math.min(900, Math.max(100, Math.round(n))) },
								});
							}}
						/>
					</SettingsRow>
					{/* The emphasis inks default to the REGULAR TEXT COLOR now
					    (appearance wave, 2026-09-26) — the empty-state labels say
					    so; explicit hex overrides ride unchanged. */}
					<SettingsRow label="Bold text colour" hint="Empty keeps the text colour" testid="row-bold-color">
						<CommitInput
							value={md?.boldColor ?? ""}
							placeholder="same as text"
							ariaLabel="bold color"
							testid="input-bold-color"
							onCommit={(v) => onSectionChange({ ...appearance, mdRendering: { ...md, boldColor: v === "" ? null : v } })}
						/>
					</SettingsRow>
					<SettingsRow label="Italic text colour" hint="Empty keeps the text colour" testid="row-italic-color">
						<CommitInput
							value={md?.italicColor ?? ""}
							placeholder="same as text"
							ariaLabel="italic color"
							testid="input-italic-color"
							onCommit={(v) => onSectionChange({ ...appearance, mdRendering: { ...md, italicColor: v === "" ? null : v } })}
						/>
					</SettingsRow>
				</SettingsGroup>
			</SettingsAdvanced>
		</>
	);
}

export function GraphSection({
	graph,
	onSectionChange,
}: {
	graph: GraphSettings | undefined;
	onSectionChange: (next: GraphSettings) => void;
}) {
	// Wave 7 collapse (owner ruling 2026-09-23): the section is the MASTER
	// SWITCH — the embedding/clustering/labeling rungs are gone; clustering
	// is the free birth-session partition derived on read, labels ARE session
	// names. The chunk budget (2026-10-02) joined it as the section's second
	// and only other control: it denominates the coverage ring AND gates the
	// auto-extraction trigger (turn settle ≥ budget fires the run).
	//
	// Resolved through the SAME core resolver the server's effective
	// settings use (one source of truth, the 4096-fallback fix 2026-10-02):
	// the hint and placeholder report exactly the number the trigger waits
	// for — never a second hand-rolled default.
	const resolved = resolveSettings(graph === undefined ? null : { version: 1, graph }).graph;
	return (
		<>
			<SettingsGroup label="Your map" testid="group-graph">
			{/* EXTRACTION (renamed, owner 2026-10-06): this switch is the DATA
			    channel — the pipeline, the auditor, the prober's graph tools. It
			    was born labeled "Graph" and that label lied once the rendering
			    switch below arrived: off ≠ no graph, off = the graph stops
			    growing. The testid keeps the old name's shape (row-enabled) so
			    this stays one rename, not a test re-pin. */}
			<SettingsRow label="Keep building my map" hint="After each session, what you learned is added to your knowledge map. Off, the map stops growing" testid="graph-row-enabled">
				<Toggle
					checked={graph?.enabled ?? true}
					label="extraction enabled"
					onChange={(on) =>
						// Compose, never replace-whole (the section PUT is, but the
					// row must not drop its sibling field — fixed with the budget
					// row's arrival: the old { enabled: on } wiped a stored budget).
						onSectionChange({ ...graph, enabled: on })
					}
				/>
			</SettingsRow>
			{/* GRAPH RENDERING (owner, 2026-10-06 — the release graph-controls
			    round): display-only. Off = the home shows the chains view
			    instead of the canvas. The ledgers, the pipeline, everything
			    data keeps working — that is the extraction switch above. */}
			<SettingsRow label="Show the map as a graph" hint="Off, the map page shows simple lists instead" testid="graph-row-rendering">
				<Toggle
					checked={graph?.rendering ?? true}
					label="graph rendering enabled"
					onChange={(on) => onSectionChange({ ...graph, rendering: on })}
				/>
			</SettingsRow>
			</SettingsGroup>
			<SettingsAdvanced testid="graph-advanced">
			<SettingsGroup>
			<SettingsRow
				label="Update the map every"
				hint={`${resolved.extractionChunkTokens} tokens of conversation. Lower is fresher and costs more`}
				testid="graph-row-chunk-tokens"
			>
				<CommitInput
					type="number"
					value={String(graph?.extractionChunkTokens ?? "")}
					placeholder={String(resolved.extractionChunkTokens)}
					ariaLabel="extraction chunk budget"
					testid="input-chunk-tokens"
					onCommit={(v) => {
						// Empty = factory default (the fix-wave discipline): absence is
						// the unset for numbers — Number("") is 0, so clamping would
						// write the floor instead of unsetting.
						if (v === "") {
							onSectionChange({ ...graph, extractionChunkTokens: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n) || n <= 0) return; // bad input: no write
						// Mirror the server sanitize exactly: floor only (cost
						// protection), no ceiling — a big budget is the user's call.
						onSectionChange({
							...graph,
							extractionChunkTokens: Math.max(EXTRACTION_CHUNK_TOKENS_FLOOR, Math.round(n)),
						});
					}}
				/>
			</SettingsRow>
			</SettingsGroup>
			</SettingsAdvanced>
		</>
	);
}