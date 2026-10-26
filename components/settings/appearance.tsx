"use client";
/**
 * THE APPEARANCE APPLICATION (thin settings wave, 2026-09-19): the settings
 * record's appearance section actually DOES something — resolved against
 * the factory defaults and applied as RUNTIME CSS variables on <html>.
 *
 * Why variables and not className swaps: every seam the settings touch was
 * built token-first (--font-prose, --lh-prose-size, --lh-ink-strong, …),
 * so application is setProperty and nothing re-renders. The mode and the
 * typeface set ride the same commit as two attributes on <html>: the
 * "dark" class (light is the default palette in globals.css) and
 * data-typeface. "system" mode follows prefers-color-scheme live. The
 * resolved theme is also written where the pre-paint script in
 * app/layout.tsx reads it (localStorage + the desktop shell), so the next
 * load opens in the right theme without a flash.
 *
 * The provider is mounted at the ROOT LAYOUT level (like ActivityProvider):
 * every page picks appearance up on load. The settings page writes a
 * section, hands the new appearance here, and the vars move immediately.
 *
 * (The open-settings keyboard chord lives in components/keyboard-shortcuts.tsx
 * with the other navigations — mod+, pushes /settings from anywhere.)
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { FACTORY_SETTINGS, type AppearanceSettings, type AppearanceTypeface } from "@/src/core";

/** The heading weight each typeface set reads best at when the user has
 *  not chosen one: Source Sans 3's Black cut (900) for classic; a
 *  semibold for the Claude set's serif, where Black reads as a shout. */
export const DEFAULT_HEADING_WEIGHT: Record<AppearanceTypeface, number> = {
	classic: FACTORY_SETTINGS.appearance.mdRendering.headingWeight,
	claude: 600,
};

/** The reading family each typeface set uses when the reading-font
 *  setting is empty (the settings row's "Empty = …" hint). */
export const DEFAULT_READING_FONT_FOR: Record<AppearanceTypeface, string> = {
	classic: "Source Sans 3",
	claude: "Source Serif 4",
};

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	const typeface = delta?.typeface ?? f.typeface;
	return {
		mode: delta?.mode ?? f.mode,
		typeface,
		background: delta?.background ?? f.background,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? DEFAULT_HEADING_WEIGHT[typeface],
			boldColor: delta?.mdRendering?.boldColor ?? f.mdRendering.boldColor,
			italicColor: delta?.mdRendering?.italicColor ?? f.mdRendering.italicColor,
		},
	};
}

export type ThemeMode = "light" | "dark";

