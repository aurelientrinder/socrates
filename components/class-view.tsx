"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { CalendarIcon, FileTextIcon, PlayIcon, ZapIcon } from "lucide-react";
import { PageFrame } from "@/components/page-header";
import { startPlanStep } from "@/components/plan-start";
import { SessionRow } from "@/components/sidebar";
import { useStartDialog } from "@/components/start-dialog";
import { ACTION_LABEL, ACTION_TAG, EXAM_STATUS } from "@/components/study-plan-card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TARGET_RETENTION, type BriefingItem, type ClassPageData } from "@/src/core";

/**
 * THE CLASS PAGE (QoL pass, 2026-11-08): one class on one screen. The pure
 * shell renders from the server's ClassPageData; the actions are handlers
 * so the render test needs no router.
 */

const DAY = 24 * 60 * 60 * 1000;
const pct = (x: number) => `${Math.round(x * 100)}%`;

function dayName(date: string, now: Date): string {
	const [y, m, d] = date.split("-").map(Number);
	const day = new Date(y!, m! - 1, d!);
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const diff = Math.round((day.getTime() - today.getTime()) / DAY);
	if (diff === 0) return "Today";
	if (diff === 1) return "Tomorrow";
	return day.toLocaleDateString("en-GB", { weekday: "long" });
}

