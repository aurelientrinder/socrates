"use client";

import { useEffect, useRef, useState } from "react";
import {
	AlertTriangleIcon,
	BookOpenIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	LayersIcon,
	MessageSquareQuoteIcon,
	MessagesSquareIcon,
	StickyNoteIcon,
} from "lucide-react";
import {
	formatSectionQuote,
	repairMathForDisplay,
	sectionAnchorId,
	type DistilledSection,
	type LessonSection,
	type SectionTrap,
} from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { cn } from "@/lib/utils";

export type LessonViewMode = "textbook" | "transcript";

/**
 * Persistent anti-amnesia strip rendered below TopBar during teach phase:
 * shows the active chapter section, established prerequisite chips, and the
 * Textbook | Transcript view switcher.
 */
export function LessonStateStrip({
	sections,
	totalPlanNodes,
	viewMode,
	onViewModeChange,
	collapsed,
	onCollapseCovered,
	onExpandAll,
	onJumpToSection,
}: {
	sections: readonly LessonSection[];
	totalPlanNodes: number;
	viewMode: LessonViewMode;
	onViewModeChange: (mode: LessonViewMode) => void;
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

			<div className="flex shrink-0 items-center gap-2">
				{viewMode === "transcript" && (covered.length > 0 || hasCollapsed) && (
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

				<div
					role="tablist"
					aria-label="Lesson view mode"
					className="inline-flex items-center rounded-lg border border-border/80 bg-surface p-0.5 text-[11px]"
				>
					<button
						type="button"
						role="tab"
						aria-selected={viewMode === "textbook"}
						data-testid="lesson-mode-textbook"
						onClick={() => onViewModeChange("textbook")}
						className={cn(
							"inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium transition-colors",
							viewMode === "textbook"
								? "bg-foreground text-background"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<BookOpenIcon className="size-3" />
						Textbook
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={viewMode === "transcript"}
						data-testid="lesson-mode-transcript"
						onClick={() => onViewModeChange("transcript")}
						className={cn(
							"inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-medium transition-colors",
							viewMode === "transcript"
								? "bg-foreground text-background"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						<MessagesSquareIcon className="size-3" />
						Transcript
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * Compact disclosure for pre-section opening probe & planning turns in Textbook mode.
 */
export function OpeningProbeDisclosure({
	count,
	open,
	onToggle,
}: {
	count: number;
	open: boolean;
	onToggle: () => void;
}) {
	return (
		<button
			type="button"
			data-testid="opening-probe-toggle"
			aria-expanded={open}
			onClick={onToggle}
			className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-surface/60 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
		>
			{open ? <ChevronDownIcon className="size-3.5 shrink-0" /> : <ChevronRightIcon className="size-3.5 shrink-0" />}
			<span className="font-medium text-foreground/85">Opening probe &amp; plan</span>
			<span className="tabular-nums">
				· {count} {count === 1 ? "turn" : "turns"}
			</span>
		</button>
	);
}

/**
 * Editorial chapter section heading injected at the start of each plan node.
 * In Textbook mode, displays a clean textbook heading + Mastered/Active badge
 * + personal margin note button. In Transcript mode, toggles section collapse.
 */
export function SectionHeader({
	section,
	viewMode = "transcript",
	collapsed,
	hasNote = false,
	noteOpen = false,
	onToggle,
	onToggleNote,
}: {
	section: LessonSection;
	viewMode?: LessonViewMode;
	collapsed: boolean;
	hasNote?: boolean;
	noteOpen?: boolean;
	onToggle: () => void;
	onToggleNote?: () => void;
}) {
	const count = section.endIndex - section.startIndex + 1;
	const isCurrent = section.status === "current";
	const isCovered = section.status === "visited";

	if (viewMode === "textbook") {
		return (
			<div
				id={sectionAnchorId(section.nodeId)}
				data-testid="lesson-section-header"
				data-section-node={section.nodeId}
				className="mt-6 scroll-mt-14 border-t border-border/80 pt-5 first:mt-0 first:border-t-0 first:pt-1"
			>
				<div className="flex items-start justify-between gap-3">
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-mono text-xs font-medium text-muted-foreground tabular-nums">
								§ {section.index}
							</span>
							<h3 className="font-prose text-lg font-bold tracking-tight text-foreground">
								{section.title}
							</h3>
							{isCovered ? (
								<span className="inline-flex items-center gap-1 rounded-full bg-good-soft px-2 py-0.5 text-[11px] font-medium text-good-ink">
									<CheckIcon className="size-2.5 text-good" />
									Mastered
								</span>
							) : isCurrent ? (
								<span className="rounded-full bg-foreground px-2 py-0.5 text-[11px] font-medium text-background">
									Active
								</span>
							) : null}
						</div>
						{section.summary && (
							<p className="mt-1 text-xs leading-relaxed text-muted-foreground">{section.summary}</p>
						)}
					</div>
					{onToggleNote && (
						<button
							type="button"
							data-testid={`section-note-toggle-${section.nodeId}`}
							onClick={onToggleNote}
							title={hasNote ? "Edit your personal takeaway for this section" : "Add your own takeaway or mnemonic"}
							className={cn(
								"inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium transition-colors",
								hasNote || noteOpen
									? "border-foreground/30 bg-surface text-foreground"
									: "border-border/70 bg-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
							)}
						>
							<StickyNoteIcon className="size-3" />
							{hasNote ? "Takeaway" : "Add takeaway"}
						</button>
					)}
				</div>
			</div>
		);
	}

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

/**
 * Editorial "Watch out" callout surfacing missed or overconfident checks from
 * a mastered section so the learner sees their own traps while re-reading.
 */
export function SectionTrapCallout({ traps }: { traps: readonly SectionTrap[] }) {
	if (traps.length === 0) return null;
	return (
		<div
			data-testid="section-trap-callout"
			className="rounded-lg border border-warn/35 bg-warn-soft/55 px-3.5 py-2.5 text-xs text-warn-ink space-y-2"
		>
			<div className="flex items-center gap-1.5 font-semibold">
				<AlertTriangleIcon className="size-3.5 shrink-0 text-warn" />
				<span>Watch out ({traps.length === 1 ? "earlier trap" : `${traps.length} earlier traps`})</span>
			</div>
			<ul className="space-y-1.5">
				{traps.map((t, i) => (
					<li key={i} className="leading-relaxed">
						<span className="font-medium text-foreground">{t.question}</span>
						{t.overconfident && (
							<span className="ml-1.5 rounded bg-warn/20 px-1 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
								overconfident
							</span>
						)}
						{t.explanation && <p className="mt-0.5 text-foreground/80">{t.explanation}</p>}
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * Inline personal margin note editor/viewer attached to a chapter section.
 * Persists on blur or Cmd/Ctrl+Enter.
 */
export function SectionMarginNote({
	nodeId,
	value,
	editing,
	onStartEdit,
	onSave,
	onCancel,
}: {
	nodeId: string;
	value: string;
	editing: boolean;
	onStartEdit: () => void;
	onSave: (next: string) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState(value);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	useEffect(() => {
		setDraft(value);
	}, [value]);

	useEffect(() => {
		if (editing) textareaRef.current?.focus();
	}, [editing]);

	if (!editing && !value.trim()) return null;

	if (!editing) {
		return (
			<div
				data-testid={`section-margin-note-${nodeId}`}
				onClick={onStartEdit}
				role="button"
				tabIndex={0}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onStartEdit();
					}
				}}
				className="group cursor-pointer rounded-r-lg border-l-2 border-foreground/30 bg-surface/70 px-3.5 py-2 text-xs transition-colors hover:bg-surface"
			>
				<div className="mb-1 flex items-center justify-between text-[11px] font-medium text-muted-foreground">
					<span className="inline-flex items-center gap-1">
						<StickyNoteIcon className="size-3" />
						Your takeaway
					</span>
					<span className="opacity-0 transition-opacity group-hover:opacity-100">Click to edit</span>
				</div>
				<div className="text-sm leading-relaxed text-foreground/95 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
					<MessageResponse>{repairMathForDisplay(value)}</MessageResponse>
				</div>
			</div>
		);
	}

	return (
		<div
			data-testid={`section-margin-note-editor-${nodeId}`}
			className="rounded-r-lg border-l-2 border-foreground/45 bg-surface px-3.5 py-2.5 text-xs space-y-2"
		>
			<div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
				<span className="inline-flex items-center gap-1">
					<StickyNoteIcon className="size-3" />
					Your takeaway
				</span>
				<span>Markdown &amp; LaTeX ($…$) · ⌘Enter to save</span>
			</div>
			<textarea
				ref={textareaRef}
				rows={3}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => onSave(draft)}
				onKeyDown={(e) => {
					if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
						e.preventDefault();
						onSave(draft);
					} else if (e.key === "Escape") {
						e.preventDefault();
						setDraft(value);
						onCancel();
					}
				}}
				placeholder="Jot your own intuition, mnemonic, or formula (supports Markdown & LaTeX)…"
				className="w-full resize-y rounded-md border border-border bg-card px-2.5 py-1.5 font-mono text-xs leading-relaxed text-foreground placeholder:font-sans placeholder:text-muted-foreground/70"
			/>
			<div className="flex items-center justify-end gap-2">
				{value.trim() && (
					<button
						type="button"
						onMouseDown={(e) => e.preventDefault()}
						onClick={() => onSave("")}
						className="rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						Clear
					</button>
				)}
				<button
					type="button"
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => onSave(draft)}
					className="rounded-md bg-foreground px-2.5 py-1 text-[11px] font-medium text-background"
				>
					Save takeaway
				</button>
			</div>
		</div>
	);
}

/**
 * Compact disclosure at the bottom of a mastered Textbook section revealing
 * the folded user replies and answered Q&A checkpoints on demand.
 */
export function DialogueArchiveToggle({
	nodeId,
	distilled,
	open,
	onToggle,
}: {
	nodeId: string;
	distilled: DistilledSection;
	open: boolean;
	onToggle: () => void;
}) {
	if (distilled.archiveIndices.length === 0) return null;
	const parts: string[] = [];
	if (distilled.userTurns > 0) {
		parts.push(`${distilled.userTurns} ${distilled.userTurns === 1 ? "reply" : "replies"}`);
	}
	if (distilled.checkCount > 0) {
		parts.push(`${distilled.checkCount} ${distilled.checkCount === 1 ? "check" : "checks"}`);
	}
	const summary = parts.length > 0 ? parts.join(" · ") : `${distilled.archiveIndices.length} archived`;

	return (
		<button
			type="button"
			data-testid={`dialogue-archive-toggle-${nodeId}`}
			aria-expanded={open}
			onClick={onToggle}
			className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
		>
			{open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
			<span>Dialogue archive</span>
			<span className="text-[11px] tabular-nums">({summary})</span>
		</button>
	);
}

/**
 * Floating "Ask tutor" pill shown when the user selects text inside a textbook
 * section (`[data-textbook-section]`). Quotes the selected text into the composer.
 */
export function SectionQuotePopover({
	containerRef,
	sections,
	enabled,
	onQuote,
}: {
	containerRef: React.RefObject<HTMLElement | null>;
	sections: readonly LessonSection[];
	enabled: boolean;
	onQuote: (quoteMarkdown: string) => void;
}) {
	const [selection, setSelection] = useState<{
		text: string;
		nodeId: string;
		top: number;
		left: number;
	} | null>(null);

	useEffect(() => {
		if (!enabled) {
			setSelection(null);
			return;
		}
		const handleSelection = () => {
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
				setSelection(null);
				return;
			}
			const text = sel.toString().trim();
			if (text.length < 4) {
				setSelection(null);
				return;
			}
			const root = containerRef.current;
			if (!root) return;
			const anchorNode = sel.anchorNode;
			const el = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
			if (!el || !root.contains(el)) {
				setSelection(null);
				return;
			}
			// Do not trigger inside inputs/textareas (e.g. margin note editor).
			if (el.closest("textarea, input, [contenteditable]")) {
				setSelection(null);
				return;
			}
			const sectionEl = el.closest<HTMLElement>("[data-textbook-section]");
			const nodeId = sectionEl?.dataset.textbookSection;
			if (!nodeId) {
				setSelection(null);
				return;
			}
			const rect = sel.getRangeAt(0).getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) {
				setSelection(null);
				return;
			}
			setSelection({
				text,
				nodeId,
				top: Math.max(8, rect.top - 36),
				left: Math.min(window.innerWidth - 130, Math.max(12, rect.left + rect.width / 2 - 52)),
			});
		};

		document.addEventListener("mouseup", handleSelection);
		document.addEventListener("keyup", handleSelection);
		return () => {
			document.removeEventListener("mouseup", handleSelection);
			document.removeEventListener("keyup", handleSelection);
		};
	}, [containerRef, enabled]);

	if (!selection) return null;
	const sec = sections.find((s) => s.nodeId === selection.nodeId);
	if (!sec) return null;

	return (
		<button
			type="button"
			data-testid="textbook-ask-tutor-pill"
			style={{ top: selection.top, left: selection.left }}
			onMouseDown={(e) => e.preventDefault()}
			onClick={() => {
				const quote = formatSectionQuote(sec, selection.text);
				if (quote) onQuote(quote);
				window.getSelection()?.removeAllRanges();
				setSelection(null);
			}}
			className="fixed z-40 inline-flex items-center gap-1.5 rounded-full border border-border bg-foreground px-3 py-1 text-xs font-medium text-background shadow-md transition-transform hover:scale-[1.02]"
		>
			<MessageSquareQuoteIcon className="size-3.5" />
			Ask tutor
		</button>
	);
}
