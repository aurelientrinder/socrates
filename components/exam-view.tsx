"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckIcon, ClockIcon, Loader2Icon, MinusIcon, PlayIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { PageHead } from "@/components/page-header";
import { cn } from "@/lib/utils";
import {
	clockText,
	CONFIDENCE_STOPS,
	examCalibrationSummary,
	OPTION_LETTERS,
	repairMathForDisplay,
	secondsLeft,
	type ExamAnswer,
	type ExamPartView,
	type ExamProblemView,
	type ExamView,
	type PartGrade,
} from "@/src/core";

/**
 * THE EXAM PAGE (mock exams, src/core/exam.ts): one page for the whole
 * life of an exam. While it is being written, a progress card; then the
 * cover (rules, size, the clock starts on Start); then the paper itself,
 * every problem on one scrolling page with a sticky clock, no tutor and
 * no hints, answers autosaved; then grading; then the marked paper:
 * points per part, every rubric line with the words that earned it, and
 * the checked reference solution.
 */

const POLL_MS = 2500;
const SAVE_DEBOUNCE_MS = 1200;

type Answers = Record<string, ExamAnswer>;

export function ExamPaper({ initial }: { initial: ExamView }) {
	const router = useRouter();
	const [view, setView] = useState<ExamView>(initial);
	const [answers, setAnswers] = useState<Answers>(initial.answers);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saveState, setSaveState] = useState<"saved" | "saving" | "offline">("saved");
	// Server clock minus local clock, so the countdown follows the server's deadline.
	const skew = useRef(initial.serverNow - Date.now());
	const dirty = useRef(new Set<string>());
	const answersRef = useRef(answers);
	answersRef.current = answers;

	const accept = useCallback((next: ExamView) => {
		skew.current = next.serverNow - Date.now();
		setView(next);
		if (next.status !== "running") setAnswers(next.answers);
	}, []);

	// Poll while the server works (writing or grading).
	useEffect(() => {
		if (view.status !== "generating" && view.status !== "grading") return;
		const timer = setInterval(() => {
			void fetch(`/api/exams/${view.id}`, { cache: "no-store" })
				.then((r) => (r.ok ? (r.json() as Promise<ExamView>) : null))
				.then((next) => next && accept(next))
				.catch(() => {});
		}, POLL_MS);
		return () => clearInterval(timer);
	}, [view.status, view.id, accept]);

	const flush = useCallback(async (): Promise<boolean> => {
		if (dirty.current.size === 0) return true;
		const ids = [...dirty.current];
		dirty.current.clear();
		const patch = Object.fromEntries(ids.map((id) => [id, answersRef.current[id]]));
		setSaveState("saving");
		try {
			const res = await fetch(`/api/exams/${view.id}/answers`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ answers: patch }),
			});
			if (res.status === 409) {
				const next = await fetch(`/api/exams/${view.id}`, { cache: "no-store" }).then((r) => r.json() as Promise<ExamView>);
				accept(next);
				return false;
			}
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			setSaveState("saved");
			return true;
		} catch {
			for (const id of ids) dirty.current.add(id);
			setSaveState("offline");
			return false;
		}
	}, [view.id, accept]);

	// Debounced autosave while the paper is open.
	useEffect(() => {
		if (view.status !== "running" || dirty.current.size === 0) return;
		const timer = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
		return () => clearTimeout(timer);
	}, [answers, view.status, flush]);

	// Leaving mid-exam: the clock keeps running on the server, so warn.
	useEffect(() => {
		if (view.status !== "running") return;
		const onBeforeUnload = (e: BeforeUnloadEvent) => {
			e.preventDefault();
		};
		window.addEventListener("beforeunload", onBeforeUnload);
		return () => window.removeEventListener("beforeunload", onBeforeUnload);
	}, [view.status]);

	const post = async (path: string, body?: unknown) => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`/api/exams/${view.id}/${path}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body ?? {}),
			});
			const json = (await res.json().catch(() => ({}))) as ExamView & { error?: string };
			if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
			accept(json);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setBusy(false);
		}
	};

	const submit = async (timedOut: boolean) => {
		dirty.current.clear();
		await post("submit", { answers: answersRef.current, timedOut });
	};
	const now = useCallback(() => Date.now() + skew.current, []);

	const onAnswer = (partId: string, change: Partial<ExamAnswer>) => {
		setAnswers((prev) => ({ ...prev, [partId]: { text: "", ...prev[partId], ...change, updatedAt: new Date().toISOString() } }));
		dirty.current.add(partId);
	};

	const remove = async () => {
		if (!window.confirm("Delete this exam and its results?")) return;
		await fetch(`/api/exams/${view.id}`, { method: "DELETE" });
		router.push("/library");
	};

	const again = async () => {
		setBusy(true);
		try {
			const res = await fetch("/api/exams", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ scope: view.scope.text, noteIds: view.scope.noteIds, minutes: view.minutes }),
			});
			const json = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
			if (!res.ok || !json.id) throw new Error(json.error ?? `HTTP ${res.status}`);
			router.push(`/exam/${json.id}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setBusy(false);
		}
	};

	return (
		<ExamScreen
			view={view}
			answers={answers}
			busy={busy}
			error={error}
			saveState={saveState}
			now={now}
			onStart={() => void post("start")}
			onAnswer={onAnswer}
			onSubmit={(timedOut) => void submit(timedOut)}
			onRetry={() => void post("retry")}
			onDelete={() => void remove()}
			onAgain={() => void again()}
		/>
	);
}

