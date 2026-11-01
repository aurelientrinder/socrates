"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon, RotateCcwIcon } from "lucide-react";
import { blurAfterPointerClick } from "@/components/focus-hygiene";

/** The reply's plain text for the clipboard: the text parts in order,
 *  one blank line apart. Thinking, tool cards and quizzes stay out — the
 *  copy is what the tutor SAID. Exported pure for tests. */
export function replyCopyText(parts: readonly { type: string; text?: string }[]): string {
	return parts
		.filter((p) => p.type === "text" && (p.text ?? "").trim() !== "")
		.map((p) => (p.text ?? "").trim())
		.join("\n\n");
}

/**
 * The quiet row under a settled tutor reply (owner, feed redesign
 * 2026-11-01): Claude's feed grammar — the reply is open text, and its
 * actions sit below it, faint until the reply is hovered or focused.
 */
export function ReplyActions({
	parts,
	onRetry,
}: {
	parts: readonly { type: string; text?: string }[];
	/** Set on the last reply when it can be re-asked (chat.tsx canRetry). */
	onRetry?: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const text = replyCopyText(parts);
	if (!text && !onRetry) return null;
	return (
		<div data-testid="reply-actions" className="-ml-1.5 mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
			{text && <button
				type="button"
				aria-label={copied ? "Copied" : "Copy reply"}
				onClick={(e) => {
					blurAfterPointerClick(e);
					void navigator.clipboard?.writeText(text).then(
						() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1500);
						},
						() => {},
					);
				}}
				className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
			>
				{copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
				{copied ? "Copied" : "Copy"}
			</button>}
			{onRetry && (
				<button
					type="button"
					data-testid="reply-retry"
					aria-label="Retry: ask for this reply again"
					title="Ask for this reply again"
					onClick={(e) => {
						blurAfterPointerClick(e);
						onRetry();
					}}
					className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<RotateCcwIcon className="size-3.5" />
					Retry
				</button>
			)}
		</div>
	);
}