function channels(hex: string): number[] {
	return hex.length === 4
		? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
		: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

/** One channel shifted on the mode's curve: additive offsets matching the
 *  hand-picked dark palette (#141414 → card #1c1c1c (+8) → accent #2a2a2a
 *  (+22) → border #434343 (+47)) — the "per-mode derivation in code" the
 *  schema promises, as the thinnest curve that keeps the palette's
 *  relationships. The light curve runs the other way (surfaces darken off
 *  a light page), at the light palette's gentler steps. */
function shift(hex: string, add: number): string {
	return `#${channels(hex).map((c) => Math.max(0, Math.min(255, c + add)).toString(16).padStart(2, "0")).join("")}`;
}

/** Which mode a background color belongs to (relative luminance over the
 *  midpoint = a light page). Pure — exported for tests. */
export function backgroundMode(hex: string): ThemeMode {
	const [r, g, b] = channels(hex).map((c) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r! + 0.7152 * g! + 0.0722 * b! > 0.18 ? "light" : "dark";
}

/** The derived palette a chosen background implies on the mode's curve:
 *  background itself, the raised surfaces (card/popover/secondary/muted),
 *  the accent, the edges (border/input), and primary-foreground (the
 *  inverted text on primary = the background's own color). */
export function derivedPalette(background: string, mode: ThemeMode = "dark"): Record<string, string> {
	const steps = mode === "dark" ? [8, 22, 47] : [-7, -19, -36];
	const card = shift(background, steps[0]!);
	const accent = shift(background, steps[1]!);
	const border = shift(background, steps[2]!);
	return {
		"--background": background,
		"--card": card,
		"--popover": card,
		"--secondary": card,
		"--muted": card,
		"--accent": accent,
		"--border": border,
		"--input": border,
		"--primary-foreground": background,
	};
}

/** THE mapping: resolved appearance → the CSS variables to set on <html>.
 *  Absent entries = leave the factory stylesheet value in place. A custom
 *  background applies only in the mode it belongs to (a dark hex on the
 *  light theme would derive an unreadable palette — the mode's own
 *  default shows instead). Pure — exported for tests. */
export function appearanceVars(
	a: ReturnType<typeof resolveAppearance>,
	mode: ThemeMode = "dark",
): Record<string, string> {
	const vars: Record<string, string> = {};
	if (a.background !== null && backgroundMode(a.background) === mode) {
		Object.assign(vars, derivedPalette(a.background, mode));
	}
	if (a.fontFamily !== null) {
		// --lh-font-prose is the runtime seam every prose consumer reads
		// (globals.css); the fallback is the typeface set's own family.
		vars["--lh-font-prose"] = `"${a.fontFamily}", var(--lh-font-prose-base)`;
	}
	// The ONE documented reading-size variable (typography round 4): prose,
	// inputs, and session titles all read it, so one setProperty moves them.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Session names: CMU Serif by default; the toggle swaps the title font
	// to the prose family — covers chat.tsx + new-session.tsx titles with
	// zero component edits (they use the .font-title utility).
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	// Markdown rendering: heading weight + the emphasis inks (the vars
	// were built "ready for the settings UI").
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	if (a.mdRendering.boldColor !== null) vars["--lh-ink-strong"] = a.mdRendering.boldColor;
	if (a.mdRendering.italicColor !== null) vars["--lh-ink-italic"] = a.mdRendering.italicColor;
	return vars;
}

/** Pure: the previously-applied names ABSENT from the next var set —
 *  these get removeProperty so the factory stylesheet value returns.
 *  (Owner repro, fix wave: resets and toggle-backs never reverted because
 *  application only ever SET properties — the removal half was missing.)
 *  Exported for tests. */
export function staleVarNames(
	prevNames: readonly string[],
	nextVars: Record<string, string>,
): string[] {
	return prevNames.filter((n) => !(n in nextVars));
}

/** The OS color-scheme preference, live ("system" mode). */
function useSystemMode(): ThemeMode {
	const [mode, setMode] = useState<ThemeMode>("light");
	useEffect(() => {
		const mq = window.matchMedia("(prefers-color-scheme: dark)");
		const sync = () => setMode(mq.matches ? "dark" : "light");
		sync();
		mq.addEventListener("change", sync);
		return () => mq.removeEventListener("change", sync);
	}, []);
	return mode;
}

/** The pre-paint copy's storage key (read by app/layout.tsx's script). */
const BOOT_STORAGE_KEY = "lh.appearance.boot";

/** A computed color variable as #rrggbb, or null when it isn't one (the
 *  desktop shell's native surfaces take hex only). */
function hexVar(name: string): string | null {
	const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
	return /^#[0-9a-f]{6}$/i.test(v) ? v : null;
}

interface AppearanceContextValue {
	/** Resolved appearance; factory until the record arrives. */
	appearance: ReturnType<typeof resolveAppearance>;
	/** The mode actually showing ("system" resolved against the OS). */
	effectiveMode: ThemeMode;
	/** Changes whenever the applied palette or fonts change — a dep for
	 *  consumers that READ the live CSS variables (the graph canvas). */
	themeKey: string;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	effectiveMode: "light",
	themeKey: "",
	onAppearanceChange: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(undefined);
	// Until the record arrives, the pre-paint script's choice stands: the
	// provider must not flip a dark user to the factory light (or back)
	// for the length of one fetch.
	const [loaded, setLoaded] = useState(false);
	const appliedRef = useRef<string>("");

	const resolved = useMemo(() => resolveAppearance(delta), [delta]);
	const systemMode = useSystemMode();
	const effectiveMode: ThemeMode = resolved.mode === "system" ? systemMode : resolved.mode;

	// The vars apply on every change — stringified as the change signal.
	const vars = useMemo(() => appearanceVars(resolved, effectiveMode), [resolved, effectiveMode]);
	const key = useMemo(() => JSON.stringify(vars), [vars]);
	// REMOVAL is half the job (owner repro, fix wave): a later write that
	// OMITS a var (empty field = factory, serif toggle back on) must clear
	// the previously-set inline value or the stale one wins forever —
	// backgrounds never reset, toggles looked dead. Every name this effect
	// has ever set is tracked; names absent from the new set are removed so
	// the factory stylesheet value returns.
	//
	// A LAYOUT effect (light theme wave): every passive effect in the tree
	// — the graph canvas reading the palette into hex, for one — runs
	// after it, so a theme switch is never read half-applied.
	const appliedNamesRef = useRef<Set<string>>(new Set());
	useLayoutEffect(() => {
		if (!loaded) return;
		const root = document.documentElement;
		root.classList.toggle("dark", effectiveMode === "dark");
		root.setAttribute("data-typeface", resolved.typeface);
		if (appliedRef.current !== key) {
			appliedRef.current = key;
			for (const name of staleVarNames([...appliedNamesRef.current], vars)) {
				root.style.removeProperty(name);
				appliedNamesRef.current.delete(name);
			}
			for (const [name, value] of Object.entries(vars)) {
				root.style.setProperty(name, value);
				appliedNamesRef.current.add(name);
			}
		}
		// Hand the next load its theme: this browser's copy, and the
		// desktop shell's (which also recolors the native window and the
		// Windows caption buttons live).
		const boot = { mode: resolved.mode, typeface: resolved.typeface };
		try {
			localStorage.setItem(BOOT_STORAGE_KEY, JSON.stringify(boot));
		} catch {
			/* storage blocked: the next load just starts from the factory */
		}
		const shell = (window as unknown as { lh?: { setTheme?: (t: unknown) => void } }).lh;
		const background = hexVar("--background");
		const symbol = hexVar("--foreground");
		if (shell?.setTheme && background && symbol) shell.setTheme({ ...boot, background, symbol });
	}, [loaded, key, vars, effectiveMode, resolved.mode, resolved.typeface]);

	// One fetch per app load: the record (sanitized server-side) carries the
	// delta; resolution happens here against the compiled factory.
	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings?: Record<string, unknown> }) => {
				if (!alive) return;
				// The record arrives sanitized server-side; the appearance
				// slice is unknown-shaped here, so it goes through the same
				// resolve (absent/invalid fields = factory anyway).
				const appearance = body.settings?.appearance;
				setDelta(
					appearance && typeof appearance === "object" ? (appearance as AppearanceSettings) : undefined,
				);
				setLoaded(true);
			})
			.catch(() => {/* settings stay as the pre-paint script set them — not worth a crash */});
		return () => {
			alive = false;
		};
	}, []);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		setDelta(next);
		setLoaded(true);
	}, []);

	const themeKey = `${loaded}|${effectiveMode}|${resolved.typeface}|${key}`;
	const value = useMemo(
		() => ({ appearance: resolved, effectiveMode, themeKey, onAppearanceChange }),
		[resolved, effectiveMode, themeKey, onAppearanceChange],
	);
	return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}
