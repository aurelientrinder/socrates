"use client";

/**
 * "Write on reMarkable" (2026-11-08): the learner answers on their tablet
 * while the reMarkable desktop app shows it (Screen Share). They pick that
 * window once; this panel shows a live preview of it, and "Use this page"
 * takes a full snapshot and hands it to the question as an image: the tutor
 * reads the page itself (diagrams, maths and all, no transcription), and it
 * becomes part of "Your thinking" for that question.
 *
 * Desktop app only: it rides the preload bridge's window capture. Pictures
 * of ONE window the learner chose; nothing is recorded or stored here.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PenLineIcon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { pickCaptureWindow, sortCaptureWindows, type AnswerSketch } from "@/src/core";

type Win = { id: string; name: string; thumbnail: string };

const PREVIEW_MS = 2000;
const REMEMBER_KEY = "socrates.capture-window";
/** Longest edge of the page sent to the tutor, and of the transcript thumbnail. */
const PAGE_EDGE = 1400;
const THUMB_EDGE = 360;

function remembered(): string | null {
	try {
		return window.localStorage.getItem(REMEMBER_KEY);
	} catch {
		return null;
	}
}

export function canCaptureRemarkable(): boolean {
	return typeof window !== "undefined" && !!window.lh?.listCaptureWindows && !!window.lh?.captureWindow;
}

/** Scale an image data URL down to a JPEG's base64 (no data: prefix). */
async function toJpegBase64(dataUrl: string, edge: number, quality: number): Promise<string> {
	const img = new Image();
	img.src = dataUrl;
	await img.decode();
	const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight));
	const canvas = document.createElement("canvas");
	canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
	canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Couldn't prepare the page.");
	// JPEG has no alpha: paint paper first.
	ctx.fillStyle = "#ffffff";
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
	return canvas.toDataURL("image/jpeg", quality).replace(/^data:image\/jpeg;base64,/, "");
}

