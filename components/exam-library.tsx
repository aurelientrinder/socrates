"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardCheckIcon } from "lucide-react";
import type { ExamStatus, ExamSummary } from "@/src/core";
import { SectionHeading } from "@/components/page-header";
import { timeAgo } from "@/components/sidebar";
import { useStartDialog } from "@/components/start-dialog";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<ExamStatus, string> = {
	generating: "Being written",
	ready: "Not started",
	running: "In progress",
	grading: "Being marked",
	graded: "Marked",
	failed: "Needs a retry",
};

/**
 * MOCK EXAMS in the Library: every exam, newest first, with its score once
 * marked. Rows open the exam page; the button opens the Start dialog on
 * Mock exam.
 */
export function ExamLibrary() {
	const [exams, setExams] = useState<ExamSummary[] | null>(null);
	const start = useStartDialog();
	useEffect(() => {
		void fetch("/api/exams", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<{ exams: ExamSummary[] }>) : { exams: [] }))
			.then((body) => setExams(body.exams))
			.catch(() => setExams([]));
	}, []);
	return <ExamLibraryBody exams={exams} onNew={() => start.open("exam")} />;
}

export function ExamLibraryBody({ exams, onNew }: { exams: ExamSummary[] | null; onNew: () => void }) {
	return (
		<section data-testid="exam-library" aria-labelledby="exams-heading" className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<SectionHeading className="flex items-baseline gap-2">
					<span id="exams-heading">Mock exams</span>
					{exams && exams.length > 0 && <span className="text-sm font-normal text-muted-foreground">{exams.length}</span>}
				</SectionHeading>
				<button
					type="button"
					onClick={onNew}
					className="flex h-9 items-center gap-2 rounded-lg border bg-surface px-3 text-sm transition-colors hover:bg-accent"
				>
					<ClipboardCheckIcon className="size-4" />
					New mock exam
				</button>
			</div>
			{exams === null ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : exams.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					No mock exams yet. A mock exam is a timed paper of real exam problems on a topic or your notes, marked at the end, so you find your gaps
					before the real one.
				</p>
			) : (
				<ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-surface">
					{exams.map((e) => (
						<li key={e.id}>
							<Link
								href={`/exam/${e.id}`}
								data-testid="library-exam"
								className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-accent"
							>
								<span className="min-w-0 flex-1 basis-60 truncate font-prose text-lg">{e.title}</span>
								{e.status === "graded" && e.earned !== undefined ? (
									<span
										className={cn(
											"rounded-full px-2.5 py-0.5 text-xs font-semibold tabular-nums",
											e.total > 0 && e.earned / e.total >= 0.8
												? "bg-good-soft text-good-ink"
												: e.total > 0 && e.earned / e.total >= 0.5
													? "bg-warn-soft text-warn-ink"
													: "bg-destructive/10 text-destructive",
										)}
									>
										{Number.isInteger(e.earned) ? e.earned : e.earned.toFixed(1)} / {e.total}
									</span>
								) : (
									<span className="rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-foreground/80">{STATUS_LABEL[e.status]}</span>
								)}
								<span className="w-24 text-right text-sm text-muted-foreground">{timeAgo(e.createdAt)}</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
