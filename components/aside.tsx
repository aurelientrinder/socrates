"use client";

/**
 * ASIDES (2026-11-04): ask the tutor something while a quiz question is
 * still waiting. AsideBar is the slim input above the question card;
 * AsideThread is the side conversation, rendered in the feed right where
 * the question sits. The question never closes: answering it later is
 * the same one click as before.
 */
import { ArrowUpIcon } from "lucide-react";
import { useState } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { BrailleSpinner } from "@/components/braille-spinner";
import type { ChatAside } from "@/src/core";

/** A question sent whose reply has not landed yet (or failed). */
export interface PendingAside {
	id: string;
	questionCallId: string;
	text: string;
	error?: string;
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
			className="pointer-events-auto mb-2 flex items-center gap-1.5 rounded-[14px] border bg-card py-1 pr-1.5 pl-3.5 shadow-[0_2px_10px_rgb(0_0_0/0.04)]"
			onSubmit={(e) => {
				e.preventDefault();
				send();
			}}
		>
			<input
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					// The dock's own Enter/Escape lanes must not see these keys.
					e.stopPropagation();
				}}
				placeholder="Ask the tutor something — the question stays open"
				aria-label="Ask the tutor a question about this"
				maxLength={4000}
				className="min-w-0 flex-1 bg-transparent py-1.5 font-ui text-[14px] outline-none placeholder:text-muted-foreground"
			/>
			<button
				type="submit"
				aria-label="Ask"
				disabled={!canSend}
				className="flex size-7 shrink-0 items-center justify-center rounded-[8px] bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-30"
			>
				<ArrowUpIcon className="size-3.5" strokeWidth={2.4} />
			</button>
		</form>
	);
}

function AsideQuestion({ text }: { text: string }) {
	return (
		<div
			data-testid="aside-question"
			className="my-2 ml-auto w-fit max-w-[80%] rounded-2xl bg-accent/80 px-4 py-2.5"
		>
			<span className="sr-only">You: </span>
			<div className="whitespace-pre-wrap font-ui text-[15px] leading-relaxed text-foreground">{text}</div>
		</div>
	);
}

/** The side conversation under one question: finished exchanges, then the
 *  one in flight (the learner's words and a thinking line, or its error). */
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
		<div data-testid="aside-thread" className="my-3 border-l-2 border-border pl-4">
			<div className="font-ui text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
				Side conversation · the question below is still open
			</div>
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
						<span className="flex items-center gap-2 font-ui text-xs font-medium text-muted-foreground">
							<BrailleSpinner label="Thinking" />
							<Shimmer duration={1}>Thinking…</Shimmer>
						</span>
					)}
				</div>
			)}
		</div>
	);
}