/** The page's pure body: the render-test seam. */
export function ExamScreen(props: {
	view: ExamView;
	answers: Answers;
	busy: boolean;
	error: string | null;
	saveState: "saved" | "saving" | "offline";
	now: () => number;
	onStart: () => void;
	onAnswer: (partId: string, change: Partial<ExamAnswer>) => void;
	onSubmit: (timedOut: boolean) => void;
	onRetry: () => void;
	onDelete: () => void;
	onAgain: () => void;
}) {
	const { view } = props;
	return (
		<div data-testid="exam-page" data-status={view.status} className="h-full overflow-y-auto">
			<div className="mx-auto flex max-w-3xl flex-col gap-8 px-6 pb-20 pt-8 sm:px-10">
				{view.status === "running" ? (
					<RunningPaper {...props} />
				) : (
					<>
						<PageHead title={view.title} />
						{props.error && (
							<p role="alert" className="text-sm text-destructive">
								{props.error}
							</p>
						)}
						{view.status === "generating" && <Working title="Writing your exam" phase={view.phase} steps={GENERATION_STEPS} />}
						{view.status === "grading" && <Working title="Grading your paper" phase={view.phase} steps={null} />}
						{view.status === "failed" && <Failed {...props} />}
						{view.status === "ready" && <Cover {...props} />}
						{view.status === "graded" && <Results {...props} />}
					</>
				)}
			</div>
		</div>
	);
}

const GENERATION_STEPS = ["Writing the problems and their solutions", "Solving it independently", "Checking every answer against the independent solution"];

function Working({ title, phase, steps }: { title: string; phase?: string; steps: string[] | null }) {
	const at = steps && phase ? steps.indexOf(phase) : -1;
	return (
		<section data-testid="exam-working" className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-6">
			<p className="flex items-center gap-2.5 text-lg font-semibold">
				<Loader2Icon className="size-5 animate-spin text-muted-foreground" />
				{title}
			</p>
			{steps ? (
				<ol className="flex flex-col gap-2">
					{steps.map((s, i) => (
						<li key={s} className={cn("flex items-center gap-2.5 text-base", i > at && "text-muted-foreground")}>
							{i < at ? <CheckIcon className="size-4 text-good" /> : i === at ? <Loader2Icon className="size-4 animate-spin" /> : <span className="size-4" />}
							{s}
						</li>
					))}
				</ol>
			) : (
				phase && <p className="text-base text-foreground/80">{phase}</p>
			)}
			<p className="text-sm text-muted-foreground">
				{steps
					? "This takes a minute or two: every reference solution is checked by a second, independent solve before you see the paper. You can leave this page; the exam waits for you in the Library, and the clock only starts when you open it."
					: "Each problem is marked with its whole scenario in view, against a checked reference solution. You can leave this page; the results wait for you in the Library."}
			</p>
		</section>
	);
}

