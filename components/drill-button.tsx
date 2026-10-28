"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TargetIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { REVIEW_START_PROMPT } from "@/components/review-start";

/**
 * THE DRILL BUTTON (weak-spot report): opens a short review session on
 * the given weak spots, due or not, and lands in it. The weak-spot
 * view's "Drill the worst" and each row's "Drill" are both this.
 */
export function DrillButton({
	keys,
	label,
	variant = "default",
	testId,
}: {
	keys: string[];
	label: string;
	variant?: "default" | "outline";
	testId?: string;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const start = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/review/drill", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ keys }),
			});
			if (!res.ok) {
				setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "Could not start the drill.");
				setBusy(false);
				return;
			}
			const { id } = (await res.json()) as { id: string };
			router.push(`/chat/${id}?prompt=${encodeURIComponent(REVIEW_START_PROMPT)}`);
		} catch {
			setError("Could not start the drill.");
			setBusy(false);
		}
	};

	return (
		<span className="flex shrink-0 flex-col items-end gap-1">
			<Button
				data-testid={testId}
				variant={variant}
				size={variant === "outline" ? "sm" : "default"}
				onClick={() => void start()}
				disabled={busy}
			>
				<TargetIcon className="size-4" />
				{label}
			</Button>
			{error && <span className="text-xs text-destructive">{error}</span>}
		</span>
	);
}
