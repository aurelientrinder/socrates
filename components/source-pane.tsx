"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BookOpenIcon, FileTextIcon, QuoteIcon, SearchIcon, XIcon } from "lucide-react";
import { filterSourcePages, formatSourceQuote, notesPages, type NoteMeta } from "@/src/core";
import { cn } from "@/lib/utils";

const SPLIT_MIN = 320;
const SPLIT_MAX = 680;
const SPLIT_SHARE = 0.44;

function prefersReducedMotion(): boolean {
	return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/**
 * The split's right column: owns open/close motion so the pane can play its
 * exit before unmounting. The column's width eases between 0 and the pane's
 * width (44% of the session area, 320-680px), so the chat reflows smoothly
 * beside it, while the pane itself keeps a fixed width and slides with the
 * edge like a drawer. Reduced motion: it simply appears and disappears.
 */
export function SourceSplit({
	open,
	...pane
}: {
	open: boolean;
	initialNoteId?: string | null;
	onQuote: (quotedMarkdown: string) => void;
	onClose: () => void;
}) {
	const [mounted, setMounted] = useState(open);
	const [shown, setShown] = useState(false);
	const [width, setWidth] = useState(0);
	const columnRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (open) {
			setMounted(true);
			// Two frames: the column must first paint at width 0 for the
			// transition to have a starting point.
			let second = 0;
			const first = requestAnimationFrame(() => {
				second = requestAnimationFrame(() => setShown(true));
			});
			return () => {
				cancelAnimationFrame(first);
				cancelAnimationFrame(second);
			};
		}
		setShown(false);
		if (prefersReducedMotion()) {
			setMounted(false);
			return undefined;
		}
		// transitionend is the normal exit; the timer covers a transition
		// that never runs (hidden window, width never measured).
		const fallback = window.setTimeout(() => setMounted(false), 320);
		return () => window.clearTimeout(fallback);
	}, [open]);

	useLayoutEffect(() => {
		if (!mounted) return;
		const area = columnRef.current?.parentElement;
		if (!area) return;
		const measure = () =>
			setWidth(Math.round(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, area.clientWidth * SPLIT_SHARE))));
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(area);
		return () => observer.disconnect();
	}, [mounted]);

	if (!mounted) return null;
	return (
		<div
			ref={columnRef}
			data-testid="source-split"
			data-state={shown ? "open" : "closed"}
			style={{ width: shown ? width : 0 }}
			onTransitionEnd={(e) => {
				if (e.target === e.currentTarget && e.propertyName === "width" && !open) setMounted(false);
			}}
			className={cn(
				"relative h-full shrink-0 overflow-hidden transition-[width,opacity] duration-200 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none",
				shown ? "opacity-100" : "opacity-0",
			)}
		>
			<div className="absolute inset-y-0 left-0" style={{ width }}>
				<SourcePane {...pane} />
			</div>
		</div>
	);
}

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
	const [pdfUrl, setPdfUrl] = useState<string | null>(null);
	const [pdfError, setPdfError] = useState(false);

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

	// The original PDF is fetched by THIS (trusted, main) frame and shown as a
	// blob: URL. Pointing the iframe at /api/notes/:id/file directly fails in
	// the desktop app: the capability header is only attached to main-frame
	// requests (electron/desktop-api.cjs), so a subframe navigation gets the
	// 403 "requires the trusted window" JSON. The blob is same-origin, holds
	// only the PDF bytes, and needs no API access from the subframe.
	const pdfNoteId = activeNote?.kind === "pdf" && view === "pdf" ? activeNote.id : null;
	useEffect(() => {
		if (!pdfNoteId) return;
		let cancelled = false;
		let objectUrl: string | null = null;
		setPdfUrl(null);
		setPdfError(false);
		fetch(`/api/notes/${encodeURIComponent(pdfNoteId)}/file`, { cache: "no-store" })
			.then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
			.then((blob) => {
				if (cancelled) return;
				objectUrl = URL.createObjectURL(new Blob([blob], { type: "application/pdf" }));
				setPdfUrl(objectUrl);
			})
			.catch(() => {
				if (!cancelled) setPdfError(true);
			});
		return () => {
			cancelled = true;
			if (objectUrl) URL.revokeObjectURL(objectUrl);
		};
	}, [pdfNoteId]);

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
			className="flex h-full w-full flex-col border-l border-border bg-surface"
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
					{pdfUrl ? (
						<iframe title={activeNote.name} src={pdfUrl} className="min-h-0 w-full flex-1 bg-background" />
					) : (
						<div className="flex flex-1 items-center justify-center p-6 text-center text-xs text-muted-foreground">
							{pdfError ? "Couldn’t open the original PDF. The Text view still works." : "Opening PDF…"}
						</div>
					)}
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
