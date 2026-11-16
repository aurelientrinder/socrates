"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ScrollTextIcon } from "lucide-react";
import type { SheetSummary } from "@/src/core";
import { STANDING_LABEL } from "@/src/core";
import { StandingMark } from "@/components/cheatsheet-view";
import { SectionHeading } from "@/components/page-header";
import { timeAgo } from "@/components/sidebar";
import { useStartDialog } from "@/components/start-dialog";

/**
 * CHEAT SHEETS in the Library: every sheet, newest first, with how many of
 * its lines are known, shaky and not seen yet (read from today's answers).
 * Rows open the sheet; the button opens the Start dialog on Cheat sheet.
 */
export function SheetLibrary() {
	const [sheets, setSheets] = useState<SheetSummary[] | null>(null);
	const start = useStartDialog();
	useEffect(() => {
		void fetch("/api/cheatsheets", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<{ sheets: SheetSummary[] }>) : { sheets: [] }))
			.then((body) => setSheets(body.sheets))
			.catch(() => setSheets([]));
	}, []);
	return <SheetLibraryBody sheets={sheets} onNew={() => start.open("sheet")} />;
}

export function SheetLibraryBody({ sheets, onNew }: { sheets: SheetSummary[] | null; onNew: () => void }) {
	return (
		<section data-testid="sheet-library" aria-labelledby="sheets-heading" className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<SectionHeading className="flex items-baseline gap-2">
					<span id="sheets-heading">Cheat sheets</span>
					{sheets && sheets.length > 0 && <span className="text-sm font-normal text-muted-foreground">{sheets.length}</span>}
				</SectionHeading>
				<button type="button" onClick={onNew} className="flex h-9 items-center gap-2 rounded-lg border bg-surface px-3 text-sm transition-colors hover:bg-accent">
					<ScrollTextIcon className="size-4" />
					New cheat sheet
				</button>
			</div>
			{sheets === null ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : sheets.length === 0 ? (
				<p className="rounded-2xl border border-dashed px-5 py-6 text-center text-sm text-muted-foreground">
					No cheat sheets yet. Everything to know for an exam, each line marked with what your answers show you know.
				</p>
			) : (
				<ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-2xl border border-border/70 bg-surface">
					{sheets.map((s) => (
						<li key={s.id}>
							<Link href={`/sheet/${s.id}`} data-testid="library-sheet" className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 transition-colors hover:bg-accent/30">
								<span className="min-w-0 flex-1 basis-60 truncate text-[15px]">{s.title}</span>
								{s.status === "ready" ? (
									<span className="flex items-center gap-3 text-xs tabular-nums text-muted-foreground">
										{(["known", "shaky", "unseen"] as const).map((k) => (
											<span key={k} title={STANDING_LABEL[k]} className="flex items-center gap-1">
												<StandingMark standing={k} className="size-2" />
												{s.counts[k]}
											</span>
										))}
									</span>
								) : (
									<span className="rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-foreground/80">
										{s.status === "generating" ? "Being written" : "Needs a retry"}
									</span>
								)}
								<span className="w-24 text-right text-sm text-muted-foreground">{timeAgo(s.createdAt)}</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
