"use client";

import { SettingsRecoveredNote, type SettingsRecoveredInfo } from "./settings-recovered-note";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarPlusIcon, CheckIcon, CircleIcon, FlameIcon, SettingsIcon, ListPlusIcon, Loader2Icon, MessageSquareIcon, PlayIcon, RefreshCwIcon, ScaleIcon, ZapIcon } from "lucide-react";
import {
	BUDGET_CHOICES,
	courseKeyOfEvent,
	STREAK_MIN_MINUTES,
	quickPrompt,
	startPrompt,
	whenLabel,
	type BriefingItem,
	type BriefingPlan,
	type ExamPlan,
	type ClassEntry,
	type StudyEvent,
	type StudyStreak,
	type UpcomingEntry,
} from "@/src/core";
import { startDraftSession } from "@/components/new-session";
import { REVIEW_START_PROMPT } from "@/components/review-start";
import { QUICK_SESSION_MINUTES, setSessionBudget } from "@/components/session-timer";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { onSettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { PageFrame } from "@/components/page-header";
import { useStartDialog } from "@/components/start-dialog";
import { ACTION_LABEL, ACTION_TAG, EXAM_STATUS, StudyPlanCard } from "@/components/study-plan-card";
import { useSessionClassColors } from "@/components/use-class-colors";
import { useClassColors } from "@/components/use-class-colors";
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
	google: { configured: boolean; connected: boolean; needsReconnect?: boolean; email?: string; pending: boolean; error?: string };
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
	/** Open Settings on a section (setup lives there now). */
	onOpenSettings?: (section: string) => void;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Steps that are recall on topics he has already studied. */
function isRecallStep(item: BriefingItem): boolean {
	return (item.action === "check" || item.action === "review" || item.action === "prep") && item.topicKeys.length > 0;
}

/** Topics in a five-minute review ("Only 5 minutes" on a recall step). */
const QUICK_REVIEW_TOPICS = 3;

/** Open a review session on a plan step's topics; null when the server
 *  has none of them (the caller falls back to a learn session). */
async function startStepReview(item: BriefingItem, limit?: number): Promise<string | null> {
	const res = await fetch("/api/review/start", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ keys: item.topicKeys, title: item.title, ...(limit ? { limit } : {}) }),
	});
	if (!res.ok) return null;
	const { id } = (await res.json()) as { id?: string };
	return id ? `/chat/${id}?prompt=${encodeURIComponent(REVIEW_START_PROMPT)}` : null;
}

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
	settingsRecovery = null,
	colorOf: colorOverride,
	doneIds = NO_DONE,
	weekDays = null,
	setup = null,
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
	/** Set when settings.json was unreadable and got recovered. */
	settingsRecovery?: SettingsRecoveredInfo | null;
	/** A plan step's class color (the calendar's .cal-cN); by default from
	 *  the step's event's class, else its session's class. */
	colorOf?: (item: BriefingItem) => number | undefined;
	/** Steps already done today: they tick off and the hero moves on. */
	doneIds?: ReadonlySet<string>;
	/** This week's sessions per day (Monday first): a click on a day's bar shows them. */
	weekDays?: WeekDaySession[][] | null;
	/** First run: what is set up yet (null hides the checklist). */
	setup?: SetupState | null;
}) {
	const plan = briefing?.plan;
	const todo = integrations.todo[0];
	const items = plan?.items ?? [];
	const first = items.find((i) => !doneIds.has(i.id));
	const rest = items.filter((i) => i !== first);
	const doneCount = items.filter((i) => doneIds.has(i.id)).length;
	const classColors = useClassColors();
	const sessionColors = useSessionClassColors();
	const colorOf =
		colorOverride ??
		((item: BriefingItem) => {
			const event = plan?.upcoming.find((u) => u.event.id === item.eventId);
			const key = event?.course.key ?? (item.eventTitle ? courseKeyOfEvent({ title: item.eventTitle }) : "");
			return (key ? classColors.get(key) : undefined) ?? (item.chatId ? sessionColors.get(item.chatId) : undefined);
		});
	const { open: openStart } = useStartDialog();
	// Five minutes of the first step, or of something new when the plan is empty.
	const quick = () => (first ? handlers.onQuick(first) : openStart("learn", QUICK_SESSION_MINUTES));
	const total = items.reduce((sum, item) => sum + item.minutes, 0);
	const exams = new Map((plan?.study?.exams ?? []).map((e) => [e.eventId, e]));
	const pushProps = {
		pushing,
		canTodo: todo?.configured === true,
		todoLabel: todo?.label ?? "to-do",
		canCalendar: integrations.google.connected,
		handlers,
	};
	return (
		<PageFrame
			title="Today"
			testId="today-view"
			width="max-w-6xl"
			actions={
				<>
					{plan && (
						<span data-testid="today-date" className="text-sm text-muted-foreground">
							{new Date(plan.generatedAt).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
						</span>
					)}
					<Button
					variant="ghost"
					size="icon"
					onClick={handlers.onRefresh}
					disabled={busy}
					data-testid="today-refresh"
					aria-label="Rebuild today's plan"
					title="Rebuild today's plan"
					className="text-muted-foreground"
				>
					{busy ? <Loader2Icon className="size-4 animate-spin" /> : <RefreshCwIcon className="size-4" />}
					</Button>
				</>
			}
		>
			<header className="-mt-5 flex flex-col gap-2">
				{briefing ? (
					<p data-testid="today-note" className="max-w-3xl font-prose text-lg leading-relaxed text-muted-foreground">
						{briefing.note}
					</p>
				) : (
					<p className="font-prose text-lg text-muted-foreground">{busy ? "Putting today's briefing together…" : "No briefing yet today."}</p>
				)}
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
			</header>

			{setup && <SetupChecklist setup={setup} onConnect={() => handlers.onOpenSettings?.("calendar")} onQuiz={quick} />}
			<div className="flex flex-wrap items-start gap-6">
				<div className="flex min-w-0 flex-[2_1_30rem] flex-col gap-6">
					{/* THE PLAN CARD (Today refine, 2026-11-08): the first step is
					    the hero, with the start button right under its title, so the
					    first click needs no reading; the rest of today's list sits
					    under it, quieter. */}
					<section
						aria-labelledby="plan-heading"
						data-testid="today-plan"
						className="flex min-w-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-surface"
					>
						<div className="flex flex-col gap-4 px-6 pb-6 pt-5">
							<div className="flex flex-wrap items-center justify-between gap-3">
								<div className="flex items-center gap-2">
									<h2 id="plan-heading" className="text-sm font-medium text-muted-foreground">
										{first && items.length > 1 ? "Up next" : "Today's plan"}
									</h2>
									{first && (
										<span className={cn("rounded-full px-2 py-px text-xs font-semibold", ACTION_TAG[first.action])}>{ACTION_LABEL[first.action]}</span>
									)}
									{doneCount > 0 && (
										<span className="flex items-center gap-1 text-xs text-muted-foreground">
											<CheckIcon className="size-3.5" /> {doneCount} of {items.length} done
										</span>
									)}
								</div>
								<BudgetPicker value={budgetMinutes} onChange={handlers.onBudget} />
							</div>
							{!plan ? (
								busy ? (
									<div aria-busy="true" className="flex flex-col gap-2.5 py-1">
										<span className="sr-only">Working out what matters most today…</span>
										<span className="h-7 w-2/3 animate-pulse rounded-lg bg-accent" />
										<span className="h-4 w-5/6 animate-pulse rounded bg-accent/70" />
									</div>
								) : (
									<p className="text-base text-muted-foreground">No plan yet.</p>
								)
							) : first ? (
								<div data-testid="today-item" className="flex flex-col gap-1.5">
									<span className="flex items-center gap-2.5 text-2xl font-semibold tracking-tight text-balance">
										<ClassDot color={colorOf(first)} className="size-3" />
										{first.title}
									</span>
									<p className="max-w-2xl text-base text-muted-foreground">{first.reason}</p>
								</div>
							) : doneCount > 0 ? (
								<div className="flex flex-col gap-1.5">
									<span className="text-2xl font-semibold tracking-tight">Today&apos;s plan is done</span>
									<p className="text-base text-muted-foreground">Everything planned for today counts. More now is a bonus, not a debt.</p>
								</div>
							) : (
								<div className="flex flex-col gap-1.5">
									<span className="text-2xl font-semibold tracking-tight">Nothing urgent today</span>
									<p className="text-base text-muted-foreground">A good day to learn something new.</p>
								</div>
							)}
							<div className="flex flex-wrap items-center gap-2">
								{first ? (
									<Button size="lg" className="h-11 rounded-xl px-5 text-base" onClick={() => handlers.onStart(first)} data-testid="today-start-first">
										<PlayIcon className="size-4 fill-current" />
										Start · {first.minutes} min
									</Button>
								) : (
									<Button size="lg" className="h-11 rounded-xl px-5 text-base" onClick={() => openStart("learn")} data-testid="today-learn-new">
										<PlayIcon className="size-4 fill-current" />
										Learn something new
									</Button>
								)}
								{plan && (
									<Button variant="outline" size="lg" className="h-11 rounded-xl px-4 text-base" onClick={quick} data-testid="today-quick">
										<ZapIcon className="size-4" />
										Only 5 minutes
									</Button>
								)}
								{first && <ItemActions item={first} pushed={briefing?.pushed?.[first.id]} {...pushProps} compact className="ml-auto" />}
							</div>
							{plan && plan.trackedTopics === 0 && (
								<p className="text-sm text-muted-foreground">
									Your memory of each topic is measured from quiz checks and practice. Once you have answered a few, the plan can
									tell what is fading before each exam.
								</p>
							)}
						</div>
						{rest.length > 0 && (
							<div className="border-t border-border/60 bg-accent/25 px-6 pb-3 pt-3">
								<div className="flex items-baseline justify-between gap-2 pb-1">
									<h3 className="text-sm font-medium text-muted-foreground">{doneCount > 0 ? "Today" : "Then"}</h3>
									<span className="text-xs tabular-nums text-muted-foreground">{total} min in all</span>
								</div>
								<ol className="flex flex-col">
									{rest.map((item, i) => (
										<PlanRow
											key={item.id}
											index={items.indexOf(item) + 1}
											item={item}
											done={doneIds.has(item.id)}
											color={colorOf(item)}
											pushed={briefing?.pushed?.[item.id]}
											{...pushProps}
										/>
									))}
								</ol>
							</div>
						)}
					</section>
					{plan && <StudyPlanCard plan={plan} onStart={handlers.onStart} colorOf={colorOf} />}
				</div>

				<div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-5">
					{settingsRecovery && <SettingsRecoveredNote recovery={settingsRecovery} />}

					{week && <WeekCard week={week} streak={streak} onQuick={quick} days={weekDays} />}

					{plan && (
						<SideCard title="Coming up" testId="today-coming-up">
							{plan.upcoming.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									{integrations.google.connected || todo?.configured
										? "No exams in the next five weeks or deadlines in the next two."
										: "Connect your calendar to see exams and deadlines here."}
								</p>
							) : (
								<ul className="flex flex-col divide-y divide-border/60">
									{plan.upcoming.map((u) => (
										<UpcomingRow
											key={u.event.id}
											entry={u}
											exam={exams.get(u.event.id)}
											now={plan.generatedAt}
											budget={plan.budgetMinutes}
											sessions={sessions}
											onLink={handlers.onLinkCourse}
										/>
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

					{honesty && (
						<section data-testid="today-honesty" className="flex flex-col gap-2 rounded-2xl border border-border/70 bg-surface px-5 py-4">
							<h2 className="flex items-center gap-2 text-base font-semibold">
								<ScaleIcon aria-hidden="true" className="size-4 text-warn" />
								Honesty check
							</h2>
							<p className="text-sm text-foreground/85">
								You feel about {honesty.points} points surer than your answers justify. When you think &ldquo;I know this&rdquo;,
								answer one question first.
							</p>
							<Link href="/progress?tab=calibration" className="self-start text-sm font-medium underline-offset-2 hover:underline">
								See calibration
							</Link>
						</section>
					)}

					<SetupNudge integrations={integrations} briefing={briefing} onFix={() => handlers.onOpenSettings?.("calendar")} />
				</div>
			</div>
		</PageFrame>
	);
}

/** The time you have today, as one small segmented control. */
function BudgetPicker({ value, onChange }: { value: number; onChange: (minutes: number) => void }) {
	return (
		<div className="flex items-center gap-2 text-xs text-muted-foreground">
			<span aria-hidden="true">Time today</span>
			<div role="group" aria-label="Time you have today" data-testid="today-budget" className="flex items-center rounded-lg bg-accent/60 p-0.5">
				{BUDGET_CHOICES.map((m) => (
					<button
						key={m}
						type="button"
						aria-pressed={value === m}
						aria-label={`${m} minutes`}
						onClick={() => onChange(m)}
						className={cn(
							"h-6 min-w-8 rounded-md px-1.5 text-xs tabular-nums transition-colors",
							value === m ? "bg-surface font-semibold text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{m}
					</button>
				))}
			</div>
			<span aria-hidden="true">min</span>
		</div>
	);
}

const NO_DONE: ReadonlySet<string> = new Set();

export interface WeekDaySession {
	chatId: string;
	title: string;
	minutes: number;
}

export interface SetupState {
	calendar: boolean;
	notes: boolean;
	quiz: boolean;
}

/** A class's color as a small square (the calendar's .cal-cN bar). */
export function ClassDot({ color, className }: { color?: number; className?: string }) {
	if (color === undefined) return null;
	return <span aria-hidden="true" className={cn(`cal-c${color} size-2.5 shrink-0 rounded-[3px]`, className)} style={{ background: "var(--bar)" }} />;
}

/** First run: three steps that make the plan worth reading. */
function SetupChecklist({ setup, onConnect, onQuiz }: { setup: SetupState; onConnect: () => void; onQuiz: () => void }) {
	const [hidden, setHidden] = useState(false);
	const steps = [
		{ key: "calendar", done: setup.calendar, title: "Connect your calendar", body: "Exams and classes are what the plan works back from.", action: "Connect", href: null, onClick: onConnect },
		{ key: "notes", done: setup.notes, title: "Import your course notes", body: "A folder per class: the tutor teaches and quizzes from them.", action: "Import", href: "/library", onClick: undefined },
		{ key: "quiz", done: setup.quiz, title: "Answer one quiz", body: "Five minutes. It is how Socrates learns what you really know.", action: "Start 5 minutes", href: null, onClick: onQuiz },
	];
	const left = steps.filter((x) => !x.done).length;
	if (left === 0 || hidden) return null;
	return (
		<section data-testid="today-setup" className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-surface px-6 py-5">
			<div className="flex items-baseline justify-between gap-3">
				<h2 className="text-lg font-semibold">Get set up</h2>
				<span className="flex items-center gap-3 text-sm text-muted-foreground">
					{3 - left} of 3 done
					<button type="button" onClick={() => setHidden(true)} className="underline-offset-2 hover:text-foreground hover:underline">
						Not now
					</button>
				</span>
			</div>
			<ol className="grid gap-3 sm:grid-cols-3">
				{steps.map((x) => (
					<li key={x.key} className={cn("flex flex-col gap-2 rounded-xl border border-border/60 p-4", x.done && "bg-accent/35")}>
						<span className="flex items-center gap-2 font-medium">
							{x.done ? (
								<span className="flex size-5 items-center justify-center rounded-full bg-foreground text-background">
									<CheckIcon className="size-3" strokeWidth={2.75} />
								</span>
							) : (
								<CircleIcon className="size-5 text-muted-foreground/60" />
							)}
							<span className={cn(x.done && "text-muted-foreground")}>{x.title}</span>
						</span>
						<p className="text-sm text-muted-foreground">{x.body}</p>
						{!x.done &&
							(x.href ? (
								<Button variant="outline" size="sm" className="mt-auto self-start" asChild>
									<Link href={x.href}>{x.action}</Link>
								</Button>
							) : (
								<Button variant="outline" size="sm" className="mt-auto self-start" onClick={x.onClick}>
									{x.action}
								</Button>
							))}
					</li>
				))}
			</ol>
		</section>
	);
}

/** Setup lives in Settings now; Today only says so when something is broken. */
function SetupNudge({ integrations, briefing, onFix }: { integrations: IntegrationsData; briefing: BriefingData | null; onFix: () => void }) {
	const g = integrations.google;
	const problem = g.needsReconnect
		? "Google Calendar needs reconnecting."
		: (briefing?.sources.calendar.error ?? briefing?.sources.todo.error ?? null);
	if (!problem) return null;
	return (
		<div data-testid="today-setup-nudge" className="flex items-center gap-2 rounded-xl border border-dashed border-border px-4 py-3 text-sm">
			<span className="size-2 shrink-0 rounded-full bg-warn" aria-hidden="true" />
			<span className="min-w-0 flex-1">{problem}</span>
			<Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={onFix} data-testid="today-fix-setup">
				<SettingsIcon className="size-3.5" />
				Fix in Settings
			</Button>
		</div>
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
			{streak.atRisk && !streak.studiedToday && (
				<button
					type="button"
					onClick={onQuick}
					data-testid="today-streak-quick"
					className="font-medium underline-offset-2 hover:underline"
				>
					Do 5 minutes
				</button>
			)}
		</div>
	);
}

/** This week (redesign wave): minutes studied per day, as small bars. */
function WeekCard({
	week,
	streak = null,
	onQuick,
	days = null,
}: {
	week: StudyWeek;
	streak?: StudyStreak | null;
	onQuick: () => void;
	days?: WeekDaySession[][] | null;
}) {
	const [open, setOpen] = useState<number | null>(null);
	const sessionColors = useSessionClassColors();
	const openDay = open !== null && days ? { index: open, sessions: days[open] ?? [] } : null;
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
				role={days ? "group" : "img"}
				aria-label={`Minutes studied each day: ${week.minutes.map((m, i) => `${DAY_NAMES[i]} ${m}`).join(", ")}`}
				className="flex h-12 items-end gap-2"
			>
				{week.minutes.map((m, i) => {
					const clickable = days !== null && m > 0;
					const Wrap = clickable ? "button" : "span";
					return (
					<Wrap
						key={i}
						{...(clickable
							? {
									type: "button" as const,
									"aria-label": `${DAY_NAMES[i]}: ${formatStudyTotal(m)}`,
									"aria-expanded": open === i,
									onClick: () => setOpen((o) => (o === i ? null : i)),
								}
							: {})}
						className={cn("flex flex-1 justify-center self-stretch items-end", clickable && "cursor-pointer rounded-md")}
					>
						<span
							data-testid="today-week-bar"
							className={cn(
								"w-full max-w-7 rounded-[5px]",
								m === 0 ? "bg-accent" : i === week.today ? "bg-foreground/75" : "bg-foreground/35",
								i === week.today && "outline-dashed outline-[1.5px] outline-offset-2 outline-muted-foreground/60",
								openDay?.index === i && "bg-foreground/75 ring-2 ring-foreground/20 ring-offset-2 ring-offset-surface",
							)}
							style={{ height: m > 0 ? `${Math.max(6, Math.round((m / top) * 48))}px` : "4px" }}
						/>
					</Wrap>
					);
				})}
			</div>
			<div aria-hidden="true" className="flex gap-2 text-xs text-muted-foreground">
				{DAY_LETTERS.map((d, i) => (
					<span key={i} className={cn("flex-1 text-center", i === week.today && "font-semibold text-foreground")}>
						{d}
					</span>
				))}
			</div>
			{openDay && (
				<div data-testid="today-week-day" className="flex flex-col gap-1.5 rounded-xl bg-accent/45 px-3.5 py-3 text-sm">
					<div className="flex items-baseline justify-between">
						<span className="font-medium">{DAY_NAMES[openDay.index]}</span>
						<span className="text-xs tabular-nums text-muted-foreground">{formatStudyTotal(week.minutes[openDay.index] ?? 0)}</span>
					</div>
					<ul className="flex flex-col gap-1">
						{openDay.sessions.length === 0 && <li className="text-muted-foreground">Flashcards or a mock exam.</li>}
						{openDay.sessions.map((x) => (
							<li key={x.chatId} className="flex items-center gap-2">
								<ClassDot color={sessionColors.get(x.chatId)} />
								<Link href={`/chat/${x.chatId}`} className="min-w-0 flex-1 truncate underline-offset-2 hover:underline">
									{x.title}
								</Link>
								<span className="text-xs tabular-nums text-muted-foreground">{x.minutes} min</span>
							</li>
						))}
					</ul>
				</div>
			)}
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

interface PushProps {
	pushing: string | null;
	canTodo: boolean;
	todoLabel: string;
	canCalendar: boolean;
	handlers: Handlers;
}

function ItemActions({
	item,
	pushed,
	pushing,
	canTodo,
	todoLabel,
	canCalendar,
	handlers,
	compact = false,
	className,
}: PushProps & { item: BriefingItem; pushed?: { todo?: string; calendar?: string }; compact?: boolean; className?: string }) {
	if (!item.chatId && !canTodo && !canCalendar) return null;
	const openLabel = item.chatTitle ? `Open “${item.chatTitle}”` : "Open session";
	return (
		<div className={cn("flex items-center gap-0.5 text-muted-foreground", className)}>
			{item.chatId && (
				<Button variant="ghost" size="sm" className={cn("h-8 text-xs", compact ? "w-8 px-0" : "px-2")} asChild>
					<Link href={`/chat/${item.chatId}`} title={openLabel} aria-label={openLabel}>
						<MessageSquareIcon className="size-3.5" />
						{!compact && "Open session"}
					</Link>
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
					compact={compact}
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
					compact={compact}
				/>
			)}
		</div>
	);
}

/** A later step of today's list: one line, its why under it; the side
 *  doors show on hover or keyboard focus, so the list reads calm. */
function PlanRow({
	index,
	item,
	pushed,
	done = false,
	color,
	...push
}: PushProps & { index: number; item: BriefingItem; pushed?: { todo?: string; calendar?: string }; done?: boolean; color?: number }) {
	return (
		<li data-testid="today-item" className="group flex gap-3 border-t border-border/50 py-2.5 first:border-t-0">
			{done ? (
				<span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-background">
					<CheckIcon className="size-3.5" strokeWidth={2.5} />
				</span>
			) : (
				<span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums text-muted-foreground">
					{index}
				</span>
			)}
			<div className="flex min-w-0 flex-1 flex-col gap-0.5">
				<div className="flex flex-wrap items-center gap-2">
					<ClassDot color={color} />
					<span className={cn("text-base font-medium", done && "text-muted-foreground line-through decoration-muted-foreground/40")}>{item.title}</span>
					<span className={cn("rounded-full px-2 py-px text-xs font-semibold", ACTION_TAG[item.action])}>{ACTION_LABEL[item.action]}</span>
				</div>
				<p className="text-sm text-muted-foreground">{item.reason}</p>
			</div>
			<div className="flex shrink-0 items-start gap-1">
				{!done && <ItemActions
					item={item}
					pushed={pushed}
					{...push}
					compact
					className="-mt-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
				/>}
				<span className="pt-1 text-sm whitespace-nowrap tabular-nums text-muted-foreground">{done ? `Done · ${item.minutes} min` : `${item.minutes} min`}</span>
				{!done && (
					<Button variant="ghost" size="sm" className="h-7 px-2" onClick={() => push.handlers.onStart(item)} data-testid="today-start" aria-label={`Start: ${item.title}`}>
						<PlayIcon className="size-3.5" />
						Start
					</Button>
				)}
			</div>
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
	compact = false,
}: {
	done?: string;
	busy: boolean;
	onClick: () => void;
	icon: React.ReactNode;
	label: string;
	doneLabel: string;
	/** Icon only, the label as its name and tooltip. */
	compact?: boolean;
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
		<Button
			variant="ghost"
			size="sm"
			className={cn("h-8 text-xs", compact ? "w-8 px-0" : "px-2")}
			onClick={onClick}
			disabled={busy}
			title={label}
			aria-label={compact ? label : undefined}
		>
			{busy ? <Loader2Icon className="size-3.5 animate-spin" /> : icon}
			{!compact && label}
		</Button>
	);
}

function UpcomingRow({
	entry,
	exam,
	now,
	budget,
	sessions,
	onLink,
}: {
	entry: UpcomingEntry;
	/** What the study plan laid out for it, when it is in the plan. */
	exam?: ExamPlan;
	now: number;
	budget: number;
	sessions: SessionOption[];
	onLink: Handlers["onLinkCourse"];
}) {
	const [editing, setEditing] = useState(false);
	const [picked, setPicked] = useState<string[]>(entry.chatIds);
	const color = useClassColors().get(entry.course.key);
	const r = entry.readiness;
	const planned = exam?.readinessPlanned ?? null;
	const lifts = r !== null && planned !== null && planned > r + 0.005;
	// "Not started" says the same as "Nothing studied yet" beside it.
	const status = exam && !(r === null && exam.status === "not-started") ? EXAM_STATUS[exam.status] : null;
	// The plan's verdict wins over the raw number: 77% today on an exam
	// the plan has on track is not a warning.
	const low = exam ? exam.status === "tight" || exam.status === "not-started" : r !== null && r < 0.9;
	return (
		<li data-testid="today-upcoming" className="group flex flex-col gap-1.5 py-3 text-sm first:pt-0 last:pb-0">
			<div className="flex items-baseline justify-between gap-2">
				<span className={cn("flex min-w-0 items-center gap-2 text-base font-medium", color !== undefined && `cal-c${color}`)}>
					{color !== undefined && <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: "var(--bar)" }} />}
					<span className="truncate">
						{entry.event.url ? (
							<a href={entry.event.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
								{entry.event.title}
							</a>
						) : (
							entry.event.title
						)}
					</span>
				</span>
				<span className={cn("shrink-0 whitespace-nowrap", low || r === null ? "font-semibold text-warn-ink" : "text-muted-foreground")}>
					{whenLabel(entry.event.start, now)}
				</span>
			</div>
			<div className="flex items-center gap-2">
				{r === null ? (
					<span className="flex-1 text-xs font-medium text-warn-ink">Nothing studied yet</span>
				) : (
					<span className="flex flex-1 items-center gap-2" title="Predicted recall of the linked topics on the day (the lighter part: with the plan)">
						<span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-accent">
							{lifts && <span className="absolute inset-y-0 left-0 rounded-full bg-foreground/20" style={{ width: pct(planned!) }} />}
							<span className={cn("absolute inset-y-0 left-0 rounded-full", low ? "bg-warn" : "bg-foreground/70")} style={{ width: pct(r) }} />
						</span>
						<span className="tabular-nums text-xs text-muted-foreground">{pct(r)} recall</span>
					</span>
				)}
				{status && <span className={cn("shrink-0 rounded-full px-2 py-px text-xs font-semibold", status.className)}>{status.label}</span>}
			</div>
			<div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
				<span>
					{exam && exam.sessions > 0
						? `${exam.sessions} session${exam.sessions === 1 ? "" : "s"} · ${formatStudyTotal(exam.minutes)}`
						: entry.kind === "deadline"
							? "Deadline"
							: "Nothing planned"}
					{lifts ? ` · ${pct(planned!)} if you follow the plan` : ""}
				</span>
				{(entry.noteCount ?? 0) > 0 && (
					<span title="Files in this course's group">
						· {entry.noteCount} {entry.noteCount === 1 ? "file" : "files"}
					</span>
				)}
				{entry.course.key && (
					<button
						type="button"
						className={cn(
							"ml-auto underline-offset-2 transition-opacity hover:text-foreground hover:underline focus-visible:opacity-100 group-hover:opacity-100",
							!editing && "opacity-0",
						)}
						onClick={() => setEditing((v) => !v)}
					>
						{entry.linked ? "Sessions" : "Link sessions"}
					</button>
				)}
			</div>
			{exam && exam.unscheduledMinutes > 0 && (
				<p className="text-xs text-warn-ink">About {formatStudyTotal(exam.unscheduledMinutes)} of it does not fit {budget} minutes a day before then.</p>
			)}
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

/** Tell the server which session a plan step started, so Today can tick
 *  it off once the session has had its time. Best effort. */
function noteStarted(id: string, target: string): void {
	const chatId = /^\/chat\/([^/?#]+)/.exec(target)?.[1];
	if (!chatId) return;
	void fetch("/api/briefing/started", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ id, chatId }),
	}).catch(() => undefined);
}

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
	settingsRecovery = null,
	doneIds = [],
	weekDays = null,
	setup = null,
}: {
	initialBriefing: BriefingData | null;
	initialIntegrations: IntegrationsData;
	initialBudget: number;
	sessions: SessionOption[];
	honesty?: { points: number } | null;
	week?: StudyWeek | null;
	streak?: StudyStreak | null;
	settingsRecovery?: SettingsRecoveredInfo | null;
	/** Today's plan steps already done (server-side: their session had its time). */
	doneIds?: string[];
	weekDays?: WeekDaySession[][] | null;
	setup?: SetupState | null;
}) {
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const [briefing, setBriefing] = useState(initialBriefing);
	const [integrations, setIntegrations] = useState(initialIntegrations);
	const [budget, setBudget] = useState(initialBudget);
	const [busy, setBusy] = useState(false);
	const [pushing, setPushing] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const done = useMemo(() => new Set(doneIds), [doneIds]);

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
				// A check, review or class prep on known topics is a real review
				// session, so the answers move the review schedule. Without
				// topics (or if none is tracked any more) it falls back to a
				// learn session, with no warm-up: it is recall already.
				const recall = isRecallStep(item);
				const target =
					(recall ? await startStepReview(item) : null) ??
					(await startDraftSession(startPrompt(item), fetch, undefined, undefined, undefined, recall ? { warmup: false } : undefined));
				if (target) {
					setSessionBudget(target, item.minutes);
					noteStarted(item.id, target);
					router.push(target);
				}
			} catch {
				setError("Could not start the session.");
			}
		},
		onQuick: async (item) => {
			try {
				// Five minutes of a recall step: the same review, three topics.
				// Otherwise the step's title names the session and turn 1
				// carries the five-minute scope.
				const target =
					(isRecallStep(item) ? await startStepReview(item, QUICK_REVIEW_TOPICS) : null) ??
					(await startDraftSession(item.title, fetch, undefined, undefined, quickPrompt(item), { warmup: false }));
				if (target) {
					setSessionBudget(target, QUICK_SESSION_MINUTES);
					noteStarted(item.id, target);
					router.push(target);
				}
			} catch {
				setError("Could not start the session.");
			}
		},
		onPrimer: async (entry) => {
			const ask =
				entry.session === "tutorial"
					? "give me one short exercise on what we are likely to practise, and check my method"
					: entry.session === "lab"
						? "ask me one question on the theory and the method behind it"
						: "remind me where we left off and ask me one prediction question about what comes next";
			const text = `5-minute primer before my ${entry.event.title} class: ${ask}.`;
			try {
				// Five minutes, like "Only 5 minutes": no warm-up.
				const target = await startDraftSession(text, fetch, undefined, undefined, undefined, { warmup: false });
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
		onOpenSettings: (section) => openSettings(section),
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
			settingsRecovery={settingsRecovery}
			doneIds={done}
			weekDays={weekDays}
			setup={setup}
		/>
	);
}
