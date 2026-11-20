"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { DiagnosticContextData } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * Collapsible diagnostic-hotspot card (twin of GraphContextCard): muted,
 * collapsed by default; expand reveals the prerequisite neighborhood,
 * active weak spots / overconfident misses, and recurring practice miss
 * patterns injected for the tutor at session start.
 */
export function DiagnosticContextCard({ data }: { data: DiagnosticContextData }) {
	const [open, setOpen] = useState(false);
	const { prerequisites = [], weakSpots = [], missPatterns = [] } = data ?? {};
	const parts: string[] = [];
	if (prerequisites.length > 0) parts.push(`${prerequisites.length} ${prerequisites.length === 1 ? "prerequisite" : "prerequisites"}`);
	if (weakSpots.length > 0) parts.push(`${weakSpots.length} ${weakSpots.length === 1 ? "weak spot" : "weak spots"}`);
	if (missPatterns.length > 0) parts.push(`${missPatterns.length} miss ${missPatterns.length === 1 ? "pattern" : "patterns"}`);

	return (
		<div data-testid="diagnostic-context-card" className="my-1">
			<button
				type="button"
				data-testid="diagnostic-context-toggle"
				onClick={() => setOpen((v) => !v)}
				className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-dashed border-border/70 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
			>
				<ChevronRightIcon aria-hidden="true" className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
				<span className="font-medium">Diagnostic context</span>
				<span className="min-w-0 flex-1 truncate">{parts.join(" · ")}</span>
			</button>
			{open && (
				<div data-testid="diagnostic-context-body" className="mt-1 space-y-2 rounded-lg border border-dashed border-border/70 px-4 py-3 text-xs">
					{prerequisites.length > 0 && (
						<div className="space-y-1">
							<p className="font-medium text-foreground/80">Prerequisite neighborhood</p>
							{prerequisites.map((p) => (
								<div key={p.id} className="leading-relaxed">
									<span className="font-medium text-foreground/80">{p.name}</span>
									<span className="text-muted-foreground">
										{" "}
										({p.retention === null ? "untested" : `${Math.round(p.retention * 100)}% recall`}
										{p.due ? ", due" : ""}
										{p.shakyFoundation ? `; shaky: ${p.shakyFoundation}` : ""})
									</span>
								</div>
							))}
						</div>
					)}
					{weakSpots.length > 0 && (
						<div className="space-y-1">
							<p className="font-medium text-foreground/80">Active blind spots</p>
							{weakSpots.map((w) => (
								<div key={w.key} className="leading-relaxed">
									<span className="font-medium text-foreground/80">{w.title}</span>
									<span className="text-muted-foreground">
										{" "}
										·{" "}
										{w.spot === "overconfident" && w.meanConfidence !== null && w.accuracy !== null
											? `felt ${Math.round(w.meanConfidence)}%, got ${Math.round(w.accuracy)}%`
											: "shaky"}{" "}
										({Math.round(w.retention * 100)}% recall)
									</span>
								</div>
							))}
						</div>
					)}
					{missPatterns.length > 0 && (
						<div className="space-y-1">
							<p className="font-medium text-foreground/80">Recurring practice misses</p>
							{missPatterns.map((m) => (
								<div key={m.missClass} className="leading-relaxed text-muted-foreground">
									<span className="font-medium text-foreground/80">{m.missClass}</span> ({m.count}×) — {m.guidance}
								</div>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
