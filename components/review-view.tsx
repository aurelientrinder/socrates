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
import { cn } from "@/lib/utils";

/**
 * THE REVIEW VIEW (knowledge decay): what you are forgetting, as of now.
 * Leads with what is due (estimated recall under the target, weakest
 * first), then what falls due this week, then every tested topic with its
 * estimated retention. Presentational only: the page folds the records
 * server-side (src/core/retention.ts).
 */
export function ReviewView({ report, status }: { report: RetentionReport; status?: ReviewStatus }) {
	const target = Math.round(TARGET_RETENTION * 100);
	return (
		<div data-testid="review-view" className="h-full overflow-y-auto">
			<div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-10">
				<header className="flex flex-col gap-2">
					<h1 className="text-xs uppercase tracking-widest text-muted-foreground/70">Review</h1>
					<p data-testid="review-headline" className="text-lg">
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
							<SectionTitle>Due now</SectionTitle>
							{report.due.length === 0 ? (
								<p className="text-sm text-muted-foreground">Nothing is due. Your next review is in the list below.</p>
							) : (
								<TopicList topics={report.due} now={report.now} testId="review-due" />
							)}
						</section>

						<section className="flex flex-col gap-3">
							<SectionTitle>Coming up in the next {UPCOMING_DAYS} days</SectionTitle>
							{report.upcoming.length === 0 ? (
								<p className="text-sm text-muted-foreground">Nothing else falls due this week.</p>
							) : (
								<TopicList topics={report.upcoming} now={report.now} testId="review-upcoming" />
							)}
						</section>

						<section className="flex flex-col gap-3">
							<SectionTitle>All topics</SectionTitle>
							<TopicList topics={report.topics} now={report.now} testId="review-topic" />
						</section>
					</>
				)}
			</div>
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
		<ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
			{topics.map((t) => (
				<li key={t.key} data-testid={testId}>
					<Link href={`/chat/${t.chatId}`} className="flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-accent">
						<div className="min-w-0 flex-1">
							<p className="truncate">{t.title}</p>
							<p className="truncate text-xs text-muted-foreground">
								{t.kind === "proposition" ? "Practice" : "Lesson"} · {t.chatTitle} · {lastResult(t)}{" "}
								{relativeDays(t.lastReviewedAt, now)}
							</p>
						</div>
						<RetentionBar retention={t.retention} />
						<span className={cn("w-24 shrink-0 text-right text-xs tabular-nums", t.due ? "text-amber-500" : "text-muted-foreground")}>
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
			<div className="relative h-2 flex-1 rounded bg-muted/40">
				<div
					className={cn(
						"absolute inset-y-0 left-0 rounded",
						retention >= TARGET_RETENTION ? "bg-emerald-500/60" : retention >= 0.7 ? "bg-amber-500/60" : "bg-red-500/60",
					)}
					style={{ width: `${Math.max(pct, 1)}%` }}
				/>
			</div>
			<span className="w-9 text-right text-xs tabular-nums">{pct}%</span>
		</div>
	);
}

function SectionTitle({ children }: { children: React.ReactNode }) {
	return <h2 className="text-xs uppercase tracking-widest text-muted-foreground/70">{children}</h2>;
}
