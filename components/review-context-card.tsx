"use client";

import { useState } from "react";
import { CheckIcon, ChevronRightIcon, MinusIcon, XIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReviewOutcome, ReviewTopic } from "@/src/core";

/**
 * The review-context card (spaced repetition): message[0] of a review
 * session — the due topics the session works through, weakest first.
 * The graph-context card's twin: scaffolding, muted, collapsed by
 * default. Expanded, each topic shows how this session's answer went.
 */

/** The review-context marker's details (core/review.ts). */
export interface ReviewContextData {
	topics: ReviewTopic[];
}

const OUTCOME_LABEL: Record<ReviewOutcome, string> = {
	recalled: "recalled",
	shaky: "right but unsure",
	missed: "missed",
	skipped: "skipped",
};

function OutcomeMark({ outcome }: { outcome?: ReviewOutcome }) {
	if (!outcome) return <span aria-hidden="true" className="inline-block size-3 shrink-0 rounded-full border border-border" />;
	const Icon = outcome === "recalled" ? CheckIcon : outcome === "missed" ? XIcon : MinusIcon;
	return (
		<Icon
			aria-label={OUTCOME_LABEL[outcome]}
			className={cn("size-3 shrink-0", outcome === "missed" ? "text-destructive" : "text-muted-foreground")}
		/>
	);
}

export function ReviewContextCard({
	data,
	outcomes = {},
}: {
	data: ReviewContextData;
	outcomes?: Record<string, ReviewOutcome>;
}) {
	const [open, setOpen] = useState(false);
	const topics = data?.topics ?? [];
	const done = topics.filter((t) => outcomes[t.key] !== undefined).length;
	return (
		<div data-testid="review-context-card" className="my-1">
			<button
				type="button"
				data-testid="review-context-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">Review</span>
				<span className="min-w-0 flex-1 truncate">
					{topics.length} {topics.length === 1 ? "topic" : "topics"} due · {done} done
				</span>
			</button>
			{open && (
				<div data-testid="review-context-body" className="mt-1 space-y-1.5 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					{topics.map((t) => (
						<div key={t.key} data-testid="review-context-topic" className="flex items-baseline gap-2 leading-relaxed">
							<OutcomeMark outcome={outcomes[t.key]} />
							<span className="min-w-0 flex-1">
								<span className="font-medium text-foreground/80">{t.title}</span>
								{t.sourceTitle && <span className="text-muted-foreground"> — from {t.sourceTitle}</span>}
							</span>
							<span className="shrink-0 tabular-nums text-muted-foreground">{Math.round(t.retention * 100)}%</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
