"use client";

/**
 * ASIDES (2026-11-04), AS SIDE THREADS (2026-11-15): ask the tutor
 * something while a quiz question is still waiting. The question never
 * closes: answering it later is the same one click as before.
 *
 * - AsideBar: the slim "ask about this" input above the question card.
 * - SideThreadLink: the one-line link the main feed shows where the
 *   question sits (BEFORE its answered card: the learner asked first).
 * - SideThreadPanel: the right-hand split view holding one question's
 *   thread, opened by the link and automatically when the learner asks.
 * - AsideThread: the exchanges themselves, the panel's body.
 */
import { ArrowUpIcon, ChevronRightIcon, MessagesSquareIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { ThinkingIndicator } from "@/components/ai-elements/reasoning";
import { cn } from "@/lib/utils";
import type { ChatAside } from "@/src/core";

/** A question sent whose reply has not landed yet (or failed). */
export interface PendingAside {
	id: string;
	questionCallId: string;
	text: string;
	error?: string;
}

/** The question text a question call carries, whatever its tool. */
export function questionTextOf(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const i = input as Record<string, unknown>;
	for (const k of ["question", "prompt", "statement", "topic"]) if (typeof i[k] === "string" && i[k]) return i[k] as string;
	return "";
}

/** One-line plain preview of Markdown/LaTeX text. */
function plain(text: string): string {
	return text
		.replace(/\$\$?([^$]*)\$\$?/g, "$1")
		.replace(/\\(mathbb|mathrm|text|mathbf)\{([^}]*)\}/g, "$2")
		.replace(/[*_`#>]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function SendButton({ disabled, label = "Send" }: { disabled: boolean; label?: string }) {
	return (
		<button
			type="submit"
			aria-label={label}
			disabled={disabled}
			className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85 disabled:opacity-25"
		>
			<ArrowUpIcon className="size-4" strokeWidth={2.4} />
		</button>
	);
}

export function AsideBar({
	onAsk,
	disabled,
	busy,
}: {
	onAsk: (text: string) => void;
	disabled?: boolean;
	/** A reply is being written: sending more waits for it. */
	busy?: boolean;
}) {
	const [value, setValue] = useState("");
	const canSend = value.trim().length > 0 && !disabled && !busy;
	const send = () => {
		if (!canSend) return;
		onAsk(value.trim());
		setValue("");
	};
	return (
		<form
			data-testid="aside-bar"
			className="pointer-events-auto mb-2.5 flex items-center gap-2 rounded-full border border-border/80 bg-card py-1 pr-1 pl-4 shadow-[0_2px_12px_rgb(0_0_0/0.04)] transition-colors focus-within:border-foreground/25"
			onSubmit={(e) => {
				e.preventDefault();
				send();
			}}
		>
			<MessagesSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.7} />
			<input
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					// The dock's own Enter/Escape lanes must not see these keys.
					e.stopPropagation();
				}}
				placeholder="Ask a question in a side thread. The quiz stays open."
				aria-label="Ask the tutor a question about this"
				maxLength={4000}
				className="min-w-0 flex-1 bg-transparent py-1.5 font-ui text-[14.5px] outline-none placeholder:text-muted-foreground"
			/>
			<SendButton disabled={!canSend} label="Ask" />
		</form>
	);
}

/** The link the main conversation shows where a question sits. */
export function SideThreadLink({
	asides,
	pending,
	open,
	onOpen,
}: {
	asides: ChatAside[];
	pending?: PendingAside | null;
	open: boolean;
	onOpen: () => void;
}) {
	const count = asides.length + (pending ? 1 : 0);
	if (count === 0) return null;
	const first = asides[0]?.text ?? pending?.text ?? "";
	const working = pending && !pending.error;
	return (
		<button
			type="button"
			data-testid="side-thread-link"
			aria-expanded={open}
			onClick={onOpen}
			className={cn(
				"group/link my-1 flex w-fit max-w-full items-center gap-2.5 rounded-xl border px-3 py-2 text-left font-ui transition-colors",
				open ? "border-foreground/30 bg-ink-soft" : "border-border/80 bg-card hover:border-foreground/25 hover:bg-ink-soft",
			)}
		>
			<MessagesSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.7} />
			<span className="shrink-0 text-[13.5px] font-semibold text-foreground">
				Side thread
			</span>
			<span className="shrink-0 text-[13px] text-muted-foreground">
				· {count} {count === 1 ? "question" : "questions"}
				{working ? " · answering…" : ""}
			</span>
			<span className="min-w-0 truncate text-[13.5px] text-muted-foreground/90 italic">“{plain(first)}”</span>
			<ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-hover/link:translate-x-0.5" />
		</button>
	);
}

function AsideQuestion({ text }: { text: string }) {
	return (
		<div data-testid="aside-question" className="my-3 ml-auto w-fit max-w-[88%] rounded-2xl bg-accent/80 px-4 py-2.5">
			<span className="sr-only">You: </span>
			<div className="whitespace-pre-wrap font-ui text-[15px] leading-relaxed text-foreground">{text}</div>
		</div>
	);
}

/** The exchanges of one side thread: finished ones, then the one in flight
 *  (the learner's words and the thinking line, or its error). */
export function AsideThread({
	asides,
	pending,
	onRetry,
}: {
	asides: ChatAside[];
	pending?: PendingAside | null;
	onRetry?: () => void;
}) {
	if (asides.length === 0 && !pending) return null;
	return (
		<div data-testid="aside-thread" className="flex flex-col">
			{asides.map((a) => (
				<div key={a.id}>
					<AsideQuestion text={a.text} />
					<div data-testid="aside-reply" className="lh-source-passage">
						<MessageResponse>{a.reply}</MessageResponse>
					</div>
				</div>
			))}
			{pending && (
				<div>
					<AsideQuestion text={pending.text} />
					{pending.error ? (
						<div
							data-testid="aside-error"
							className="flex items-center gap-3 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm"
						>
							<span className="min-w-0 flex-1">{pending.error}</span>
							{onRetry && (
								<button type="button" onClick={onRetry} className="shrink-0 font-medium underline-offset-2 hover:underline">
									Try again
								</button>
							)}
						</div>
					) : (
						<ThinkingIndicator className="py-1" />
					)}
				</div>
			)}
		</div>
	);
}

/** The right-hand split view: one question's side thread. */
export function SideThreadPanel({
	question,
	open: questionOpen,
	asides,
	pending,
	onRetry,
	onAsk,
	onClose,
	disabled,
}: {
	/** The quiz question the thread hangs off (Markdown). */
	question: string;
	/** The question is still waiting for its answer: the thread takes
	 *  follow-ups. Answered → read-only. */
	open: boolean;
	asides: ChatAside[];
	pending?: PendingAside | null;
	onRetry?: () => void;
	onAsk: (text: string) => void;
	onClose: () => void;
	disabled?: boolean;
}) {
	const [value, setValue] = useState("");
	const busy = !!pending && !pending.error;
	const canSend = questionOpen && value.trim().length > 0 && !disabled && !busy;
	const scrollRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const count = asides.length + (pending ? 1 : 0);
	// Follow the newest exchange.
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	}, [count, pending?.error]);
	const send = () => {
		if (!canSend) return;
		onAsk(value.trim());
		setValue("");
	};
	return (
		<aside
			data-testid="side-thread-panel"
			aria-label="Side thread"
			className="lh-thread-in flex h-full w-[clamp(20rem,38%,32rem)] shrink-0 flex-col border-l border-border bg-background"
		>
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-4">
				<MessagesSquareIcon aria-hidden className="size-4 text-muted-foreground" strokeWidth={1.7} />
				<span className="font-ui text-[14px] font-semibold text-foreground">Side thread</span>
				<span
					className={cn(
						"rounded-full px-2 py-0.5 font-ui text-[11.5px] font-medium",
						questionOpen ? "bg-amber-500/12 text-amber-800 dark:text-amber-300" : "bg-ink-soft text-muted-foreground",
					)}
				>
					{questionOpen ? "Quiz still open" : "Quiz answered"}
				</span>
				<button
					type="button"
					aria-label="Close side thread"
					data-testid="side-thread-close"
					onClick={onClose}
					className="ml-auto flex size-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-ink-soft hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</div>
			<div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-6">
				<div className="rounded-xl border border-border/80 bg-card px-3.5 py-3">
					<div className="font-ui text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase">About this question</div>
					<div className="lh-source-passage mt-1 line-clamp-4 text-[14.5px] [&_p]:my-0">
						<MessageResponse>{question || "The quiz question"}</MessageResponse>
					</div>
					<div className="mt-1.5 font-ui text-[12px] text-muted-foreground">
						The tutor sees the whole session so far and this question, but won’t give away the answer.
					</div>
				</div>
				<AsideThread asides={asides} pending={pending} onRetry={onRetry} />
			</div>
			<div className="shrink-0 px-4 pb-4">
				{questionOpen ? (
					<form
						data-testid="side-thread-composer"
						className="rounded-[22px] border border-border/80 bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04),0_6px_22px_rgb(0_0_0/0.05)] transition-colors focus-within:border-foreground/25"
						onSubmit={(e) => {
							e.preventDefault();
							send();
						}}
					>
						<textarea
							ref={inputRef}
							value={value}
							onChange={(e) => setValue(e.target.value)}
							onKeyDown={(e) => {
								e.stopPropagation();
								if (e.key === "Enter" && !e.shiftKey) {
									e.preventDefault();
									send();
								}
							}}
							rows={1}
							maxLength={4000}
							placeholder="Ask a follow-up…"
							aria-label="Ask a follow-up in the side thread"
							className="field-sizing-content lh-input block max-h-40 min-h-11 w-full resize-none bg-transparent px-4 pt-3 pb-1 outline-none placeholder:text-muted-foreground"
						/>
						<div className="flex items-center justify-end px-2 pb-2">
							<SendButton disabled={!canSend} />
						</div>
					</form>
				) : (
					<div className="rounded-xl bg-ink-soft px-4 py-3 text-center font-ui text-[13px] text-muted-foreground">
						This quiz has been answered, so the thread is closed. The tutor got this thread along with your answer.
					</div>
				)}
			</div>
		</aside>
	);
}
