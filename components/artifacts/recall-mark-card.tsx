"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import { GlyphMark } from "@/components/ui/glyph-mark";
import { cn } from "@/lib/utils";
import { isRecallMarkData, repairMathForDisplay, type ArtifactPartProps, type KeyPointStatus } from "@/src/core";

/**
 * The free-recall marking card (review_mark, core/recall-review.ts): what
 * a full answer covers, point by point, with how his explanation did on
 * each — and the line of his answer that earned the credit, so a mark is
 * never a bare verdict. Wrong claims follow, each with its correction.
 * The outcome chip is the computed grade, in the quiz cards' register.
 *
 * Reads the result DETAILS (our execute authored them). Pending and
 * errored calls render nothing here: chat.tsx shows the live card and
 * the quiet "Retrying…" line.
 */

const OUTCOME: Record<1 | 2 | 3, { label: string; chip: string }> = {
	3: { label: "recalled", chip: "bg-good-soft text-good" },
	2: { label: "partly recalled", chip: "bg-warn-soft text-warn-ink" },
	1: { label: "not recalled", chip: "bg-red-500/15 text-red-500" },
};

const STATUS_LABEL: Record<KeyPointStatus, string> = {
	covered: "covered",
	partial: "partly",
	missed: "left out",
};

function StatusMark({ status }: { status: KeyPointStatus }) {
	if (status === "partial") {
		return (
			<span aria-hidden className="mt-1 flex size-3.5 shrink-0 items-center justify-center text-warn-ink">
				<span className="h-0.5 w-3 rounded-full bg-current" />
			</span>
		);
	}
	return (
		<span aria-hidden className={cn("mt-0.5 flex shrink-0", status === "covered" ? "text-good" : "text-red-500")}>
			<GlyphMark kind={status === "covered" ? "check" : "x"} className="size-3.5" />
		</span>
	);
}

export function RecallMarkCard({ part }: ArtifactPartProps) {
	if (part.state !== "output-available" || !isRecallMarkData(part.output)) return null;
	const mark = part.output;
	const outcome = OUTCOME[mark.grade];
	return (
		<div data-testid="recall-mark-card" className="lh-card-enter my-1 rounded-xl border bg-card p-4 text-card-foreground">
			<div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
				What a full answer covers
				<span className={cn("rounded px-1.5 py-0.5", outcome.chip)}>{outcome.label}</span>
			</div>
			<ul className="flex flex-col gap-2 text-sm">
				{mark.points.map((p, i) => (
					<li key={i} data-testid="recall-mark-point" data-status={p.status} className="flex items-start gap-2.5">
						<StatusMark status={p.status} />
						<div className="min-w-0 flex-1">
							<div className={cn(p.status === "missed" && "text-foreground")}>
								<MessageResponse className="[&_p]:m-0">{repairMathForDisplay(p.point)}</MessageResponse>
							</div>
							<div className="mt-0.5 text-xs text-muted-foreground">
								<span className="sr-only">{STATUS_LABEL[p.status]}: </span>
								{p.evidence ? <>You wrote: “{p.evidence}”</> : p.status === "missed" ? "Not in your answer." : null}
							</div>
						</div>
					</li>
				))}
			</ul>
			{mark.errors.length > 0 && (
				<div className="mt-3 border-t border-border/60 pt-3">
					<div className="mb-1.5 text-xs font-medium text-muted-foreground">To correct</div>
					<ul className="flex flex-col gap-2 text-sm">
						{mark.errors.map((e, i) => (
							<li key={i} data-testid="recall-mark-error">
								<div className="text-muted-foreground line-through decoration-red-500/60">“{e.claim}”</div>
								<MessageResponse className="[&_p]:m-0">{repairMathForDisplay(e.correction)}</MessageResponse>
							</li>
						))}
					</ul>
				</div>
			)}
			<div className="mt-3 text-xs text-muted-foreground">
				Marked against what you were taught{mark.sourceTitle ? ` in “${mark.sourceTitle}”` : ""}.
			</div>
		</div>
	);
}