function whenLabel(start: number, now: Date): string {
	const date = new Date(start).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
	const days = Math.round((new Date(start).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
	return `${date} · ${days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`}`;
}

function Card({ title, right, children, className, testId }: { title: string; right?: React.ReactNode; children: React.ReactNode; className?: string; testId?: string }) {
	return (
		<section data-testid={testId} className={cn("flex flex-col gap-3 rounded-2xl border border-border/70 bg-surface px-5 py-4", className)}>
			<div className="flex items-baseline justify-between gap-2">
				<h2 className="text-base font-semibold">{title}</h2>
				{right}
			</div>
			{children}
		</section>
	);
}

export interface ClassHandlers {
	onStart: (item: BriefingItem) => void;
	onQuick: (item: BriefingItem) => void;
	onMockExam: () => void;
	onLearn: () => void;
	onOpenSession: (id: string) => void;
}

export function ClassShell({
	data,
	handlers,
	now = new Date(),
	activeId = null,
	starting = false,
}: {
	data: ClassPageData;
	handlers: ClassHandlers;
	now?: Date;
	activeId?: string | null;
	starting?: boolean;
}) {
	const next = data.plan[0]?.item ?? null;
	const total = data.plan.reduce((sum, p) => sum + p.item.minutes, 0);
	const exam = data.exam;
	const status = exam?.plan ? EXAM_STATUS[exam.plan.status] : null;
	const summary = [
		`${data.sessions.length} ${data.sessions.length === 1 ? "session" : "sessions"}`,
		`${data.notes.length} note ${data.notes.length === 1 ? "file" : "files"}`,
		`${data.topics.length} ${data.topics.length === 1 ? "topic" : "topics"} tracked`,
	].join(" · ");
	const actions = (
		<div className="flex flex-wrap items-center gap-2">
			{next ? (
				<>
					<Button size="lg" className="h-11 rounded-xl px-5 text-base" disabled={starting} onClick={() => handlers.onStart(next)} data-testid="class-start">
						<PlayIcon className="size-4 fill-current" />
						{next.title} · {next.minutes} min
					</Button>
					<Button variant="outline" size="lg" className="h-11 rounded-xl px-4 text-base" disabled={starting} onClick={() => handlers.onQuick(next)}>
						<ZapIcon className="size-4" />
						Only 5 minutes
					</Button>
				</>
			) : (
				<Button size="lg" className="h-11 rounded-xl px-5 text-base" onClick={handlers.onLearn} data-testid="class-learn">
					<PlayIcon className="size-4 fill-current" />
					Learn something in {data.label}
				</Button>
			)}
			{data.notes.length > 0 && (
				<Button variant="ghost" size="lg" className="ml-auto h-11 rounded-xl px-4 text-base" onClick={handlers.onMockExam} data-testid="class-mock-exam">
					Mock exam
				</Button>
			)}
		</div>
	);

	return (
		<PageFrame title={data.label} width="max-w-6xl" testId="class-page">
			<div className={cn(`cal-c${data.color}`, "-mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground")}>
				<span aria-hidden="true" className="size-3 rounded-[3px] bg-(--bar)" />
				<span>{summary}</span>
				{data.next && (
					<span>
						Next: {data.next.title}, {new Date(data.next.start).toLocaleString("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit" })}
					</span>
				)}
			</div>
			<div className="flex flex-wrap items-start gap-6">
				<div className="flex min-w-0 flex-[2_1_30rem] flex-col gap-6">
					<section data-testid="class-hero" className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-surface px-6 pt-5 pb-6">
						{exam ? (
							<>
								<div className="flex items-center justify-between gap-3">
									<span className="text-sm font-medium text-muted-foreground">{exam.kind === "exam" ? "Next exam" : "Next deadline"}</span>
									{status && <span className={cn("rounded-full px-2 py-px text-xs font-semibold", status.className)}>{status.label}</span>}
								</div>
								<div className="flex flex-wrap items-baseline justify-between gap-2">
									<span className="text-2xl font-semibold tracking-tight">{exam.title}</span>
									<span className="text-base text-muted-foreground">{whenLabel(exam.start, now)}</span>
								</div>
								{exam.plan && exam.plan.readinessNow !== null && (
									<div className="flex flex-col gap-1.5">
										<span className="relative h-2 overflow-hidden rounded-full bg-accent">
											{exam.plan.readinessPlanned !== null && (
												<span className="absolute inset-y-0 left-0 rounded-full bg-foreground/20" style={{ width: pct(exam.plan.readinessPlanned) }} />
											)}
											<span className="absolute inset-y-0 left-0 rounded-full bg-foreground/70" style={{ width: pct(exam.plan.readinessNow) }} />
										</span>
										<span className="text-sm text-muted-foreground">
											{pct(exam.plan.readinessNow)} recall on the day as things stand
											{exam.plan.readinessPlanned !== null &&
												`, ${pct(exam.plan.readinessPlanned)} if you follow the plan: ${exam.plan.sessions} ${exam.plan.sessions === 1 ? "session" : "sessions"}, ${exam.plan.minutes} min`}
											.
										</span>
									</div>
								)}
							</>
						) : (
							<div className="flex flex-col gap-1">
								<span className="text-sm font-medium text-muted-foreground">{next ? "Next for this class" : "Nothing planned"}</span>
								<span className="text-xl font-semibold tracking-tight">
									{next ? next.reason || next.title : "No exam on the calendar and nothing due. A short session keeps it fresh."}
								</span>
							</div>
						)}
						{actions}
					</section>

					<Card title="What you know" right={<span className="text-sm text-muted-foreground">recall now</span>} testId="class-topics">
						{data.topics.length === 0 ? (
							<p className="text-sm text-muted-foreground">Nothing tested yet. Answer a few questions in a session and it shows here.</p>
						) : (
							<ul className="flex flex-col gap-2.5">
								{data.topics.map((t) => {
									const fading = t.due || t.retention < TARGET_RETENTION;
									return (
										<li key={t.key} className="flex items-center gap-3 text-sm">
											<span className="w-56 shrink-0 truncate">{t.title}</span>
											<span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-accent">
												<span className={cn("absolute inset-y-0 left-0 rounded-full", fading ? "bg-warn" : "bg-foreground/60")} style={{ width: pct(t.retention) }} />
											</span>
											<span className={cn("w-20 text-right text-xs tabular-nums", fading ? "font-semibold text-warn-ink" : "text-muted-foreground")}>
												{pct(t.retention)}
												{fading ? " · fading" : ""}
											</span>
										</li>
									);
								})}
							</ul>
						)}
					</Card>

					<Card title="Its plan" right={total > 0 ? <span className="text-sm text-muted-foreground">{total} min</span> : undefined} testId="class-plan">
						{data.plan.length === 0 ? (
							<p className="text-sm text-muted-foreground">Nothing planned for this class in the coming days.</p>
						) : (
							<ol className="flex flex-col divide-y divide-border/50">
								{data.plan.map(({ date, item }) => (
									<li key={`${date}-${item.id}`} className="flex items-center gap-4 py-2 text-sm first:pt-0 last:pb-0">
										<span className="w-24 shrink-0 font-medium">{dayName(date, now)}</span>
										<span className="min-w-0 flex-1 truncate">{item.title}</span>
										<span className={cn("rounded-full px-2 py-px text-xs font-semibold", ACTION_TAG[item.action])}>{ACTION_LABEL[item.action]}</span>
										<span className="w-12 text-right text-xs text-muted-foreground tabular-nums">{item.minutes} min</span>
									</li>
								))}
							</ol>
						)}
					</Card>
				</div>

				<div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-5">
					<Card title="Sessions" right={<span className="text-sm text-muted-foreground">{data.sessions.length}</span>} testId="class-sessions">
						{data.sessions.length === 0 ? (
							<p className="text-sm text-muted-foreground">No sessions filed here yet.</p>
						) : (
							<div className="-mx-2">
								{data.sessions.map((c) => (
									<SessionRow key={c.id} chat={c} active={c.id === activeId} onOpen={() => handlers.onOpenSession(c.id)} classColor={data.color} />
								))}
							</div>
						)}
					</Card>
					<Card
						title="Notes"
						right={
							<Link href="/library" className="text-sm text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
								Add files
							</Link>
						}
						testId="class-notes"
					>
						{data.notes.length === 0 ? (
							<p className="text-sm text-muted-foreground">No notes yet. Add your slides or PDFs in the Library.</p>
						) : (
							<ul className="flex flex-col gap-1.5 text-sm">
								{data.notes.map((n) => (
									<li key={n.id} className="flex items-center gap-2">
										<FileTextIcon className="size-3.5 shrink-0 text-muted-foreground" />
										<span className="truncate">{n.name}</span>
									</li>
								))}
							</ul>
						)}
					</Card>
					{data.classes.length > 0 && (
						<Card title="Classes this week" testId="class-week">
							<ul className="flex flex-col gap-2 text-sm">
								{data.classes.map((c) => (
									<li key={`${c.start}-${c.title}`} className="flex items-center gap-2">
										<CalendarIcon className="size-3.5 text-muted-foreground" />
										<span className="w-20 text-muted-foreground tabular-nums">
											{new Date(c.start).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" })}
										</span>
										<span className="flex-1 truncate">{c.title}</span>
										{c.tough && <span className="rounded-full bg-warn-soft px-2 py-px text-xs font-semibold text-warn-ink">tough</span>}
									</li>
								))}
							</ul>
						</Card>
					)}
				</div>
			</div>
		</PageFrame>
	);
}

export function ClassView({ data }: { data: ClassPageData }) {
	const router = useRouter();
	const pathname = usePathname();
	const { open: openStart } = useStartDialog();
	const [starting, setStarting] = useState(false);
	const start = async (item: BriefingItem, quick: boolean) => {
		setStarting(true);
		try {
			const target = await startPlanStep(item, quick);
			if (target) router.push(target);
		} finally {
			setStarting(false);
		}
	};
	return (
		<ClassShell
			data={data}
			starting={starting}
			activeId={/^\/chat\/([^/]+)/.exec(pathname)?.[1] ?? null}
			handlers={{
				onStart: (item) => void start(item, false),
				onQuick: (item) => void start(item, true),
				onMockExam: () => openStart("exam", undefined, { topic: data.label, notes: data.notes }),
				onLearn: () => openStart("learn", undefined, { topic: data.label, notes: data.notes }),
				onOpenSession: (id) => router.push(`/chat/${id}`),
			}}
		/>
	);
}