function Failed({ view, busy, onRetry, onDelete }: Parameters<typeof ExamScreen>[0]) {
	return (
		<section data-testid="exam-failed" className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-6">
			<p className="text-lg font-semibold">{view.failedDuring === "grading" ? "Grading stopped" : "The exam could not be written"}</p>
			{view.error && <p className="text-base text-foreground/80">{view.error}</p>}
			<div className="flex flex-wrap gap-3">
				<button
					type="button"
					disabled={busy}
					onClick={onRetry}
					className="flex h-11 items-center gap-2 rounded-xl bg-primary px-5 text-base font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
				>
					<RotateCcwIcon className="size-4" />
					{view.failedDuring === "grading" ? "Finish grading" : "Try again"}
				</button>
				<button type="button" onClick={onDelete} className="h-11 rounded-xl px-4 text-base text-muted-foreground hover:bg-accent hover:text-foreground">
					Delete
				</button>
			</div>
		</section>
	);
}

function Cover({ view, busy, onStart, onDelete }: Parameters<typeof ExamScreen>[0]) {
	const checks = view.checks;
	return (
		<section data-testid="exam-cover" className="flex flex-col gap-6 rounded-2xl border border-border/70 bg-card p-7">
			<dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
				<Fact label="Time" value={`${view.minutes} min`} />
				<Fact label="Problems" value={String(view.problemCount)} />
				<Fact label="Questions" value={String(view.partCount)} />
				<Fact label="Points" value={String(view.totalPoints)} />
			</dl>
			{view.scope.text && (
				<p className="text-base text-foreground/80">
					<span className="font-semibold text-foreground">Covers: </span>
					{view.scope.text}
				</p>
			)}
			<ul className="flex list-disc flex-col gap-1.5 pl-5 text-base">
				<li>Exam conditions: no tutor, no hints, no notes. Answer from memory.</li>
				<li>The clock starts when you press Start and keeps running if you leave the page. When it reaches zero, your paper is handed in as it is.</li>
				<li>Show your working: marks are given for method as well as for the final answer.</li>
				<li>Under each question, say how sure you are. It is how Socrates measures whether you know what you think you know.</li>
			</ul>
			{checks && checks.parts > 0 && (
				<p className="text-sm text-muted-foreground" data-testid="exam-checks">
					Every reference solution was checked by an independent solve
					{checks.fixed + checks.dropped > 0
						? `: ${checks.fixed > 0 ? `${checks.fixed} corrected` : ""}${checks.fixed > 0 && checks.dropped > 0 ? ", " : ""}${checks.dropped > 0 ? `${checks.dropped} removed as unreliable` : ""} before you see it.`
						: ", and all of them held up."}
				</p>
			)}
			<div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-5">
				<button type="button" onClick={onDelete} className="text-sm text-muted-foreground underline-offset-2 hover:underline">
					Delete this exam
				</button>
				<button
					type="button"
					data-testid="exam-start"
					disabled={busy}
					onClick={onStart}
					className="flex h-12 items-center gap-2.5 rounded-xl bg-primary px-6 text-base font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
				>
					{busy ? <Loader2Icon className="size-4 animate-spin" /> : <PlayIcon className="size-4 fill-current" />}
					Start the exam
				</button>
			</div>
		</section>
	);
}

function Fact({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex flex-col gap-0.5">
			<dt className="text-sm text-muted-foreground">{label}</dt>
			<dd className="text-2xl font-semibold tabular-nums">{value}</dd>
		</div>
	);
}

// ─── the paper ──────────────────────────────────────────────────────────────

function useCountdown(deadlineAt: string | undefined, now: () => number): number {
	const [left, setLeft] = useState(() => secondsLeft(deadlineAt, now()));
	useEffect(() => {
		const tick = () => setLeft(secondsLeft(deadlineAt, now()));
		tick();
		const timer = setInterval(tick, 500);
		return () => clearInterval(timer);
	}, [deadlineAt, now]);
	return left;
}

