"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, PlayIcon, RefreshCwIcon } from "lucide-react";
import { IGNORED, dayOf, hourRange, minutesOfDay, packDay, titleKey, weekStarts, type BriefingItem, type EventKind, type PlanDay } from "@/src/core";
import { Button } from "@/components/ui/button";
import { CourseReview } from "@/components/course-review";
import { cn } from "@/lib/utils";

/**
 * THE CLASS CALENDAR (Library › Calendar, 2026-10-29): eight weeks of the
 * learner's calendar as a week grid, every event filed under a class, marked
 * "not a class", or waiting for one (hatched/dashed amber), so nothing the
 * classifier missed is silent. Click an event to choose its class, or drag
 * it onto a class chip. Redesign (2026-11-01): one card with a Week/Month
 * switch, class chips above the grid, the study plan as a layer, and a side
 * panel holding a small month and the "To file" list. A choice is a pin stored apart from the
 * classifier (src/core/course-calendar.ts), so it survives a re-read of the
 * calendar; every change has an Undo.
 */

// Transport-only mirrors of src/core/course-calendar.ts and src/server/course-calendar.ts.
type Placement =
	| { state: "filed"; key: string; by: "you" | "auto" }
	| { state: "ignored"; by: "you" | "auto"; why: "pinned" | "dismissed" | "all-day" | "keyword" }
	| { state: "unplaced"; guess: string | null };

interface CalEvent {
	id: string;
	title: string;
	start: number;
	end: number;
	allDay: boolean;
	kind: EventKind;
	placement: Placement;
	pin?: "event" | "title";
}

interface CalGroup {
	key: string;
	label: string;
	noteCount: number;
	nextExam: { title: string; start: number } | null;
	events: number;
}

interface CalendarData {
	source: "google" | "briefing" | "none";
	connected: boolean;
	error?: string;
	now: number;
	from: number;
	to: number;
	events: CalEvent[];
	groups: CalGroup[];
	coverage: { total: number; filed: number; ignored: number; unplaced: number };
}

interface PinChange {
	scope: "event" | "title";
	id: string;
	value: string | null;
}

const WEEKS = 8;
const HOUR_PX = 56;
const PAD_PX = 10;
const GUTTER_PX = 52;
const DAY_MS = 24 * 60 * 60 * 1000;
const PALETTE = 6;
/** "To file" cards shown before "+N more". */
const NEEDS_SHOWN = 4;
const PLAN_KEY = "socrates.calendar.showPlan";

/** Local YYYY-MM-DD (the study plan's day key). */
const ymd = (ms: number) => {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const monthStart = (ms: number) => {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
};
const addMonths = (ms: number, n: number) => {
	const d = new Date(ms);
	return new Date(d.getFullYear(), d.getMonth() + n, 1).getTime();
};

async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
	const res = await fetch(url, {
		method,
		...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
	});
	const data = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
	return data;
}

const fmt = (ms: number, o: Intl.DateTimeFormatOptions) => new Date(ms).toLocaleDateString(undefined, o);
const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
const span = (e: Pick<CalEvent, "start" | "end">) => `${clock(e.start)} – ${clock(e.end)}`;

interface Popover {
	id: string;
	mode: "menu" | "new";
	/** Apply to every event with this title (true) or only this one. */
	all: boolean;
}

interface Toast {
	text: string;
	undo: () => Promise<void>;
}

/** The drag type of a class row (events drag as plain text). */
const COURSE_DRAG = "application/x-socrates-course";

