"use client";

/**
 * Library › Calendar › Review: everything the classifier did, in three plain
 * lists, so nothing is silently missed. Events needing a class, events set
 * aside as "not a class" (with the reason), and events filed automatically
 * (with the class they went to). Each row can be corrected in place.
 */

import type { EventKind } from "@/src/core";
import { cn } from "@/lib/utils";

export interface ReviewEvent {
	id: string;
	title: string;
	start: number;
	end: number;
	allDay: boolean;
	kind: EventKind;
	pin?: "event" | "title";
	placement:
		| { state: "filed"; key: string; by: "you" | "auto" }
		| { state: "ignored"; by: "you" | "auto"; why: "pinned" | "dismissed" | "all-day" | "keyword" }
		| { state: "unplaced"; guess: string | null };
}

export interface ReviewGroup {
	key: string;
	label: string;
}

interface Row {
	key: string;
	first: ReviewEvent;
	count: number;
}

const WHY: Record<string, string> = {
	pinned: "You marked it",
	dismissed: "You dismissed its course",
	"all-day": "All-day events aren't classes",
	keyword: "Looks like gym, lunch or a break",
};

const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });

function rowsOf(events: readonly ReviewEvent[], keyOf: (title: string) => string): Row[] {
	const out: Row[] = [];
	for (const e of events) {
		const k = keyOf(e.title);
		const at = out.find((r) => r.key === k);
		if (at) at.count++;
		else out.push({ key: k, first: e, count: 1 });
	}
	return out;
}

export function CourseReview({
	events,
	groups,
	titleKey,
	onFile,
	onClose,
}: {
	events: ReviewEvent[];
	groups: ReviewGroup[];
	titleKey: (title: string) => string;
	/** File one event (or all with its title) under a class key, or "~ignored". */
	onFile: (e: ReviewEvent, value: string, all: boolean) => void;
	onClose: () => void;
}) {
	const groupOf = new Map(groups.map((g) => [g.key, g.label]));
	const needs = rowsOf(events.filter((e) => e.placement.state === "unplaced"), titleKey);
	const ignored = rowsOf(events.filter((e) => e.placement.state === "ignored"), titleKey);
	const auto = rowsOf(events.filter((e) => e.placement.state === "filed" && e.placement.by === "auto"), titleKey);

	const picker = (r: Row, current: string, label: string) => (
		<select
			aria-label={`${label}: ${r.first.title}`}
			value=""
			onChange={(ev) => ev.target.value && onFile(r.first, ev.target.value, r.count > 1 && r.first.kind !== "exam")}
			className="h-8 max-w-44 rounded-md border bg-card px-2 text-xs font-medium"
		>
			<option value="">{current}</option>
			{groups.map((g) => (
				<option key={g.key} value={g.key}>
					{g.label}
				</option>
			))}
		</select>
	);

	const line = (r: Row, note: string, action: React.ReactNode, warn = false) => (
		<li key={r.key} data-testid="review-row" className={cn("flex items-center gap-3 rounded-[10px] border bg-card px-3 py-2", warn && "border-dashed border-warn/70")}>
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-semibold">
					{r.first.title}
					{r.first.kind === "exam" && <span className="ml-2 rounded bg-foreground px-1.5 py-px text-[10px] font-bold uppercase text-background">Exam</span>}
				</p>
				<p className="truncate text-xs text-muted-foreground">
					{r.count > 1 ? `${r.count} events, next ${fmt(r.first.start)}` : fmt(r.first.start)} · {note}
				</p>
			</div>
			{action}
		</li>
	);

	const section = (id: string, title: string, hint: string, rows: Row[], render: (r: Row) => React.ReactNode, empty: string) => (
		<section aria-labelledby={id} data-testid={id} className="flex flex-col gap-2">
			<div>
				<h3 id={id} className="text-sm font-semibold">
					{title} <span className="tabular-nums text-muted-foreground">{rows.reduce((n, r) => n + r.count, 0)}</span>
				</h3>
				<p className="text-xs text-muted-foreground">{hint}</p>
			</div>
			{rows.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : <ul className="flex flex-col gap-1.5">{rows.map(render)}</ul>}
		</section>
	);

	return (
		<div className="flex flex-col gap-6 px-5 py-4" data-testid="course-review">
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">What the classifier decided, so you can check it.</p>
				<button type="button" onClick={onClose} className="text-sm font-semibold text-good hover:underline">
					Back to the week
				</button>
			</div>
			{section(
				"review-needs",
				"Needs a class",
				"Nothing matched these. Pick the class they belong to.",
				needs,
				(r) =>
					line(
						r,
						r.first.placement.state === "unplaced" && r.first.placement.guess ? `looks like ${groupOf.get(r.first.placement.guess) ?? "a class"}` : "no class matches",
						<div className="flex items-center gap-2">
							{picker(r, "File under…", "File under")}
							<button type="button" onClick={() => onFile(r.first, "~ignored", r.count > 1)} className="text-xs font-semibold text-muted-foreground hover:underline">
								Not a class
							</button>
						</div>,
						true,
					),
				"Every event has a class.",
			)}
			{section(
				"review-ignored",
				"Not a class",
				"Left out of your plan and briefing. Put one back if it was a mistake.",
				ignored,
				(r) => line(r, r.first.placement.state === "ignored" ? WHY[r.first.placement.why] ?? "Set aside" : "", picker(r, "Put back in…", "Put back in"), r.first.kind === "exam"),
				"Nothing was set aside.",
			)}
			{section(
				"review-auto",
				"Filed automatically",
				"Matched by name. Move one if the match is wrong.",
				auto,
				(r) => line(r, `in ${r.first.placement.state === "filed" ? groupOf.get(r.first.placement.key) ?? "a class" : ""}`, picker(r, "Move to…", "Move to")),
				"Nothing was filed automatically.",
			)}
		</div>
	);
}