function RunningPaper({ view, answers, busy, error, saveState, now, onAnswer, onSubmit }: Parameters<typeof ExamScreen>[0]) {
	const left = useCountdown(view.deadlineAt, now);
	const fired = useRef(false);
	useEffect(() => {
		if (left === 0 && !fired.current) {
			fired.current = true;
			onSubmit(true);
		}
	}, [left, onSubmit]);
	const parts = view.problems.flatMap((p) => p.parts);
	const blank = parts.filter((p) => isBlankView(p, answers[p.id])).length;
	const handIn = () => {
		const msg = blank > 0 ? `${blank} of ${parts.length} questions are still blank. Hand in anyway?` : "Hand in your paper? You cannot change it afterwards.";
		if (window.confirm(msg)) onSubmit(false);
	};
	return (
		<>
			<header className="lh-drag sticky top-0 z-10 -mx-6 flex flex-wrap items-center gap-3 border-b border-border/60 bg-background/95 px-6 py-3 backdrop-blur sm:-mx-10 sm:px-10">
				<p className="min-w-0 flex-1 truncate font-semibold">{view.title}</p>
				<span data-testid="exam-save" className="text-xs text-muted-foreground">
					{saveState === "saving" ? "Saving…" : saveState === "offline" ? "Not saved yet, retrying" : "Saved"}
				</span>
				<span
					data-testid="exam-clock"
					className={cn(
						"flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-mono text-base tabular-nums",
						left <= 60 ? "bg-destructive/10 text-destructive" : left <= 300 ? "bg-warn-soft text-warn-ink" : "bg-accent",
					)}
				>
					<ClockIcon className="size-4" />
					{clockText(left)}
				</span>
				<button
					type="button"
					data-testid="exam-submit"
					disabled={busy}
					onClick={handIn}
					className="h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
				>
					Hand in
				</button>
			</header>
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{view.problems.map((problem) => (
				<ProblemCard key={problem.id} problem={problem}>
					{problem.parts.map((part) => (
						<PartInput key={part.id} part={part} answer={answers[part.id]} onAnswer={(c) => onAnswer(part.id, c)} />
					))}
				</ProblemCard>
			))}
			<div className="flex justify-end">
				<button
					type="button"
					disabled={busy}
					onClick={handIn}
					className="flex h-12 items-center gap-2 rounded-xl bg-primary px-6 text-base font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
				>
					Hand in my paper
				</button>
			</div>
		</>
	);
}

function isBlankView(part: ExamPartView, answer: ExamAnswer | undefined): boolean {
	if (!answer) return true;
	if (part.kind === "choice") return answer.choice === undefined;
	return !answer.text.trim() && !answer.final?.trim();
}

function points(n: number): string {
	return `${n} ${n === 1 ? "point" : "points"}`;
}

function ProblemCard({ problem, children, score }: { problem: ExamProblemView; children: React.ReactNode; score?: React.ReactNode }) {
	const total = problem.parts.reduce((a, p) => a + p.points, 0);
	return (
		<section data-testid="exam-problem" className="flex flex-col gap-5 rounded-2xl border border-border/70 bg-card p-6">
			<header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<h2 className="lh-page-title flex-1 text-2xl">
					Problem {problem.id}. {problem.title}
				</h2>
				{score ?? <span className="text-sm text-muted-foreground">{points(total)}</span>}
			</header>
			<div className="font-prose text-[17px] leading-relaxed">
				<MessageResponse>{repairMathForDisplay(problem.scenario)}</MessageResponse>
			</div>
			<div className="flex flex-col gap-6">{children}</div>
		</section>
	);
}

function PartPrompt({ part }: { part: ExamPartView }) {
	return (
		<div className="flex items-start gap-3">
			<span className="pt-0.5 font-semibold">({part.id.replace(/^\d+/, "")})</span>
			<div className="min-w-0 flex-1 font-prose text-[17px]">
				<MessageResponse>{repairMathForDisplay(part.prompt)}</MessageResponse>
			</div>
			<span className="shrink-0 pt-1 text-xs text-muted-foreground tabular-nums">{points(part.points)}</span>
		</div>
	);
}

