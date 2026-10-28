"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarPlusIcon, FlameIcon, ListPlusIcon, Loader2Icon, PlayIcon, RefreshCwIcon, ZapIcon } from "lucide-react";
import {
	BUDGET_CHOICES,
	STREAK_MIN_MINUTES,
	quickPrompt,
	startPrompt,
	whenLabel,
	type BriefingItem,
	type BriefingPlan,
	type ClassEntry,
	type StudyEvent,
	type StudyStreak,
	type UpcomingEntry,
} from "@/src/core";
import { startDraftSession } from "@/components/new-session";
import { QUICK_SESSION_MINUTES, setSessionBudget } from "@/components/session-timer";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { onSettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { PageFrame } from "@/components/page-header";
import { useStartDialog } from "@/components/start-dialog";
import { ACTION_LABEL, ACTION_TAG, StudyPlanCard } from "@/components/study-plan-card";
import { cn } from "@/lib/utils";

/**
 * THE TODAY VIEW (daily briefing, the home screen since the redesign wave):
 * a plan card with at most three things to study today and why, inside the
 * time you have, with one button that starts the first; beside it what is
 * coming up in the next two weeks with a readiness bar, today's classes,
 * an honesty check when your answers show overconfidence, and a gentle
 * study streak with a five-minute way to keep it on a low day. Under the
 * plan, the study plan card shows the days up to each exam
 * (components/study-plan-card.tsx). The ranking is server-side code
 * (src/core/briefing.ts, src/core/study-plan.ts);
 * this view only shows it and runs the clicks — Start opens a fresh
 * session seeded with the item, and nothing reaches Google Calendar or
 * Todoist except through the two push buttons.
 */

export interface SourceState {
	connected: boolean;
	count: number;
	error?: string;
}

export interface BriefingData {
	plan: BriefingPlan;
	note: string;
	noteSource: "model" | "fallback";
	sources: { calendar: SourceState; todo: SourceState & { provider: string } };
	events: StudyEvent[];
	pushed: Record<string, { todo?: string; calendar?: string }>;
}

export interface IntegrationsData {
	google: { configured: boolean; connected: boolean; email?: string; pending: boolean; error?: string };
	todo: { id: string; label: string; configured: boolean }[];
}

export interface SessionOption {
	id: string;
	title: string;
}

interface Handlers {
	onStart: (item: BriefingItem) => void;
	/** The first step as a five-minute session (low-motivation days). */
	onQuick: (item: BriefingItem) => void;
	onPrimer: (entry: ClassEntry) => void;
	onPush: (item: BriefingItem, target: "todo" | "calendar") => void;
	onRefresh: () => void;
	onBudget: (minutes: number) => void;
	onConnectGoogle: () => void;
	onDisconnectGoogle: () => void;
	onOpenKeys: (keyId: string) => void;
	onLinkCourse: (key: string, label: string, chatIds: string[]) => void;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The pure shell — the render-test seam. */
export function TodayShell({
	briefing,
	integrations,
	budgetMinutes,
	sessions,
	busy,
	pushing,
	error,
	handlers,
	honesty = null,
	week = null,
	streak = null,
}: {
	briefing: BriefingData | null;
	integrations: IntegrationsData;
	budgetMinutes: number;
	sessions: SessionOption[];
	/** Generating or refreshing. */
	busy: boolean;
	/** "<itemId>:<target>" while a push is in flight. */
	pushing: string | null;
	error: string | null;
	handlers: Handlers;
	/** Set when quiz answers show clear overconfidence: the gap in points. */
	honesty?: { points: number } | null;
	/** Minutes studied each day this week (Monday first) and today's index. */
	week?: StudyWeek | null;
	/** The study streak; with the week, it shows in the This week card. */
	streak?: StudyStreak | null;
}) {
	const plan = briefing?.plan;
	const todo = integrations.todo[0];
	const items = plan?.items ?? [];
	const first = items[0];
	const { open: openStart } = useStartDialog();
	// Five minutes of the first step, or of something new when the plan is empty.
	const quick = () => (first ? handlers.onQuick(first) : openStart("learn", QUICK_SESSION_MINUTES));
	const total = items.reduce((sum, item) => sum + item.minutes, 0);
	return (
		<PageFrame
			title="Today"
			testId="today-view"
			width="max-w-6xl"
			actions={
				<Button variant="ghost" size="sm" onClick={handlers.onRefresh} disabled={busy} data-testid="today-refresh">
					{busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
					Refresh
				</Button>
			}
		>
			<header className="-mt-4 flex flex-col gap-3">
				{briefing ? (
					<p data-testid="today-note" className="max-w-2xl font-prose text-xl leading-relaxed text-foreground/85">
						{briefing.note}
					</p>
				) : (
					<p className="font-prose text-xl text-muted-foreground">{busy ? "Putting today's briefing together…" : "No briefing yet today."}</p>
				)}
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
			</header>

			<div className="flex flex-wrap items-start gap-6">
				{/* THE PLAN CARD (redesign wave): what to do, in order, inside the
				    time you have, and one button that starts the first thing. */}
				<div className="flex min-w-0 flex-[2_1_30rem] flex-col gap-6">
					<section
						aria-labelledby="plan-heading"
						data-testid="today-plan"
						className="flex min-w-0 flex-col rounded-2xl border border-border/70 bg-surface px-6 pb-6 pt-5"
					>
						<div className="mb-2 flex flex-wrap items-center justify-between gap-3">
							<h2 id="plan-heading" className="text-lg font-semibold">
								Today&apos;s plan
							</h2>
							<div role="group" aria-label="Time you have today" data-testid="today-budget" className="flex gap-0.5 rounded-lg bg-accent/70 p-0.5">
								{BUDGET_CHOICES.map((m) => (
									<button
										key={m}
										type="button"
										aria-pressed={budgetMinutes === m}
										onClick={() => handlers.onBudget(m)}
										className={cn(
											"h-8 rounded-md px-2.5 text-sm transition-colors",
											budgetMinutes === m ? "bg-surface font-semibold text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
										)}
									>
										{m} min
									</button>
								))}
							</div>
						</div>
						{!plan ? (
							<p className="py-4 text-sm text-muted-foreground">{busy ? "Working out what matters most today…" : "No plan yet."}</p>
						) : items.length === 0 ? (
							<p className="py-4 text-base text-muted-foreground">Nothing urgent. A good day to learn something new.</p>
						) : (
							<ol className="flex flex-col">
								{items.map((item, i) => (
									<PlanRow
										key={item.id}
										index={i + 1}
										item={item}
										pushed={briefing?.pushed?.[item.id]}
										pushing={pushing}
										canTodo={todo?.configured === true}
										todoLabel={todo?.label ?? "to-do"}
										canCalendar={integrations.google.connected}
										handlers={handlers}
									/>
								))}
							</ol>
						)}
						{plan && plan.trackedTopics === 0 && (
							<p className="pt-2 text-sm text-muted-foreground">
								Your memory of each topic is measured from quiz checks and practice. Once you have answered a few, the plan can
								tell what is fading before each exam.
							</p>
						)}
						<div className="mt-2 flex flex-wrap items-center gap-4 border-t border-border/60 pt-4">
							{first ? (
								<Button size="lg" className="h-12 rounded-xl px-6 text-base" onClick={() => handlers.onStart(first)} data-testid="today-start-first">
									<PlayIcon className="size-4 fill-current" />
									{items.length > 1 ? `Start with ${ACTION_LABEL[first.action].toLowerCase()}` : "Start"} · {first.minutes} min
								</Button>
							) : (
								<Button size="lg" className="h-12 rounded-xl px-6 text-base" onClick={() => openStart("learn")} data-testid="today-learn-new">
									<PlayIcon className="size-4 fill-current" />
									Learn something new
								</Button>
							)}
							{plan && (
								<Button variant="ghost" size="lg" className="h-12 rounded-xl px-4 text-base" onClick={quick} data-testid="today-quick">
									<ZapIcon className="size-4" />
									Only 5 minutes
								</Button>
							)}
							{total > 0 && <span className="text-sm text-muted-foreground">{total} min planned in all</span>}
						</div>
					</section>
					{plan && <StudyPlanCard plan={plan} onStart={handlers.onStart} />}
				</div>

				<div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-5">
					{plan && (
						<SideCard title="Coming up" testId="today-coming-up">
							{plan.upcoming.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									{integrations.google.connected || todo?.configured
										? "No exams in the next five weeks or deadlines in the next two."
										: "Connect your calendar to see exams and deadlines here."}
								</p>
							) : (
								<ul className="flex flex-col gap-3">
									{plan.upcoming.map((u) => (
										<UpcomingRow key={u.event.id} entry={u} now={plan.generatedAt} sessions={sessions} onLink={handlers.onLinkCourse} />
									))}
								</ul>
							)}
						</SideCard>
					)}

					{plan && plan.todayClasses.length > 0 && (
						<SideCard title="Classes today">
							<ul className="flex flex-col gap-2">
								{plan.todayClasses.map((c) => (
									<li key={c.event.id} className="flex items-center gap-2 text-sm">
										<span className="shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">{timeOf(c.event)}</span>
										<span className="min-w-0 flex-1 truncate">{c.event.title}</span>
										{plan.study?.tough.some((t) => t.key === c.course.key) && (
											<span className="shrink-0 rounded-full bg-warn-soft px-2 py-px text-xs font-semibold text-warn-ink">tough</span>
										)}
										<Button variant="ghost" size="sm" onClick={() => handlers.onPrimer(c)} data-testid="today-primer">
											5-min primer
										</Button>
									</li>
								))}
							</ul>
						</SideCard>
					)}

					{week && <WeekCard week={week} streak={streak} onQuick={quick} />}

					{honesty && (
						<section data-testid="today-honesty" className="flex flex-col gap-2 rounded-2xl bg-good-soft px-5 py-4">
							<h2 className="text-base font-semibold text-good-ink">Honesty check</h2>
							<p className="text-base text-foreground/85">
								You feel about {honesty.points} points surer than your answers justify. When you think &ldquo;I know this&rdquo;,
								answer one question first.
							</p>
							<Link href="/progress?tab=calibration" className="text-sm font-medium text-good-ink underline-offset-2 hover:underline">
								See calibration
							</Link>
						</section>
					)}

					<Connections integrations={integrations} briefing={briefing} handlers={handlers} />
				</div>
			</div>
		</PageFrame>
	);
}

export interface StudyWeek {
	/** Seven entries, Monday first. */
	minutes: number[];
	/** Today's position in `minutes` (0 = Monday). */
	today: number;
}

const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];
const DAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "1 h 40 min", "25 min". Pure. */
export function formatStudyTotal(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** The streak line's words: encouraging, never a scolding. Pure. */
export function streakMessage(streak: StudyStreak): string {
	const run = `${streak.days}-day streak`;
	if (streak.days === 0) return "Start a streak today. Even 5 minutes counts.";
	if (streak.studiedToday) return `${run}. Today counts.`;
	if (streak.atRisk) return `${run}. 5 minutes today keeps it going.`;
	return `${run}. Study today to add a day.`;
}

/** The streak (2026-10-27) under the week's bars, with a five-minute
 *  start while today does not count yet. */
function StreakLine({ streak, onQuick }: { streak: StudyStreak; onQuick: () => void }) {
	return (
		<div
			data-testid="today-streak"
			title={`A day counts with ${STREAK_MIN_MINUTES} minutes of study or more. One rest day between study days does not break the streak.`}
			className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/60 pt-3 text-sm"
		>
			<FlameIcon
				aria-hidden="true"
				className={cn("size-4 shrink-0", streak.days > 0 && streak.studiedToday ? "text-warn" : "text-muted-foreground")}
			/>
			<span className={cn("flex-1", streak.days > 0 ? "text-foreground" : "text-muted-foreground")}>{streakMessage(streak)}</span>
			{!streak.studiedToday && (
				<button
					type="button"
					onClick={onQuick}
					data-testid="today-streak-quick"
					className="font-medium text-good-ink underline-offset-2 hover:underline"
				>
					Do 5 minutes
				</button>
			)}
		</div>
	);
}

/** This week (redesign wave): minutes studied per day, as small bars. */
function WeekCard({ week, streak = null, onQuick }: { week: StudyWeek; streak?: StudyStreak | null; onQuick: () => void }) {
	const total = week.minutes.reduce((a, b) => a + b, 0);
	// Scale to the busiest day, but never so that a few minutes fill the bar.
	const top = Math.max(30, ...week.minutes);
	return (
		<section data-testid="today-week" className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-surface px-5 py-4">
			<div className="flex items-baseline justify-between gap-2">
				<h2 className="text-base font-semibold">This week</h2>
				<span className="text-sm text-muted-foreground tabular-nums">{total > 0 ? formatStudyTotal(total) : "Nothing yet"}</span>
			</div>
			<div
				role="img"
				aria-label={`Minutes studied each day: ${week.minutes.map((m, i) => `${DAY_NAMES[i]} ${m}`).join(", ")}`}
				className="flex h-16 items-end gap-2"
			>
				{week.minutes.map((m, i) => (
					<span
						key={i}
						data-testid="today-week-bar"
						className={cn(
							"flex-1 rounded",
							m > 0 ? "bg-good" : "bg-accent",
							i === week.today && "outline-dashed outline-[1.5px] outline-offset-2 outline-muted-foreground/60",
						)}
						style={{ height: m > 0 ? `${Math.max(8, Math.round((m / top) * 64))}px` : "4px" }}
					/>
				))}
			</div>
			<div aria-hidden="true" className="flex gap-2 text-xs text-muted-foreground">
				{DAY_LETTERS.map((d, i) => (
					<span key={i} className={cn("flex-1 text-center", i === week.today && "font-semibold text-foreground")}>
						{d}
					</span>
				))}
			</div>
			{streak && <StreakLine streak={streak} onQuick={onQuick} />}
		</section>
	);
}

/** A card in Today's right-hand column. */
function SideCard({ title, testId, children }: { title: string; testId?: string; children: React.ReactNode }) {
	return (
		<section data-testid={testId} className="flex flex-col gap-3 rounded-2xl border border-border/70 bg-surface px-5 py-4">
			<h2 className="text-base font-semibold">{title}</h2>
			{children}
		</section>
	);
}

function timeOf(e: StudyEvent): string {
	return e.allDay ? "all day" : new Date(e.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Connections({ integrations, briefing, handlers }: { integrations: IntegrationsData; briefing: BriefingData | null; handlers: Handlers }) {
	const g = integrations.google;
	const todo = integrations.todo[0];
	const calendarError = briefing?.sources.calendar.error ?? g.error;
	const todoError = briefing?.sources.todo.error;
	const allGood = g.connected && todo?.configured && !calendarError && !todoError;
	if (allGood) return null;
	return (
		<section data-testid="today-connections" className="flex flex-col gap-3 rounded-2xl border border-dashed border-border px-5 py-4 text-sm">
			<h2 className="text-base font-semibold">Connections</h2>
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">Google Calendar</span>
				{g.connected ? (
					<>
						<span className="text-muted-foreground">connected{g.email ? ` as ${g.email}` : ""}</span>
						<Button variant="ghost" size="sm" className="ml-auto" onClick={handlers.onDisconnectGoogle}>
							Disconnect
						</Button>
					</>
				) : g.configured ? (
					<Button size="sm" className="ml-auto" onClick={handlers.onConnectGoogle} disabled={g.pending} data-testid="today-connect-google">
						{g.pending ? "Waiting for the browser…" : "Sign in with Google"}
					</Button>
				) : (
					<>
						<span className="text-muted-foreground">needs your own Google OAuth client (one-time, about 5 minutes).</span>
						<Button variant="ghost" size="sm" className="ml-auto" onClick={() => handlers.onOpenKeys("GOOGLE_OAUTH_CLIENT_ID")}>
							Add client ID
						</Button>
					</>
				)}
			</div>
			{calendarError && <p className="text-destructive">{calendarError}</p>}
			{todo && (
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-medium">{todo.label}</span>
					{todo.configured ? (
						<span className="text-muted-foreground">connected</span>
					) : (
						<>
							<span className="text-muted-foreground">paste your API token to see dated tasks and add study tasks.</span>
							<Button variant="ghost" size="sm" className="ml-auto" onClick={() => handlers.onOpenKeys("TODOIST_API_TOKEN")}>
								Add token
							</Button>
						</>
					)}
				</div>
			)}
			{todoError && <p className="text-destructive">{todoError}</p>}
		</section>
	);
}

function PlanRow({
	index,
	item,
	pushed,
	pushing,
	canTodo,
	todoLabel,
	canCalendar,
	handlers,
}: {
	index: number;
	item: BriefingItem;
	pushed?: { todo?: string; calendar?: string };
	pushing: string | null;
	canTodo: boolean;
	todoLabel: string;
	canCalendar: boolean;
	handlers: Handlers;
}) {
	return (
		<li data-testid="today-item" className="flex gap-3.5 border-t border-border/60 py-3.5 first:border-t-0">
			<span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border text-sm text-muted-foreground">{index}</span>
			<div className="flex min-w-0 flex-1 flex-col gap-1">
				<div className="flex flex-wrap items-center gap-2">
					<span className="font-prose text-lg">{item.title}</span>
					<span className={cn("rounded-full px-2 py-px text-xs font-semibold", ACTION_TAG[item.action])}>{ACTION_LABEL[item.action]}</span>
				</div>
				<p className="text-sm text-muted-foreground">{item.reason}</p>
				<div className="-ml-2 flex flex-wrap items-center gap-1">
					<Button variant="ghost" size="sm" onClick={() => handlers.onStart(item)} data-testid="today-start">
						<PlayIcon className="size-3.5" />
						Start
					</Button>
					{item.chatId && (
						<Button variant="ghost" size="sm" asChild>
							<Link href={`/chat/${item.chatId}`}>Open {item.chatTitle ? `“${item.chatTitle}”` : "session"}</Link>
						</Button>
					)}
					{canTodo && (
						<PushButton
							done={pushed?.todo}
							busy={pushing === `${item.id}:todo`}
							onClick={() => handlers.onPush(item, "todo")}
							icon={<ListPlusIcon className="size-3.5" />}
							label={`Add to ${todoLabel}`}
							doneLabel={`In ${todoLabel}`}
						/>
					)}
					{canCalendar && (
						<PushButton
							done={pushed?.calendar}
							busy={pushing === `${item.id}:calendar`}
							onClick={() => handlers.onPush(item, "calendar")}
							icon={<CalendarPlusIcon className="size-3.5" />}
							label="Block time"
							doneLabel="Blocked"
						/>
					)}
				</div>
			</div>
			<span className="shrink-0 pt-1 text-sm whitespace-nowrap text-muted-foreground">{item.minutes} min</span>
		</li>
	);
}

function PushButton({
	done,
	busy,
	onClick,
	icon,
	label,
	doneLabel,
}: {
	done?: string;
	busy: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
	doneLabel: string;
}) {
	if (done) {
		return done.startsWith("https://") ? (
			<a href={done} target="_blank" rel="noreferrer" className="px-2 text-xs text-muted-foreground underline-offset-2 hover:underline">
				{doneLabel} ✓
			</a>
		) : (
			<span className="px-2 text-xs text-muted-foreground">{doneLabel} ✓</span>
		);
	}
	return (
		<Button variant="ghost" size="sm" onClick={onClick} disabled={busy}>
			{busy ? <Loader2Icon className="size-3.5 animate-spin" /> : icon}
			{label}
		</Button>
	);
}

function UpcomingRow({
	entry,
	now,
	sessions,
	onLink,
}: {
	entry: UpcomingEntry;
	now: number;
	sessions: SessionOption[];
	onLink: Handlers["onLinkCourse"];
}) {
	const [editing, setEditing] = useState(false);
	const [picked, setPicked] = useState<string[]>(entry.chatIds);
	const r = entry.readiness;
	return (
		<li data-testid="today-upcoming" className="flex flex-col gap-1.5 text-sm">
			<div className="flex items-baseline justify-between gap-2">
				<span className="min-w-0 truncate text-base">
					{entry.event.url ? (
						<a href={entry.event.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
							{entry.event.title}
						</a>
					) : (
						entry.event.title
					)}
				</span>
				<span className={cn("shrink-0 whitespace-nowrap", r !== null && r < 0.9 ? "font-semibold text-warn-ink" : "text-muted-foreground")}>
					{whenLabel(entry.event.start, now)}
				</span>
			</div>
			<div className="flex items-center gap-2">
				{r === null ? (
					<span className="flex-1 text-xs text-warn-ink">nothing studied yet</span>
				) : (
					<span className="flex flex-1 items-center gap-2" title="Average predicted recall of the linked topics on the day">
						<span className="h-1.5 flex-1 overflow-hidden rounded-full bg-accent">
							<span className={cn("block h-full rounded-full", r >= 0.9 ? "bg-good" : "bg-warn")} style={{ width: pct(r) }} />
						</span>
						<span className="tabular-nums text-xs text-muted-foreground">{pct(r)} recall</span>
					</span>
				)}
				<span className="text-xs text-muted-foreground">{entry.kind}</span>
				{entry.course.key && (
					<button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setEditing((v) => !v)}>
						{entry.linked ? "Sessions" : "Link sessions"}
					</button>
				)}
			</div>
			{editing && (
				<div className="flex flex-col gap-2 rounded-md bg-muted/40 p-2">
					<p className="text-xs text-muted-foreground">
						Which sessions belong to <span className="font-medium text-foreground">{entry.course.label}</span>? This is remembered for every
						event of the course.
					</p>
					<div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
						{sessions.map((s) => (
							<label key={s.id} className="flex items-center gap-2 text-xs">
								<input
									type="checkbox"
									checked={picked.includes(s.id)}
									onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.id] : p.filter((id) => id !== s.id)))}
								/>
								<span className="truncate">{s.title}</span>
							</label>
						))}
					</div>
					<div className="flex justify-end gap-2">
						<Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
							Cancel
						</Button>
						<Button
							size="sm"
							onClick={() => {
								onLink(entry.course.key, entry.course.label, picked);
								setEditing(false);
							}}
						>
							Save
						</Button>
					</div>
				</div>
			)}
		</li>
	);
}

