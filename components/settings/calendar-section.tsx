"use client";

import { useCallback, useEffect, useState } from "react";
import { BellIcon, CalendarIcon, ListChecksIcon } from "lucide-react";
import { REMINDER_HOUR_CHOICES } from "@/src/core";
import { Button } from "@/components/ui/button";
import type { BriefingData, IntegrationsData } from "@/components/today-view";
import { cn } from "@/lib/utils";

/**
 * SETTINGS → CALENDAR & REMINDERS (QoL pass, 2026-11-08): the connection
 * controls and the reminders that used to sit on Today. Today keeps one
 * nudge here when something is broken; setup lives in Settings.
 */

interface ReminderStatus {
	prefs: { enabled: boolean; hour: number };
	syncedAt?: number;
	scheduled?: number;
	error?: string;
}

const hourLabel = (h: number) => (h === 12 ? "12 pm" : h > 12 ? `${h - 12} pm` : `${h} am`);

async function json<T>(res: Response): Promise<T> {
	const body = (await res.json().catch(() => ({}))) as T & { error?: string };
	if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status})`);
	return body;
}

/** One row: a tile, the name, a status line with a dot, the control. */
export function ServiceRow({
	icon,
	title,
	status,
	ok = true,
	testid,
	children,
}: {
	icon: React.ReactNode;
	title: string;
	status: React.ReactNode;
	ok?: boolean;
	testid?: string;
	children?: React.ReactNode;
}) {
	return (
		<div data-testid={testid} className="flex flex-wrap items-center gap-3 px-4 py-3">
			<span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-foreground/80">{icon}</span>
			<div className="min-w-0 flex-1">
				<div className="text-[14.5px] font-medium">{title}</div>
				<div className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
					<span aria-hidden="true" className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", ok ? "bg-foreground/50" : "bg-warn")} />
					<span>{status}</span>
				</div>
			</div>
			{children}
		</div>
	);
}

export function CalendarSection({ onOpenKeys }: { onOpenKeys: (keyId: string) => void }) {
	const [integrations, setIntegrations] = useState<IntegrationsData | null>(null);
	const [briefing, setBriefing] = useState<BriefingData | null>(null);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			const body = await json<{ briefing: BriefingData | null; integrations: IntegrationsData }>(await fetch("/api/briefing"));
			setIntegrations(body.integrations);
			setBriefing(body.briefing);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not load the connections.");
		}
	}, []);
	useEffect(() => void load(), [load]);

	// While a Google sign-in waits on the browser, poll its status.
	const pending = integrations?.google.pending === true;
	useEffect(() => {
		if (!pending) return;
		const timer = setInterval(async () => {
			try {
				const google = await json<IntegrationsData["google"]>(await fetch("/api/integrations/google"));
				setIntegrations((prev) => (prev ? { ...prev, google } : prev));
				if (!google.pending) clearInterval(timer);
			} catch {
				// keep polling; the sign-in times out server-side
			}
		}, 1500);
		return () => clearInterval(timer);
	}, [pending]);

	const google = async (action: "connect" | "disconnect") => {
		setError(null);
		try {
			const body = await json<{ authUrl?: string; status?: IntegrationsData["google"] } & IntegrationsData["google"]>(
				await fetch("/api/integrations/google", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ action }),
				}),
			);
			const status = body.status ?? body;
			setIntegrations((prev) => (prev ? { ...prev, google: status } : prev));
			// The desktop shell routes window.open to the real browser.
			if (action === "connect" && body.authUrl) window.open(body.authUrl, "_blank", "noopener");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Google sign-in failed.");
		}
	};

	if (!integrations) return <p className="text-sm text-muted-foreground">{error ?? "Loading…"}</p>;
	const g = integrations.google;
	const todo = integrations.todo[0];
	const calendarError = briefing?.sources.calendar.error ?? g.error;
	const todoError = briefing?.sources.todo.error;

	return (
		<div className="flex flex-col gap-6" data-testid="section-calendar-body">
			<section className="flex flex-col gap-2">
				<div>
					<h3 className="text-[13px] font-semibold text-muted-foreground">Connections</h3>
					<p className="text-[12.5px] text-muted-foreground">Nothing is sent to them except what you choose to add.</p>
				</div>
				<div className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-surface">
					<ServiceRow
						icon={<CalendarIcon className="size-4" />}
						title="Google Calendar"
						ok={g.connected && !g.needsReconnect && !calendarError}
						testid="settings-google"
						status={
							calendarError ??
							(g.connected
								? g.needsReconnect
									? "Reconnect once so Socrates can keep its study blocks and reminders on its own “Socrates” calendar."
									: `Connected${g.email ? ` as ${g.email}` : ""} · study blocks go to your Socrates calendar`
								: g.configured
									? "Not connected"
									: "Needs your own Google OAuth client first (one-time, about 5 minutes).")
						}
					>
						{g.connected ? (
							<>
								{g.needsReconnect && (
									<Button size="sm" onClick={() => void google("connect")} disabled={g.pending}>
										{g.pending ? "Waiting for the browser…" : "Reconnect"}
									</Button>
								)}
								<Button variant="ghost" size="sm" onClick={() => void google("disconnect")}>
									Disconnect
								</Button>
							</>
						) : g.configured ? (
							<Button size="sm" onClick={() => void google("connect")} disabled={g.pending} data-testid="settings-connect-google">
								{g.pending ? "Waiting for the browser…" : "Sign in with Google"}
							</Button>
						) : (
							<Button variant="outline" size="sm" onClick={() => onOpenKeys("GOOGLE_OAUTH_CLIENT_ID")}>
								Add client ID
							</Button>
						)}
					</ServiceRow>
					{todo && (
						<ServiceRow
							icon={<ListChecksIcon className="size-4" />}
							title={todo.label}
							ok={todo.configured && !todoError}
							status={todoError ?? (todo.configured ? "Connected · dated tasks show as deadlines" : "Paste your API token to see dated tasks and add study tasks.")}
						>
							{!todo.configured && (
								<Button variant="outline" size="sm" onClick={() => onOpenKeys("TODOIST_API_TOKEN")}>
									Add token
								</Button>
							)}
						</ServiceRow>
					)}
				</div>
				{error && <p className="text-sm text-destructive">{error}</p>}
			</section>

			<section className="flex flex-col gap-2">
				<h3 className="text-[13px] font-semibold text-muted-foreground">Reminders</h3>
				{g.connected ? (
					<Reminders />
				) : (
					<p className="text-[13px] text-muted-foreground">Reminders arrive through your Google Calendar, so they need it connected first.</p>
				)}
			</section>
		</div>
	);
}

/** Opt-in gentle pings on the Socrates calendar, so the phone and the
 *  laptop both alert even with the app closed. */
function Reminders() {
	const [status, setStatus] = useState<ReminderStatus | null>(null);
	const [busy, setBusy] = useState(false);

	const post = useCallback(async (body: Record<string, unknown>) => {
		setBusy(true);
		try {
			const res = await fetch("/api/reminders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
			const data = (await res.json()) as ReminderStatus & { error?: string };
			setStatus((prev) => (res.ok ? data : prev ? { ...prev, error: data.error } : prev));
		} catch {
			setStatus((prev) => (prev ? { ...prev, error: "Could not reach the app." } : prev));
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		void fetch("/api/reminders")
			.then((r) => (r.ok ? (r.json() as Promise<ReminderStatus>) : null))
			.then((s) => s && setStatus(s))
			.catch(() => undefined);
	}, []);

	if (!status) return null;
	const { enabled, hour } = status.prefs;
	return (
		<>
			<div data-testid="settings-reminders" className="overflow-hidden rounded-xl border border-border/70 bg-surface">
				<ServiceRow
					icon={<BellIcon className="size-4" />}
					title="Study reminders"
					status={status.error ?? "One nudge on days with planned work, and a heads-up before exams, on your phone and laptop."}
					ok={!status.error}
				>
					<button
						type="button"
						role="switch"
						aria-checked={enabled}
						aria-label="Study reminders"
						disabled={busy}
						onClick={() => void post({ enabled: !enabled })}
						className={cn("relative h-5 w-9 shrink-0 rounded-full transition-colors", enabled ? "bg-foreground" : "bg-accent ring-1 ring-border ring-inset")}
					>
						<span className={cn("absolute top-0.5 size-4 rounded-full bg-background shadow-xs transition-all", enabled ? "right-0.5" : "left-0.5")} />
					</button>
				</ServiceRow>
			</div>
			{enabled && (
				<div className="flex flex-wrap items-center gap-3 pl-1 text-sm">
					<span className="text-muted-foreground">Time</span>
					<div role="group" aria-label="Reminder time" className="flex rounded-lg bg-accent/60 p-0.5 text-xs">
						{REMINDER_HOUR_CHOICES.map((h) => (
							<button
								key={h}
								type="button"
								aria-pressed={hour === h}
								disabled={busy}
								onClick={() => void post({ hour: h })}
								className={cn("rounded-md px-2 py-1", hour === h ? "bg-surface font-semibold text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
							>
								{hourLabel(h)}
							</button>
						))}
					</div>
					<span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
						{status.scheduled !== undefined && `${status.scheduled} scheduled`}
						<button type="button" disabled={busy} onClick={() => void post({ sync: true })} className="underline-offset-2 hover:text-foreground hover:underline">
							Sync now
						</button>
					</span>
				</div>
			)}
		</>
	);
}
