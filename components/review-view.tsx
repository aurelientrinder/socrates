import Link from "next/link";
import {
	GRADE_AGAIN,
	GRADE_HARD,
	TARGET_RETENTION,
	UPCOMING_DAYS,
	relativeDays,
	type RetentionReport,
	type ReviewStatus,
	type TopicRetention,
} from "@/src/core";
import { ReviewStart } from "@/components/review-start";
import { SectionHeading } from "@/components/page-header";
import { cn } from "@/lib/utils";

/**
 * THE REVIEW VIEW (knowledge decay): what you are forgetting, as of now.
 * Leads with what is due (estimated recall under the target, weakest
 * first), then what falls due this week, then every tested topic with its
 * estimated retention. Presentational only: the page folds the records
 * server-side (src/core/retention.ts). Rendered as the Memory tab of the
 * Progress page, which owns the page title.
 */
export function ReviewView({ report, status }: { report: RetentionReport; status?: ReviewStatus }) {
	const target = Math.round(TARGET_RETENTION * 100);
	return (
		<div data-testid="review-view" className="flex flex-col gap-8">
			<header className="flex flex-col gap-2">
				<p data-testid="review-headline" className="font-prose text-xl">
					{headline(report)}
				</p>
				<p className="text-sm text-muted-foreground">
					Each topic&apos;s memory is estimated from how you actually did when tested (quiz checks after teaching, and
					practice problems), never from how sure you felt. It fades over time, and a topic is due once its estimated
					recall drops under {target}%. Each successful review makes it last longer.
				</p>
			</header>

			{report.topics.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					Answer a few check questions in a teaching session, or solve a practice problem, and your topics appear here.
				</p>
			) : (
				<>
					{status && <ReviewStart status={status} />}
					<section className="flex flex-col gap-3">
						<SectionHeading>Due now</SectionHeading>
						{report.due.length === 0 ? (
							<p className="text-sm text-muted-foreground">Nothing is due. Your next review is in the list below.</p>
						) : (
							<TopicList topics={report.due} now={report.now} testId="review-due" />
						)}
					</section>

					<section className="flex flex-col gap-3">
						<SectionHeading>Coming up in the next {UPCOMING_DAYS} days</SectionHeading>
						{report.upcoming.length === 0 ? (
							<p className="text-sm text-muted-foreground">Nothing else falls due this week.</p>
						) : (
							<TopicList topics={report.upcoming} now={report.now} testId="review-upcoming" />
						)}
					</section>

					<section className="flex flex-col gap-3">
						<SectionHeading>All topics</SectionHeading>
						<TopicList topics={report.topics} now={report.now} testId="review-topic" />
					</section>
				</>
			)}
		</div>
	);
}

function headline(report: RetentionReport): string {
	if (report.topics.length === 0) return "No tested topics yet.";
	const n = report.due.length;
	if (n === 0) return `All ${report.topics.length} tested ${report.topics.length === 1 ? "topic is" : "topics are"} still fresh.`;
	return `${n} ${n === 1 ? "topic is" : "topics are"} fading and due for review.`;
}

function TopicList({ topics, now, testId }: { topics: TopicRetention[]; now: number; testId: string }) {
	return (
		<ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-surface">
			{topics.map((t) => (
				<li key={t.key} data-testid={testId}>
					<Link href={`/chat/${t.chatId}`} className="flex items-center gap-3 px-4 py-2.5 text-base transition-colors hover:bg-accent">
						<div className="min-w-0 flex-1">
							<p className="truncate">{t.title}</p>
							<p className="truncate text-xs text-muted-foreground">
								{t.kind === "proposition" ? "Practice" : "Lesson"} · {t.chatTitle} · {lastResult(t)}{" "}
								{relativeDays(t.lastReviewedAt, now)}
							</p>
						</div>
						<RetentionBar retention={t.retention} />
						<span className={cn("w-24 shrink-0 text-right text-xs tabular-nums", t.due ? "font-semibold text-warn-ink" : "text-muted-foreground")}>
							{t.due ? `due ${dueText(t.dueAt, now)}` : `due ${relativeDays(t.dueAt, now)}`}
						</span>
					</Link>
				</li>
			))}
		</ul>
	);
}

function lastResult(t: TopicRetention): string {
	return t.lastGrade === GRADE_AGAIN ? "missed" : t.lastGrade === GRADE_HARD ? "shaky" : "recalled";
}

/** "now" for anything that fell due today, else how long it has been overdue. */
function dueText(dueAt: number, now: number): string {
	const rel = relativeDays(dueAt, now);
	return rel === "today" ? "now" : rel;
}

function RetentionBar({ retention }: { retention: number }) {
	const pct = Math.round(retention * 100);
	return (
		<div className="flex w-32 shrink-0 items-center gap-2" title={`Estimated chance you recall this now: ${pct}%`}>
			<div className="relative h-1.5 flex-1 rounded-full bg-accent">
				<div
					className={cn(
						"absolute inset-y-0 left-0 rounded-full",
						retention >= TARGET_RETENTION ? "bg-good" : "bg-warn",
					)}
					style={{ width: `${Math.max(pct, 1)}%` }}
				/>
			</div>
			<span className="w-9 text-right text-xs tabular-nums">{pct}%</span>
		</div>
	);
}
