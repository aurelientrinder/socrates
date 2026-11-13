"use client";

import { useMemo } from "react";
import { Maximize2Icon } from "lucide-react";
import { sanitizeSvg, sanitizeStreamingSvg } from "@/components/artifacts/sanitize-svg";
import { useSessionMermaid } from "@/components/session-overlay";
import { Hint } from "@/components/ui/hint";
import { cn } from "@/lib/utils";

/**
 * Inline or live-dock SVG diagram block (Track 3):
 * - Sanitizes untrusted model-authored SVG (streaming-safe closure when drawing live).
 * - Theme-blended container using semantic tokens (`currentColor` / CSS vars).
 * - Click-to-expand fullscreen pan/zoom overlay once settled.
 */
export function DiagramFigure({
	svg,
	streaming = false,
	className,
}: {
	svg: string;
	streaming?: boolean;
	className?: string;
}) {
	const overlay = useSessionMermaid();
	const safe = useMemo(
		() => (streaming ? sanitizeStreamingSvg(svg) : sanitizeSvg(svg)),
		[svg, streaming],
	);

	if (!safe && !streaming) return null;

	return (
		<div
			data-testid="diagram-figure"
			data-streaming={streaming ? "true" : undefined}
			className={cn(
				"group/diagram relative overflow-hidden rounded-xl border border-border/60 bg-muted/20 p-3 text-foreground",
				className,
			)}
		>
			{!streaming && safe && overlay && (
				<Hint label="Expand diagram" side="left">
					<button
						type="button"
						onClick={() => overlay.openFigure(svg, false, { themed: true })}
						aria-label="Expand diagram"
						data-testid="diagram-expand"
						className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-md border border-border/70 bg-background/85 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:bg-accent hover:text-foreground group-hover/diagram:opacity-100 focus-visible:opacity-100"
					>
						<Maximize2Icon className="size-3.5" />
					</button>
				</Hint>
			)}
			{safe ? (
				<div
					className="flex items-center justify-center [&_svg]:h-auto [&_svg]:max-h-64 [&_svg]:w-full [&_svg]:max-w-full"
					dangerouslySetInnerHTML={{ __html: safe }}
				/>
			) : (
				<div className="flex h-24 items-center justify-center text-xs text-muted-foreground">
					Drawing diagram…
				</div>
			)}
			{streaming && safe && (
				<div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
					<span className="size-1.5 animate-pulse rounded-full bg-primary" />
					<span>Drawing diagram…</span>
				</div>
			)}
		</div>
	);
}
