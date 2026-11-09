"use client";
/**
 * THE SETTINGS DIALOG (settings-app wave, 2026-09-20): the thin settings
 * page graduated into the designed surface — a centered modal over
 * everything, left section nav + one scrolling content column.
 *
 * Owner decisions this wave:
 * - Dialog, not a page: opens over whatever screen you're on (the payoff:
 *   appearance edits restyle the chat LIVE behind the dialog). Escape,
 *   backdrop, and ✕ all close. Modal-only — /settings redirects, so
 *   nothing links into a dead surface.
 * - Left section nav in the app's mono chrome (text-only, session-list
 *   language — active = bg-accent), no icons, matching the minimal-color
 *   doctrine.
 * - The dialog is surface-agnostic by construction: the sections talk to
 *   /api/settings* and localStorage only, so this shell can be re-mounted
 *   as a true OS window in the Electron round with near-zero churn.
 *
 * The record + the single `write` seam moved here from the thin page:
 * one record instance for the whole dialog, sections write through it,
 * switching sections never refetches.
 */

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import {
	CURRENT_SETTINGS_VERSION,
	type AgentSettings,
	type AppearanceSettings,
	type CompactionSettings,
	type GraphSettings,
	type UserSettings,
} from "@/src/core";
import { useAppearance } from "./appearance.tsx";
import { SettingsSection, SettingsRow, Toggle } from "./controls.tsx";
import { AgentSection } from "./agent-section.tsx";
import type { ModelsSettings } from "@/src/core";
import { MENU_CLOSE_EVENT, MENU_OPEN_EVENT } from "@/components/menu-shell";
import { notifySettingsSaved } from "@/components/settings-signal";
import { KeysSection } from "./keys-section.tsx";
import { ModelVisibility } from "./model-visibility.tsx";
import { Hint } from "@/components/ui/hint";
import { downloadFile } from "@/components/artifacts/download";
import { AppearanceSection, GraphSection } from "./appearance-section.tsx";
import { KeyboardSection } from "./keyboard-section.tsx";
import { CalendarSection } from "./calendar-section.tsx";
import { SettingsGroup, SettingsAdvanced } from "./controls.tsx";
import { CalendarIcon, DatabaseIcon, GraduationCapIcon, KeyboardIcon, KeyRoundIcon, NetworkIcon, PaletteIcon, SearchIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Owner (2026-09-20): hints earn their place — mechanics-explaining
 *  prose is out; only the keyboard note stays (storage location is a
 *  real question users ask). */
const SECTIONS = [
	{ id: "agent", label: "Tutor", group: "Studying", desc: "How Socrates teaches you and checks what you know.", keywords: "language quiz checks warm-up tools research demo diagram pdf dictation prompts instructions memory compaction" },
	{ id: "calendar", label: "Calendar & reminders", group: "Studying", desc: "Where your plan reads exams and classes, and when Socrates nudges you.", keywords: "google todoist connect reminders notifications schedule" },
	{ id: "appearance", label: "Appearance", group: "App", desc: "How Socrates looks on this computer.", keywords: "theme dark light mode paper background font size headings colour color" },
	{ id: "keyboard", label: "Keyboard", group: "App", desc: "Shortcuts for the things you do most.", keywords: "shortcuts keys bindings rebind" },
	{ id: "keys", label: "Models & keys", group: "Setup", desc: "Which AI models Socrates uses, and the keys it reaches them with.", keywords: "api key provider anthropic openai gemini model thinking oauth todoist token" },
	{ id: "graph", label: "Knowledge map", group: "Setup", desc: "The map of what you have learned, built from your sessions.", keywords: "graph extraction concepts" },
	{ id: "general", label: "Data & updates", group: "Setup", desc: "Your sessions, map, flashcards and exams live on this computer.", keywords: "update backup restore export import data" },
] as const;
const GROUPS = ["Studying", "App", "Setup"] as const;
const SECTION_DESC = Object.fromEntries(SECTIONS.map((s) => [s.id, s.desc])) as Record<(typeof SECTIONS)[number]["id"], string>;
const SECTION_ICONS: Record<(typeof SECTIONS)[number]["id"], React.ReactNode> = {
	agent: <GraduationCapIcon className="size-4" />,
	calendar: <CalendarIcon className="size-4" />,
	appearance: <PaletteIcon className="size-4" />,
	keyboard: <KeyboardIcon className="size-4" />,
	keys: <KeyRoundIcon className="size-4" />,
	graph: <NetworkIcon className="size-4" />,
	general: <DatabaseIcon className="size-4" />,
};
type SectionId = (typeof SECTIONS)[number]["id"];

/** `open(section?, row?)` — the optional ROW deep-links into the Keys
 *  section with that row unfolded (zero-keys wave: the dictation error's
 *  click lands on the Gemini row). `row` is the KEY ID (the env-var
 *  name, e.g. GEMINI_API_KEY — KeysSection's openRow state), not the
 *  row's testid. */
const DialogContext = createContext<{ open: (section?: string, row?: string) => void }>({ open: () => {} });

/** AppShell-level mount: the sidebar row and the mod+, chord call this.
 *  `open(section)` lands the dialog on a specific section (the first-run
 *  setup flow deep-links to Keys when no provider key exists yet). */
/** The auto-update row's hint (tooltip wave): honest user language — no
 *  stream vocabulary. Exported for the copy pin (tooltip-mechanism test). */
export const AUTO_UPDATE_HINT = "Automatic updates arrive in an upcoming release";

export function SettingsDialogProvider({
	children,
}: {
	children: React.ReactNode;
}) {
	const [show, setShow] = useState(false);
	const [landOn, setLandOn] = useState<SectionId>("keys");
	const [landOnRow, setLandOnRow] = useState<string | null>(null);
	const open = useCallback((section?: string, row?: string) => {
		setLandOn(section ? section as SectionId : "keys");
		setLandOnRow(row ?? null);
		setShow(true);
	}, []);
	return (
		<DialogContext.Provider value={{ open }}>
			{children}
			{show && (
				<SettingsDialog onClose={() => setShow(false)} initialSection={landOn} initialRow={landOnRow} />
			)}
		</DialogContext.Provider>
	);
}

export function useSettingsDialog() {
	return useContext(DialogContext);
}

function SettingsDialog({
	onClose,
	initialSection,
	initialRow,
}: {
	onClose: () => void;
	initialSection: SectionId;
	/** The keys-section row to unfold (see DialogContext above). */
	initialRow: string | null;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	// Plain dim backdrop (no blur — nothing decorative); a genuine
	// backdrop click closes, the dialog body stops propagation.
	return createPortal(
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80"
			data-testid="settings-backdrop"
			{...backdropDismiss}
		>
			<SettingsDialogBody onClose={onClose} initialSection={initialSection} initialRow={initialRow} />
		</div>,
		document.body,
	);
}

/** The dialog without the portal/backdrop — the SSR-testable frame
 *  (portals render nothing under renderToStaticMarkup). */
export function SettingsDialogBody({
	onClose,
	initialSection = "keys",
	initialRow = null,
}: {
	onClose: () => void;
	initialSection?: SectionId;
	/** The keys row to unfold on arrival (null = none). While-open
	 *  retargets follow it exactly like initialSection below. */
	initialRow?: string | null;
}) {
	const { onAppearanceChange } = useAppearance();
	const [record, setRecord] = useState<UserSettings | null | undefined>(
		undefined,
	);
	const [error, setError] = useState<string | null>(null);
	// MenuShell open-count — drives the content column's scroll lock.
	const [openMenus, setOpenMenus] = useState(0);
	const contentRef = useRef<HTMLDivElement | null>(null);
	// Scroll-lock (fix wave, owner ruling: the scrollbar MAY stay,
	// scrolling must NOT happen, nothing may move): the content column
	// keeps overflow-y-auto — the scrollbar and every width stay exactly
	// as they are — and while any MenuShell is open, non-passive wheel +
	// touchmove listeners on the column preventDefault. React attaches
	// synthetic wheel/touch passively at the root, so this needs the
	// native-listener ref seam.
	useEffect(() => {
		const el = contentRef.current;
		if (!el || openMenus === 0) return;
		const block = (e: Event) => e.preventDefault();
		el.addEventListener("wheel", block, { passive: false });
		el.addEventListener("touchmove", block, { passive: false });
		return () => {
			el.removeEventListener("wheel", block);
			el.removeEventListener("touchmove", block);
		};
	}, [openMenus]);

	useEffect(() => {
		const onOpen = () => setOpenMenus((n) => n + 1);
		const onClose = () => setOpenMenus((n) => Math.max(0, n - 1));
		window.addEventListener(MENU_OPEN_EVENT, onOpen);
		window.addEventListener(MENU_CLOSE_EVENT, onClose);
		return () => {
			window.removeEventListener(MENU_OPEN_EVENT, onOpen);
			window.removeEventListener(MENU_CLOSE_EVENT, onClose);
		};
	}, []);
	const [active, setActive] = useState<SectionId>(initialSection);
	// A deep-link fired while the dialog is ALREADY open (first exercised by
	// the wave-6 embedding picker's "Add a provider key first…" link — the
	// picker itself died with wave 7, the mechanism is general) changes
	// initialSection under our feet — follow it, or the link silently does
	// nothing.
	useEffect(() => {
		setActive(initialSection);
	}, [initialSection]);
	const [query, setQuery] = useState("");
	const q = query.trim().toLowerCase();
	const shown = q ? SECTIONS.filter((s) => `${s.label} ${s.keywords}`.toLowerCase().includes(q)) : SECTIONS;
	// The keys row to unfold: the deep link, or a jump from another section.
	const [row, setRow] = useState<string | null>(initialRow);
	useEffect(() => setRow(initialRow), [initialRow]);

	// Fetch once per dialog mount. 200 {settings: null} is FIRST BOOT
	// (no record = factory everything), not a failure — the error state is
	// a non-200 or a network throw only.
	useEffect(() => {
		fetch("/api/settings")
			.then((r) =>
				r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`)),
			)
			.then((body: { settings: UserSettings | null }) =>
				setRecord(body.settings ?? { version: CURRENT_SETTINGS_VERSION }),
			)
			.catch(() => setRecord(null));
	}, []);

	// Escape closes — the layered-dismiss convention (Esc is dead for the
	// sections' own editors while they hold focus; this listener is the
	// dialog's outer layer).
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// THE ONE-ESC LAW (owner, keyboard round 2026-10-06): claim
				// at the document level — the window chain (dictation →
				// abort) must not also act. One Esc, one action.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [onClose]);

	/** ONE writer for the whole dialog: PUT the whole section, keep the
	 *  record mirror in sync, surface route errors inline (a 400 is a
	 *  schema mistake caught by the validation surface). */
	const write = useCallback(
		async (
			section: "general" | "agent" | "models" | "appearance" | "graph" | "compaction",
			body: object,
		) => {
			setError(null);
			const res = await fetch(`/api/settings/${section}`, {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const detail = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				setError(`${section}: ${detail.error ?? res.status}`);
				return;
			}
			// Server truth, never the request body (fix wave, owner repro):
			// the models section clamps pinned thinking levels on write
			// (bd68486) — a swap that rides an unsupported level lands
			// CLAMPED in the record, and the writing surface must show the
			// stored value in this same interaction, not the optimistic one.
			const stored = (
				(await res.json().catch(() => null)) as { settings?: UserSettings } | null
			)?.settings;
			setRecord(
				(prev) =>
					stored ?? ({ ...(prev ?? {}), [section]: body }) as UserSettings,
			);
			notifySettingsSaved(section);
			if (section === "appearance")
				onAppearanceChange(body as AppearanceSettings);
		},
		[onAppearanceChange],
	);

	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Settings"
			data-testid="settings-dialog"
			className="settings-dialog-pop flex h-[720px] max-h-[88vh] w-[1000px] max-w-[92vw] overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xl"
			onClick={(e) => e.stopPropagation()}
		>
			{/* Left nav: grouped by what you are doing, with a search. */}
			<nav
				aria-label="Settings sections"
				data-testid="settings-nav"
				className="flex w-[220px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border/70 bg-sidebar p-3"
			>
				<h2 className="px-2 pt-1 text-xl font-semibold tracking-tight">Settings</h2>
				<label className="flex h-8 items-center gap-2 rounded-lg border border-border/70 bg-surface px-2.5 text-[13px] text-muted-foreground focus-within:border-foreground/40">
					<SearchIcon className="size-3.5 shrink-0" />
					<input
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && shown[0]) setActive(shown[0].id);
						}}
						placeholder="Search settings"
						aria-label="Search settings"
						data-testid="settings-search"
						className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
					/>
				</label>
				{GROUPS.map((group) => {
					const items = shown.filter((s) => s.group === group);
					if (!items.length) return null;
					return (
						<div key={group} className="flex flex-col gap-px">
							<div className="px-2.5 pb-1 text-[12px] font-semibold text-muted-foreground">{group}</div>
							{items.map((s) => (
								<button
									key={s.id}
									type="button"
									data-testid={`settings-nav-${s.id}`}
									aria-current={active === s.id}
									className={cn(
										"flex h-8.5 items-center gap-2.5 rounded-[9px] px-2.5 text-left text-[14px] transition-colors",
										active === s.id ? "bg-ink-soft font-semibold text-foreground" : "text-foreground/85 hover:bg-accent/60",
									)}
									onClick={() => setActive(s.id)}
								>
									<span className="text-muted-foreground">{SECTION_ICONS[s.id]}</span>
									{s.label}
								</button>
							))}
						</div>
					);
				})}
				{shown.length === 0 && <p className="px-2.5 text-[13px] text-muted-foreground">Nothing matches.</p>}
			</nav>

			<div className="relative flex min-w-0 flex-1 flex-col">
				<Hint label="Close" binding="escape" side="left">
					<button
						type="button"
						aria-label="Close settings"
						data-testid="settings-close"
						className="absolute top-5 right-5 z-10 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
						onClick={onClose}
					>
						<XIcon className="size-4" />
					</button>
				</Hint>
				{/* Content column: one section at a time. It LOCKS while any
				    MenuShell is open (wheel/touch intercepted, nothing shifts). */}
				<div
					ref={contentRef}
					className="min-w-0 flex-1 overflow-y-auto"
					data-testid="settings-content"
				>
					{error && (
						<p
							role="alert"
							className="m-4 rounded-sm border border-red-500/40 px-3 py-2 text-xs text-red-500"
							data-testid="settings-error"
						>
							{error}
						</p>
					)}
					{record === undefined ? (
						<p className="px-6 py-5 text-xs text-muted-foreground/70">
							Loading settings…
						</p>
					) : record === null ? (
						<p className="px-6 py-5 text-xs text-muted-foreground/70">
							Settings could not be loaded — refresh to retry.
						</p>
					) : (
						<div>
							{active === "general" && (
								<SettingsSection title="Data & updates" hint={SECTION_DESC.general} testid="section-general">
									<SettingsGroup label="Updates">
										<SettingsRow
										label="Update automatically"
										hint={AUTO_UPDATE_HINT}
										testid="row-auto-update"
									>
										<Toggle
											checked={record.general?.autoUpdate ?? true}
											label="auto update"
											onChange={(on) =>
												void write("general", { autoUpdate: on })
											}
										/>
									</SettingsRow>
									</SettingsGroup>
									<SettingsGroup label="About">
										<SettingsRow label="Version" hint="The release of Socrates you are running." testid="row-app-version">
											<span className="text-[14px] tabular-nums text-muted-foreground" data-testid="app-version">
												{process.env.NEXT_PUBLIC_APP_VERSION ?? "unknown"}
											</span>
										</SettingsRow>
									</SettingsGroup>
									<SettingsGroup label="Backups" hint="A copy is saved every day in the data folder.">
										<SettingsRow
										label="Export everything"
										hint="One file with your sessions, map, flashcards, exams and settings (no keys)."
										testid="row-export-data"
									>
										<ExportButton />
									</SettingsRow>
									<SettingsRow
										label="Restore a copy"
										hint="From a daily backup or an export file. What you have now is kept first, so a restore can be undone."
										testid="row-restore-data"
									>
										<RestoreControls />
									</SettingsRow>
									</SettingsGroup>
								</SettingsSection>
							)}
							{active === "keys" && (
								<SettingsSection title="Models & keys" hint={SECTION_DESC.keys} testid="section-keys">
									<KeysSection initialRow={row ?? undefined} />
									<AgentSection
										part="models"
										agent={record.agent}
										models={record.models}
										graph={record.graph}
										compaction={record.compaction}
										onModelsChange={(next: ModelsSettings) => void write("models", next)}
										onSectionChange={(next: AgentSettings) => void write("agent", next)}
										onCompactionChange={(next: CompactionSettings) => void write("compaction", next)}
									/>
									<SettingsAdvanced testid="models-advanced">
										<ModelVisibility />
									</SettingsAdvanced>
								</SettingsSection>
							)}
							{active === "agent" && (
								<SettingsSection title="Tutor" hint={SECTION_DESC.agent} testid="section-agent">
									<AgentSection
										part="tutor"
										agent={record.agent}
										models={record.models}
										graph={record.graph}
										compaction={record.compaction}
										onModelsChange={(next: ModelsSettings) =>
											void write("models", next)
										}
										onSectionChange={(next: AgentSettings) =>
											void write("agent", next)
										}
										onCompactionChange={(next: CompactionSettings) =>
											void write("compaction", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "appearance" && (
								<SettingsSection title="Appearance" hint={SECTION_DESC.appearance} testid="section-appearance">
									<AppearanceSection
										appearance={record.appearance}
										onSectionChange={(next: AppearanceSettings) =>
											void write("appearance", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "graph" && (
								<SettingsSection title="Knowledge map" hint={SECTION_DESC.graph} testid="section-graph">
									<GraphSection
										graph={record.graph}
										onSectionChange={(next: GraphSettings) =>
											void write("graph", next)
										}
									/>
								</SettingsSection>
							)}
							{active === "calendar" && (
								<SettingsSection title="Calendar & reminders" hint={SECTION_DESC.calendar} testid="section-calendar">
									<CalendarSection
										onOpenKeys={(keyId) => {
											setRow(keyId);
											setActive("keys");
										}}
									/>
								</SettingsSection>
							)}
							{active === "keyboard" && (
								<SettingsSection title="Keyboard" hint={SECTION_DESC.keyboard} testid="section-keyboard">
									<KeyboardSection />
								</SettingsSection>
							)}
						</div>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2 border-t border-border/60 px-8 py-2.5 text-[12px] text-muted-foreground">
					Changes save as you make them.
				</div>
			</div>
		</div>
	);
}

/** Fetches the export and saves it as a file. A plain download link would
 *  save a server error page as the "export" when the request is refused;
 *  this reports the failure instead. */
function ExportButton() {
	const [state, setState] = useState<"idle" | "busy" | "error">("idle");
	const save = async () => {
		setState("busy");
		try {
			const res = await fetch("/api/export", { cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const stamp = new Date().toISOString().slice(0, 10);
			downloadFile(`socrates-export-${stamp}.json`, await res.text(), "application/json");
			setState("idle");
		} catch {
			setState("error");
		}
	};
	return (
		<span className="flex shrink-0 items-center gap-2">
			{state === "error" && <span role="alert" className="text-xs text-destructive">Couldn&apos;t export. Try again.</span>}
			<button
				type="button"
				disabled={state === "busy"}
				onClick={() => void save()}
				className="h-8 rounded-lg border border-border bg-surface px-3 text-[13px] hover:bg-accent disabled:opacity-60"
			>
				{state === "busy" ? "Exporting…" : "Export"}
			</button>
		</span>
	);
}

interface Snapshot {
	name: string;
	kind: "daily" | "before-restore";
	sessions: number;
}

function snapshotLabel(s: Snapshot): string {
	if (s.kind === "daily") return `${s.name} (${s.sessions} ${s.sessions === 1 ? "session" : "sessions"})`;
	const m = /(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(s.name);
	return m ? `Before a restore, ${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : s.name;
}

/** Restore from a daily snapshot or from an export file. Asks first, since
 *  it replaces what is there now, then reloads so every page reads the
 *  restored data. */
function RestoreControls() {
	const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
	const [picked, setPicked] = useState("");
	const [state, setState] = useState<{ tone: "idle" | "busy" | "ok" | "error"; text?: string }>({ tone: "idle" });
	const fileInput = useRef<HTMLInputElement>(null);

	useEffect(() => {
		void fetch("/api/restore", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<{ snapshots: Snapshot[] }>) : null))
			.then((d) => {
				if (!d) return;
				setSnapshots(d.snapshots);
				setPicked(d.snapshots[0]?.name ?? "");
			})
			.catch(() => undefined);
	}, []);

	const send = async (body: unknown) => {
		if (!window.confirm("Restore replaces your current sessions, map, flashcards, exams and settings with the copy you picked. A copy of what you have now is kept first. Continue?")) return;
		setState({ tone: "busy", text: "Restoring…" });
		try {
			const res = await fetch("/api/restore", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const data = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
			setState({ tone: "ok", text: "Restored. Reloading…" });
			setTimeout(() => window.location.reload(), 800);
		} catch (err) {
			setState({ tone: "error", text: err instanceof Error ? err.message : "Couldn't restore." });
		}
	};

	const fromFile = async (file: File | undefined) => {
		if (!file) return;
		let bundle: unknown;
		try {
			bundle = JSON.parse(await file.text());
		} catch {
			setState({ tone: "error", text: "That file is not a Socrates export." });
			return;
		}
		await send({ bundle });
	};

	const busy = state.tone === "busy";
	return (
		<span className="flex min-w-0 flex-col items-end gap-1.5">
			<span className="flex flex-wrap items-center justify-end gap-2">
				{snapshots.length > 0 && (
					<>
						<select
							aria-label="Snapshot to restore"
							value={picked}
							disabled={busy}
							onChange={(e) => setPicked(e.target.value)}
							className="h-8 max-w-48 rounded-lg border border-border bg-surface px-2 text-[13px]"
						>
							{snapshots.map((s) => (
								<option key={s.name} value={s.name}>{snapshotLabel(s)}</option>
							))}
						</select>
						<button
							type="button"
							disabled={busy || !picked}
							onClick={() => void send({ snapshot: picked })}
							className="h-8 rounded-lg border border-border bg-surface px-3 text-[13px] hover:bg-accent disabled:opacity-60"
						>
							Restore
						</button>
					</>
				)}
				<button
					type="button"
					disabled={busy}
					onClick={() => fileInput.current?.click()}
					className="h-8 rounded-lg border border-border bg-surface px-3 text-[13px] hover:bg-accent disabled:opacity-60"
				>
					From a file…
				</button>
				<input
					ref={fileInput}
					type="file"
					accept="application/json,.json"
					className="hidden"
					onChange={(e) => {
						void fromFile(e.target.files?.[0]);
						e.target.value = "";
					}}
				/>
			</span>
			{state.text && (
				<span role={state.tone === "error" ? "alert" : "status"} className={state.tone === "error" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
					{state.text}
				</span>
			)}
		</span>
	);
}
