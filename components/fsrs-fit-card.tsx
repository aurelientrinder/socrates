"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FsrsModelStatus } from "@/src/core";

/**
 * Compact FSRS-6 memory-model panel on Progress → Memory: shows whether
 * published FSRS-6 defaults or personalized weights are active, how many
 * follow-up reviews are available for fitting, and Fit / Reset actions.
 */
export function FsrsFitCard({ initial }: { initial: FsrsModelStatus }) {
	const router = useRouter();
	const [status, setStatus] = useState<FsrsModelStatus>(initial);
	const [busy, setBusy] = useState<"fit" | "reset" | null>(null);
	const [note, setNote] = useState<string | null>(null);

	const ready = status.reviews >= status.minReviews;
	const improvementPct =
		status.source === "personal" &&
		typeof status.baselineLogLoss === "number" &&
		typeof status.fittedLogLoss === "number" &&
		status.baselineLogLoss > 0
			? Math.round(((status.baselineLogLoss - status.fittedLogLoss) / status.baselineLogLoss) * 1000) / 10
			: null;

	async function onFit() {
		setBusy("fit");
		setNote(null);
		try {
			const res = await fetch("/api/fsrs", { method: "POST" });
			const data = (await res.json()) as {
				error?: string;
				fit?: { improved?: boolean } | null;
				status?: FsrsModelStatus;
			};
			if (data.status) setStatus(data.status);
			if (!res.ok) {
				setNote(data.error ?? "Could not fit personal weights yet.");
				return;
			}
			if (data.fit && !data.fit.improved) {
				setNote("FSRS-6 defaults already fit your history best — keeping defaults.");
			} else {
				setNote("Fitted to your recall history.");
				router.refresh();
			}
		} catch {
			setNote("Fit request failed. Try again.");
		} finally {
			setBusy(null);
		}
	}

	async function onReset() {
		setBusy("reset");
		setNote(null);
		try {
			const res = await fetch("/api/fsrs", { method: "DELETE" });
			if (res.ok) {
				const next = (await res.json()) as FsrsModelStatus;
				setStatus(next);
				setNote("Reset to FSRS-6 defaults.");
				router.refresh();
			}
		} catch {
			setNote("Reset failed. Try again.");
		} finally {
			setBusy(null);
		}
	}

	return (
		<section className="flex flex-col gap-2" data-testid="fsrs-model-card">
			<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/70 bg-surface px-4 py-3">
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium">
						Memory model ·{" "}
						<span className="text-muted-foreground">
							{status.source === "personal" ? "Personal FSRS-6" : "FSRS-6 defaults"}
						</span>
					</p>
					<p className="text-xs text-muted-foreground tabular-nums">
						{status.source === "personal" && improvementPct !== null
							? `Fitted on ${status.reviews} follow-up reviews (${improvementPct}% lower log-loss, Brier ${status.fittedBrier?.toFixed(3) ?? "—"}).`
							: ready
								? `${status.reviews} follow-up reviews recorded — ready to personalize forgetting curves to your memory.`
								: `${status.reviews} / ${status.minReviews} follow-up reviews needed to personalize forgetting curves.`}
					</p>
					{note && <p className="mt-1 text-xs text-muted-foreground">{note}</p>}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					<button
						type="button"
						onClick={onFit}
						disabled={!ready || busy !== null}
						className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
					>
						{busy === "fit" ? "Fitting…" : status.source === "personal" ? "Re-fit" : "Fit to my history"}
					</button>
					{status.source === "personal" && (
						<button
							type="button"
							onClick={onReset}
							disabled={busy !== null}
							className="rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
						>
							{busy === "reset" ? "Resetting…" : "Reset"}
						</button>
					)}
				</div>
			</div>
		</section>
	);
}
