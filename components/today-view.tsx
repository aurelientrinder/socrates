"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarPlusIcon, ListPlusIcon, Loader2Icon, PlayIcon, RefreshCwIcon } from "lucide-react";
import {
	BUDGET_CHOICES,
	startPrompt,
	whenLabel,
	type BriefingItem,
	type BriefingPlan,
	type ClassEntry,
	type StudyEvent,
	type UpcomingEntry,
} from "@/src/core";
import { startDraftSession } from "@/components/new-session";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { onSettingsSaved } from "@/components/settings-signal";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * THE TODAY VIEW (daily briefing): at most three things to study today and
 * why, what is coming up in the next two weeks with a readiness bar, and
 * today's classes. The ranking is server-side code (src/core/briefing.ts);
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
}) {
	const plan = briefing?.plan;
	const todo = integrations.todo[0];
	return (
		<div data-testid="today-view" className="h-full overflow-y-auto">
			<div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-10">
				<header className="flex flex-col gap-3">
					<div className="flex items-center gap-3">
						<h1 className="text-xs uppercase tracking-widest text-muted-foreground/70">Today</h1>
						<span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
							<label htmlFor="today-budget">Daily budget</label>
							<select
								id="today-budget"
								data-testid="today-budget"
								value={budgetMinutes}
								onChange={(e) => handlers.onBudget(Number(e.target.value))}
								className="rounded-md border bg-transparent px-1.5 py-0.5"
							>
								{BUDGET_CHOICES.map((m) => (
									<option key={m} value={m}>
										{m} min
									</option>
								))}
							</select>
							<Button variant="ghost" size="sm" onClick={handlers.onRefresh} disabled={busy} data-testid="today-refresh">
								{busy ? <Loader2Icon className="size-3.5 animate-spin" /> : <RefreshCwIcon className="size-3.5" />}
								Refresh
							</Button>
						</span>
					</div>
					{briefing ? (
						<p data-testid="today-note" className="text-lg leading-relaxed">
							{briefing.note}
						</p>
					) : (
						<p className="text-lg text-muted-foreground">{busy ? "Putting today's briefing together…" : "No briefing yet today."}</p>
					)}
					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}
				</header>

				<Connections integrations={integrations} briefing={briefing} handlers={handlers} />

				{plan && (
					<>
						<section className="flex flex-col gap-3">
							<SectionTitle>Do first</SectionTitle>
							{plan.items.length === 0 ? (
								<p className="text-sm text-muted-foreground">Nothing urgent. A good day to learn something new.</p>
							) : (
								<ol className="flex flex-col gap-3">
									{plan.items.map((item, i) => (
										<ItemCard
											key={item.id}
											index={i + 1}
											item={item}
											pushed={briefing.pushed?.[item.id]}
											pushing={pushing}
											canTodo={todo?.configured === true}
											todoLabel={todo?.label ?? "to-do"}
											canCalendar={integrations.google.connected}
											handlers={handlers}
										/>
									))}
								</ol>
							)}
							{plan.trackedTopics === 0 && (
								<p className="text-sm text-muted-foreground">
									Your memory of each topic is measured from quiz checks and practice. Once you have answered a few, the briefing
									can tell what is fading before each exam.
								</p>
							)}
						</section>

						<section className="flex flex-col gap-3">
							<SectionTitle>Coming up in the next two weeks</SectionTitle>
							{plan.upcoming.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									{integrations.google.connected || todo?.configured
										? "No exams or deadlines found."
										: "Connect your calendar to see exams and deadlines here."}
								</p>
							) : (
								<ul className="flex flex-col divide-y rounded-md border">
									{plan.upcoming.map((u) => (
										<UpcomingRow key={u.event.id} entry={u} now={plan.generatedAt} sessions={sessions} onLink={handlers.onLinkCourse} />
									))}
								</ul>
							)}
						</section>

						{plan.todayClasses.length > 0 && (
							<section className="flex flex-col gap-3">
								<SectionTitle>Classes today</SectionTitle>
								<ul className="flex flex-col divide-y rounded-md border">
									{plan.todayClasses.map((c) => (
										<li key={c.event.id} className="flex items-center gap-3 px-3 py-2 text-sm">
											<span className="w-20 shrink-0 whitespace-nowrap tabular-nums text-muted-foreground">{timeOf(c.event)}</span>
											<span className="min-w-0 flex-1 truncate">{c.event.title}</span>
											<Button variant="ghost" size="sm" onClick={() => handlers.onPrimer(c)} data-testid="today-primer">
												5-minute primer
											</Button>
										</li>
									))}
								</ul>
							</section>
						)}
					</>
				)}
			</div>
		</div>
	);
}

function SectionTitle({ children }: { children: React.ReactNode }) {
	return <h2 className="text-xs uppercase tracking-widest text-muted-foreground/70">{children}</h2>;
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
		<section data-testid="today-connections" className="flex flex-col gap-2 rounded-md border p-3 text-sm">
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

const ACTION_LABEL = { review: "Review", check: "Quick check", learn: "New material" } as const;

function ItemCard({
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
		<li data-testid="today-item" className="flex flex-col gap-2 rounded-md border p-3">
			<div className="flex items-baseline gap-2">
				<span className="tabular-nums text-muted-foreground">{index}.</span>
				<span className="font-medium">{item.title}</span>
				<span className="ml-auto shrink-0 text-xs text-muted-foreground">
					{ACTION_LABEL[item.action]} · {item.minutes} min
				</span>
			</div>
			<p className="text-sm text-muted-foreground">{item.reason}</p>
			<div className="flex flex-wrap items-center gap-2">
				<Button size="sm" onClick={() => handlers.onStart(item)} data-testid="today-start">
					<PlayIcon className="size-3.5" />
					Start
				</Button>
				{item.chatId && (
					<Link href={`/chat/${item.chatId}`} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
						Open {item.chatTitle ? `“${item.chatTitle}”` : "session"}
					</Link>
				)}
				<span className="ml-auto flex items-center gap-1">
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
				</span>
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
		<li data-testid="today-upcoming" className="flex flex-col gap-2 px-3 py-2 text-sm">
			<div className="flex items-center gap-3">
				<span className="w-24 shrink-0 text-muted-foreground">{whenLabel(entry.event.start, now)}</span>
				<span className="min-w-0 flex-1 truncate">
					{entry.event.url ? (
						<a href={entry.event.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
							{entry.event.title}
						</a>
					) : (
						entry.event.title
					)}
					<span className="ml-2 text-xs text-muted-foreground">{entry.kind}</span>
				</span>
				{r === null ? (
					<span className="text-xs text-amber-500">nothing studied yet</span>
				) : (
					<span className="flex w-28 shrink-0 items-center gap-2" title="Average predicted recall of the linked topics on the day">
						<span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
							<span className={cn("block h-full", r >= 0.9 ? "bg-emerald-500" : r >= 0.7 ? "bg-amber-500" : "bg-red-500")} style={{ width: pct(r) }} />
						</span>
						<span className="tabular-nums text-xs text-muted-foreground">{pct(r)}</span>
					</span>
				)}
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
}: {
	initialBriefing: BriefingData | null;
	initialIntegrations: IntegrationsData;
	initialBudget: number;
	sessions: SessionOption[];
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
				if (target) router.push(target);
			} catch {
				setError("Could not start the session.");
			}
		},
		onPrimer: async (entry) => {
			const text = `5-minute primer before my ${entry.event.title} class: remind me where we left off and ask me one prediction question about what comes next.`;
			try {
				const target = await startDraftSession(text, fetch);
				if (target) router.push(target);
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
		/>
	);
}
