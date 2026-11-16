"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, Loader2Icon, PrinterIcon, RotateCcwIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { DiagramFigure } from "@/components/diagram-figure";
import { DrillButton } from "@/components/drill-button";
import { PageHead } from "@/components/page-header";
import { MermaidOverlay, SessionMermaidContext } from "@/components/session-overlay";
import { timeAgo } from "@/components/sidebar";
import { useStartDialog } from "@/components/start-dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { repairMathForDisplay, sheetCounts, shakyKeys, SHEET_STEPS, STANDING_LABEL, type SheetItem, type SheetRecord, type Standing } from "@/src/core";

/**
 * THE CHEAT SHEET PAGE (src/core/cheatsheet.ts): a progress card while it
 * is written, then the sheet: dense, two columns on a wide window, every
 * line marked with what your tested answers say about it. The counts on
 * top filter the sheet (just the shaky lines, just the new ones) and lead
 * to the next step: drill the shaky ones, learn the ones never seen.
 * Prints to paper as the sheet alone.
 */

const POLL_MS = 2500;

export type SheetFilter = "all" | Standing;

export function CheatSheetPage({ initial }: { initial: SheetRecord }) {
	const router = useRouter();
	const start = useStartDialog();
	const [sheet, setSheet] = useState<SheetRecord>(initial);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [filter, setFilter] = useState<SheetFilter>("all");

	useEffect(() => {
		if (sheet.status !== "generating") return;
		const timer = setInterval(() => {
			void fetch(`/api/cheatsheets/${sheet.id}`, { cache: "no-store" })
				.then((r) => (r.ok ? (r.json() as Promise<SheetRecord>) : null))
				.then((next) => next && setSheet(next))
				.catch(() => {});
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [sheet.status, sheet.id]);

	const request = async (url: string, body?: unknown): Promise<{ id?: string } & Partial<SheetRecord>> => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });
			const json = (await res.json().catch(() => ({}))) as { id?: string; error?: string } & Partial<SheetRecord>;
			if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
			return json;
		} finally {
			setBusy(false);
		}
	};

	return (
		<CheatSheetScreen
			sheet={sheet}
			busy={busy}
			error={error}
			filter={filter}
			onFilter={setFilter}
			onRetry={() =>
				void request(`/api/cheatsheets/${sheet.id}/retry`)
					.then((next) => setSheet(next as SheetRecord))
					.catch((err: Error) => setError(err.message))
			}
			onAgain={() =>
				void request("/api/cheatsheets", { scope: sheet.scope.text, focus: sheet.scope.focus, noteIds: sheet.scope.noteIds })
					.then((r) => r.id && router.push(`/sheet/${r.id}`))
					.catch((err: Error) => setError(err.message))
			}
			onDelete={() => {
				if (!window.confirm("Delete this cheat sheet?")) return;
				void fetch(`/api/cheatsheets/${sheet.id}`, { method: "DELETE" }).then(() => router.push("/library"));
			}}
			onLearn={(terms) => start.open("learn", undefined, { topic: `${sheet.scope.text ? `${sheet.scope.text}: ` : ""}${terms.join(", ")}` })}
			onPrint={() => window.print()}
		/>
	);
}

/** The page's pure body: the render-test seam. */
export function CheatSheetScreen(props: {
	sheet: SheetRecord;
	busy: boolean;
	error: string | null;
	filter: SheetFilter;
	onFilter: (f: SheetFilter) => void;
	onRetry: () => void;
	onAgain: () => void;
	onDelete: () => void;
	onLearn: (terms: string[]) => void;
	onPrint: () => void;
	now?: number;
}) {
	const { sheet } = props;
	const [figureFocus, setFigureFocus] = useState<string | null>(null);
	const overlay = useMemo(() => ({ openMermaid: () => {}, openFigure: (svg: string) => setFigureFocus(svg) }), []);
	const ready = sheet.status === "ready";
	return (
		<SessionMermaidContext.Provider value={overlay}>
			<div className="relative h-full overflow-hidden">
				<div data-testid="sheet-page" data-status={sheet.status} className="lh-print-root relative h-full overflow-y-auto">
					<div className="mx-auto flex max-w-6xl flex-col gap-5 px-6 pb-16 pt-8 sm:px-10">
						<PageHead
							title={sheet.title}
							actions={
								ready ? (
									<span className="flex items-center gap-1 print:hidden">
										<Button variant="ghost" size="sm" onClick={props.onPrint} data-testid="sheet-print">
											<PrinterIcon className="size-4" />
											Print
										</Button>
										<Button variant="ghost" size="sm" disabled={props.busy} onClick={props.onAgain} data-testid="sheet-again">
											<RotateCcwIcon className="size-4" />
											Write again
										</Button>
									</span>
								) : undefined
							}
						/>
						<ScopeLine sheet={sheet} now={props.now} />
						{props.error && (
							<p role="alert" className="text-sm text-destructive">
								{props.error}
							</p>
						)}
						{sheet.status === "generating" && <Working phase={sheet.phase} />}
						{sheet.status === "failed" && <Failed {...props} />}
						{ready && <Sheet {...props} />}
					</div>
				</div>
				{figureFocus !== null && <MermaidOverlay svg={figureFocus} themed onClose={() => setFigureFocus(null)} />}
			</div>
		</SessionMermaidContext.Provider>
	);
}

