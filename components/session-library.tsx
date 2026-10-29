"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { SearchIcon } from "lucide-react";
import type { ChatKind, ChatListItem } from "@/src/core";
import { fuzzyScore } from "@/src/core";
import { SectionHeading } from "@/components/page-header";
import { timeAgo } from "@/components/sidebar";
import { useServerResync } from "@/components/server-events";
import { useClasses } from "@/components/use-class-colors";
import { cn } from "@/lib/utils";

type KindFilter = "all" | ChatKind;

const FILTERS: { id: KindFilter; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "teach", label: "Learn" },
	{ id: "practice", label: "Practice" },
	{ id: "review", label: "Review" },
];

const KIND_LABEL: Record<ChatKind, string> = { teach: "Learn", practice: "Practice", review: "Review" };

/**
 * EVERY SESSION (the Library's second half, redesign wave): the full
 * history the sidebar's recent list leaves out, filterable by kind and
 * searchable by title, newest first. Same /api/chats list the sidebar
 * reads; rows open the session.
 */
export function SessionLibrary() {
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [filter, setFilter] = useState<KindFilter>("all");
	const classes = useClasses();
	const [classKey, setClassKey] = useState<string | null>(null);
	const activeClass = classes.find((c) => c.key === classKey) ?? null;

	const load = useCallback(async () => {
		try {
			const res = await fetch("/api/chats", { cache: "no-store" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setChats(((await res.json()) as { chats: ChatListItem[] }).chats);
			setError(null);
		} catch (err) {
			setError(`Couldn't load your sessions (${err instanceof Error ? err.message : String(err)}).`);
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);
	useServerResync(() => void load());

	const shown = useMemo(() => {
		if (!chats) return null;
		const byKind = chats.filter((c) => (filter === "all" || (c.kind ?? "teach") === filter) && (!activeClass || activeClass.sessions.includes(c.id)));
		const q = query.trim();
		if (!q) return [...byKind].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return byKind
			.map((c) => ({ c, score: fuzzyScore(q, c.title) }))
			.filter((x) => x.score !== null)
			.sort((a, b) => (b.score as number) - (a.score as number))
			.map((x) => x.c);
	}, [chats, filter, query, activeClass]);

	return (
		<section data-testid="session-library" aria-labelledby="sessions-heading" className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<SectionHeading className="flex items-baseline gap-2">
					<span id="sessions-heading">All sessions</span>
					{chats && <span className="text-sm font-normal text-muted-foreground">{chats.length}</span>}
				</SectionHeading>
				<div className="flex flex-wrap items-center gap-2">
					<label className="relative flex items-center">
						<span className="sr-only">Search sessions</span>
						<SearchIcon className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground" aria-hidden="true" />
						<input
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search"
							data-testid="library-search"
							className="h-9 w-44 rounded-lg border bg-surface pl-8 pr-3 text-base text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
						/>
					</label>
					<div role="group" aria-label="Filter by kind" className="flex gap-0.5 rounded-lg bg-accent/70 p-0.5">
						{FILTERS.map((f) => (
							<button
								key={f.id}
								type="button"
								aria-pressed={filter === f.id}
								data-testid={`library-filter-${f.id}`}
								onClick={() => setFilter(f.id)}
								className={cn(
									"h-8 rounded-md px-3 text-base transition-colors",
									filter === f.id
										? "bg-surface font-semibold text-foreground shadow-xs"
										: "text-muted-foreground hover:text-foreground",
								)}
							>
								{f.label}
							</button>
						))}
					</div>
				</div>
			</div>

			{classes.length > 0 && (
				<div role="group" aria-label="Filter by class" data-testid="library-classes" className="flex flex-wrap gap-1.5">
					<button
						type="button"
						aria-pressed={classKey === null}
						onClick={() => setClassKey(null)}
						className={cn("h-8 rounded-full px-3 text-sm", classKey === null ? "bg-foreground font-semibold text-background" : "bg-accent text-muted-foreground hover:text-foreground")}
					>
						All classes
					</button>
					{classes.map((c) => (
						<button
							key={c.key}
							type="button"
							aria-pressed={classKey === c.key}
							onClick={() => setClassKey(classKey === c.key ? null : c.key)}
							className={cn(`cal-c${c.color}`, "flex h-8 items-center gap-1.5 rounded-full px-3 text-sm", classKey === c.key ? "bg-foreground font-semibold text-background" : "bg-accent text-muted-foreground hover:text-foreground")}
						>
							<span className="size-2 rounded-[3px]" style={{ background: "var(--bar)" }} />
							{c.label}
						</button>
					))}
				</div>
			)}

			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{shown === null ? (
				!error && <p className="text-sm text-muted-foreground">Loading…</p>
			) : shown.length === 0 ? (
				<p className="text-sm text-muted-foreground">
					{query.trim() || filter !== "all" ? "No sessions match." : "No sessions yet. Start studying and they appear here."}
				</p>
			) : (
				<ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-xl border border-border/70 bg-surface">
					{shown.map((c) => (
						<li key={c.id}>
							<Link
								href={`/chat/${c.id}`}
								data-testid="library-session"
								className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-accent"
							>
								<span className="flex min-w-0 flex-1 basis-60 items-center gap-2.5">
									{(() => {
										const cls = classes.find((k) => k.sessions.includes(c.id));
										return cls ? <span className={cn(`cal-c${cls.color}`, "size-2.5 shrink-0 rounded-[3px]")} style={{ background: "var(--bar)" }} title={cls.label} /> : null;
									})()}
									<span className="truncate font-prose text-lg">{c.title}</span>
								</span>
								<span className="rounded-full bg-accent px-2.5 py-0.5 text-xs font-semibold text-foreground/80">
									{KIND_LABEL[c.kind ?? "teach"]}
								</span>
								<span className="w-24 text-right text-sm text-muted-foreground">{timeAgo(c.updatedAt)}</span>
							</Link>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