export function CourseCalendar() {
	const [data, setData] = useState<CalendarData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [week, setWeek] = useState(0);
	const [pop, setPop] = useState<Popover | null>(null);
	const [focus, setFocus] = useState<string | null>(null);
	const [showIgnored, setShowIgnored] = useState(false);
	const [reviewing, setReviewing] = useState(false);
	const [toast, setToast] = useState<Toast | null>(null);
	const [newName, setNewName] = useState("");
	const [view, setView] = useState<"week" | "month">("week");
	const [allNeeds, setAllNeeds] = useState(false);
	const [planDays, setPlanDays] = useState<PlanDay[]>([]);
	const [showPlan, setShowPlanState] = useState(true);
	const setShowPlan = useCallback((on: boolean) => {
		setShowPlanState(on);
		try {
			localStorage.setItem(PLAN_KEY, on ? "1" : "0");
		} catch {}
	}, []);
	const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const load = useCallback(async (refresh = false) => {
		setRefreshing(refresh);
		try {
			setData(await request<CalendarData>(`/api/courses/calendar${refresh ? "?refresh=1" : ""}`, "GET"));
			setError(null);
		} catch (err) {
			setError(`Couldn't load your calendar (${err instanceof Error ? err.message : String(err)}).`);
		} finally {
			setRefreshing(false);
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);
	// The study plan (Today's planner) as a layer: what to study each day, next to the classes.
	useEffect(() => {
		try {
			if (localStorage.getItem(PLAN_KEY) === "0") setShowPlanState(false);
		} catch {}
		void request<{ briefing: { study?: { days: PlanDay[] } } | null }>("/api/briefing", "GET")
			.then((b) => setPlanDays((b.briefing?.study?.days ?? []).filter((d) => d.items.length > 0)))
			.catch(() => setPlanDays([]));
	}, []);

	const say = useCallback((text: string, undo: () => Promise<void>) => {
		clearTimeout(toastTimer.current);
		setToast({ text, undo });
		toastTimer.current = setTimeout(() => setToast(null), 9000);
	}, []);
	useEffect(() => () => clearTimeout(toastTimer.current), []);

	const events = data?.events ?? [];
	const groups = data?.groups ?? [];
	const byId = useMemo(() => new Map(events.map((e) => [e.id, e])), [events]);
	const groupOf = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups]);
	// A class keeps its color for as long as the set of classes is the same.
	const colorOf = useMemo(() => new Map([...groups].sort((a, b) => a.key.localeCompare(b.key)).map((g, i) => [g.key, i % PALETTE])), [groups]);
	const sameTitle = useCallback((e: CalEvent) => events.filter((x) => titleKey(x.title) === titleKey(e.title)), [events]);

	/** Send pins; on success show the calendar they produce and offer Undo. */
	const applyPins = useCallback(
		async (changes: PinChange[], text: string, after?: { undo: () => Promise<unknown> }) => {
			try {
				const res = await request<{ undo: PinChange[]; calendar: CalendarData }>("/api/courses/pins", "PUT", { changes });
				setData(res.calendar);
				setError(null);
				setPop(null);
				say(text, async () => {
					const back = await request<{ calendar: CalendarData }>("/api/courses/pins", "PUT", { changes: res.undo });
					if (after) await after.undo();
					setData(await request<CalendarData>("/api/courses/calendar", "GET").catch(() => back.calendar));
					setToast(null);
				});
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[say],
	);

	/** The pins that file `e` (and, when `all`, everything with its title) under a class or "not a class". */
	const pinsFor = useCallback(
		(e: CalEvent, value: string, all: boolean): PinChange[] => {
			if (!all) return [{ scope: "event", id: e.id, value }];
			// A title pin must reach events that carry a pin of their own too.
			const own = sameTitle(e).filter((x) => x.pin === "event").map((x): PinChange => ({ scope: "event", id: x.id, value: null }));
			return [{ scope: "title", id: titleKey(e.title), value }, ...own];
		},
		[sameTitle],
	);

	const defaultAll = useCallback((e: CalEvent) => sameTitle(e).length > 1 && e.kind !== "exam", [sameTitle]);

	const file = useCallback(
		(e: CalEvent, value: string, all: boolean) => {
			const n = all ? sameTitle(e).length : 1;
			const where = value === IGNORED ? "marked not a class" : `filed under ${groupOf.get(value)?.label ?? "the class"}`;
			void applyPins(pinsFor(e, value, all), `${n > 1 ? `${n} × ` : ""}“${e.title}” ${where}`);
		},
		[applyPins, groupOf, pinsFor, sameTitle],
	);

	const fileAllSuggested = useCallback(() => {
		const seen = new Map<string, { e: CalEvent; key: string }>();
		for (const e of events) {
			if (e.placement.state === "unplaced" && e.placement.guess && !seen.has(titleKey(e.title))) seen.set(titleKey(e.title), { e, key: e.placement.guess });
		}
		const changes = [...seen.values()].flatMap(({ e, key }) => pinsFor(e, key, true));
		if (changes.length === 0) return;
		void applyPins(changes, `${seen.size} ${seen.size === 1 ? "title" : "titles"} filed as suggested`);
	}, [applyPins, events, pinsFor]);

	const createAndFile = useCallback(
		async (e: CalEvent, label: string, all: boolean) => {
			const name = label.trim();
			if (!name) return;
			try {
				const made = await request<{ key: string }>("/api/courses", "POST", { label: name });
				await applyPins(pinsFor(e, made.key, all), `New class “${name}” made from “${e.title}”`, {
					undo: () => request("/api/courses/" + encodeURIComponent(made.key), "DELETE"),
				});
				setNewName("");
			} catch (err) {
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[applyPins, pinsFor],
	);

	// ── time geometry ─────────────────────────────────────────────────────
	const weeks = useMemo(() => (data ? weekStarts(data.from, WEEKS) : []), [data]);
	const range = useMemo(
		() =>
			hourRange(
				events
					.filter((e) => !e.allDay)
					.map((e) => {
						const start = minutesOfDay(e.start);
						return { start, end: Math.min(24 * 60, start + Math.round((e.end - e.start) / 60000)) };
					}),
			),
		[events],
	);
	const showWeekend = useMemo(() => events.some((e) => [0, 6].includes(new Date(e.start).getDay()) && e.placement.state !== "ignored"), [events]);
	const nDays = showWeekend ? 7 : 5;
	const visible = (e: CalEvent) => showIgnored || e.placement.state !== "ignored";
	const ws = weeks[week];
	const days = ws === undefined ? [] : Array.from({ length: nDays }, (_, i) => dayOf(ws, i));
	const weekEvents = ws === undefined ? [] : events.filter((e) => e.start >= ws && e.start < ws + 7 * DAY_MS && visible(e));
	const unplaced = events.filter((e) => e.placement.state === "unplaced");
	const needs = useMemo(() => {
		const out: { key: string; first: CalEvent; count: number }[] = [];
		for (const e of unplaced) {
			const k = titleKey(e.title);
			const at = out.find((x) => x.key === k);
			if (at) at.count++;
			else out.push({ key: k, first: e, count: 1 });
		}
		return out;
	}, [unplaced]);
	const hasSuggestion = needs.some((n) => n.first.placement.state === "unplaced" && n.first.placement.guess);

	const weekOf = useCallback((ms: number) => (data ? Math.min(WEEKS - 1, Math.max(0, Math.floor((ms - data.from) / (7 * DAY_MS)))) : 0), [data]);
	const planByDay = useMemo(() => new Map(planDays.map((d) => [d.date, d.items])), [planDays]);
	const examDays = useMemo(() => new Set(events.filter((e) => e.kind === "exam" && e.placement.state !== "ignored").map((e) => ymd(e.start))), [events]);
	const openEvent = useCallback(
		(e: CalEvent, mode: Popover["mode"] = "menu") => {
			setWeek(weekOf(e.start));
			setNewName(e.title.replace(/^(CM|TD|TP)\s+/i, ""));
			setPop({ id: e.id, mode, all: defaultAll(e) });
		},
		[defaultAll, weekOf],
	);

	// ── popover placement ──────────────────────────────────────────────────
	const popRef = useRef<HTMLDivElement>(null);
	const [popAt, setPopAt] = useState<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		if (!pop) {
			setPopAt(null);
			return;
		}
		const place = () => {
			const anchor = document.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(pop.id)}"]`);
			const box = popRef.current;
			if (!box) return;
			const w = box.offsetWidth;
			const h = box.offsetHeight;
			const r = anchor?.getBoundingClientRect();
			let left = r ? r.right + 10 : (innerWidth - w) / 2;
			if (r && left + w > innerWidth - 12) left = r.left - w - 10;
			left = Math.max(12, Math.min(innerWidth - w - 12, left));
			const top = Math.max(12, Math.min(innerHeight - h - 12, r ? r.top : (innerHeight - h) / 2));
			setPopAt({ left, top });
		};
		place();
		const close = () => setPop(null);
		const onKey = (ev: KeyboardEvent) => ev.key === "Escape" && close();
		const onDown = (ev: PointerEvent) => {
			const t = ev.target as HTMLElement | null;
			if (t && !t.closest("[data-cal-pop],[data-event-id],[data-need]")) close();
		};
		addEventListener("resize", close);
		// The popover follows its event when the grid or the page scrolls.
		addEventListener("scroll", place, true);
		document.addEventListener("keydown", onKey);
		document.addEventListener("pointerdown", onDown);
		return () => {
			removeEventListener("resize", close);
			removeEventListener("scroll", place, true);
			document.removeEventListener("keydown", onKey);
			document.removeEventListener("pointerdown", onDown);
		};
	}, [pop, week, data]);

	// ── merging classes ────────────────────────────────────────────────────
	/** Fold class `from` into `into`; the toast's Undo puts both back. */
	const merge = async (from: string, into: string) => {
		const a = groupOf.get(from)?.label ?? "the class";
		const b = groupOf.get(into)?.label ?? "the class";
		try {
			const res = await request<{ restore: unknown; calendar: CalendarData }>("/api/courses/merge", "POST", { from, into });
			setData(res.calendar);
			setError(null);
			setPop(null);
			if (focus === from) setFocus(into);
			say(`Merged ${a} into ${b}`, async () => {
				const back = await request<{ calendar: CalendarData }>("/api/courses/unmerge", "POST", { restore: res.restore });
				setData(back.calendar);
				setToast(null);
			});
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	// ── drag and drop ──────────────────────────────────────────────────────
	const [over, setOver] = useState<string | null>(null);
	const dropOn = (target: string) => (ev: React.DragEvent) => {
		ev.preventDefault();
		setOver(null);
		const dragged = ev.dataTransfer.getData(COURSE_DRAG);
		if (dragged) {
			if (groupOf.has(target) && target !== dragged) void merge(dragged, target);
			return;
		}
		const e = byId.get(ev.dataTransfer.getData("text/plain"));
		if (!e) return;
		if (target === "new") openEvent(e, "new");
		else file(e, target === "ignored" ? IGNORED : target, defaultAll(e));
	};
	const dropProps = (target: string) => ({
		onDragOver: (ev: React.DragEvent) => {
			ev.preventDefault();
			setOver(target);
		},
		onDragLeave: () => setOver((v) => (v === target ? null : v)),
		onDrop: dropOn(target),
	});

	if (!data) {
		return (
			<p data-testid="course-calendar-loading" className="text-sm text-muted-foreground">
				{error ?? "Loading your calendar…"}
			</p>
		);
	}

	const cov = data.coverage;
	const popEvent = pop ? byId.get(pop.id) : undefined;
	const end = data.from + WEEKS * 7 * DAY_MS;
	// The month on show: the one the current week's Thursday falls in.
	const monthAnchor = monthStart(ws === undefined ? data.now : dayOf(ws, 3));
	const todayWeek = weekOf(data.now);
	const prevMonth = addMonths(monthAnchor, -1);
	const nextMonth = addMonths(monthAnchor, 1);
	const prevWeek = view === "week" ? (week > 0 ? week - 1 : null) : monthAnchor > data.from ? weekOf(Math.max(prevMonth, data.from)) : null;
	const nextWeek = view === "week" ? (week < WEEKS - 1 ? week + 1 : null) : nextMonth < end ? weekOf(nextMonth) : null;
	const monthExams = events.filter((e) => e.kind === "exam" && e.placement.state !== "ignored" && e.start >= monthAnchor && e.start < nextMonth).length;
	const heading =
		view === "month"
			? { title: fmt(monthAnchor, { month: "long" }), sub: `${new Date(monthAnchor).getFullYear()}${monthExams > 0 ? ` · ${monthExams} exam${monthExams === 1 ? "" : "s"}` : ""}` }
			: days.length > 0
				? weekHeading(days)
				: { title: "", sub: "" };
	const nowShown = days.some((d) => new Date(d).toDateString() === new Date(data.now).toDateString());
	const nowMin = minutesOfDay(data.now);
	const nowTop = nowShown && nowMin >= range.from * 60 && nowMin <= range.to * 60 ? PAD_PX + ((nowMin - range.from * 60) / 60) * HOUR_PX : null;

	if (data.source === "none" && events.length === 0) {
		return (
			<div data-testid="course-calendar-empty" className="flex max-w-xl flex-col gap-2 rounded-2xl border bg-card px-5 py-4">
				<h2 className="text-lg font-semibold">Your calendar isn&apos;t connected</h2>
				<p className="text-sm text-muted-foreground">
					Connect Google Calendar and your classes show up here, week by week, so you can put each one in its course. {data.error ? `(${data.error})` : ""}
				</p>
				<div>
					<Button asChild size="sm" variant="outline">
						<Link href="/">Connect it on Today</Link>
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div data-testid="course-calendar" className="flex flex-col gap-3">
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{data.error && (
				<p className="text-sm text-muted-foreground" data-testid="calendar-stale">
					Couldn&apos;t refresh from Google just now ({data.error}). Showing the last copy.
				</p>
			)}
			<div className="flex flex-wrap overflow-hidden rounded-[1.25rem] border bg-card shadow-[0_1px_2px_rgba(31,30,29,0.04),0_12px_32px_-18px_rgba(31,30,29,0.18)]">
				{/* ── the calendar ─────────────────────────────────────── */}
				<section className="flex min-w-0 flex-[999_1_40rem] flex-col" aria-label={view === "week" ? "Week" : "Month"}>
					<div className="flex flex-wrap items-center gap-2.5 px-5 pt-4.5 pb-3.5">
						<h2 className="lh-page-title text-[1.625rem] leading-tight" data-testid="cal-title">
							{heading.title}
						</h2>
						<span className="mt-1 text-sm tabular-nums text-muted-foreground">{heading.sub}</span>
						<div className="flex-1" />
						<div role="group" aria-label="View" className="flex rounded-[10px] bg-muted p-[3px] text-[13px] font-medium">
							{(["week", "month"] as const).map((v) => (
								<button
									key={v}
									type="button"
									aria-pressed={view === v}
									data-testid={`cal-view-${v}`}
									onClick={() => {
										setView(v);
										setPop(null);
									}}
									className={cn("rounded-[7px] px-3.5 py-1.5 capitalize text-muted-foreground", view === v && "bg-card text-foreground shadow-[0_1px_2px_rgba(31,30,29,0.1),0_0_0_1px_rgba(31,30,29,0.04)] dark:bg-accent")}
								>
									{v}
								</button>
							))}
						</div>
						<Button size="sm" variant="outline" onClick={() => { setWeek(todayWeek); setPop(null); }}>
							Today
						</Button>
						<Button size="icon-sm" variant="outline" aria-label={view === "week" ? "Previous week" : "Previous month"} disabled={prevWeek === null} onClick={() => { if (prevWeek !== null) setWeek(prevWeek); setPop(null); }}>
							<ChevronLeftIcon className="size-4" />
						</Button>
						<Button size="icon-sm" variant="outline" aria-label={view === "week" ? "Next week" : "Next month"} disabled={nextWeek === null} onClick={() => { if (nextWeek !== null) setWeek(nextWeek); setPop(null); }}>
							<ChevronRightIcon className="size-4" />
						</Button>
						{data.connected && (
							<Button size="icon-sm" variant="ghost" aria-label="Refresh from Google Calendar" onClick={() => void load(true)} disabled={refreshing}>
								<RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
							</Button>
						)}
					</div>

					{/* classes: legend, filter, drop targets */}
					<div className="flex flex-wrap items-center gap-1.5 px-5 pb-4" aria-label="Classes" role="group">
						{groups.map((g) => (
							<button
								key={g.key}
								type="button"
								data-testid="cal-class"
								aria-pressed={focus === g.key}
								title={`${g.nextExam ? `Exam ${fmt(g.nextExam.start, { weekday: "short", day: "numeric", month: "short" })}` : "No exam in calendar"}${groups.length > 1 ? " · drag onto another class to merge" : ""}`}
								onClick={() => setFocus(focus === g.key ? null : g.key)}
								draggable
								onDragStart={(ev) => ev.dataTransfer.setData(COURSE_DRAG, g.key)}
								{...dropProps(g.key)}
								className={cn(
									`cal-c${colorOf.get(g.key) ?? 0}`,
									"inline-flex h-[30px] max-w-full items-center gap-[7px] rounded-full border bg-card pr-3 pl-2.5 text-[13px] font-medium transition-colors hover:bg-foreground/[0.03]",
									focus === g.key && "border-[color-mix(in_srgb,var(--bar)_35%,transparent)] bg-[var(--tint)] text-[var(--ink)] hover:bg-[var(--tint)]",
									over === g.key && "ring-[1.5px] ring-good",
								)}
							>
								<span className="size-2 shrink-0 rounded-full" style={{ background: "var(--bar)" }} />
								<span className="truncate">{g.label}</span>
								<span className="text-xs tabular-nums opacity-60">{g.events}</span>
							</button>
						))}
						<div
							data-testid="cal-drop-new"
							{...dropProps("new")}
							title="Drop an event here to make a new class from it"
							className={cn("inline-flex h-[30px] items-center rounded-full border border-dashed px-3 text-[13px] text-muted-foreground", over === "new" && "bg-good-soft ring-[1.5px] ring-good")}
						>
							+ New class
						</div>
						<button
							type="button"
							data-testid="cal-drop-ignored"
							aria-pressed={showIgnored}
							title={showIgnored ? "Hide events that are not a class" : "Show events that are not a class"}
							onClick={() => setShowIgnored((v) => !v)}
							{...dropProps("ignored")}
							className={cn(
								"inline-flex h-[30px] items-center gap-1.5 rounded-full border border-dashed px-3 text-[13px] text-muted-foreground hover:text-foreground",
								showIgnored && "border-solid bg-muted text-foreground",
								over === "ignored" && "bg-good-soft ring-[1.5px] ring-good",
							)}
						>
							Not a class <span className="text-xs tabular-nums opacity-70">{cov.ignored}</span>
						</button>
						<div className="flex-1" />
						{planDays.length > 0 && (
							<label className="flex cursor-pointer items-center gap-2 text-[12.5px] text-muted-foreground">
								<input type="checkbox" role="switch" className="peer sr-only" checked={showPlan} onChange={(e) => setShowPlan(e.target.checked)} data-testid="cal-show-plan" />
								<span aria-hidden className="relative h-4 w-7 rounded-full bg-border transition-colors peer-checked:bg-good peer-focus-visible:ring-2 peer-focus-visible:ring-ring after:absolute after:top-0.5 after:left-0.5 after:size-3 after:rounded-full after:bg-white after:transition-transform peer-checked:after:translate-x-3" />
								Show study plan
							</label>
						)}
					</div>

					{reviewing && <CourseReview events={events} groups={groups} titleKey={titleKey} onFile={file} onClose={() => setReviewing(false)} />}
					{view === "month" && !reviewing && (
						<MonthGrid
							month={monthAnchor}
							from={data.from}
							to={data.from + WEEKS * 7 * DAY_MS}
							now={data.now}
							events={events.filter(visible)}
							plan={showPlan ? planByDay : null}
							colorOf={colorOf}
							focus={focus}
							onOpen={openEvent}
							onPickDay={(d) => {
								setWeek(weekOf(d));
								setView("week");
							}}
						/>
					)}
					<div className={cn("overflow-x-auto border-t", (reviewing || view !== "week") && "hidden")} data-testid="cal-grid-wrap">
						<div className="grid" style={{ gridTemplateColumns: `${GUTTER_PX}px repeat(${nDays}, minmax(7.5rem, 1fr))`, minWidth: GUTTER_PX + nDays * 120 }}>
							<div className="border-b" />
							{days.map((d) => {
								const today = new Date(d).toDateString() === new Date(data.now).toDateString();
								const past = d + DAY_MS <= data.now && !today;
								return (
									<div key={d} className={cn("flex items-baseline gap-[7px] border-b px-3 pt-3.5 pb-3", past && "opacity-55")}>
										<span className={cn("text-xs font-medium tracking-[0.02em] uppercase", today ? "text-good" : "text-muted-foreground")}>{fmt(d, { weekday: "short" })}</span>
										<span className={cn("text-[1.375rem] leading-8 font-semibold tracking-[-0.01em] tabular-nums", today && "rounded-[9px] bg-good px-2 text-[1.1875rem] text-background")}>{new Date(d).getDate()}</span>
									</div>
								);
							})}
							<AllDayRow days={days} events={weekEvents} colorOf={colorOf} onOpen={openEvent} />
							{showPlan && <PlanRow days={days} plan={planByDay} />}
							<div className="relative" style={{ height: (range.to - range.from) * HOUR_PX + 2 * PAD_PX }} aria-hidden>
								{Array.from({ length: range.to - range.from + 1 }, (_, i) => {
									const hourTop = PAD_PX + i * HOUR_PX;
									if (nowTop !== null && Math.abs(nowTop - hourTop) < 14) return null;
									return (
										<span key={i} className="absolute right-2.5 -translate-y-1/2 text-[11px] tabular-nums leading-none text-muted-foreground/70" style={{ top: hourTop }}>
											{range.from + i}:00
										</span>
									);
								})}
								{nowTop !== null && (
									<span className="absolute right-1.5 z-10 -translate-y-1/2 rounded-[5px] bg-[#d0453a] px-[5px] py-px text-[10.5px] font-bold tabular-nums text-white" style={{ top: nowTop }}>
										{clock(data.now)}
									</span>
								)}
							</div>
							{days.map((d) => (
								<DayColumn
									key={d}
									day={d}
									events={weekEvents.filter((e) => !e.allDay && e.start >= d && e.start < d + DAY_MS)}
									now={data.now}
									range={range}
									colorOf={colorOf}
									groupOf={groupOf}
									focus={focus}
									openId={pop?.id ?? null}
									onOpen={openEvent}
								/>
							))}
						</div>
					</div>
				</section>

				{/* ── side panel ───────────────────────────────────────── */}
				<aside className="flex min-w-0 flex-[1_1_17rem] flex-col gap-5 border-t bg-sidebar/40 px-4.5 py-5 lg:max-w-[19rem] lg:border-t-0 lg:border-l" aria-label="Month and events to file">
					<MiniMonth
						month={monthAnchor}
						from={data.from}
						to={data.from + WEEKS * 7 * DAY_MS}
						now={data.now}
						week={view === "week" ? ws : undefined}
						examDays={examDays}
						onPick={(d) => {
							setWeek(weekOf(d));
							setPop(null);
						}}
					/>
					<div className="h-px bg-border/60" />
					<section aria-labelledby="cal-needs" data-testid="cal-needs" className="flex flex-col gap-2.5">
						<div className="flex items-baseline justify-between gap-2">
							<h3 id="cal-needs" className="text-sm font-semibold">
								To file
							</h3>
							<button
								type="button"
								onClick={() => setReviewing((v) => !v)}
								aria-pressed={reviewing}
								data-testid="cal-coverage"
								className="rounded-md text-xs tabular-nums text-muted-foreground hover:text-foreground"
							>
								{cov.filed} of {cov.filed + cov.unplaced} filed · <span className="font-semibold text-good">{reviewing ? "Back" : "Review"}</span>
							</button>
						</div>
						<div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
							<div className={cn("h-full rounded-full", cov.unplaced === 0 ? "bg-good" : "bg-warn")} style={{ width: `${cov.filed + cov.unplaced === 0 ? 100 : Math.round((100 * cov.filed) / (cov.filed + cov.unplaced))}%` }} />
						</div>
						{needs.length === 0 ? (
							<p className="flex items-center gap-2 text-sm text-muted-foreground">
								<CheckIcon className="size-4 text-good" />
								Every event has a class.
							</p>
						) : (
							<>
								<ul className="flex flex-col gap-2">
									{(allNeeds ? needs : needs.slice(0, NEEDS_SHOWN)).map(({ key, first, count }) => {
										const guess = first.placement.state === "unplaced" ? first.placement.guess : null;
										const g = guess ? groupOf.get(guess) : undefined;
										return (
											<li
												key={key}
												data-need
												draggable
												onDragStart={(ev) => ev.dataTransfer.setData("text/plain", first.id)}
												className="flex min-w-0 cursor-grab flex-col rounded-xl border bg-card px-3 py-2.5"
											>
												<button type="button" onClick={() => openEvent(first)} className="min-w-0 text-left">
													<span className="block truncate text-[13.5px] font-semibold">{first.title}</span>
													<span className="mt-0.5 block text-xs tabular-nums text-muted-foreground">
														{count > 1 ? `${count} events · ${fmt(first.start, { weekday: "short" })}s ${clock(first.start)}` : `${fmt(first.start, { weekday: "short", day: "numeric", month: "short" })} · ${clock(first.start)}${first.kind === "exam" ? " · exam" : ""}`}
													</span>
												</button>
												{g && (
													<button
														type="button"
														onClick={() => file(first, g.key, count > 1 && first.kind !== "exam")}
														className={cn(`cal-c${colorOf.get(g.key) ?? 0}`, "mt-2 flex max-w-full items-center gap-1.5 self-start rounded-lg border border-[color-mix(in_srgb,var(--bar)_25%,transparent)] px-2.5 py-1 text-xs font-semibold")}
														style={{ background: "var(--tint)", color: "var(--ink)" }}
													>
														<span className="size-[7px] shrink-0 rounded-full" style={{ background: "var(--bar)" }} />
														<span className="truncate">File under {g.label}</span>
													</button>
												)}
											</li>
										);
									})}
								</ul>
								<div className="mt-0.5 flex items-center justify-between gap-2">
									{needs.length > NEEDS_SHOWN ? (
										<button type="button" onClick={() => setAllNeeds((v) => !v)} className="text-[12.5px] text-muted-foreground hover:text-foreground">
											{allNeeds ? "Show fewer" : `+${needs.length - NEEDS_SHOWN} more`}
										</button>
									) : (
										<span />
									)}
									{hasSuggestion && (
										<Button size="sm" onClick={fileAllSuggested} data-testid="cal-file-suggested">
											File suggested
										</Button>
									)}
								</div>
							</>
						)}
					</section>
				</aside>
			</div>

			{pop && popEvent && (
				<div
					ref={popRef}
					data-cal-pop
					role="dialog"
					aria-label={popEvent.title}
					style={{ position: "fixed", left: popAt?.left ?? -9999, top: popAt?.top ?? 0, visibility: popAt ? "visible" : "hidden" }}
					className="z-50 flex w-[19rem] max-w-[calc(100vw-1.5rem)] flex-col gap-3 rounded-2xl border bg-card p-3.5 shadow-xl"
				>
					<div>
						<h4 className="text-lg font-semibold leading-snug">{popEvent.title}</h4>
						<p className="text-xs tabular-nums text-muted-foreground">
							{popEvent.kind === "exam" ? "Exam · " : ""}
							{fmt(popEvent.start, { weekday: "long", day: "numeric", month: "long" })}
							{popEvent.allDay ? " · all day" : ` · ${span(popEvent)}`}
						</p>
					</div>
					<StatusLine event={popEvent} groupOf={groupOf} colorOf={colorOf} />
					{pop.mode === "menu" ? (
						<>
							<div>
								<p className="mb-1 text-[11px] font-semibold text-muted-foreground">{popEvent.placement.state === "filed" ? "Move to" : "File under"}</p>
								<ul className="flex flex-col">
									{groups.map((g) => {
										const here = popEvent.placement.state === "filed" && popEvent.placement.key === g.key;
										const suggested = popEvent.placement.state === "unplaced" && popEvent.placement.guess === g.key;
										return (
											<li key={g.key}>
												<button
													type="button"
													data-testid="cal-pick"
													onClick={() => (here ? setPop(null) : file(popEvent, g.key, pop.all))}
													className={cn(`cal-c${colorOf.get(g.key) ?? 0}`, "grid w-full grid-cols-[0.625rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-foreground/5")}
												>
													<span className="size-2.5 rounded-[3px]" style={{ background: "var(--bar)" }} />
													<span className="truncate">{g.label}</span>
													{here ? <CheckIcon className="size-3.5 text-good" /> : suggested ? <span className="rounded-full bg-good-soft px-2 text-[11px] font-semibold text-good-ink">Suggested</span> : <span />}
												</button>
											</li>
										);
									})}
								</ul>
							</div>
							<ScopeSwitch count={sameTitle(popEvent).length} all={pop.all} onChange={(all) => setPop({ ...pop, all })} />
							<div className="flex justify-between gap-2 border-t pt-2">
								<button type="button" className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground" onClick={() => setPop({ ...pop, mode: "new" })}>
									+ New class
								</button>
								<button type="button" data-testid="cal-pick-ignored" className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-foreground/5 hover:text-foreground" onClick={() => file(popEvent, IGNORED, pop.all)}>
									Not a class
								</button>
							</div>
						</>
					) : (
						<form
							className="flex flex-col gap-3"
							onSubmit={(ev) => {
								ev.preventDefault();
								void createAndFile(popEvent, newName, pop.all);
							}}
						>
							<label className="flex flex-col gap-1 text-[11px] font-semibold text-muted-foreground">
								New class name
								<input
									autoFocus
									data-testid="cal-new-name"
									value={newName}
									onChange={(e) => setNewName(e.target.value)}
									className="rounded-md border bg-background px-2.5 py-1.5 text-sm font-normal text-foreground"
								/>
							</label>
							<ScopeSwitch count={sameTitle(popEvent).length} all={pop.all} onChange={(all) => setPop({ ...pop, all })} />
							<div className="flex justify-end gap-2">
								<Button type="button" size="sm" variant="ghost" onClick={() => setPop({ ...pop, mode: "menu" })}>
									Back
								</Button>
								<Button type="submit" size="sm" disabled={!newName.trim()} data-testid="cal-new-create">
									Create class
								</Button>
							</div>
						</form>
					)}
				</div>
			)}

			{toast && (
				<div role="status" data-testid="cal-toast" className="fixed bottom-5 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-xl bg-foreground py-2.5 pr-2 pl-4 text-sm text-background shadow-xl">
					<span>{toast.text}</span>
					<button
						type="button"
						className="rounded-md px-2.5 py-1 font-semibold hover:bg-background/20"
						onClick={() => {
							const undo = toast.undo;
							setToast(null);
							void undo().catch((err) => setError(err instanceof Error ? err.message : String(err)));
						}}
					>
						Undo
					</button>
				</div>
			)}
		</div>
	);
}

/** "November" (or "November – December") and "2 – 6 Nov", for the week's heading. */
function weekHeading(days: number[]): { title: string; sub: string } {
	const a = days[0]!;
	const b = days[days.length - 1]!;
	const m = (ms: number) => fmt(ms, { month: "long" });
	return {
		title: m(a) === m(b) ? m(a) : `${m(a)} – ${m(b)}`,
		sub: `${fmt(a, { day: "numeric" })} – ${fmt(b, { day: "numeric", month: "short" })}`,
	};
}

function StatusLine({ event, groupOf, colorOf }: { event: CalEvent; groupOf: Map<string, CalGroup>; colorOf: Map<string, number> }) {
	const p = event.placement;
	if (p.state === "filed") {
		const g = groupOf.get(p.key);
		return (
			<div className={cn(`cal-c${colorOf.get(p.key) ?? 0}`, "flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs")}>
				<span className="size-2 shrink-0 rounded-full" style={{ background: "var(--bar)" }} />
				<span>
					{p.by === "you" ? "You filed this under" : "Filed automatically under"} <b>{g?.label ?? p.key}</b>
				</span>
			</div>
		);
	}
	if (p.state === "ignored") {
		return <div className="rounded-lg bg-muted px-2.5 py-1.5 text-xs">{p.by === "you" ? "You marked this" : "Treated as"} <b>not a class</b></div>;
	}
	const g = p.guess ? groupOf.get(p.guess) : undefined;
	return (
		<div className="flex items-center gap-2 rounded-lg bg-muted px-2.5 py-1.5 text-xs">
			<span className="size-2 shrink-0 rounded-full bg-warn" />
			<span>
				Not filed yet{g ? <> · looks like <b>{g.label}</b></> : null}
			</span>
		</div>
	);
}

function ScopeSwitch({ count, all, onChange }: { count: number; all: boolean; onChange: (all: boolean) => void }) {
	if (count < 2) return null;
	return (
		<div role="group" aria-label="Apply to" className="grid grid-cols-2 gap-0.5 rounded-lg bg-muted p-0.5 text-xs">
			{[
				[true, `All ${count} like this`],
				[false, "Only this one"],
			].map(([v, label]) => (
				<button
					key={String(v)}
					type="button"
					aria-pressed={all === v}
					onClick={() => onChange(v as boolean)}
					className={cn("truncate rounded-md px-2 py-1.5 text-muted-foreground", all === v && "bg-card font-semibold text-foreground shadow-xs")}
				>
					{label as string}
				</button>
			))}
		</div>
	);
}

/** Where an event sits across its day: two overlapping events cascade (the later one on top, wider), more share the width. */
function placeSlot(slot: { col: number; cols: number }): React.CSSProperties {
	if (slot.cols === 2) return slot.col === 0 ? { left: 5, width: "calc(62% - 7px)" } : { left: "calc(34% + 2px)", width: "calc(66% - 7px)" };
	return { left: `calc(${slot.col} * 100% / ${slot.cols} + 5px)`, width: `calc(100% / ${slot.cols} - 10px)` };
}

/** Skin of one event, from its placement. */
function eventLook(e: CalEvent, color: number | undefined): { className: string; style: React.CSSProperties } {
	const p = e.placement;
	const exam = e.kind === "exam";
	if (p.state === "filed") {
		return exam
			? { className: `cal-c${color ?? 0} shadow-[0_6px_16px_-8px_var(--bar)]`, style: { background: "var(--bar)", color: "var(--background)" } }
			: { className: `cal-c${color ?? 0} border border-[color-mix(in_srgb,var(--bar)_22%,transparent)]`, style: { background: "var(--tint)", color: "var(--ink)" } };
	}
	if (p.state === "unplaced") {
		return exam
			? { className: "text-card shadow-[0_6px_16px_-8px_rgba(31,30,29,0.5)]", style: { background: "color-mix(in srgb, var(--foreground) 78%, var(--card))" } }
			: { className: "border border-dashed border-warn/60 text-foreground", style: { background: "var(--card)" } };
	}
	return { className: "border border-dashed border-border text-muted-foreground opacity-60", style: { background: "var(--muted)" } };
}

function AllDayRow({ days, events, colorOf, onOpen }: { days: number[]; events: CalEvent[]; colorOf: Map<string, number>; onOpen: (e: CalEvent) => void }) {
	const allDay = events.filter((e) => e.allDay);
	if (allDay.length === 0) return null;
	return (
		<>
			<div className="border-b px-1 py-1.5 text-right text-[10px] leading-5 text-muted-foreground/70">all day</div>
			{days.map((d) => (
				<div key={d} className="flex min-w-0 flex-col gap-0.5 border-b border-l px-1 py-1">
					{allDay
						.filter((e) => e.start >= d && e.start < d + DAY_MS)
						.map((e) => {
							const look = eventLook(e, e.placement.state === "filed" ? colorOf.get(e.placement.key) : undefined);
							return (
								<button key={e.id} type="button" data-event-id={e.id} onClick={() => onOpen(e)} className={cn(look.className, "truncate rounded-md px-1.5 py-0.5 text-left text-[11px] font-medium")} style={look.style}>
									{e.title}
								</button>
							);
						})}
				</div>
			))}
		</>
	);
}

function DayColumn({
	day,
	events,
	now,
	range,
	colorOf,
	groupOf,
	focus,
	openId,
	onOpen,
}: {
	day: number;
	events: CalEvent[];
	now: number;
	range: { from: number; to: number };
	colorOf: Map<string, number>;
	groupOf: Map<string, CalGroup>;
	focus: string | null;
	openId: string | null;
	onOpen: (e: CalEvent) => void;
}) {
	const height = (range.to - range.from) * HOUR_PX + 2 * PAD_PX;
	const spans = events.map((e) => {
		const start = minutesOfDay(e.start);
		return { start, end: Math.min(24 * 60, start + Math.max(1, Math.round((e.end - e.start) / 60000))) };
	});
	const slots = packDay(spans);
	const today = new Date(day).toDateString() === new Date(now).toDateString();
	const y = (min: number) => PAD_PX + ((min - range.from * 60) / 60) * HOUR_PX;
	return (
		<div
			className={cn("relative border-l", today && "bg-good-soft/40")}
			style={{
				height,
				backgroundImage: "linear-gradient(to bottom, color-mix(in srgb, var(--border) 45%, transparent) 1px, transparent 1px)",
				backgroundSize: `100% ${HOUR_PX}px`,
				backgroundPosition: `0 ${PAD_PX}px`,
			}}
		>
			{today && <div className="pointer-events-none absolute right-0 -left-px z-[5] h-0.5 bg-[#d0453a]" style={{ top: y(minutesOfDay(now)) }}><span className="absolute -top-[3px] -left-1 size-2 rounded-full bg-[#d0453a]" /></div>}
			{events.map((e, i) => {
				const slot = slots[i]!;
				const s = spans[i]!;
				const top = y(s.start) + 1;
				const h = Math.max(22, ((Math.max(s.end - s.start, 1)) / 60) * HOUR_PX - 3);
				const key = e.placement.state === "filed" ? e.placement.key : undefined;
				const look = eventLook(e, key ? colorOf.get(key) : undefined);
				const exam = e.kind === "exam";
				const compact = h < 46;
				const narrow = slot.cols > 2 || (slot.cols === 2 && slot.col === 0);
				const dim = focus !== null && key !== focus;
				const past = e.end < now;
				const label = key ? groupOf.get(key)?.label : e.placement.state === "ignored" ? "Not a class" : "Needs a class";
				const unplaced = e.placement.state === "unplaced";
				const bar = !exam && e.placement.state !== "ignored";
				return (
					<button
						key={e.id}
						type="button"
						draggable
						data-testid="cal-event"
						data-state={e.placement.state}
						data-event-id={e.id}
						aria-label={`${e.title}, ${span(e)}, ${label}`}
						onDragStart={(ev) => ev.dataTransfer.setData("text/plain", e.id)}
						onClick={() => onOpen(e)}
						className={cn(
							look.className,
							"absolute z-10 flex cursor-pointer overflow-hidden rounded-[9px] py-1.5 pr-2 text-left text-xs leading-[1.35] transition-[box-shadow,opacity] hover:z-30 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring",
							bar ? "pl-3" : "pl-2.5",
							compact ? "flex-row items-center gap-1.5 py-0" : "flex-col",
							slot.cols > 1 && slot.col > 0 && "ring-2 ring-card",
							past && "opacity-55",
							dim && "opacity-15",
							openId === e.id && "z-30 ring-2 ring-foreground ring-offset-1 ring-offset-card",
						)}
						style={{ ...look.style, top, height: h, ...placeSlot(slot) }}
					>
						{bar && <span className={cn("absolute top-[5px] bottom-[5px] left-1 w-[3px] rounded-full", unplaced && "bg-warn/60")} style={unplaced ? undefined : { background: "var(--bar)" }} />}
						{exam && !compact && e.placement.state !== "ignored" && (
							<span className="mb-1 self-start rounded-[5px] bg-[color-mix(in_srgb,var(--background)_22%,transparent)] px-1.5 py-0.5 text-[10px] leading-none font-bold tracking-[0.06em] uppercase">Exam</span>
						)}
						<span className={cn("min-w-0 text-[12.5px] font-semibold", narrow && !compact ? "line-clamp-2 break-words" : "truncate")}>{e.title}</span>
						{!compact && <span className="truncate tabular-nums opacity-80">{narrow ? clock(e.start) : span(e)}</span>}
						{!compact && !narrow && h > 76 && key && !exam && <span className="mt-0.5 truncate opacity-60">{label}</span>}
						{!compact && h > 76 && unplaced && !exam && !narrow && (
							<span className="mt-1.5 inline-flex items-center gap-[5px] self-start rounded-full bg-warn-soft py-0.5 pr-2 pl-[7px] text-[11px] font-semibold text-warn-ink">
								<span className="size-1.5 rounded-full bg-warn" />
								Needs a class
							</span>
						)}
						{!compact && h > 60 && unplaced && exam && (
							<span className="mt-0.5 inline-flex items-center gap-1.5 truncate font-semibold text-warn-soft">
								<span className="size-1.5 shrink-0 rounded-full bg-warn" />
								Not filed
							</span>
						)}
						{compact && !narrow && <span className="shrink-0 tabular-nums opacity-80">{clock(e.start)}</span>}
						{unplaced && narrow && compact && <span className="absolute right-1.5 bottom-1.5 size-2 rounded-full bg-warn ring-2 ring-card" title="Needs a class" />}
					</button>
				);
			})}
		</div>
	);
}

/** The study plan's sessions for each day of the week, above the hours (the plan sets the day, not the hour). */
function PlanRow({ days, plan }: { days: number[]; plan: Map<string, BriefingItem[]> }) {
	if (!days.some((d) => (plan.get(ymd(d))?.length ?? 0) > 0)) return null;
	return (
		<>
			<div className="border-b px-1 py-2 text-right text-[10px] leading-5 text-muted-foreground/70">plan</div>
			{days.map((d) => (
				<div key={d} data-testid="cal-plan-day" className="flex min-w-0 flex-col gap-1 border-b border-l px-1.5 py-1.5">
					{(plan.get(ymd(d)) ?? []).map((item) => (
						<Link
							key={item.id}
							href="/"
							title={`${item.title} · ${item.minutes} min. ${item.reason}`}
							className="flex min-w-0 items-center gap-2 rounded-[9px] border border-good/25 bg-card px-2 py-1.5 text-xs text-good-ink shadow-[0_1px_2px_rgba(29,69,102,0.06)] hover:border-good/50"
						>
							<span className="grid size-5 shrink-0 place-items-center rounded-full bg-good">
								<PlayIcon className="size-2 fill-background text-background" />
							</span>
							<span className="min-w-0 leading-tight">
								<span className="block truncate font-semibold">{item.title}</span>
								<span className="block truncate text-[11px] opacity-75">{item.minutes} min</span>
							</span>
						</Link>
					))}
				</div>
			))}
		</>
	);
}

/** Monday-first days of the 6-week block that shows `month`. */
function monthCells(month: number): number[] {
	const first = new Date(month);
	const lead = (first.getDay() + 6) % 7;
	return Array.from({ length: 42 }, (_, i) => new Date(first.getFullYear(), first.getMonth(), 1 - lead + i).getTime());
}

const WEEKDAY_INITIALS = ["M", "T", "W", "T", "F", "S", "S"];

/** The side panel's small month: the week on show as a band, exam days dotted, click a day to go to its week. */
function MiniMonth({
	month,
	from,
	to,
	now,
	week,
	examDays,
	onPick,
}: {
	month: number;
	from: number;
	to: number;
	now: number;
	week: number | undefined;
	examDays: Set<string>;
	onPick: (day: number) => void;
}) {
	const cells = monthCells(month);
	const m = new Date(month).getMonth();
	const today = ymd(now);
	return (
		<div>
			<div className="mb-2.5 flex items-center justify-between">
				<span className="text-sm font-semibold">{fmt(month, { month: "long" })}</span>
				{examDays.size > 0 && (
					<span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
						<span className="size-1.5 rounded-full bg-warn" />
						exam
					</span>
				)}
			</div>
			<div className="grid grid-cols-7 gap-y-0.5 text-center text-xs tabular-nums" data-testid="cal-mini-month">
				{WEEKDAY_INITIALS.map((w, i) => (
					<span key={i} className="pb-1 text-[10.5px] font-semibold text-muted-foreground/70">
						{w}
					</span>
				))}
				{cells.map((d, i) => {
					const inWeek = week !== undefined && d >= week && d < week + 7 * DAY_MS;
					const out = new Date(d).getMonth() !== m;
					const reachable = d >= from && d < to;
					const isToday = ymd(d) === today;
					return (
						<button
							key={d}
							type="button"
							disabled={!reachable}
							onClick={() => onPick(d)}
							aria-label={fmt(d, { weekday: "long", day: "numeric", month: "long" })}
							className={cn(
								"relative grid h-7 place-items-center disabled:cursor-default",
								out || !reachable ? "text-muted-foreground/45" : "text-foreground/85 hover:text-foreground",
								inWeek && "bg-good-soft",
								inWeek && i % 7 === 0 && "rounded-l-lg",
								inWeek && i % 7 === 6 && "rounded-r-lg",
							)}
						>
							{isToday && <span className="absolute size-[26px] rounded-full bg-good" />}
							<span className={cn("relative", isToday && "font-semibold text-background")}>{new Date(d).getDate()}</span>
							{examDays.has(ymd(d)) && <span className="absolute bottom-0.5 size-1 rounded-full bg-warn" />}
						</button>
					);
				})}
			</div>
		</div>
	);
}

/** The month view: every day with its first events (exams first), the plan's sessions, click a day for its week. */
function MonthGrid({
	month,
	from,
	to,
	now,
	events,
	plan,
	colorOf,
	focus,
	onOpen,
	onPickDay,
}: {
	month: number;
	from: number;
	to: number;
	now: number;
	events: CalEvent[];
	plan: Map<string, BriefingItem[]> | null;
	colorOf: Map<string, number>;
	focus: string | null;
	onOpen: (e: CalEvent) => void;
	onPickDay: (day: number) => void;
}) {
	const cells = monthCells(month);
	const m = new Date(month).getMonth();
	const today = ymd(now);
	const SHOWN = 3;
	return (
		<div className="border-t" data-testid="cal-month">
			<div className="grid grid-cols-7">
				{cells.slice(0, 7).map((d) => (
					<div key={d} className="px-2.5 pt-2.5 pb-2 text-[11.5px] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
						{fmt(d, { weekday: "short" })}
					</div>
				))}
			</div>
			<div className="grid grid-cols-7">
				{cells.map((d, i) => {
					const out = new Date(d).getMonth() !== m;
					const reachable = d >= from && d < to;
					const key = ymd(d);
					const dayEvents = reachable && !out ? events.filter((e) => ymd(e.start) === key).sort((a, b) => Number(b.kind === "exam") - Number(a.kind === "exam") || a.start - b.start) : [];
					const items = reachable && !out && plan ? (plan.get(key) ?? []) : [];
					const total = dayEvents.length + items.length;
					const weekend = i % 7 >= 5;
					return (
						<div
							key={d}
							className={cn(
								"flex min-h-[7.25rem] min-w-0 flex-col gap-[3px] border-t p-2",
								i % 7 !== 0 && "border-l",
								out || !reachable ? "bg-muted/40" : weekend && "bg-sidebar/30",
							)}
						>
							<button
								type="button"
								disabled={!reachable}
								onClick={() => onPickDay(d)}
								aria-label={`Week of ${fmt(d, { day: "numeric", month: "long" })}`}
								className={cn(
									"mb-0.5 grid size-[26px] place-items-center rounded-lg text-[13px] font-semibold tabular-nums enabled:hover:bg-foreground/5",
									out || !reachable ? "text-muted-foreground/45" : "text-foreground/85",
									key === today && "bg-good text-background enabled:hover:bg-good",
								)}
							>
								{new Date(d).getDate()}
							</button>
							{dayEvents.slice(0, SHOWN).map((e) => {
								const k = e.placement.state === "filed" ? e.placement.key : undefined;
								const exam = e.kind === "exam";
								const unplaced = e.placement.state === "unplaced";
								const ignored = e.placement.state === "ignored";
								const dim = focus !== null && k !== focus;
								return (
									<button
										key={e.id}
										type="button"
										data-event-id={e.id}
										data-testid="cal-month-event"
										onClick={() => onOpen(e)}
										className={cn(
											k !== undefined && `cal-c${colorOf.get(k) ?? 0}`,
											"flex h-[22px] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-left text-[11.5px] leading-none whitespace-nowrap",
											exam && !ignored
												? unplaced
													? "bg-[color-mix(in_srgb,var(--foreground)_78%,var(--card))] font-semibold text-card"
													: "bg-[var(--bar)] font-semibold text-background shadow-[0_4px_10px_-6px_var(--bar)]"
												: unplaced
													? "border border-dashed border-warn/60 text-foreground/85"
													: ignored
														? "text-muted-foreground opacity-60"
														: "text-foreground/85 hover:bg-foreground/5",
											dim && "opacity-25",
										)}
									>
										{exam && !ignored ? (
											<span className="rounded bg-[color-mix(in_srgb,var(--background)_22%,transparent)] px-1 py-0.5 text-[9.5px] font-bold tracking-[0.06em] uppercase">Exam</span>
										) : (
											<span className={cn("size-1.5 shrink-0 rounded-full", unplaced ? "bg-warn" : ignored ? "bg-border" : "bg-[var(--bar)]")} />
										)}
										<span className="min-w-0 truncate">{e.title}</span>
									</button>
								);
							})}
							{items.slice(0, Math.max(0, SHOWN - dayEvents.length)).map((item) => (
								<Link key={item.id} href="/" title={`${item.title} · ${item.minutes} min`} className="flex h-[22px] min-w-0 items-center gap-1.5 rounded-md border border-good/25 bg-card px-1.5 text-[11.5px] leading-none text-good-ink">
									<span className="size-1.5 shrink-0 rounded-[2px] bg-good" />
									<span className="min-w-0 truncate">{item.title}</span>
								</Link>
							))}
							{total > SHOWN && (
								<button type="button" onClick={() => onPickDay(d)} className="self-start pl-1.5 text-[11.5px] text-muted-foreground hover:text-foreground">
									+{total - SHOWN} more
								</button>
							)}
						</div>
					);
				})}
			</div>
		</div>
	);
}