function ScopeLine({ sheet, now }: { sheet: SheetRecord; now?: number }) {
	const bits = [
		sheet.scope.noteIds.length > 0 ? `from ${sheet.scope.noteIds.length} note ${sheet.scope.noteIds.length === 1 ? "file" : "files"}` : null,
		sheet.status === "ready" ? `made ${timeAgo(sheet.createdAt, now !== undefined ? new Date(now) : undefined)}` : null,
		sheet.checks && sheet.checks.items > 0
			? sheet.checks.fixed + sheet.checks.dropped > 0
				? `every line checked, ${[sheet.checks.fixed > 0 ? `${sheet.checks.fixed} corrected` : "", sheet.checks.dropped > 0 ? `${sheet.checks.dropped} removed` : ""].filter(Boolean).join(", ")}`
				: "every line checked"
			: null,
	].filter(Boolean);
	return (
		<p data-testid="sheet-scope" className="-mt-3 text-sm text-muted-foreground">
			{sheet.scope.text && <span className="text-foreground/85">{sheet.scope.text}</span>}
			{sheet.scope.focus && (
				<>
					{sheet.scope.text && " · "}
					<span>Focus: {sheet.scope.focus}</span>
				</>
			)}
			{bits.length > 0 && <>{(sheet.scope.text || sheet.scope.focus) && " · "}{bits.join(" · ")}</>}
		</p>
	);
}

function Working({ phase }: { phase?: string }) {
	const at = phase ? (SHEET_STEPS as readonly string[]).indexOf(phase) : -1;
	return (
		<section data-testid="sheet-working" className="flex max-w-2xl flex-col gap-3 rounded-xl border border-border/70 bg-card p-5">
			<p className="flex items-center gap-2.5 text-base font-semibold">
				<Loader2Icon className="size-4 animate-spin text-muted-foreground" />
				Writing your cheat sheet
			</p>
			<ol className="flex flex-col gap-1.5 text-[15px]">
				{SHEET_STEPS.map((s, i) => (
					<li key={s} className={cn("flex items-center gap-2.5", i > at && "text-muted-foreground")}>
						{i < at ? <CheckIcon className="size-4 text-good" /> : i === at ? <Loader2Icon className="size-4 animate-spin" /> : <span className="size-4" />}
						{s}
					</li>
				))}
			</ol>
			<p className="text-sm text-muted-foreground">
				A minute or two. Each line is then marked from your own tested answers, not from what the model thinks. You can leave this page; the sheet waits
				in the Library.
			</p>
		</section>
	);
}

function Failed({ sheet, busy, onRetry, onDelete }: Parameters<typeof CheatSheetScreen>[0]) {
	return (
		<section data-testid="sheet-failed" className="flex max-w-2xl flex-col gap-3 rounded-xl border border-border/70 bg-card p-5">
			<p className="text-base font-semibold">The cheat sheet could not be written</p>
			{sheet.error && <p className="text-[15px] text-foreground/80">{sheet.error}</p>}
			<div className="flex flex-wrap gap-2">
				<Button disabled={busy} onClick={onRetry}>
					<RotateCcwIcon className="size-4" />
					Try again
				</Button>
				<Button variant="ghost" onClick={onDelete}>
					Delete
				</Button>
			</div>
		</section>
	);
}

/** The standing mark: a filled ink dot, an amber half dot, an empty ring. */
export function StandingMark({ standing, className }: { standing: Standing; className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn(
				"inline-block size-2.5 shrink-0 rounded-full",
				standing === "known" && "bg-good",
				standing === "shaky" && "bg-[linear-gradient(90deg,var(--lh-warn)_50%,transparent_50%)] ring-[1.5px] ring-warn ring-inset",
				standing === "unseen" && "ring-[1.5px] ring-muted-foreground/70 ring-inset",
				className,
			)}
		/>
	);
}

const FILTERS: { id: SheetFilter; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "known", label: STANDING_LABEL.known },
	{ id: "shaky", label: STANDING_LABEL.shaky },
	{ id: "unseen", label: STANDING_LABEL.unseen },
];

