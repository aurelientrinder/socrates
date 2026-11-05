"use client";

/**
 * A numbered note citation inside a tutor reply (2026-11-04): a small [1]
 * that opens the passage it points at, read from the saved note itself, so
 * the learner can check the tutor's claim against their own notes.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { passageFor, type Citation, type Passage } from "@/src/core";

interface Loaded {
	name: string;
	passage: Passage | null;
}

type State = { status: "loading" } | { status: "missing" } | ({ status: "ok" } & Loaded);

const cache = new Map<string, Promise<{ name: string; text: string } | null>>();

function loadNote(id: string): Promise<{ name: string; text: string } | null> {
	let hit = cache.get(id);
	if (!hit) {
		hit = fetch(`/api/notes/${id}`)
			.then(async (res) => {
				if (!res.ok) return null;
				const body = (await res.json()) as { note: { name: string }; text: string };
				return { name: body.note.name, text: body.text };
			})
			.catch(() => null);
		cache.set(id, hit);
		// A failed lookup must not stick (the note may be imported later).
		void hit.then((v) => {
			if (v === null) cache.delete(id);
		});
	}
	return hit;
}

export function CitationChip({ n, citation }: { n: number; citation: Citation }) {
	const [open, setOpen] = useState(false);
	const [state, setState] = useState<State>({ status: "loading" });
	const button = useRef<HTMLButtonElement>(null);
	const card = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

	useEffect(() => {
		if (!open) return;
		let live = true;
		void loadNote(citation.noteId).then((note) => {
			if (!live) return;
			if (!note) return setState({ status: "missing" });
			setState({ status: "ok", name: note.name, passage: passageFor(note.text, citation.anchor) });
		});
		return () => {
			live = false;
		};
	}, [open, citation.noteId, citation.anchor]);

	useLayoutEffect(() => {
		if (!open || !button.current) return;
		const place = () => {
			const r = button.current!.getBoundingClientRect();
			const width = Math.min(420, window.innerWidth - 24);
			setPos({ top: r.bottom + 6, left: Math.max(12, Math.min(r.left - 12, window.innerWidth - width - 12)) });
		};
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			const t = e.target as Node;
			if (!card.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setOpen(false);
				button.current?.focus();
			}
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const openFile = async () => {
		if (window.lh?.openNote) await window.lh.openNote(citation.noteId);
		else window.open(`/api/notes/${citation.noteId}/file`, "_blank", "noopener");
	};

	const missing = state.status === "missing" || (state.status === "ok" && state.passage === null);

	return (
		<>
			<button
				ref={button}
				type="button"
				data-testid="citation-chip"
				aria-expanded={open}
				aria-label={`Source ${n}`}
				onClick={() => setOpen((o) => !o)}
				className={cn(
					"ml-0.5 mr-px inline-flex h-[1.15em] min-w-[1.5em] -translate-y-px cursor-pointer items-center justify-center rounded-md px-1 align-baseline font-ui text-[0.72em] leading-none transition-colors",
					open ? "bg-foreground text-background" : "bg-accent text-muted-foreground hover:bg-foreground/15 hover:text-foreground",
				)}
			>
				{n}
			</button>
			{open && pos
				? createPortal(
						<div
							ref={card}
							role="dialog"
							aria-label={`Source ${n}`}
							data-testid="citation-card"
							style={{ top: pos.top, left: pos.left, width: Math.min(420, window.innerWidth - 24) }}
							className="fixed z-50 rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-lg"
						>
							{state.status === "loading" ? (
								<p className="font-ui text-sm text-muted-foreground">Loading…</p>
							) : missing ? (
								<p className="font-ui text-sm text-muted-foreground">
									{state.status === "ok"
										? `${state.name} has no ${citation.anchor.startsWith("p") ? "page" : "line"} ${citation.anchor.slice(1)}, so this citation can't be checked. Treat the claim with care.`
										: "This note isn't in your saved notes any more, so the citation can't be checked."}
								</p>
							) : state.status === "ok" ? (
								<>
									<p className="font-ui text-xs text-muted-foreground">
										<span className="text-foreground">{state.name}</span>
										{state.passage!.where ? ` · ${state.passage!.where}` : ""}
									</p>
									<blockquote className="mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap border-l-2 border-border pl-3 text-[14px] leading-relaxed">
										{state.passage!.text}
									</blockquote>
									<button type="button" onClick={() => void openFile()} className="mt-2.5 font-ui text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
										Open the file
									</button>
								</>
							) : null}
						</div>,
						document.body,
					)
				: null}
		</>
	);
}
