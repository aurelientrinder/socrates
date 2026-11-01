"use client";

import { useEffect, useState } from "react";
import { CheckIcon, CircleAlertIcon, ClockIcon, LoaderCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Transport-only mirror of src/server/reading-queue.ts. */
interface QueueItem {
	id: string;
	name: string;
	source: "import" | "folder";
	folder?: string;
	status: "waiting" | "reading" | "mapping" | "done" | "failed";
	step?: string;
	error?: string;
}

/**
 * THE READING QUEUE (2026-11-01): every file the AI is reading (scanned or
 * handwritten pages) or adding to the map, imported by hand or arriving
 * from the watched folder. Shown only while there is something to show;
 * polls fast while work runs and slowly otherwise.
 */
export function ReadingQueue() {
	const [items, setItems] = useState<QueueItem[]>([]);
	const [active, setActive] = useState(false);

	useEffect(() => {
		let stop = false;
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			let next = false;
			try {
				const res = await fetch("/api/reading-queue");
				if (res.ok) {
					const body = (await res.json()) as { items: QueueItem[]; active: boolean };
					if (!stop) {
						setItems(body.items);
						setActive(body.active);
					}
					next = body.active;
				}
			} catch {
				// Offline for a moment: try again on the slow beat.
			}
			if (!stop) timer = setTimeout(tick, next ? 1500 : 6000);
		};
		void tick();
		const wake = () => { clearTimeout(timer); void tick(); };
		window.addEventListener("lh:notes-changed", wake);
		return () => { stop = true; clearTimeout(timer); window.removeEventListener("lh:notes-changed", wake); };
	}, []);

	if (items.length === 0) return null;
	const running = items.filter((i) => i.status === "reading" || i.status === "mapping" || i.status === "waiting").length;
	return (
		<section data-testid="reading-queue" aria-label="Files being read" className="rounded-2xl border border-border/70 bg-surface">
			<header className="flex items-center gap-2 px-4 py-2.5 text-sm">
				{active ? <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" /> : <CheckIcon className="size-4 text-muted-foreground" />}
				<span className="font-medium">{active ? `Reading ${running} ${running === 1 ? "file" : "files"}` : "Reading finished"}</span>
				<span className="text-muted-foreground">Scanned and handwritten pages are read by the AI, then added to your map.</span>
			</header>
			<ul className="divide-y divide-border/60 border-t border-border/60">
				{items.map((item) => (
					<li key={item.id} data-testid="reading-queue-item" className="flex items-center gap-3 px-4 py-2 text-sm">
						<StatusIcon status={item.status} />
						<span className="min-w-0 flex-1">
							<span className="block truncate">{item.name}</span>
							{item.status === "failed" && item.error && <span className="block truncate text-xs text-destructive" title={item.error}>{item.error}</span>}
						</span>
						{item.folder && <span className="hidden shrink-0 rounded-full bg-accent/70 px-2 py-0.5 text-xs text-muted-foreground sm:block">{item.folder}</span>}
						<span className={cn("shrink-0 text-xs", item.status === "failed" ? "text-destructive" : "text-muted-foreground")}>{label(item)}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function StatusIcon({ status }: { status: QueueItem["status"] }) {
	if (status === "reading" || status === "mapping") return <LoaderCircleIcon className="size-4 shrink-0 animate-spin text-muted-foreground" />;
	if (status === "waiting") return <ClockIcon className="size-4 shrink-0 text-muted-foreground" />;
	if (status === "failed") return <CircleAlertIcon className="size-4 shrink-0 text-destructive" />;
	return <CheckIcon className="size-4 shrink-0 text-good-ink" />;
}

function label(item: QueueItem): string {
	if (item.status === "waiting") return "In line";
	if (item.status === "failed") return "Stopped";
	if (item.status === "done") return "Added to your map";
	return item.step ?? (item.status === "mapping" ? "Adding to your map" : "Reading");
}
