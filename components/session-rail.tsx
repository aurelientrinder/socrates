"use client";

import { useMemo } from "react";
import { CheckIcon } from "lucide-react";
import { derivedNodeStatus, derivePlanStatuses, type PlanNodeStatus, type PlanTree } from "@/src/core";
import { latestTree, type PopupMessage } from "@/components/plan-block";
import { cn } from "@/lib/utils";

/**
 * THE PLAN RAIL (redesign wave, 2026-10-26): the session's plan as a
 * checklist down the right edge — what you have covered, where you are,
 * what is left — so a session has a visible end. Statuses derive from the
 * transcript exactly like the plan diagram (derivePlanStatuses), so the
 * rail moves the moment a tagged check streams in. Wide windows only; the
 * top bar's Plan chip and the diagram popup serve every width.
 */

export interface RailStep {
	id: string;
	title: string;
	status: PlanNodeStatus;
}

/** The plan's nodes in teaching order (prerequisites first, ties kept in
 *  the tree's own order) with their derived statuses. Pure. */
export function railSteps(tree: PlanTree, statusOf: (id: string) => PlanNodeStatus): RailStep[] {
	const ids = new Set(tree.nodes.map((n) => n.id));
	const indegree = new Map(tree.nodes.map((n) => [n.id, 0]));
	for (const e of tree.edges) {
		if (ids.has(e.from) && ids.has(e.to)) indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
	}
	const placed = new Set<string>();
	const order: string[] = [];
	// Kahn's algorithm, always taking the earliest ready node in tree order.
	while (order.length < tree.nodes.length) {
		const next = tree.nodes.find((n) => !placed.has(n.id) && (indegree.get(n.id) ?? 0) === 0);
		// A cycle (never expected): append the rest in tree order.
		if (!next) {
			for (const n of tree.nodes) if (!placed.has(n.id)) order.push(n.id), placed.add(n.id);
			break;
		}
		placed.add(next.id);
		order.push(next.id);
		for (const e of tree.edges) if (e.from === next.id && ids.has(e.to)) indegree.set(e.to, (indegree.get(e.to) ?? 0) - 1);
	}
	const byId = new Map(tree.nodes.map((n) => [n.id, n]));
	return order.map((id) => ({ id, title: byId.get(id)!.title, status: statusOf(id) }));
}

/** How far through the plan: covered steps (visited, plus the current one
 *  counted as half done) over all steps, 0..1. Pure. */
export function railProgress(steps: readonly RailStep[]): number {
	if (steps.length === 0) return 0;
	const done = steps.reduce((sum, s) => sum + (s.status === "visited" ? 1 : s.status === "current" ? 0.5 : 0), 0);
	return done / steps.length;
}

/** Where the session is in its plan, for the header ("step 2 of 9"):
 *  null without a plan or once no step is current. Pure. */
export function planStepOf(steps: readonly RailStep[] | null): { index: number; total: number } | null {
	if (!steps || steps.length === 0) return null;
	const i = steps.findIndex((s) => s.status === "current");
	return i < 0 ? null : { index: i + 1, total: steps.length };
}

/** The steps of the session's latest plan, or null when there is none. */
export function usePlanSteps(messages: readonly PopupMessage[]): RailStep[] | null {
	return useMemo(() => {
		const tree = latestTree(messages);
		if (!tree || tree.nodes.length === 0) return null;
		const statuses = derivePlanStatuses(tree, messages as Parameters<typeof derivePlanStatuses>[1]);
		return railSteps(tree, (id) => derivedNodeStatus(statuses, id));
	}, [messages]);
}

export function PlanRail({ steps, onOpenPlan }: { steps: readonly RailStep[]; onOpenPlan: () => void }) {
	return (
		<aside
			aria-labelledby="plan-rail-heading"
			data-testid="plan-rail"
			className="hidden w-[270px] shrink-0 flex-col overflow-y-auto border-l border-border bg-background min-[1200px]:flex"
		>
			{/* The window-controls band (sidebar refine, 2026-11-03): the same
			    height and bottom line as the session's top bar, and a drag
			    surface, so the native minimise/maximise/close buttons sit on
			    their own strip instead of over the Plan heading. */}
			<div aria-hidden="true" className="lh-drag h-15 shrink-0 border-b border-border" />
			<div className="flex flex-col gap-3 px-3.5 pt-4 pb-5">
			<div className="flex items-baseline justify-between gap-2">
				<h2 id="plan-rail-heading" className="text-[14.5px] font-bold">
					Plan
				</h2>
				<button type="button" onClick={onOpenPlan} className="text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground">
					See the map
				</button>
			</div>
			<ol className="flex flex-col gap-[3px]">
				{steps.map((s) => (
					<li
						key={s.id}
						data-testid="plan-rail-step"
						data-status={s.status}
						aria-current={s.status === "current" ? "step" : undefined}
						className={cn(
							"flex items-start gap-2.5 rounded-lg px-2 py-1.75 text-[13.5px] leading-[1.3]",
							s.status === "current" && "bg-ink-soft font-semibold text-foreground",
							s.status === "visited" && "text-muted-foreground",
						)}
					>
						<span
							aria-hidden="true"
							className={cn(
								"mt-px flex size-4 shrink-0 items-center justify-center rounded-full",
								s.status === "visited" && "bg-foreground/45 text-background",
								s.status === "current" && "border-2 border-foreground!",
								s.status === "upcoming" && "border-[1.5px] border-border",
							)}
						>
							{s.status === "visited" && <CheckIcon className="size-2.5" strokeWidth={3.5} />}
						</span>
						<span>
							{s.title}
							{s.status === "visited" && <span className="sr-only"> (covered)</span>}
						</span>
					</li>
				))}
			</ol>
			</div>
		</aside>
	);
}