function Sheet({ sheet, filter, onFilter, onLearn, onDelete }: Parameters<typeof CheatSheetScreen>[0]) {
	const counts = sheetCounts(sheet.sections);
	const total = counts.known + counts.shaky + counts.unseen;
	const drill = shakyKeys(sheet);
	const unseen = sheet.sections.flatMap((s) => s.items.filter((i) => i.standing === "unseen").map((i) => i.term));
	const sections = sheet.sections
		.map((s) => ({ ...s, items: filter === "all" ? s.items : s.items.filter((i) => i.standing === filter) }))
		.filter((s) => s.items.length > 0);
	return (
		<>
			<div data-testid="sheet-standing" className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border/60 py-2 print:hidden">
				<div role="group" aria-label="Show" className="flex flex-wrap gap-0.5 rounded-lg bg-accent/70 p-0.5">
					{FILTERS.map((f) => (
						<button
							key={f.id}
							type="button"
							aria-pressed={filter === f.id}
							data-testid={`sheet-filter-${f.id}`}
							onClick={() => onFilter(f.id)}
							className={cn(
								"flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors",
								filter === f.id ? "bg-surface font-semibold text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
							)}
						>
							{f.id !== "all" && <StandingMark standing={f.id} className="size-2" />}
							{f.label}
							<span className="tabular-nums text-muted-foreground">{f.id === "all" ? total : counts[f.id]}</span>
						</button>
					))}
				</div>
				<p className="min-w-0 flex-1 basis-64 text-[13px] text-muted-foreground">
					Marked from your tested answers, as of now. A line you have never been tested on counts as not seen, however familiar it looks.
				</p>
				<span className="flex items-center gap-2">
					{drill.length > 0 && <DrillButton keys={drill} label={`Drill the shaky ${drill.length === 1 ? "one" : "ones"}`} variant="outline" testId="sheet-drill" />}
					{unseen.length > 0 && (
						<Button variant="outline" size="sm" onClick={() => onLearn(unseen.slice(0, 8))} data-testid="sheet-learn">
							Learn the new ones
						</Button>
					)}
				</span>
			</div>

			{sections.length === 0 ? (
				<p className="text-sm text-muted-foreground">Nothing on this sheet is marked {STANDING_LABEL[filter as Standing].toLowerCase()}.</p>
			) : (
				<div data-testid="sheet-body" className="columns-1 gap-x-10 lg:columns-2 print:columns-2 print:gap-x-6">
					{sections.map((s) => (
						<section key={s.title} className="mb-5 break-inside-avoid-column">
							<h2 className="mb-1.5 border-b border-border/70 pb-1 text-[15px] font-semibold tracking-tight">{s.title}</h2>
							<ul className="flex flex-col">
								{s.items.map((i) => (
									<Item key={i.id} item={i} />
								))}
							</ul>
						</section>
					))}
				</div>
			)}

			<div className="flex justify-end print:hidden">
				<button type="button" onClick={onDelete} className="text-sm text-muted-foreground underline-offset-2 hover:underline">
					Delete this cheat sheet
				</button>
			</div>
		</>
	);
}

function Item({ item }: { item: SheetItem }) {
	return (
		<li data-testid="sheet-item" data-standing={item.standing} className="flex break-inside-avoid gap-2.5 border-b border-border/40 py-1.5 last:border-b-0">
			<span title={`${STANDING_LABEL[item.standing]}. ${item.reason}`} className="flex h-5 items-center">
				<StandingMark standing={item.standing} />
				<span className="sr-only">{STANDING_LABEL[item.standing]}</span>
			</span>
			<div className="min-w-0 flex-1 text-[14px] leading-snug">
				<p className="font-semibold">{item.term}</p>
				<MessageResponse className="lh-sheet-body h-auto">{repairMathForDisplay(item.body)}</MessageResponse>
				{item.figure && (
					<figure className="m-0 mt-1">
						<DiagramFigure svg={item.figure} className="border-border/50 bg-transparent px-2 py-1.5" svgClassName="[&_svg]:max-h-48" />
					</figure>
				)}
				{item.watch && (
					<div className="mt-0.5 flex gap-1 text-warn-ink">
						<span className="shrink-0 text-[13px] leading-[1.4] font-semibold">Watch:</span>
						<MessageResponse className="lh-sheet-body lh-sheet-watch h-auto min-w-0 flex-1">{repairMathForDisplay(item.watch)}</MessageResponse>
					</div>
				)}
				{item.standing === "shaky" && <p className="mt-0.5 text-[12px] text-muted-foreground print:hidden">{item.reason}</p>}
			</div>
		</li>
	);
}
