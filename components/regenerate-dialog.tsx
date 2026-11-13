"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";

export function RegenerateDialogBody({
	onClose,
	onConfirm,
}: {
	onClose: () => void;
	onConfirm: () => void;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Regenerate from here?"
			data-testid="regenerate-dialog"
			className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
			{...backdropDismiss}
		>
			<div
				className="mx-4 w-full max-w-sm rounded-xl border bg-card p-5 shadow-lg"
				onClick={(e) => e.stopPropagation()}
			>
				<h2 className="text-sm font-semibold text-card-foreground" data-testid="regenerate-title">
					Regenerate from here?
				</h2>
				<p className="mt-1.5 text-xs text-muted-foreground" data-testid="regenerate-line">
					Everything after this response — messages, answers, and later progress — will be discarded.
				</p>
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						data-testid="regenerate-cancel"
						onClick={onClose}
						className="rounded-sm px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						Cancel
					</button>
					<button
						type="button"
						data-testid="regenerate-confirm"
						onClick={onConfirm}
						className="rounded-sm border border-destructive/50 bg-destructive/10 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/20"
					>
						Regenerate
					</button>
				</div>
			</div>
		</div>
	);
}

export function RegenerateDialog({
	open,
	onClose,
	onConfirm,
}: {
	open: boolean;
	onClose: () => void;
	onConfirm: () => void;
}) {
	useEffect(() => {
		if (!open) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [open, onClose]);

	if (!open || typeof document === "undefined") return null;
	return createPortal(
		<RegenerateDialogBody onClose={onClose} onConfirm={onConfirm} />,
		document.body,
	);
}