function PartInput({ part, answer, onAnswer }: { part: ExamPartView; answer: ExamAnswer | undefined; onAnswer: (c: Partial<ExamAnswer>) => void }) {
	const [preview, setPreview] = useState(false);
	const text = answer?.text ?? "";
	return (
		<div data-testid="exam-part" className="flex flex-col gap-3 border-t border-border/50 pt-5 first:border-t-0 first:pt-0">
			<PartPrompt part={part} />
			{part.kind === "choice" ? (
				<div role="radiogroup" aria-label={`Answer to ${part.id}`} className="flex flex-col gap-2">
					{part.options?.map((option, i) => (
						<button
							key={i}
							type="button"
							role="radio"
							aria-checked={answer?.choice === i}
							onClick={() => onAnswer({ choice: i })}
							className={cn(
								"flex items-start gap-3 rounded-xl border-[1.5px] px-3.5 py-2.5 text-left text-base transition-colors",
								answer?.choice === i ? "border-good bg-good-soft" : "border-border/70 bg-background hover:bg-accent/60",
							)}
						>
							<span className="font-semibold">{OPTION_LETTERS[i]}</span>
							<span className="min-w-0 flex-1">
								<MessageResponse>{repairMathForDisplay(option)}</MessageResponse>
							</span>
						</button>
					))}
				</div>
			) : (
				<>
					{preview ? (
						<div className="min-h-24 rounded-xl border bg-background px-3.5 py-3 font-prose text-base">
							{text.trim() ? <MessageResponse>{repairMathForDisplay(text)}</MessageResponse> : <span className="text-muted-foreground">Nothing written yet.</span>}
						</div>
					) : (
						<textarea
							aria-label={part.kind === "numeric" ? `Working for ${part.id}` : `Answer to ${part.id}`}
							value={text}
							rows={part.kind === "numeric" ? 4 : 6}
							onChange={(e) => onAnswer({ text: e.target.value })}
							placeholder={part.kind === "numeric" ? "Your working. Marks are given for method." : "Your answer. Show your reasoning."}
							className="lh-input min-h-24 resize-y rounded-xl border bg-background px-3.5 py-3 font-prose text-base outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
						/>
					)}
					<div className="flex flex-wrap items-center gap-3">
						{part.kind === "numeric" && (
							<label className="flex items-center gap-2 text-sm font-semibold">
								Final answer
								<input
									aria-label={`Final answer to ${part.id}`}
									value={answer?.final ?? ""}
									onChange={(e) => onAnswer({ final: e.target.value })}
									inputMode="decimal"
									className="lh-input h-9 w-40 rounded-lg border bg-background px-3 font-mono text-base font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
								/>
								{part.unit && <span className="font-normal text-muted-foreground">{part.unit}</span>}
							</label>
						)}
						<button type="button" onClick={() => setPreview((p) => !p)} className="text-xs text-muted-foreground underline-offset-2 hover:underline">
							{preview ? "Edit" : "Preview math"}
						</button>
					</div>
				</>
			)}
			<ConfidencePicker value={answer?.confidence} onChange={(confidence) => onAnswer({ confidence })} />
		</div>
	);
}

function ConfidencePicker({ value, onChange }: { value: number | undefined; onChange: (v: number) => void }) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<span className="text-sm text-muted-foreground">
				How sure are you this is right?
			</span>
			<div role="group" aria-label="How sure are you" className="flex gap-0.5 rounded-lg bg-accent/70 p-0.5">
				{CONFIDENCE_STOPS.map((stop) => (
					<button
						key={stop}
						type="button"
						aria-pressed={value === stop}
						onClick={() => onChange(stop)}
						className={cn(
							"h-7 rounded-md px-2.5 text-xs tabular-nums transition-colors",
							value === stop ? "bg-surface font-semibold text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{stop}%
					</button>
				))}
			</div>
		</div>
	);
}

// ─── the marked paper ───────────────────────────────────────────────────────