export function RemarkableCapture({ onSketch, disabled }: { onSketch: (sketch: AnswerSketch) => void; disabled?: boolean }) {
	const [supported, setSupported] = useState(false);
	const [open, setOpen] = useState(false);
	const [windows, setWindows] = useState<Win[] | null>(null);
	const [chosen, setChosen] = useState<Win | null>(null);
	const [preview, setPreview] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [capturing, setCapturing] = useState(false);
	const busy = useRef(false);

	useEffect(() => setSupported(canCaptureRemarkable()), []);

	const load = useCallback(async () => {
		setError(null);
		const r = await window.lh?.listCaptureWindows?.();
		if (!r?.ok || !r.windows) {
			setError(r?.error ?? "Couldn't list windows.");
			setWindows([]);
			return;
		}
		setWindows(sortCaptureWindows(r.windows));
		setChosen(pickCaptureWindow(r.windows, remembered()));
	}, []);

	useEffect(() => {
		if (open) void load();
		else {
			setWindows(null);
			setChosen(null);
			setPreview(null);
			setError(null);
		}
	}, [open, load]);

	// The live preview: one small picture every couple of seconds while a
	// window is chosen. Skips a tick while the last one is still in flight.
	useEffect(() => {
		if (!open || !chosen || capturing) return;
		let stop = false;
		const tick = async () => {
			if (busy.current) return;
			busy.current = true;
			try {
				const r = await window.lh?.captureWindow?.(chosen.id);
				if (stop) return;
				if (r?.ok && r.dataUrl) {
					setPreview(r.dataUrl);
					setError(null);
				} else setError(r?.error ?? "Can't see that window.");
			} finally {
				busy.current = false;
			}
		};
		void tick();
		const timer = setInterval(() => void tick(), PREVIEW_MS);
		return () => {
			stop = true;
			clearInterval(timer);
		};
	}, [open, chosen, capturing]);

	const choose = (w: Win) => {
		setChosen(w);
		setPreview(null);
		try {
			window.localStorage.setItem(REMEMBER_KEY, w.name);
		} catch {
			/* remembering is a convenience */
		}
	};

	const usePage = async () => {
		if (!chosen || capturing) return;
		setCapturing(true);
		setError(null);
		try {
			const shot = await window.lh?.captureWindow?.(chosen.id, true);
			if (!shot?.ok || !shot.dataUrl) throw new Error(shot?.error ?? "Couldn't capture the page.");
			const data = await toJpegBase64(shot.dataUrl, PAGE_EDGE, 0.75);
			const thumb = await toJpegBase64(shot.dataUrl, THUMB_EDGE, 0.6);
			onSketch({ mimeType: "image/jpeg", data, thumb });
			setOpen(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Couldn't capture the page.");
		} finally {
			setCapturing(false);
		}
	};

	// Esc closes the panel and stops there (it must not also abort a turn).
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			setOpen(false);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [open]);

	if (!supported) return null;

	return (
		<>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				disabled={disabled}
				onClick={() => setOpen((v) => !v)}
				data-testid="remarkable-capture-open"
				title="Write your answer on your reMarkable"
				className="h-9 shrink-0 gap-1.5 rounded-xl px-2.5 text-xs text-muted-foreground"
			>
				<PenLineIcon className="size-4" />
				reMarkable
			</Button>
			{open &&
				// A portal: the dock's shell clips its overflow, a modal must not be clipped.
				createPortal(
					<div
						className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/30 p-4"
						onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}
					>
						<div
							role="dialog"
							aria-label="Write on reMarkable"
							data-testid="remarkable-capture"
							className="max-h-[85vh] w-full max-w-xl overflow-auto rounded-2xl border border-border bg-card p-4 shadow-xl"
						>
							<div className="mb-2 flex items-center gap-2">
								<div className="min-w-0 flex-1 text-sm font-medium">Write on your reMarkable</div>
								<Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Close" onClick={() => setOpen(false)}>
									<XIcon className="size-4" />
								</Button>
							</div>
							{!chosen ? (
								<div>
									<p className="mb-2 text-sm text-muted-foreground">
										Start Screen Share on your tablet, then pick the reMarkable app's window. Socrates will remember it.
									</p>
									{windows === null ? (
										<p className="text-sm text-muted-foreground">Looking for windows…</p>
									) : windows.length === 0 ? (
										<p className="text-sm text-muted-foreground">No windows found.</p>
									) : (
										<div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
											{windows.map((w) => (
												<button
													key={w.id}
													type="button"
													onClick={() => choose(w)}
													className="overflow-hidden rounded-xl border border-border text-left transition-colors hover:border-foreground/40"
												>
													{/* eslint-disable-next-line @next/next/no-img-element */}
													<img src={w.thumbnail} alt="" className="aspect-[4/3] w-full bg-muted object-cover object-top" />
													<div className="truncate px-2 py-1.5 text-xs">{w.name}</div>
												</button>
											))}
										</div>
									)}
									<div className="mt-2">
										<Button type="button" variant="ghost" size="sm" onClick={() => void load()}>
											Refresh
										</Button>
									</div>
								</div>
							) : (
								<div>
									<div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
										<span className="min-w-0 flex-1 truncate">Watching: {chosen.name}</span>
										<button type="button" className="underline-offset-2 hover:underline" onClick={() => setChosen(null)}>
											Change window
										</button>
									</div>
									<div className="flex min-h-40 items-center justify-center overflow-hidden rounded-xl border border-border bg-muted">
										{preview ? (
											// eslint-disable-next-line @next/next/no-img-element
											<img src={preview} alt="Live view of your reMarkable" className="max-h-[40vh] w-auto max-w-full" />
										) : (
											<span className="text-sm text-muted-foreground">Waiting for the first picture…</span>
										)}
									</div>
									<div className="mt-3 flex items-center gap-2">
										<span className="min-w-0 flex-1 text-xs text-muted-foreground">
											Write your reasoning, then press the button. The tutor sees your page as a picture, as part of “Your thinking”.
										</span>
										<Button
											type="button"
											disabled={capturing || !preview}
											onClick={() => void usePage()}
											data-testid="remarkable-use-page"
											className="h-9 rounded-xl px-4 text-sm font-medium"
										>
											{capturing ? "Capturing…" : "Use this page"}
										</Button>
									</div>
								</div>
							)}
							{error && (
								<p role="alert" className="mt-2 text-sm text-destructive">
									{error}
								</p>
							)}
						</div>
					</div>,
					document.body,
				)}
		</>
	);
}
