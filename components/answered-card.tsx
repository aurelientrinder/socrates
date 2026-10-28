"use client";

import { useState } from "react";
import { LightbulbIcon } from "lucide-react";
import { ConfidenceRail } from "@/components/confidence-rail";
import { GlyphMark } from "@/components/ui/glyph-mark";
import { ThinkingBlock } from "@/components/thinking-block";
import { cn } from "@/lib/utils";
import { MessageResponse } from "@/components/ai-elements/message";
import type { QuestionAnswerData } from "@/src/core";
import { parseAskInput, parseQuizInput, repairMathForDisplay } from "@/src/core";

/**
 * Static rendering of an answered question (tool part in `output-available`).
 *
 * Quiz answers are GRADED: ✓/✗ marks, the correct answers, and the
 * explanation. Ask answers are NOT graded — a plain record of what was said.
 * (The v1 bug this pins: ask answers must never get quiz grading UI.)
 * Explain answers are graded by the MODEL in its next reply, not by the
 * client — the card reveals his answer, the committed correct answer, and
 * the explanation, with NO verdict chips (owner ruling 2026-09-27).
 */
export function AnsweredCard({ answer, input }: { answer: QuestionAnswerData; input?: unknown }) {
	const [whyOpen, setWhyOpen] = useState(true); // open by default (owner, 2026-10-27)
	if (answer.dismissed) {
		return (
			<div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
				<span className="font-medium">{answer.questionText}</span> — skipped
			</div>
		);
	}

	const isQuiz = answer.kind === "quiz";
	const isExplain = answer.kind === "explain";
	// Free-recall review: the marking card that follows shows the key
	// points with his marks; this card reveals them only when he could not
	// recall the topic at all (no marking follows "I don't remember").
	const freeRecall = answer.tool === "review_recall";
	const selectedIdx = new Set(answer.answers.map((a) => a.index));
	const correctIdx = new Set(answer.correctIndices ?? []);
	// The question's own context rides the ORIGINAL CALL, not the answer
	// snapshot (owner, 2026-10-12): the details line — and, for ask
	// questions, option descriptions — re-render from the persisted
	// arguments, so every existing transcript shows them too. The lean
	// snapshot (what the model sees, compactAnswerForModel) is untouched;
	// any parse failure or absent input renders exactly the older card.
	const askInput = answer.kind === "ask" ? parseAskInput(input) : undefined;
	const parsedDetails = askInput?.details ?? (answer.kind === "quiz" ? parseQuizInput(input)?.details : undefined);
	const descByIndex = new Map((askInput?.options ?? []).map((o, i) => [i + 1, o.description]));

	return (
		<>
		{/* The reading channel LIFTED (owner round, 2026-10-05): thoughts
		    captured while reading are chronologically PRIOR to the question —
		    rendered as its own user-side block ABOVE the card, the unified
		    ThinkingBlock, instead of an inset inside the answer. Same muted
		    rail as before; the label is now plain "Your thinking". */}
		{answer.readingThinking && (
			<ThinkingBlock testId="reading-thinking-block" label="Your thinking" text={answer.readingThinking} defaultOpen />
		)}
		{/* [&>*:last-child]:mb-0 (owner round, 2026-10-07): on ask cards the
		    thinking row is the last child — its my-3 stacked with the card's
		    p-4 into a 28px void below (12px above); the card's own padding is
		    the bottom rhythm when a row ends the card. */}
		<div
			className="rounded-xl border bg-card p-4 text-card-foreground [&>*:last-child]:mb-0"
			data-testid="answered-card"
		>
			<div className="mb-1 flex items-center gap-2 text-xs font-medium text-muted-foreground">
				{/* The tool's OWN name first (owner 2026-10-09): probe-phase
			    cards label Probe/Recall — the phase boundary visible in the
			    transcript. No `tool` on old records: kind labels as before. */}
				{answer.tool === "probe"
					? "Probe"
					: answer.tool === "review"
						? "Review"
					: freeRecall
						? "Review · explain from memory"
					: answer.tool === "recall"
						? "Recall"
						: isQuiz
								? answer.questionType === "predict"
									? "Prediction"
									: "Check"
									: isExplain
										? "Explain"
											: "Question"}
				{isQuiz &&
					(answer.dontKnow ? (
						<span className="rounded bg-muted px-1.5 py-0.5">didn't know</span>
					) : answer.correct ? (
						<span className="rounded bg-good-soft px-1.5 py-0.5 text-good">correct</span>
					) : (
						<span className="rounded bg-red-500/15 px-1.5 py-0.5 text-red-500">incorrect</span>
					))}
			</div>
			<div className="mb-3 font-medium">
				<MessageResponse>{repairMathForDisplay(answer.questionText)}</MessageResponse>
			</div>
			{parsedDetails && (
				// The details line, same paint as the pending dock (owner,
				// 2026-10-12): full markdown, LaTeX included.
				<div className="mb-3 text-sm text-muted-foreground">
					<MessageResponse>{parsedDetails}</MessageResponse>
				</div>
			)}

			{((answer.options?.length ?? 0) > 0 || answer.other) && (
				<div className="flex flex-col gap-1.5 text-sm">
					{answer.options?.map((opt) => {
						const sel = selectedIdx.has(opt.index);
						const key = isQuiz && correctIdx.has(opt.index);
						return (
							<div
								key={opt.index}
								className={cn(
									"flex items-center gap-2 rounded-lg border px-3 py-1.5",
									sel && key && "border-good/50 bg-good-soft",
									sel && !key && isQuiz && "border-red-500/60 bg-red-500/10",
									sel && !isQuiz && "border-primary bg-accent",
									!sel && key && "border-good/50",
								)}
							>
								{isQuiz && (
									// Zapf-Dingbats-derived SVG outlines — the exact LaTeX \ding{51}/
									// \ding{55} hand-drawn shapes (owner, round 6); see ui/glyph-mark.
									<span
										aria-hidden
										data-mark={sel && key ? "check" : sel && !key ? "x" : !sel && key ? "check" : undefined}
										className={cn(
											"flex shrink-0 items-center",
											sel && key && "text-good",
											sel && !key && "text-red-500",
											!sel && key && "text-good",
										)}
									>
										{/* Owner round 8: a touch smaller than the text (size-4→size-3.5,
											   ≈14px vs the 16px row) while centered. */}
										{(key || sel) && <GlyphMark kind={key ? "check" : "x"} className="size-3.5" />}
									</span>
								)}
								<span className={cn(!sel && "text-muted-foreground")}>
									<MessageResponse>{repairMathForDisplay(opt.label)}</MessageResponse>
									{descByIndex.get(opt.index) && (
										// Ask-option subtext (owner, 2026-10-12): same markdown path
										// as the pending dock — LaTeX included. Quiz options carry
										// none (owner ruling 2026-09-26); the map stays empty for them.
										<MessageResponse className="lh-prose block text-xs text-muted-foreground">
											{descByIndex.get(opt.index)}
										</MessageResponse>
									)}
								</span>
							</div>
						);
					})}
					{/* The learner's own typed option is an OPTION — same container,
					    same selected styling as its siblings, not a loose quote
					    floating outside the list. Quotes keep the learner's words. */}
					{answer.other && (
						<div
							data-testid="answered-other"
							className="flex items-center gap-2 rounded-lg border border-primary bg-accent px-3 py-1.5"
						>
							<span>“{answer.other}”</span>
						</div>
					)}
				</div>
			)}

			{answer.text && <div className="lh-prose mt-2 whitespace-pre-wrap">“{answer.text}”</div>}

			{/* The confidence record (owner round 6): the slider's rail, disc
			    removed — the missing handle itself says "this is a record, not a
			    control". Same paint, same ticks, same ramp, same % read-out as the
			    live dock. Quiz answers only, and only when a confidence exists:
			    "I don't know" sent none (its slider was grayed out), explain and
			    ask never had one, and records from before the feature carry no
			    field — nothing to show, nothing rendered. */}
			{(isQuiz || freeRecall) && answer.confidence != null && (
				<div className="mt-3 flex items-center gap-3" data-testid="answered-confidence">
					<ConfidenceRail value={answer.confidence} className="min-w-0 flex-1" />
					<span className="w-9 shrink-0 text-right font-mono text-sm tabular-nums text-muted-foreground">
						{answer.confidence}%
					</span>
				</div>
			)}
			{answer.dontKnow && isQuiz && (
				<div className="mt-2 text-sm text-muted-foreground">Answered “I don't know”.</div>
			)}
			{answer.dontKnow && freeRecall && (
				<div className="mt-2 text-sm text-muted-foreground">Answered “I don't remember”.</div>
			)}

			{(answer.thinking ?? answer.note) && (
				/* The SAME unified row (owner round, 2026-10-05): the quiz answer's
				    thinking is the identical collapsible ThinkingBlock — one
				    geometry, but NO band on the card (owner round five, 2026-10-07:
				    the accent lift read too light); rail only, heights identical. */
				<ThinkingBlock
					testId="your-thinking"
					label="Your thinking"
					text={answer.thinking ?? answer.note ?? ""}
					inCard
				/>
			)}

			{/* The explain reveal (owner ruling 2026-09-27): the committed answer
			    — one field, reasoning included — shown on submit; no verdict,
			    the model's next reply IS the grading. */}
			{isExplain && answer.committed && freeRecall && answer.dontKnow && (
				<div className="mt-3 rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground" data-testid="recall-key-points">
					<div className="mb-1 font-medium text-foreground">A full answer covers</div>
					<MessageResponse>{repairMathForDisplay(answer.committed)}</MessageResponse>
				</div>
			)}
			{isExplain && answer.committed && !freeRecall && (
				<div className="mt-3 rounded-lg bg-muted py-2 text-sm text-muted-foreground">
					<span className="font-medium text-foreground">The answer: </span>
					<MessageResponse className="inline [&_p]:inline [&_p]:m-0">{repairMathForDisplay(answer.committed)}</MessageResponse>
				</div>
			)}
		</div>
		{isQuiz && answer.explanation && (
			/* The explanation as its OWN card (owner, 2026-10-27 — reverses the
			   2026-10-07 tuck): a large neutral block under the question card,
			   open by default. Same white card paint as the question, no tint;
			   full-block markdown (paragraphs, display math) at full ink — the
			   old 50% fade was hard to read. "Hide" folds it to its header. */
			<div
				data-testid="tucked-explanation"
				data-open={whyOpen ? "true" : "false"}
				className="mt-3 rounded-xl border bg-card px-5 py-4 text-card-foreground"
			>
				<div className="flex items-center justify-between gap-3">
					<span className="flex items-center gap-2 text-sm font-medium">
						<LightbulbIcon aria-hidden className="size-4 text-muted-foreground" />
						Why
					</span>
					<button
						type="button"
						aria-expanded={whyOpen}
						onClick={() => setWhyOpen((v) => !v)}
						className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
					>
						{whyOpen ? "Hide" : "Show"}
					</button>
				</div>
				{whyOpen && (
					<MessageResponse className="mt-2.5 leading-relaxed">
						{repairMathForDisplay(answer.explanation)}
					</MessageResponse>
				)}
			</div>
		)}
		</>
	);
}
