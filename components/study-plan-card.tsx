"use client";

import { PlayIcon } from "lucide-react";
import { WEEK_DAYS, dayLabel, whenLabel, type BriefingItem, type BriefingPlan, type ExamPlan, type ItemAction } from "@/src/core";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * THE STUDY PLAN CARD (Today, under today's list): what the planner
 * (src/core/study-plan.ts) laid out from the calendar — each exam with its
 * sessions and the recall it should reach, the rest of the week day by
 * day, the classes flagged as tough, and what changed since yesterday's
 * plan. Read-only apart from Start, which runs a later session now.
 */

export const ACTION_LABEL: Record<ItemAction, string> = {
	review: "Review",
	check: "Quick check",
	learn: "New material",
	rehearse: "Exam rehearsal",
	prep: "Class prep",
};

/** The tint behind each kind of plan step: amber for fading memory and
 *  class prep, neutral ink for everything else (no blue, Today refine). */
export const ACTION_TAG: Record<ItemAction, string> = {
	review: "bg-warn-soft text-warn-ink",
	check: "bg-accent text-foreground/80",
	learn: "bg-accent text-foreground/80",
	rehearse: "bg-accent text-foreground/80",
	prep: "bg-warn-soft text-warn-ink",
};

const pct = (x: number) => `${Math.round(x * 100)}%`;

function minutesLabel(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** An exam's standing in the plan, shown in Today's Coming up list. */
export const EXAM_STATUS: Record<ExamPlan["status"], { label: string; className: string }> = {
	"not-started": {
		label: "Not started",
		className: "bg-warn-soft text-warn-ink",
	},
	tight: { label: "Tight", className: "bg-warn-soft text-warn-ink" },
	"on-track": { label: "On track", className: "bg-accent text-foreground/80" },
	ready: { label: "Ready", className: "bg-accent text-foreground/80" },
};

export function StudyPlanCard({ plan, onStart }: { plan: BriefingPlan; onStart: (item: BriefingItem) => void }) {
	const study = plan.study;
	if (!study) return null;
	const now = plan.generatedAt;
	const week = study.days.slice(1, WEEK_DAYS).filter((d) => d.items.length > 0);
	const later = study.days.slice(WEEK_DAYS).flatMap((d) => d.items);
	const changes = plan.changes ?? [];
	if (week.length === 0 && study.tough.length === 0 && changes.length === 0) return null;
	return (
		<section
			aria-labelledby="study-plan-heading"
			data-testid="today-study-plan"
			className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-surface px-6 pb-6 pt-5"
		>
			<div className="flex flex-col gap-1">
				<h2 id="study-plan-heading" className="text-lg font-semibold">
					Rest of the week
				</h2>
				<p className="text-sm text-muted-foreground">From your calendar and your answers, rebuilt every morning.</p>
			</div>

			{changes.length > 0 && (
				<ul data-testid="study-plan-changes" className="flex flex-col gap-1.5 rounded-xl bg-accent/50 px-4 py-3 text-sm">
					{changes.map((c) => (
						<li key={c} className="flex gap-2">
							<span aria-hidden="true" className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
							<span>{c}</span>
						</li>
					))}
				</ul>
			)}

			{week.length > 0 && (
				<div className="flex flex-col gap-3">
					<ol className="flex flex-col divide-y divide-border/50">
						{week.map((day) => (
							<li key={day.date} data-testid="study-plan-day" className="flex gap-4 py-2.5 first:pt-0 last:pb-0">
								<div className="flex w-24 shrink-0 flex-col text-sm">
									<span className="font-medium">{dayLabel(day.date, now)}</span>
									<span className="text-xs tabular-nums text-muted-foreground">{minutesLabel(day.minutes)}</span>
								</div>
								<ul className="flex min-w-0 flex-1 flex-col gap-1">
									{day.items.map((item) => (
										<li key={item.id} className="group flex min-h-7 items-center gap-2 text-sm">
											<span className="min-w-0 flex-1 truncate" title={item.reason}>
												{item.title}
											</span>
											{/* The tag and "Do now" share one slot: hover or focus swaps them. */}
											<span className="relative flex shrink-0 justify-end">
												<span
													className={cn(
														"rounded-full px-2 py-px text-xs font-semibold transition-opacity group-focus-within:opacity-0 group-hover:opacity-0",
														ACTION_TAG[item.action],
													)}
												>
													{ACTION_LABEL[item.action]}
												</span>
												<Button
													variant="ghost"
													size="sm"
													className="absolute right-0 top-1/2 h-7 -translate-y-1/2 px-2 text-xs opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
													onClick={() => onStart(item)}
													aria-label={`Start now: ${item.title}`}
												>
													<PlayIcon className="size-3" />
													Do now
												</Button>
											</span>
										</li>
									))}
								</ul>
							</li>
						))}
					</ol>
					{later.length > 0 && (
						<p className="text-sm text-muted-foreground">
							Then {later.length} more session{later.length === 1 ? "" : "s"} ({minutesLabel(later.reduce((a, i) => a + i.minutes, 0))})
							after this week.
						</p>
					)}
				</div>
			)}

			{study.tough.length > 0 && (
				<div data-testid="study-plan-tough" className="flex flex-col gap-2 border-t border-border/60 pt-4">
					<h3 className="text-base font-semibold">Tough classes</h3>
					<ul className="flex flex-col gap-2">
						{study.tough.map((t) => (
							<li key={t.key} className="flex flex-col text-sm">
								<span>
									<span className="font-medium">{t.label}</span>
									<span className="text-muted-foreground"> · next class {whenLabel(t.nextClass.start, now)}</span>
								</span>
								<span className="text-muted-foreground">
									{t.reason.charAt(0).toUpperCase() + t.reason.slice(1)} A short prep is planned before each class this week.
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
}
