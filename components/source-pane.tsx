"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpenIcon, FileTextIcon, QuoteIcon, SearchIcon, XIcon } from "lucide-react";
import { filterSourcePages, formatSourceQuote, notesPages, type NoteMeta } from "@/src/core";
import { cn } from "@/lib/utils";

interface SelectedPassage {
	text: string;
	page?: number;
}

/**
 * Side-by-side source reader docked inside a learning/practice session.
 * Supports toggling between inline PDF (`/api/notes/:id/file`) and searchable
 * extracted text (`notesPages`) with highlight-to-quote into the composer.
 */
export function SourcePane({
	initialNoteId,
	onQuote,
	onClose,
}: {
	initialNoteId?: string | null;
	onQuote: (quotedMarkdown: string) => void;
	onClose: () => void;
}) {
	const [notes, setNotes] = useState<NoteMeta[]>([]);
	const [loadingList, setLoadingList] = useState(true);
	const [selectedId, setSelectedId] = useState<string>(initialNoteId ?? "");
	const [activeNote, setActiveNote] = useState<NoteMeta | null>(null);
	const [text, setText] = useState<string>("");
	const [loadingNote, setLoadingNote] = useState(false);
	const [view, setView] = useState<"pdf" | "text">("text");
	const [query, setQuery] = useState("");
	const [selection, setSelection] = useState<SelectedPassage | null>(null);
	const textContainerRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let cancelled = false;
		setLoadingList(true);
		fetch("/api/notes", { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<{ notes?: NoteMeta[] }>) : { notes: [] }))
			.then((data) => {
				if (cancelled) return;
				const list = data.notes ?? [];
				setNotes(list);
				setSelectedId((prev) => {
					if (prev && list.some((n) => n.id === prev)) return prev;
					if (initialNoteId && list.some((n) => n.id === initialNoteId)) return initialNoteId;
					return list[0]?.id ?? "";
				});
			})
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) setLoadingList(false);
			});
		return () => {
			cancelled = true;
		};
	}, [initialNoteId]);

	useEffect(() => {
		if (!selectedId) {
			setActiveNote(null);
			setText("");
			return;
		}
		let cancelled = false;
		setLoadingNote(true);
		setSelection(null);
		fetch(`/api/notes/${encodeURIComponent(selectedId)}`, { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<{ note: NoteMeta; text: string }>) : null))
			.then((data) => {
				if (cancelled || !data) return;
				setActiveNote(data.note);
				setText(data.text);
				setView(data.note.kind === "pdf" ? "pdf" : "text");
			})
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) setLoadingNote(false);
			});
		return () => {
			cancelled = true;
		};
	}, [selectedId]);

	const pages = useMemo(() => (text ? notesPages(text) : []), [text]);
	const filtered = useMemo(() => filterSourcePages(pages, query), [pages, query]);

	function captureSelection(page?: number) {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed) return;
		const chosen = sel.toString().trim();
		if (chosen.length < 3) return;
		if (textContainerRef.current && sel.anchorNode && !textContainerRef.current.contains(sel.anchorNode)) return;
		setSelection({ text: chosen, page });
	}

	function sendQuote(prompt?: string) {
		if (!selection || !activeNote) return;
		const md = formatSourceQuote({
			noteName: activeNote.name,
			passage: selection.text,
			page: selection.page,
			prompt,
		});
		if (md) onQuote(md);
		setSelection(null);
		window.getSelection()?.removeAllRanges();
	}

	return (
		<aside
			data-testid="source-pane"
			aria-label="Source reader"
			className="flex h-full w-[44%] min-w-[320px] max-w-[680px] shrink-0 flex-col border-r border-border bg-surface"
		>
			<div className="flex items-center gap-2 border-b border-border px-3 py-2">
				<BookOpenIcon className="size-4 shrink-0 text-muted-foreground" />
				{loadingList ? (
					<span className="flex-1 text-xs text-muted-foreground">Loading notes…</span>
				) : notes.length === 0 ? (
					<span className="flex-1 text-xs text-muted-foreground">No imported notes yet (import in Library).</span>
				) : (
					<select
						aria-label="Choose a saved note"
						value={selectedId}
						onChange={(e) => setSelectedId(e.target.value)}
						className="h-7 min-w-0 flex-1 truncate rounded-md border border-border bg-card px-2 text-xs"
					>
						{notes.map((n) => (
							<option key={n.id} value={n.id}>
								{n.name}
							</option>
						))}
					</select>
				)}
				{activeNote?.kind === "pdf" && (
					<div className="flex shrink-0 rounded-md border border-border bg-card p-0.5 text-[11px]">
						<button
							type="button"
							onClick={() => setView("pdf")}
							className={cn(
								"rounded px-2 py-0.5 transition-colors",
								view === "pdf" ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
							)}
						>
							PDF
						</button>
						<button
							type="button"
							onClick={() => setView("text")}
							className={cn(
								"rounded px-2 py-0.5 transition-colors",
								view === "text" ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
							)}
						>
							Text
						</button>
					</div>
				)}
				<button
					type="button"
					onClick={onClose}
					aria-label="Close source reader"
					className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</div>

			{!activeNote ? (
				<div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">
					<FileTextIcon className="size-6 opacity-40" />
					<p>{loadingNote ? "Opening source…" : "Import a PDF or notes file in Library to read it side-by-side."}</p>
				</div>
			) : view === "pdf" && activeNote.kind === "pdf" ? (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex items-center justify-between border-b border-border/60 bg-card/60 px-3 py-1.5 text-[11px] text-muted-foreground">
						<span>Viewing original PDF</span>
						<button
							type="button"
							onClick={() => setView("text")}
							className="font-medium text-foreground underline-offset-2 hover:underline"
						>
							Switch to Text to highlight &amp; quote
						</button>
					</div>
					<iframe
						title={activeNote.name}
						src={`/api/notes/${encodeURIComponent(activeNote.id)}/file`}
						className="min-h-0 flex-1 w-full bg-background"
					/>
				</div>
			) : (
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
						<SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
						<input
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search in note…"
							aria-label="Search in note"
							className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
						/>
						{query.trim() && (
							<span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
								{filtered.length} {filtered.length === 1 ? "page" : "pages"}
							</span>
						)}
					</div>

					{selection && (
						<div
							data-testid="source-quote-bar"
							className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-3 py-2 text-xs"
						>
							<p className="min-w-0 flex-1 truncate text-muted-foreground">
								<QuoteIcon className="mr-1 inline size-3" />
								“{selection.text}”
								{selection.page !== undefined ? ` (p. ${selection.page})` : ""}
							</p>
							<div className="flex shrink-0 items-center gap-1.5">
								<button
									type="button"
									onClick={() => sendQuote()}
									className="rounded-md border border-border bg-surface px-2.5 py-1 font-medium hover:bg-accent"
								>
									Quote
								</button>
								<button
									type="button"
									onClick={() => sendQuote("Can you walk me through why this follows?")}
									className="rounded-md bg-foreground px-2.5 py-1 font-medium text-background hover:opacity-90"
								>
									Ask why
								</button>
							</div>
						</div>
					)}

					<div ref={textContainerRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
						{loadingNote ? (
							<p className="text-xs text-muted-foreground">Loading text…</p>
						) : filtered.length === 0 ? (
							<p className="text-xs text-muted-foreground">No matching passages.</p>
						) : (
							filtered.map((p, i) => (
								<article
									key={p.page ?? i}
									onMouseUp={() => captureSelection(p.page)}
									onKeyUp={() => captureSelection(p.page)}
									className="rounded-xl border border-border/60 bg-card p-3.5"
								>
									{p.page !== undefined && (
										<p className="mb-1.5 text-[11px] font-medium text-muted-foreground tabular-nums">
											Page {p.page}
											{p.matches > 0 ? ` · ${p.matches} ${p.matches === 1 ? "match" : "matches"}` : ""}
										</p>
									)}
									<pre className="whitespace-pre-wrap font-prose text-sm leading-relaxed text-foreground/90">
										{p.text}
									</pre>
								</article>
							))
						)}
					</div>
				</div>
			)}
		</aside>
	);
}