function Results({ view, busy, onDelete, onAgain }: Parameters<typeof ExamScreen>[0]) {
	const earned = useMemo(() => Object.values(view.grades).reduce((a, g) => a + g.earned, 0), [view.grades]);
	const pct = view.totalPoints > 0 ? Math.round((100 * earned) / view.totalPoints) : 0;
	const calibration = useMemo(() => examCalibrationSummary(view), [view]);
	const used =
		view.startedAt && view.submittedAt ? Math.max(0, Math.round((Date.parse(view.submittedAt) - Date.parse(view.startedAt)) / 1000)) : null;
	const topics = new Set(view.problems.flatMap((p) => p.parts.flatMap((x) => x.topicKeys ?? []))).size;
	return (
		<>
			<section data-testid="exam-results" className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-7">
				<p className="flex flex-wrap items-baseline gap-3">
					<span data-testid="exam-score" className="lh-page-title text-5xl tabular-nums">
						{fmt(earned)} / {view.totalPoints}
					</span>
					<span className="text-2xl text-muted-foreground tabular-nums">{pct}%</span>
				</p>
				<p className="text-base text-foreground/80">
					{view.timedOut ? "Time ran out, so the paper was handed in as it was." : used !== null ? `Handed in after ${clockText(used)} of ${view.minutes}:00.` : null}
				</p>
				{calibration && (
					<p data-testid="exam-calibration" className="text-base">
						You rated {calibration.rated} {calibration.rated === 1 ? "answer" : "answers"}: on average {calibration.meanConfidence}% sure, and{" "}
						{calibration.right} of {calibration.rated} scored at least 80%.
						{calibration.confidentMisses > 0 && (
							<span className="font-semibold text-warn-ink">
								{" "}
								{calibration.confidentMisses} {calibration.confidentMisses === 1 ? "was a confident miss" : "were confident misses"}: you felt sure and
								were not. Those are the gaps to work on first.
							</span>
						)}
					</p>
				)}
				{topics > 0 && (
					<p className="text-sm text-muted-foreground">
						The results updated the memory schedule of {topics} {topics === 1 ? "topic" : "topics"} and count on your{" "}
						<Link href="/progress?tab=calibration" className="underline underline-offset-2">
							calibration
						</Link>
						. Missed topics come back in your{" "}
						<Link href="/progress" className="underline underline-offset-2">
							reviews
						</Link>{" "}
						sooner.
					</p>
				)}
				<div className="flex flex-wrap gap-3 border-t border-border/60 pt-4">
					<button
						type="button"
						disabled={busy}
						onClick={onAgain}
						className="flex h-10 items-center gap-2 rounded-xl bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
					>
						{busy ? <Loader2Icon className="size-4 animate-spin" /> : <RotateCcwIcon className="size-4" />}
						New exam on the same material
					</button>
					<Link href="/library" className="flex h-10 items-center rounded-xl px-4 text-sm hover:bg-accent">
						Library
					</Link>
					<button type="button" onClick={onDelete} className="h-10 rounded-xl px-4 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
						Delete
					</button>
				</div>
			</section>
			{view.problems.map((problem) => {
				const got = problem.parts.reduce((a, p) => a + (view.grades[p.id]?.earned ?? 0), 0);
				const total = problem.parts.reduce((a, p) => a + p.points, 0);
				return (
					<ProblemCard key={problem.id} problem={problem} score={<ScoreBadge earned={got} points={total} />}>
						{problem.parts.map((part) => (
							<MarkedPart key={part.id} part={part} answer={view.answers[part.id]} grade={view.grades[part.id]} />
						))}
						{problem.sources.length > 0 && <p className="text-xs text-muted-foreground">From your notes: {problem.sources.join("; ")}</p>}
					</ProblemCard>
				);
			})}
		</>
	);
}

