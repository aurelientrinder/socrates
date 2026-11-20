"use client";

import { CheckIcon, ChevronDownIcon, ChevronRightIcon, LayersIcon } from "lucide-react";
import { sectionAnchorId, type LessonSection } from "@/src/core";
import { cn } from "@/lib/utils";

/**
 * Persistent anti-amnesia strip rendered below TopBar during teach phase:
 * shows the active chapter section, established prerequisite chips, and a
 * 1-click "Collapse covered / Expand all" control.
 */
export function LessonStateStrip({
	sections,
	totalPlanNodes,
	collapsed,
	onCollapseCovered,
	onExpandAll,
	onJumpToSection,
}: {
	sections: readonly LessonSection[];
	totalPlanNodes: number;
	collapsed: ReadonlySet<string>;
	onCollapseCovered: () => void;
	onExpandAll: () => void;
	onJumpToSection: (nodeId: string) => void;
}) {
	if (sections.length === 0) return null;
	const current = sections.find((s) => s.status === "current") ?? sections.at(-1)!;
	const covered = sections.filter((s) => s.status === "visited");
	const hasCollapsed = collapsed.size > 0;
	const allCoveredCollapsed = covered.length > 0 && covered.every((s) => collapsed.has(s.nodeId));

	return (
		<div
			data-testid="lesson-state-strip"
			className="flex flex-wrap items-center justify-between gap-2 border-b border-border/70 bg-background/95 px-4 py-1.5 text-xs backdrop-blur-xs"
		>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				<button
					type="button"
					onClick={() => onJumpToSection(current.nodeId)}
					className="inline-flex min-w-0 items-center gap-1.5 font-medium text-foreground hover:underline"
				>
					<LayersIcon className="size-3.5 shrink-0 text-muted-foreground" />
					<span className="tabular-nums text-muted-foreground">
						§ {current.index}/{Math.max(totalPlanNodes, sections.length)}
					</span>
					<span className="truncate">{current.title}</span>
				</button>

				{current.prerequisites.length > 0 && (
					<div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
						<span className="text-border">·</span>
						<span>Built on:</span>
						{current.prerequisites.slice(0, 3).map((p) => (
							<button
								key={p.id}
								type="button"
								onClick={() => onJumpToSection(p.id)}
								className={cn(
									"inline-flex items-center gap-1 rounded-md border border-border/70 px-1.5 py-0.5 transition-colors hover:bg-accent hover:text-foreground",
									p.status === "visited" && "bg-surface text-foreground/80",
								)}
							>
								{p.status === "visited" && <CheckIcon className="size-2.5 text-good" />}
								<span className="max-w-32 truncate">{p.title}</span>
							</button>
						))}
					</div>
				)}
			</div>

			{(covered.length > 0 || hasCollapsed) && (
				<button
					type="button"
					data-testid="toggle-covered-sections"
					onClick={allCoveredCollapsed || hasCollapsed ? onExpandAll : onCollapseCovered}
					className="shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					{allCoveredCollapsed || hasCollapsed
						? `Expand all (${collapsed.size} collapsed)`
						: `Collapse ${covered.length} covered`}
				</button>
			)}
		</div>
	);
}

/**
 * Textbook-style chapter section heading injected at the start of each plan
 * node's teaching span. Covered sections collapse/expand cleanly on click.
 */
export function SectionHeader({
	section,
	collapsed,
	onToggle,
}: {
	section: LessonSection;
	collapsed: boolean;
	onToggle: () => void;
}) {
	const count = section.endIndex - section.startIndex + 1;
	const isCurrent = section.status === "current";
	const isCovered = section.status === "visited";

	return (
		<div
			id={sectionAnchorId(section.nodeId)}
			data-testid="lesson-section-header"
			data-section-node={section.nodeId}
			className="mt-4 scroll-mt-14 border-t border-border/70 pt-3"
		>
			<button
				type="button"
				aria-expanded={!collapsed}
				onClick={onToggle}
				className="group flex w-full cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent/60"
			>
				<span className="mt-0.5 text-muted-foreground">
					{collapsed ? <ChevronRightIcon className="size-4" /> : <ChevronDownIcon className="size-4" />}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex flex-wrap items-center gap-2">
						<span className="font-mono text-xs text-muted-foreground tabular-nums">§ {section.index}</span>
						<h3 className="font-prose text-base font-semibold tracking-tight text-foreground">
							{section.title}
						</h3>
						{isCovered ? (
							<span className="inline-flex items-center gap-1 rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
								<CheckIcon className="size-2.5 text-good" />
								Covered
							</span>
						) : isCurrent ? (
							<span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-foreground">
								Current
							</span>
						) : null}
						{collapsed && (
							<span className="text-xs text-muted-foreground tabular-nums">
								· {count} {count === 1 ? "block" : "blocks"} hidden
							</span>
						)}
					</div>
					{section.summary && !collapsed && (
						<p className="mt-0.5 text-xs text-muted-foreground">{section.summary}</p>
					)}
				</div>
			</button>
		</div>
	);
}
