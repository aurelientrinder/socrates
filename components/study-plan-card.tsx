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

/** The tint behind each kind of plan step: amber for fading memory,
 *  blue for a check, neutral for new material and rehearsals. */
export const ACTION_TAG: Record<ItemAction, string> = {
	review: "bg-warn-soft text-warn-ink",
	check: "bg-good-soft text-good-ink",
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

const STATUS: Record<ExamPlan["status"], { label: string; className: string }> = {
	"not-started": {
		label: "Not started",
		className: "bg-warn-soft text-warn-ink",
	},
	tight: { label: "Tight", className: "bg-warn-soft text-warn-ink" },
	"on-track": { label: "On track", className: "bg-good-soft text-good-ink" },
	ready: { label: "Ready", className: "bg-good-soft text-good-ink" },
};

export function StudyPlanCard({ plan, onStart }: { plan: BriefingPlan; onStart: (item: BriefingItem) => void }) {
	const study = plan.study;
	if (!study) return null;
	const now = plan.generatedAt;
	const week = study.days.slice(1, WEEK_DAYS).filter((d) => d.items.length > 0);
	const later = study.days.slice(WEEK_DAYS).flatMap((d) => d.items);
	const changes = plan.changes ?? [];
	const exams = study.exams.filter((e) => e.kind === "exam" || e.sessions > 0 || e.unscheduledMinutes > 0);
	if (exams.length === 0 && week.length === 0 && study.tough.length === 0 && changes.length === 0) return null;
	return (
		<section
			aria-labelledby="study-plan-heading"
			data-testid="today-study-plan"
			className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-surface px-6 pb-6 pt-5"
		>
			<div className="flex flex-col gap-1">
				<h2 id="study-plan-heading" className="text-lg font-semibold">
					Study plan
				</h2>
				<p className="text-sm text-muted-foreground">
					Built from your calendar and what your answers show you know. Rebuilt every morning, so it follows how you do.
				</p>
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

			{exams.length > 0 && (
				<ul className="flex flex-col gap-3">
					{exams.map((exam) => (
						<ExamRow key={exam.eventId} exam={exam} now={now} budget={plan.budgetMinutes} />
					))}
				</ul>
			)}

			{week.length > 0 && (
				<div className="flex flex-col gap-3 border-t border-border/60 pt-4">
					<h3 className="text-base font-semibold">Rest of the week</h3>
					<ol className="flex flex-col gap-3">
						{week.map((day) => (
							<li key={day.date} data-testid="study-plan-day" className="flex flex-col gap-1">
								<div className="flex items-baseline justify-between gap-2 text-sm">
									<span className="font-medium">{dayLabel(day.date, now)}</span>
									<span className="tabular-nums text-muted-foreground">{minutesLabel(day.minutes)}</span>
								</div>
								<ul className="flex flex-col">
									{day.items.map((item) => (
										<li key={item.id} className="group flex items-center gap-2 text-sm">
											<span className={cn("shrink-0 rounded-full px-2 py-px text-xs font-semibold", ACTION_TAG[item.action])}>
												{ACTION_LABEL[item.action]}
											</span>
											<span className="min-w-0 flex-1 truncate" title={item.reason}>
												{item.title}
											</span>
											<Button
												variant="ghost"
												size="sm"
												className="h-7 shrink-0 px-2 text-xs text-muted-foreground"
												onClick={() => onStart(item)}
												aria-label={`Start now: ${item.title}`}
											>
												<PlayIcon className="size-3" />
												Do now
											</Button>
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

function ExamRow({ exam, now, budget }: { exam: ExamPlan; now: number; budget: number }) {
	const status = STATUS[exam.status];
	const r = exam.readinessNow;
	const planned = exam.readinessPlanned;
	return (
		<li data-testid="study-plan-exam" className="flex flex-col gap-1.5 text-sm">
			<div className="flex flex-wrap items-baseline gap-2">
				<span className="min-w-0 truncate text-base">
					{exam.url ? (
						<a href={exam.url} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
							{exam.title}
						</a>
					) : (
						exam.title
					)}
				</span>
				<span className="text-muted-foreground">{whenLabel(exam.start, now)}</span>
				<span className={cn("ml-auto rounded-full px-2 py-px text-xs font-semibold", status.className)}>{status.label}</span>
			</div>
			<p className="text-muted-foreground">
				{exam.sessions > 0
					? `${exam.sessions} session${exam.sessions === 1 ? "" : "s"} planned, ${minutesLabel(exam.minutes)} in all.`
					: exam.status === "ready"
						? "Nothing needed yet: everything linked should still be solid on the day."
						: "Nothing planned for it."}
				{r !== null && (
					<>
						{" "}
						Recall on the day: {pct(r)} as things stand
						{planned !== null && planned > r + 0.005 ? `, about ${pct(planned)} if you follow the plan` : ""}.
					</>
				)}
			</p>
			{exam.unscheduledMinutes > 0 && (
				<p className="text-warn-ink">
					About {minutesLabel(exam.unscheduledMinutes)} of it does not fit {budget} minutes a day before then. More time per day would cover
					it.
				</p>
			)}
		</li>
	);
}
