import Link from "next/link";
import {
	CONFIDENT_MISS_FLOOR,
	RECENT_ANSWERS,
	REVIEW_SESSION_SIZE,
	relativeDays,
	weakSpotHeadline,
	type WeakSpot,
	type WeakSpotReport,
} from "@/src/core";
import { DrillButton } from "@/components/drill-button";
import { SectionHeading } from "@/components/page-header";
import { cn } from "@/lib/utils";

/**
 * THE WEAK-SPOT VIEW: the topics most worth drilling, worst first. Each
 * row says why it is listed (felt sure but got it wrong, or only just
 * recalled it), how sure you were vs how often you were right on its
 * latest answers, and how much you are predicted to recall now. One
 * button drills the worst few; each row can be drilled alone.
 * Presentational only: the page folds the records server-side
 * (src/core/weak-spots.ts). Rendered as the Weak spots tab of Progress.
 */
export function WeakSpotsView({ report }: { report: WeakSpotReport }) {
	const worst = report.spots.slice(0, REVIEW_SESSION_SIZE);
	return (
		<div data-testid="weak-spots-view" className="flex flex-col gap-8">
			<header className="flex flex-col gap-2">
				<p data-testid="weak-spots-headline" className="font-prose text-xl">
					{weakSpotHeadline(report)}
				</p>
				<p className="text-sm text-muted-foreground">
					A topic is listed as overconfident when you missed it while at least {CONFIDENT_MISS_FLOOR}% sure and your
					latest {RECENT_ANSWERS} answers on it were surer than they were right, and as shaky when you missed it or only
					just got it the last time it was tested. Overconfident topics come first. A topic leaves the list once your
					latest answers on it are right and sure.
				</p>
			</header>

			{report.tracked === 0 ? (
				<p className="text-sm text-muted-foreground">
					Answer a few check questions in a teaching session, or solve a practice problem, and your weak spots appear here.
				</p>
			) : report.spots.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					Nothing to drill. The <Link href="/progress" className="underline underline-offset-2 hover:text-foreground">Memory</Link>{" "}
					tab shows what is fading.
				</p>
			) : (
				<>
					<section data-testid="weak-spots-drill" className="flex flex-wrap items-center gap-3 rounded-xl bg-warn-soft px-5 py-4">
						<DrillButton
							keys={worst.map((s) => s.key)}
							label={worst.length === 1 ? "Drill it" : `Drill the worst ${worst.length}`}
							testId="weak-spots-drill-button"
						/>
						<p className="text-base text-foreground/80">
							One fresh question on each, aimed at what you got wrong. About {worst.length}{" "}
							{worst.length === 1 ? "minute" : "minutes"}.
						</p>
					</section>

					<section className="flex flex-col gap-3">
						<SectionHeading>Weak spots, worst first</SectionHeading>
						<ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-surface">
							{report.spots.map((s) => (
								<SpotRow key={s.key} spot={s} now={report.now} />
							))}
						</ul>
						<p className="text-xs text-muted-foreground">
							Only answers tied to a topic count here (checks after teaching, reviews, practice problems). The{" "}
							<Link href="/progress?tab=calibration" className="underline underline-offset-2 hover:text-foreground">
								Calibration
							</Link>{" "}
							tab has every quiz answer, including your misses at {CONFIDENT_MISS_FLOOR}%+ confidence.
						</p>
					</section>
				</>
			)}
		</div>
	);
}

function SpotRow({ spot, now }: { spot: WeakSpot; now: number }) {
	const pct = Math.round(spot.retention * 100);
	return (
		<li data-testid="weak-spot" data-spot={spot.spot} className="flex items-start gap-3 px-4 py-3">
			<div className="min-w-0 flex-1">
				<div className="flex flex-wrap items-center gap-2">
					<Link href={`/chat/${spot.chatId}`} className="min-w-0 truncate text-base hover:underline">
						{spot.title}
					</Link>
					<span
						className={cn(
							"shrink-0 rounded-full px-2 py-0.5 text-xs",
							spot.spot === "overconfident" ? "bg-warn-soft font-semibold text-warn-ink" : "bg-accent text-muted-foreground",
						)}
					>
						{spot.spot === "overconfident" ? "Overconfident" : "Shaky"}
					</span>
				</div>
				<p className="mt-0.5 text-sm text-foreground/80">{spot.reason}</p>
				{spot.missedQuestions[0] && (
					<p className="mt-1 line-clamp-2 text-sm italic text-muted-foreground">Missed: {spot.missedQuestions[0]}</p>
				)}
				<p className="mt-1 text-xs text-muted-foreground">
					{spot.kind === "proposition" ? "Practice" : "Lesson"} · {spot.chatTitle} · tested {relativeDays(spot.lastReviewedAt, now)} ·{" "}
					<span title="Estimated chance you recall this now">recall now about {pct}%</span>
				</p>
			</div>
			<DrillButton keys={[spot.key]} label="Drill" variant="outline" testId="weak-spot-drill" />
		</li>
	);
}
