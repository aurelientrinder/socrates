"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CheckIcon, ChevronLeftIcon, ChevronRightIcon, RefreshCwIcon } from "lucide-react";
import { IGNORED, dayOf, hourRange, minutesOfDay, packDay, titleKey, weekStarts, type EventKind } from "@/src/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * THE CLASS CALENDAR (Library › Calendar, 2026-10-29): eight weeks of the
 * learner's calendar as a week grid, every event filed under a class, marked
 * "not a class", or waiting for one (hatched/dashed amber), so nothing the
 * classifier missed is silent. Click an event to choose its class, or drag
 * it onto a class in the rail. A choice is a pin stored apart from the
 * classifier (src/core/course-calendar.ts), so it survives a re-read of the
 * calendar; every change has an Undo.
 */

// Transport-only mirrors of src/core/course-calendar.ts and src/server/course-calendar.ts.
type Placement =
	| { state: "filed"; key: string; by: "you" | "auto" }
	| { state: "ignored"; by: "you" | "auto" }
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

export function CourseCalendar() {
	const [data, setData] = useState<CalendarData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [refreshing, setRefreshing] = useState(false);
	const [week, setWeek] = useState(0);
	const [pop, setPop] = useState<Popover | null>(null);
	const [focus, setFocus] = useState<string | null>(null);
	const [showIgnored, setShowIgnored] = useState(false);
	const [toast, setToast] = useState<Toast | null>(null);
	const [newName, setNewName] = useState("");
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

	// ── drag and drop ──────────────────────────────────────────────────────
	const [over, setOver] = useState<string | null>(null);
	const dropOn = (target: string) => (ev: React.DragEvent) => {
		ev.preventDefault();
		setOver(null);
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
	const heading = days.length > 0 ? weekHeading(days) : { title: "", sub: "" };

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
			<div className="grid overflow-hidden rounded-2xl border bg-card lg:grid-cols-[17rem_minmax(0,1fr)]">
				{/* ── rail ─────────────────────────────────────────────── */}
				<aside className="order-2 flex min-w-0 flex-col gap-5 border-t bg-sidebar p-3.5 lg:order-1 lg:max-h-[52rem] lg:overflow-y-auto lg:border-t-0 lg:border-r">
					<section aria-labelledby="cal-classes">
						<h3 id="cal-classes" className="mb-1.5 px-1.5 text-xs font-semibold text-muted-foreground">
							Classes
						</h3>
						{groups.length === 0 && <p className="px-1.5 text-sm text-muted-foreground">No classes yet. File an event under “New class” to make one.</p>}
						<ul className="flex flex-col gap-0.5">
							{groups.map((g) => (
								<li key={g.key}>
									<button
										type="button"
										data-testid="cal-class"
										aria-pressed={focus === g.key}
										onClick={() => setFocus(focus === g.key ? null : g.key)}
										{...dropProps(g.key)}
										className={cn(
											`cal-c${colorOf.get(g.key) ?? 0}`,
											"grid w-full grid-cols-[0.75rem_minmax(0,1fr)_auto] items-center gap-x-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-foreground/5",
											focus === g.key && "bg-card ring-1 ring-border",
											over === g.key && "bg-good-soft ring-[1.5px] ring-good",
										)}
									>
										<span className="row-span-2 size-2.5 rounded-[3px]" style={{ background: "var(--bar)" }} />
										<span className="truncate text-sm font-semibold">{g.label}</span>
										<span className="row-span-2 text-xs tabular-nums text-muted-foreground">{g.events}</span>
										<span className={cn("col-start-2 truncate text-xs", g.nextExam ? "text-muted-foreground" : "text-warn-ink")}>
											{g.nextExam ? `Exam ${fmt(g.nextExam.start, { weekday: "short", day: "numeric", month: "short" })}` : "No exam in calendar"}
										</span>
									</button>
								</li>
							))}
						</ul>
						<div className="mt-1.5 flex flex-col gap-0.5 border-t pt-1.5">
							<div
								data-testid="cal-drop-new"
								{...dropProps("new")}
								className={cn("flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground", over === "new" && "bg-good-soft ring-[1.5px] ring-good")}
							>
								<span className="w-3 text-center">+</span>New class
							</div>
							<div
								data-testid="cal-drop-ignored"
								{...dropProps("ignored")}
								className={cn("flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground", over === "ignored" && "bg-good-soft ring-[1.5px] ring-good")}
							>
								<span className="w-3 text-center">⌀</span>
								<span>
									Not a class <span className="tabular-nums opacity-70">{cov.ignored}</span>
								</span>
							</div>
							<label className="mt-1 flex cursor-pointer items-center gap-2 px-2 py-1 text-xs text-muted-foreground">
								<input type="checkbox" checked={showIgnored} onChange={(e) => setShowIgnored(e.target.checked)} data-testid="cal-show-ignored" />
								Show them on the calendar
							</label>
						</div>
						<p className="mt-2 px-1.5 text-xs leading-snug text-muted-foreground/80">Drag an event onto a class to file it, or click it.</p>
					</section>

					<section aria-labelledby="cal-needs" data-testid="cal-needs">
						<h3 id="cal-needs" className="mb-1.5 flex items-baseline justify-between px-1.5 text-xs font-semibold text-muted-foreground">
							Needs a class
							{cov.unplaced > 0 && <span className="rounded-full bg-warn-soft px-2 text-[11px] tabular-nums text-warn-ink">{cov.unplaced}</span>}
						</h3>
						{needs.length === 0 ? (
							<p className="flex items-center gap-2 px-1.5 text-sm text-muted-foreground">
								<CheckIcon className="size-4 text-good" />
								Every event has a class.
							</p>
						) : (
							<>
								<ul className="flex flex-col gap-1.5">
									{needs.map(({ key, first, count }) => {
										const guess = first.placement.state === "unplaced" ? first.placement.guess : null;
										const g = guess ? groupOf.get(guess) : undefined;
										return (
											<li
												key={key}
												data-need
												draggable
												onDragStart={(ev) => ev.dataTransfer.setData("text/plain", first.id)}
												className="flex min-w-0 cursor-grab flex-col gap-0.5 rounded-[10px] border border-dashed border-warn/70 bg-card px-2.5 py-2"
											>
												<button type="button" onClick={() => openEvent(first)} className="min-w-0 text-left">
													<span className="block truncate text-sm font-semibold">{first.title}</span>
													<span className="block text-xs tabular-nums text-muted-foreground">
														{count > 1 ? `${count} events · ${fmt(first.start, { weekday: "short" })}s ${clock(first.start)}` : `${fmt(first.start, { weekday: "short", day: "numeric", month: "short" })} · ${clock(first.start)}${first.kind === "exam" ? " · exam" : ""}`}
													</span>
												</button>
												{g && (
													<button
														type="button"
														onClick={() => file(first, g.key, count > 1 && first.kind !== "exam")}
														className={cn(`cal-c${colorOf.get(g.key) ?? 0}`, "mt-1 flex max-w-full items-center gap-1.5 self-start rounded-md px-2 py-1 text-xs font-semibold")}
														style={{ background: "var(--tint)", color: "var(--ink)" }}
													>
														<span className="size-1.5 shrink-0 rounded-full" style={{ background: "var(--bar)" }} />
														<span className="truncate">
															<span className="font-medium opacity-80">File under </span>
															{g.label}
														</span>
													</button>
												)}
											</li>
										);
									})}
								</ul>
								{hasSuggestion && (
									<button type="button" onClick={fileAllSuggested} className="mt-1.5 px-1.5 py-1 text-xs font-semibold text-good hover:underline">
										File all as suggested
									</button>
								)}
							</>
						)}
					</section>

					<section aria-labelledby="cal-weeks">
						<h3 id="cal-weeks" className="mb-1.5 px-1.5 text-xs font-semibold text-muted-foreground">
							Jump to a week
						</h3>
						<ul className="flex flex-col gap-0.5">
							{weeks.map((w, i) => {
								const inWeek = events.filter((e) => e.start >= w && e.start < w + 7 * DAY_MS);
								const open = inWeek.filter((e) => e.placement.state === "unplaced").length;
								const exams = inWeek.filter((e) => e.kind === "exam" && e.placement.state !== "ignored").length;
								return (
									<li key={w}>
										<button
											type="button"
											aria-current={i === week ? "true" : undefined}
											onClick={() => {
												setWeek(i);
												setPop(null);
											}}
											className={cn("flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-sm tabular-nums hover:bg-foreground/5", i === week && "bg-card font-semibold ring-1 ring-border")}
										>
											<span>{fmt(w, { day: "numeric", month: "short" })}</span>
											<span className="flex items-center gap-1.5 text-[11px] font-medium">
												{exams > 0 && <span className="text-muted-foreground">{exams} exam{exams === 1 ? "" : "s"}</span>}
												{open > 0 && <span className="rounded-full bg-warn-soft px-1.5 text-warn-ink">{open}</span>}
											</span>
										</button>
									</li>
								);
							})}
						</ul>
					</section>
				</aside>

				{/* ── the week ─────────────────────────────────────────── */}
				<section className="order-1 flex min-w-0 flex-col lg:order-2" aria-label="Week">
					<div className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-3.5">
						<h2 className="text-xl font-semibold" data-testid="cal-title">
							{heading.title}
							<span className="ml-2 text-sm font-normal tabular-nums text-muted-foreground">{heading.sub}</span>
						</h2>
						<div className="flex items-center gap-3">
							<span className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="cal-coverage">
								<Ring done={cov.filed} total={cov.filed + cov.unplaced} />
								<span className="tabular-nums">
									{cov.filed} of {cov.filed + cov.unplaced} filed
								</span>
							</span>
							{data.connected && (
								<Button size="icon-sm" variant="ghost" aria-label="Refresh from Google Calendar" onClick={() => void load(true)} disabled={refreshing}>
									<RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
								</Button>
							)}
							<div className="flex overflow-hidden rounded-md border">
								<Button size="icon-sm" variant="ghost" className="rounded-none" aria-label="Previous week" disabled={week === 0} onClick={() => { setWeek(week - 1); setPop(null); }}>
									<ChevronLeftIcon className="size-4" />
								</Button>
								<Button size="sm" variant="ghost" className="rounded-none border-x" onClick={() => { setWeek(0); setPop(null); }}>
									Today
								</Button>
								<Button size="icon-sm" variant="ghost" className="rounded-none" aria-label="Next week" disabled={week === WEEKS - 1} onClick={() => { setWeek(week + 1); setPop(null); }}>
									<ChevronRightIcon className="size-4" />
								</Button>
							</div>
						</div>
					</div>

					<div className="overflow-x-auto" data-testid="cal-grid-wrap">
						<div className="grid" style={{ gridTemplateColumns: `${GUTTER_PX}px repeat(${nDays}, minmax(7.5rem, 1fr))`, minWidth: GUTTER_PX + nDays * 120 }}>
							<div className="border-b" />
							{days.map((d) => {
								const today = new Date(d).toDateString() === new Date(data.now).toDateString();
								const past = d + DAY_MS <= data.now && !today;
								return (
									<div key={d} className={cn("flex items-center gap-1.5 border-b px-2.5 py-2", past && "text-muted-foreground/60")}>
										<span className={cn("text-xs font-medium", today ? "font-semibold text-good-ink" : "text-muted-foreground")}>{fmt(d, { weekday: "short" })}</span>
										<span className={cn("grid size-7 place-items-center rounded-full text-base font-semibold tabular-nums", today && "bg-good text-white")}>{new Date(d).getDate()}</span>
									</div>
								);
							})}
							<AllDayRow days={days} events={weekEvents} colorOf={colorOf} onOpen={openEvent} />
							<div className="relative" style={{ height: (range.to - range.from) * HOUR_PX + 2 * PAD_PX }} aria-hidden>
								{Array.from({ length: range.to - range.from + 1 }, (_, i) => (
									<span key={i} className="absolute right-2 -translate-y-1/2 text-[11px] tabular-nums leading-none text-muted-foreground/70" style={{ top: PAD_PX + i * HOUR_PX }}>
										{String(range.from + i).padStart(2, "0")}:00
									</span>
								))}
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

function Ring({ done, total }: { done: number; total: number }) {
	const r = 7;
	const c = 2 * Math.PI * r;
	const full = total === 0 || done >= total;
	return (
		<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="shrink-0">
			<circle cx="9" cy="9" r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
			<circle cx="9" cy="9" r={r} fill="none" stroke={full ? "var(--lh-good)" : "var(--lh-warn)"} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${total === 0 ? c : (c * done) / total} ${c}`} transform="rotate(-90 9 9)" />
		</svg>
	);
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

/** Skin of one event, from its placement. */
function eventLook(e: CalEvent, color: number | undefined): { className: string; style: React.CSSProperties } {
	const p = e.placement;
	if (p.state === "filed") {
		const exam = e.kind === "exam";
		return {
			className: `cal-c${color ?? 0}`,
			style: exam ? { background: "var(--bar)", color: "#fff" } : { background: "var(--tint)", color: "var(--ink)" },
		};
	}
	if (p.state === "unplaced") {
		return {
			className: "border-[1.5px] border-dashed border-warn text-warn-ink",
			style: { background: e.kind === "exam" ? "var(--lh-warn-soft)" : "var(--card)" },
		};
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
				backgroundImage: "linear-gradient(to bottom, color-mix(in srgb, var(--border) 55%, transparent) 1px, transparent 1px)",
				backgroundSize: `100% ${HOUR_PX}px`,
				backgroundPosition: `0 ${PAD_PX}px`,
			}}
		>
			{today && <div className="pointer-events-none absolute right-0 left-0 z-20 h-0.5 bg-[#c8463b]" style={{ top: y(minutesOfDay(now)) }}><span className="absolute -top-[3px] -left-[5px] size-2.5 rounded-full bg-[#c8463b]" /></div>}
			{events.map((e, i) => {
				const slot = slots[i]!;
				const s = spans[i]!;
				const top = y(s.start) + 1;
				const h = Math.max(22, ((Math.max(s.end - s.start, 1)) / 60) * HOUR_PX - 3);
				const key = e.placement.state === "filed" ? e.placement.key : undefined;
				const look = eventLook(e, key ? colorOf.get(key) : undefined);
				const exam = e.kind === "exam";
				const compact = h < 46;
				const narrow = slot.cols > 1;
				const dim = focus !== null && key !== focus;
				const past = e.end < now;
				const label = key ? groupOf.get(key)?.label : e.placement.state === "ignored" ? "Not a class" : "Needs a class";
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
							"absolute z-10 flex cursor-pointer overflow-hidden rounded-lg px-2 py-1 text-left text-xs leading-tight transition-[box-shadow,opacity] hover:z-30 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring",
							compact ? "flex-row items-center gap-1.5" : "flex-col gap-px",
							past && "opacity-55",
							dim && "opacity-15",
							openId === e.id && "z-30 ring-2 ring-foreground ring-offset-1 ring-offset-card",
						)}
						style={{ ...look.style, top, height: h, left: `calc(${slot.col} * 100% / ${slot.cols} + 3px)`, width: `calc(100% / ${slot.cols} - 6px)` }}
					>
						{e.placement.state === "filed" && !exam && <span className="absolute top-1 bottom-1 left-1 w-[3px] rounded-full" style={{ background: "var(--bar)" }} />}
						<span className={cn("min-w-0", e.placement.state === "filed" && !exam && "pl-1.5", narrow && !compact ? "line-clamp-2 break-words" : "truncate", "font-semibold")}>
							{exam && <span className={cn("mr-1.5 inline-block rounded px-1 py-px align-[1px] text-[9px] font-bold uppercase tracking-wider", e.placement.state === "filed" ? "bg-white/25" : "bg-warn text-white")}>Exam</span>}
							{e.title}
						</span>
						{!compact && !narrow && (
							<span className={cn("truncate tabular-nums opacity-80", e.placement.state === "filed" && !exam && "pl-1.5")}>{span(e)}</span>
						)}
						{!compact && !narrow && h > 76 && <span className={cn("truncate opacity-80", e.placement.state === "filed" && !exam && "pl-1.5")}>{label}</span>}
						{compact && !narrow && <span className="shrink-0 tabular-nums opacity-80">{clock(e.start)}</span>}
						{narrow && <span className="absolute right-1.5 bottom-1.5 size-2 rounded-full bg-warn ring-2 ring-card" title="Overlaps another event" />}
					</button>
				);
			})}
		</div>
	);
}