// ─── The stateful view ──────────────────────────────────────────────────────

async function json<T>(res: Response): Promise<T> {
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
	return body;
}

export function TodayView({
	initialBriefing,
	initialIntegrations,
	initialBudget,
	sessions,
	honesty = null,
	week = null,
	streak = null,
}: {
	initialBriefing: BriefingData | null;
	initialIntegrations: IntegrationsData;
	initialBudget: number;
	sessions: SessionOption[];
	honesty?: { points: number } | null;
	week?: StudyWeek | null;
	streak?: StudyStreak | null;
}) {
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const [briefing, setBriefing] = useState(initialBriefing);
	const [integrations, setIntegrations] = useState(initialIntegrations);
	const [budget, setBudget] = useState(initialBudget);
	const [busy, setBusy] = useState(false);
	const [pushing, setPushing] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const generate = useCallback(async (refresh: boolean) => {
		setBusy(true);
		setError(null);
		try {
			const body = await json<{ briefing: BriefingData; integrations: IntegrationsData }>(
				await fetch("/api/briefing", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ refresh }),
				}),
			);
			setBriefing(body.briefing);
			setIntegrations(body.integrations);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not build the briefing.");
		} finally {
			setBusy(false);
		}
	}, []);

	// First open of the day builds the briefing.
	useEffect(() => {
		if (!initialBriefing) void generate(false);
	}, [initialBriefing, generate]);

	// A client ID or token saved in Settings → Keys changes what can connect.
	useEffect(
		() =>
			onSettingsSaved(async (section) => {
				if (section !== "keys") return;
				try {
					const body = await json<{ integrations: IntegrationsData }>(await fetch("/api/briefing"));
					setIntegrations(body.integrations);
				} catch {
					// the next refresh picks it up
				}
			}),
		[],
	);

	// While a Google sign-in waits on the browser, poll its status; refresh once connected.
	useEffect(() => {
		if (!integrations.google.pending) return;
		const timer = setInterval(async () => {
			try {
				const google = await json<IntegrationsData["google"]>(await fetch("/api/integrations/google"));
				setIntegrations((prev) => ({ ...prev, google }));
				if (!google.pending) {
					clearInterval(timer);
					if (google.connected) void generate(true);
				}
			} catch {
				// keep polling; the sign-in times out server-side
			}
		}, 1500);
		return () => clearInterval(timer);
	}, [integrations.google.pending, generate]);

	const handlers: Handlers = {
		onStart: async (item) => {
			try {
				const target = await startDraftSession(startPrompt(item), fetch);
				if (target) {
					setSessionBudget(target, item.minutes);
					router.push(target);
				}
			} catch {
				setError("Could not start the session.");
			}
		},
		onQuick: async (item) => {
			try {
				// The step's title names the session; turn 1 carries the five-minute scope.
				const target = await startDraftSession(item.title, fetch, undefined, undefined, quickPrompt(item));
				if (target) {
					setSessionBudget(target, QUICK_SESSION_MINUTES);
					router.push(target);
				}
			} catch {
				setError("Could not start the session.");
			}
		},
		onPrimer: async (entry) => {
			const text = `5-minute primer before my ${entry.event.title} class: remind me where we left off and ask me one prediction question about what comes next.`;
			try {
				const target = await startDraftSession(text, fetch);
				if (target) {
					setSessionBudget(target, 5);
					router.push(target);
				}
			} catch {
				setError("Could not start the session.");
			}
		},
		onPush: async (item, target) => {
			setPushing(`${item.id}:${target}`);
			setError(null);
			try {
				const result = await json<{ url?: string }>(
					await fetch("/api/briefing/push", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ id: item.id, target }),
					}),
				);
				setBriefing((b) =>
					b ? { ...b, pushed: { ...b.pushed, [item.id]: { ...b.pushed?.[item.id], [target]: result.url ?? "added" } } } : b,
				);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Could not push that item.");
			} finally {
				setPushing(null);
			}
		},
		onRefresh: () => void generate(true),
		onBudget: async (minutes) => {
			setBudget(minutes);
			try {
				await json(
					await fetch("/api/briefing/prefs", {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ budgetMinutes: minutes }),
					}),
				);
				void generate(true);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Could not save the budget.");
			}
		},
		onConnectGoogle: async () => {
			setError(null);
			try {
				const body = await json<{ authUrl: string; status: IntegrationsData["google"] }>(
					await fetch("/api/integrations/google", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ action: "connect" }),
					}),
				);
				setIntegrations((prev) => ({ ...prev, google: body.status }));
				// The desktop shell routes window.open to the real browser.
				window.open(body.authUrl, "_blank", "noopener");
			} catch (err) {
				setError(err instanceof Error ? err.message : "Could not start Google sign-in.");
			}
		},
		onDisconnectGoogle: async () => {
			try {
				const google = await json<IntegrationsData["google"]>(
					await fetch("/api/integrations/google", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ action: "disconnect" }),
					}),
				);
				setIntegrations((prev) => ({ ...prev, google }));
			} catch (err) {
				setError(err instanceof Error ? err.message : "Could not disconnect.");
			}
		},
		onOpenKeys: (keyId) => openSettings("keys", keyId),
		onLinkCourse: async (key, label, chatIds) => {
			try {
				await json(
					await fetch("/api/briefing/courses", {
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ key, label, chatIds }),
					}),
				);
				void generate(true);
			} catch (err) {
				setError(err instanceof Error ? err.message : "Could not save the course link.");
			}
		},
	};

	return (
		<TodayShell
			briefing={briefing}
			integrations={integrations}
			budgetMinutes={budget}
			sessions={sessions}
			busy={busy}
			pushing={pushing}
			error={error}
			handlers={handlers}
			honesty={honesty}
			week={week}
			streak={streak}
		/>
	);
}