function fmt(n: number): string {
	return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function ScoreBadge({ earned, points: total }: { earned: number; points: number }) {
	const share = total > 0 ? earned / total : 0;
	return (
		<span
			className={cn(
				"rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums",
				share >= 0.8 ? "bg-good-soft text-good-ink" : share >= 0.5 ? "bg-warn-soft text-warn-ink" : "bg-destructive/10 text-destructive",
			)}
		>
			{fmt(earned)} / {total}
		</span>
	);
}

function MarkedPart({ part, answer, grade }: { part: ExamPartView; answer: ExamAnswer | undefined; grade: PartGrade | undefined }) {
	return (
		<div data-testid="exam-marked-part" className="flex flex-col gap-3 border-t border-border/50 pt-5 first:border-t-0 first:pt-0">
			<div className="flex items-start gap-3">
				<div className="min-w-0 flex-1">
					<PartPrompt part={part} />
				</div>
				{grade && <ScoreBadge earned={grade.earned} points={grade.points} />}
			</div>
			<div className="flex flex-col gap-1.5 rounded-xl bg-background px-4 py-3">
				<p className="text-xs font-semibold text-muted-foreground">
					Your answer{typeof answer?.confidence === "number" ? ` · you were ${answer.confidence}% sure` : ""}
				</p>
				{part.kind === "choice" ? (
					<p className="text-base">
						{answer?.choice !== undefined ? `${OPTION_LETTERS[answer.choice]}. ${part.options?.[answer.choice] ?? ""}` : <span className="text-muted-foreground">Blank</span>}
					</p>
				) : answer && (answer.text.trim() || answer.final?.trim()) ? (
					<div className="font-prose text-base">
						{answer.text.trim() && <MessageResponse>{repairMathForDisplay(answer.text)}</MessageResponse>}
						{answer.final?.trim() && (
							<p className="mt-1 font-mono text-sm">
								Final answer: {answer.final}
								{part.unit ? ` ${part.unit}` : ""}
							</p>
						)}
					</div>
				) : (
					<p className="text-base text-muted-foreground">Blank</p>
				)}
			</div>
			{grade && (
				<>
					{grade.feedback && <p className="text-base">{grade.feedback}</p>}
					{grade.method === "rubric" && part.rubric && (
						<ul className="flex flex-col gap-2" aria-label="Marking">
							{part.rubric.map((item) => {
								const c = grade.criteria.find((x) => x.id === item.id);
								const awarded = c?.awarded ?? 0;
								return (
									<li key={item.id} className="flex items-start gap-2.5 text-sm">
										<span
											className={cn(
												"mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full",
												awarded >= item.points ? "bg-good-soft text-good-ink" : awarded > 0 ? "bg-warn-soft text-warn-ink" : "bg-accent text-muted-foreground",
											)}
										>
											{awarded >= item.points ? <CheckIcon className="size-3.5" /> : awarded > 0 ? <MinusIcon className="size-3.5" /> : <XIcon className="size-3.5" />}
										</span>
										<div className="min-w-0 flex-1">
											<p>
												{item.criterion}
												{item.final && <span className="text-muted-foreground"> (checked against the exact value)</span>}
											</p>
											{c?.evidence && awarded > 0 && <p className="mt-0.5 border-l-2 border-border pl-2 text-muted-foreground">“{c.evidence}”</p>}
										</div>
										<span className="shrink-0 tabular-nums text-muted-foreground">
											{fmt(awarded)}/{item.points}
										</span>
									</li>
								);
							})}
						</ul>
					)}
					{grade.carriedForward && (
						<p className="text-sm text-muted-foreground">Your method was credited using your own earlier result (error carried forward).</p>
					)}
					{grade.withheld ? (
						<p className="text-sm text-muted-foreground">
							{fmt(grade.withheld)} {grade.withheld === 1 ? "point was" : "points were"} not given because the marker could not point to where your answer earns
							{grade.withheld === 1 ? " it" : " them"}.
						</p>
					) : null}
				</>
			)}
			{part.solution && (
				<details className="group rounded-xl border border-border/70 bg-surface px-4 py-3" open={!grade || grade.earned < grade.points}>
					<summary className="cursor-pointer text-sm font-semibold">Model solution</summary>
					<div className="mt-2 font-prose text-base">
						<MessageResponse>{repairMathForDisplay(part.solution)}</MessageResponse>
						{part.finalAnswer && (
							<div className="mt-2 font-semibold">
								<MessageResponse>
									{repairMathForDisplay(
										`Answer: ${part.kind === "choice" && part.correctOption !== undefined ? `${OPTION_LETTERS[part.correctOption]}. ` : ""}${part.finalAnswer}`,
									)}
								</MessageResponse>
							</div>
						)}
					</div>
				</details>
			)}
		</div>
	);
}
