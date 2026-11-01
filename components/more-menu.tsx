"use client";

import { useCallback, useRef, useState } from "react";
import { MoreHorizontalIcon } from "lucide-react";
import { usePopoverDismiss } from "@/components/popover-dismiss";
import { cn } from "@/lib/utils";

export interface MoreMenuItem {
	label: string;
	onSelect: () => void;
	danger?: boolean;
	disabled?: boolean;
	/** A thin rule above this item. */
	divider?: boolean;
	testId?: string;
}

/** A "⋯" button with a small menu of actions (Library cards and rows). */
export function MoreMenu({ items, label, testId, className }: { items: MoreMenuItem[]; label: string; testId?: string; className?: string }) {
	const [open, setOpen] = useState(false);
	const root = useRef<HTMLDivElement>(null);
	const close = useCallback(() => setOpen(false), []);
	usePopoverDismiss(root, open, close);
	return (
		<div ref={root} className={cn("relative", className)}>
			<button
				type="button"
				aria-label={label}
				aria-haspopup="menu"
				aria-expanded={open}
				data-testid={testId}
				onClick={() => setOpen((v) => !v)}
				className={cn(
					"flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
					open && "bg-accent text-foreground",
				)}
			>
				<MoreHorizontalIcon className="size-4" />
			</button>
			{open && (
				<div role="menu" className="absolute right-0 top-full z-30 mt-1 flex min-w-48 flex-col rounded-xl border bg-card p-1.5 text-sm shadow-xl">
					{items.map((item) => (
						<div key={item.label} className="contents">
							{item.divider && <div className="mx-1.5 my-1 h-px bg-border/70" />}
							<button
								type="button"
								role="menuitem"
								disabled={item.disabled}
								data-testid={item.testId}
								onClick={() => {
									setOpen(false);
									item.onSelect();
								}}
								className={cn(
									"rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50",
									item.danger ? "text-destructive" : "text-foreground",
								)}
							>
								{item.label}
							</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
