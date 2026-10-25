import Link from "next/link";
import { CALIBRATED_WITHIN, CONFIDENT_MISS_FLOOR, calibrationVerdict, type CalibrationReport } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * THE CALIBRATION VIEW: stated confidence vs actual accuracy across every
 * session. Leads with the verdict, then the per-stop picture (what you
 * said vs how often you were right), then the confident misses (the
 * "I was sure" gaps to review first), then the per-session breakdown.
 * Presentational only: the page folds the records server-side.
 */
export function CalibrationView({ report }: { report: CalibrationReport }) {
	return (
		<div data-testid="calibration-view" className="h-full overflow-y-auto">
			<div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-10">
				<header className="flex flex-col gap-2">
					<h1 className="text-xs uppercase tracking-widest text-muted-foreground/70">Calibration</h1>
					<p data-testid="calibration-verdict" className="text-lg">
						{calibrationVerdict(report)}
					</p>
					<p className="text-sm text-muted-foreground">
						Every quiz answer records how sure you were. This compares that with how often you were actually right,
						across all your sessions.
					</p>
				</header>

				{report.answered === 0 ? (
					<p className="text-sm text-muted-foreground">
						Answer a few quiz questions with the confidence slider in a teaching session, and your picture appears here.
					</p>
				) : (
					<>
						<section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
							<Stat label="Rated answers" value={String(report.answered)} />
							<Stat label="Avg confidence" value={`${Math.round(report.meanConfidence!)}%`} />
							<Stat label="Actually right" value={`${Math.round(report.accuracy!)}%`} />
							<Stat
								label="Gap"
								value={`${report.gap! > 0 ? "+" : ""}${Math.round(report.gap!)}`}
								tone={Math.abs(report.gap!) <= CALIBRATED_WITHIN ? "good" : "warn"}
							/>
						</section>

						<section className="flex flex-col gap-3">
							<SectionTitle>When you said… you were right</SectionTitle>
							<div className="flex flex-col gap-2">
								{report.bins.map((bin) => (
									<div key={bin.confidence} data-testid="calibration-bin" className="flex items-center gap-3 text-sm">
										<span className="w-12 shrink-0 text-right tabular-nums">{bin.confidence}%</span>
										<div className="relative h-5 flex-1 rounded bg-muted/40">
											{bin.accuracy !== null && (
												<div
													className={cn(
														"absolute inset-y-0 left-0 rounded",
														Math.abs(bin.accuracy - bin.confidence) <= 10 ? "bg-emerald-500/60" : "bg-amber-500/60",
													)}
													style={{ width: `${Math.max(bin.accuracy, 1)}%` }}
												/>
											)}
											{/* The stated confidence: where the bar would end if you were perfectly calibrated. */}
											<div
												className="absolute inset-y-[-2px] w-0.5 bg-foreground/70"
												style={{ left: `${bin.confidence}%` }}
												title={`Perfectly calibrated would be ${bin.confidence}%`}
											/>
										</div>
										<span className="w-28 shrink-0 text-right tabular-nums text-muted-foreground">
											{bin.accuracy === null ? "no answers" : `${Math.round(bin.accuracy)}% of ${bin.count}`}
										</span>
									</div>
								))}
							</div>
							<p className="text-xs text-muted-foreground">
								The line marks perfect calibration. A bar short of its line means you were surer than you should have been.
								{report.dontKnow > 0 &&
									` You also answered "I don't know" ${report.dontKnow} ${report.dontKnow === 1 ? "time" : "times"}, which is honest and not counted here.`}
							</p>
						</section>

						<section className="flex flex-col gap-3">
							<SectionTitle>Review these first: wrong at {CONFIDENT_MISS_FLOOR}%+ confidence</SectionTitle>
							{report.confidentMisses.length === 0 ? (
								<p className="text-sm text-muted-foreground">No confident misses. Nice.</p>
							) : (
								<ul className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60">
									{report.confidentMisses.map((miss, i) => (
										<li key={`${miss.chatId}-${miss.answeredAt}-${i}`} data-testid="calibration-miss" className="flex items-start gap-3 px-3 py-2 text-sm">
											<span className="w-10 shrink-0 tabular-nums text-amber-500">{miss.confidence}%</span>
											<div className="min-w-0 flex-1">
												<p className="line-clamp-2">{miss.questionText}</p>
												<Link href={`/chat/${miss.chatId}`} className="text-xs text-muted-foreground hover:text-foreground">
													{miss.chatTitle}
												</Link>
											</div>
										</li>
									))}
								</ul>
							)}
						</section>

						<section className="flex flex-col gap-3">
							<SectionTitle>By session</SectionTitle>
							<div className="flex flex-col divide-y divide-border/60 rounded-lg border border-border/60 text-sm">
								<div className="flex gap-3 px-3 py-1.5 text-[11px] uppercase tracking-widest text-muted-foreground/70">
									<span className="flex-1">Session</span>
									<span className="w-16 text-right">Answers</span>
									<span className="w-20 text-right">Confidence</span>
									<span className="w-16 text-right">Right</span>
								</div>
								{report.sessions.map((s) => (
									<Link key={s.chatId} href={`/chat/${s.chatId}`} className="flex gap-3 px-3 py-2 transition-colors hover:bg-accent">
										<span className="min-w-0 flex-1 truncate">{s.title}</span>
										<span className="w-16 text-right tabular-nums">{s.answered}</span>
										<span className="w-20 text-right tabular-nums">{Math.round(s.meanConfidence)}%</span>
										<span
											className={cn(
												"w-16 text-right tabular-nums",
												s.meanConfidence - s.accuracy > CALIBRATED_WITHIN && "text-amber-500",
											)}
										>
											{Math.round(s.accuracy)}%
										</span>
									</Link>
								))}
							</div>
						</section>
					</>
				)}
			</div>
		</div>
	);
}

function SectionTitle({ children }: { children: React.ReactNode }) {
	return <h2 className="text-xs uppercase tracking-widest text-muted-foreground/70">{children}</h2>;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "warn" }) {
	return (
		<div className="flex flex-col gap-1 rounded-lg border border-border/60 px-3 py-2">
			<span className="text-[11px] uppercase tracking-widest text-muted-foreground/70">{label}</span>
			<span
				className={cn(
					"text-xl tabular-nums",
					tone === "good" && "text-emerald-500",
					tone === "warn" && "text-amber-500",
				)}
			>
				{value}
			</span>
		</div>
	);
}
