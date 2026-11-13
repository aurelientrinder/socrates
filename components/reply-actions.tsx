"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon, RotateCcwIcon } from "lucide-react";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { stripDiagrams } from "@/src/core";

/** The reply's plain text for the clipboard: the text parts in order,
 *  one blank line apart (inline `<diagram>` blocks stripped). Thinking,
 *  tool cards and quizzes stay out — the copy is what the tutor SAID.
 *  Exported pure for tests. */
export function replyCopyText(parts: readonly { type: string; text?: string }[]): string {
	return parts
		.filter((p) => p.type === "text")
		.map((p) => stripDiagrams(p.text ?? "").trim())
		.filter((t) => t !== "")
		.join("\n\n");
}

/**
 * The quiet row under a settled tutor reply (owner, feed redesign
 * 2026-11-01): Claude's feed grammar — the reply is open text, and its
 * actions sit below it, subtly visible at rest and full opacity on hover/focus.
 */
export function ReplyActions({
	parts,
	onRetry,
	onRegenerate,
}: {
	parts: readonly { type: string; text?: string }[];
	onRetry?: () => void;
	onRegenerate?: () => void;
}) {
	const [copied, setCopied] = useState(false);
	const text = replyCopyText(parts);
	const regenerate = onRegenerate ?? onRetry;
	if (!text && !regenerate) return null;
	return (
		<div data-testid="reply-actions" className="-ml-1.5 mt-1 flex items-center gap-1 opacity-60 transition-opacity hover:opacity-100 group-hover:opacity-100 focus-within:opacity-100">
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
			{regenerate && (
				<button
					type="button"
					data-testid="reply-retry"
					aria-label="Regenerate response"
					title="Regenerate response"
					onClick={(e) => {
						blurAfterPointerClick(e);
						regenerate();
					}}
					className="flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<RotateCcwIcon className="size-3.5" />
					Regenerate
				</button>
			)}
		</div>
	);
}
