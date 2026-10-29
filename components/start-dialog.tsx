"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { BookOpenIcon, ClipboardCheckIcon, DumbbellIcon, Loader2Icon, PlayIcon, RotateCcwIcon, XIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { readWarmupPreference, startDraftSession, writeWarmupPreference } from "@/components/new-session";
import { REVIEW_START_PROMPT } from "@/components/review-start";
import { colorsFor, courseNotesLine, DEFAULT_EXAM_LENGTH, EXAM_LENGTHS, problemCountFor, REVIEW_SESSION_SIZE, WARMUP_SIZE } from "@/src/core";
import { DEFAULT_SESSION_LENGTH, QUICK_SESSION_MINUTES, SESSION_LENGTHS, setSessionBudget } from "@/components/session-timer";
import { cn } from "@/lib/utils";

/**
 * THE START DIALOG (redesign wave, 2026-10-26): one door for every kind of
 * session. Learn (a teaching session on a topic), Practice (problems, no
 * new teaching) or Review (the due topics, weakest first). Opened by the
 * sidebar's Start studying button, mod+N, and Today's "Learn something
 * new". Learn and Practice create the session exactly like the draft view
 * (startDraftSession: the topic becomes the title and turn 1); Review is
 * the Progress page's Start review (/api/review/start). Mock exam writes a
 * timed paper on a topic and/or saved notes (/api/exams) and opens it.
 */

export type StartMode = "learn" | "practice" | "review" | "exam";

/** What a caller can fill in ahead (a course's "Mock exam": its name and files). */
export interface StartPreset {
	topic?: string;
	notes?: NoteChip[];
}

/** A mock exam is written from at most this many files (src/server/exams.ts). */
const EXAM_MAX_NOTES = 5;

const StartDialogContext = createContext<{ open: (mode?: StartMode, minutes?: number, preset?: StartPreset) => void }>({ open: () => {} });

/** Open the Start dialog from anywhere under the app shell. */
export function useStartDialog() {
	return useContext(StartDialogContext);
}

/** The window event mod+N dispatches (keyboard-shortcuts.tsx) to open it. */
export const OPEN_START_EVENT = "lh:open-start";

export function StartDialogProvider({ children }: { children: React.ReactNode }) {
	const [mode, setMode] = useState<StartMode | null>(null);
	const [minutes, setMinutes] = useState<number>(DEFAULT_SESSION_LENGTH);
	const [preset, setPreset] = useState<StartPreset | undefined>(undefined);
	const open = useCallback((m: StartMode = "learn", length: number = DEFAULT_SESSION_LENGTH, p?: StartPreset) => {
		setMinutes(length);
		setPreset(p);
		setMode(m);
	}, []);
	useEffect(() => {
		const onOpen = () =>
			setMode((m) => {
				if (m === null) {
					setMinutes(DEFAULT_SESSION_LENGTH);
					setPreset(undefined);
				}
				return m ?? "learn";
			});
		window.addEventListener(OPEN_START_EVENT, onOpen);
		return () => window.removeEventListener(OPEN_START_EVENT, onOpen);
	}, []);
	return (
		<StartDialogContext.Provider value={{ open }}>
			{children}
			{mode !== null && <StartDialog initialMode={mode} initialMinutes={minutes} preset={preset} onClose={() => setMode(null)} />}
		</StartDialogContext.Provider>
	);
}

interface NoteChip {
	id: string;
	name: string;
}

/** The first message for a session started from a saved note. */
export function notePrompt(mode: "learn" | "practice", name: string): string {
	return mode === "practice" ? `Give me practice problems on my notes "${name}".` : `Teach me what is in my notes "${name}".`;
}

/** Turn 1 of a five-minute session (2026-10-27): the learner's words plus
 *  the scope, so the tutor keeps it tiny and stops on time. The words alone
 *  stay the session's title. */
export function quickSessionPrompt(mode: "learn" | "practice", text: string): string {
	const scope =
		mode === "practice"
			? "I only have 5 minutes: give me one or two short problems on this, check my answers, and stop there."
			: "I only have 5 minutes: teach me the single most important idea here, ask me one question to check it, and stop there.";
	return `${text.trim()}\n\n(${scope})`;
}

function StartDialog({
	initialMode,
	initialMinutes,
	preset,
	onClose,
}: {
	initialMode: StartMode;
	initialMinutes: number;
	preset?: StartPreset;
	onClose: () => void;
}) {
	const router = useRouter();
	const [mode, setMode] = useState<StartMode>(initialMode);
	const [topic, setTopic] = useState(preset?.topic ?? "");
	const [due, setDue] = useState<number | null>(null);
	const [notes, setNotes] = useState<NoteChip[]>([]);
	const [minutes, setMinutes] = useState<number>(initialMinutes);
	const [examMinutes, setExamMinutes] = useState<number>(DEFAULT_EXAM_LENGTH);
	const [pickedNotes, setPickedNotes] = useState<string[]>(() => (preset?.notes ?? []).slice(0, EXAM_MAX_NOTES).map((n) => n.id));
	const [warmup, setWarmup] = useState<boolean>(readWarmupPreference);
	const [classes, setClasses] = useState<StartClass[]>([]);
	const [classKey, setClassKey] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});

	useEffect(() => {
		void fetch("/api/review")
			.then((r) => (r.ok ? r.json() : null))
			.then((body: { due: number } | null) => setDue(body?.due ?? 0))
			.catch(() => setDue(0));
		void fetch("/api/notes")
			.then((r) => (r.ok ? r.json() : null))
			.then((body: { notes: (NoteChip & { importedAt: string })[] } | null) => {
				const recent = [...(body?.notes ?? [])]
					.sort((a, b) => b.importedAt.localeCompare(a.importedAt))
					.slice(0, 6)
					.map(({ id, name }) => ({ id, name }));
				// A course's files come first, all of them; then the recent ones.
				const given = preset?.notes ?? [];
				setNotes(given.length > 0 ? given : recent);
			})
			.catch(() => setNotes(preset?.notes ?? []));
	}, [preset]);

	useEffect(() => {
		void fetch("/api/courses")
			.then((r) => (r.ok ? (r.json() as Promise<{ courses: { key: string; label: string; notes: NoteChip[] }[] }>) : null))
			.then((body) => {
				const list = body?.courses ?? [];
				const colors = colorsFor(list.map((c) => c.key));
				setClasses(list.map((c) => ({ key: c.key, label: c.label, color: colors.get(c.key) ?? 0, notes: c.notes.map(({ id, name }) => ({ id, name })) })));
			})
			.catch(() => undefined);
	}, []);

	/** Pick a class: its name becomes the topic and its notes the ones on offer. */
	const pickClass = (key: string | null) => {
		const prev = classes.find((c) => c.key === classKey);
		const next = classes.find((c) => c.key === key);
		setClassKey(next ? next.key : null);
		if (!next) {
			if (prev && topic === prev.label) setTopic("");
			return;
		}
		if (!topic.trim() || topic === prev?.label) setTopic(next.label);
		if (next.notes.length > 0) {
			setNotes(next.notes);
			setPickedNotes(next.notes.slice(0, EXAM_MAX_NOTES).map((n) => n.id));
		}
	};

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !busy) {
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [busy, onClose]);

	const go = async (text: string) => {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			let target: string | null;
			if (mode === "exam") {
				const res = await fetch("/api/exams", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ scope: text, noteIds: pickedNotes, minutes: examMinutes }),
				});
				const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
				if (!res.ok || !body.id) throw new Error(body.error ?? "Could not start the exam.");
				target = `/exam/${body.id}`;
			} else if (mode === "review") {
				const res = await fetch("/api/review/start", { method: "POST" });
				const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
				if (!res.ok || !body.id) throw new Error(body.error ?? "Could not start the review.");
				target = `/chat/${body.id}?prompt=${encodeURIComponent(REVIEW_START_PROMPT)}`;
			} else {
				const kind = mode === "practice" ? "practice" : "learn";
				const quick = minutes === QUICK_SESSION_MINUTES;
				const cls = classes.find((c) => c.key === classKey && c.label === text);
				const firstMessage = quick
					? quickSessionPrompt(kind, text)
					: cls && kind === "learn"
						? `Teach me ${cls.label}, starting from what I already know.${courseNotesLine(cls.notes.map((n) => n.name))}`
						: undefined;
				// A five-minute session is one idea and one question: no warm-up.
				target = await startDraftSession(text, fetch, kind === "practice" ? "practice" : undefined, undefined, firstMessage, {
					warmup: warmup && !quick,
				});
				if (target) setSessionBudget(target, minutes);
			}
			if (!target) {
				setBusy(false);
				return;
			}
			onClose();
			router.push(target);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not start the session.");
			setBusy(false);
		}
	};

	return createPortal(
		<div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-scrim px-4 py-16" {...backdropDismiss}>
			<StartDialogBody
				mode={mode}
				topic={topic}
				due={due}
				notes={notes}
				minutes={minutes}
				examMinutes={examMinutes}
				pickedNotes={pickedNotes}
				busy={busy}
				error={error}
				onMode={setMode}
				onMinutes={setMinutes}
				onExamMinutes={setExamMinutes}
				classes={classes}
				classKey={classKey}
				onClass={pickClass}
				warmup={warmup}
				onWarmup={(on) => {
					setWarmup(on);
					writeWarmupPreference(on);
				}}
				onTopic={setTopic}
				onStart={() => void go(topic)}
				onNote={(name) => void go(notePrompt(mode === "practice" ? "practice" : "learn", name))}
				onPickNote={(id) =>
					setPickedNotes((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.length >= EXAM_MAX_NOTES ? ids : [...ids, id]))
				}
				onClose={onClose}
			/>
		</div>,
		document.body,
	);
}

/** A class the dialog can start from. */
export interface StartClass {
	key: string;
	label: string;
	color: number;
	notes: NoteChip[];
}

const MODES: { id: StartMode; label: string; desc: string; icon: React.ReactNode }[] = [
	{ id: "learn", label: "Learn", desc: "Socrates teaches something new and checks you as it goes.", icon: <BookOpenIcon className="size-4" /> },
	{ id: "practice", label: "Practice", desc: "Solve problems on what you have covered. No new teaching.", icon: <DumbbellIcon className="size-4" /> },
	{ id: "review", label: "Review", desc: "Quick recall on the topics you are starting to forget.", icon: <RotateCcwIcon className="size-4" /> },
	{ id: "exam", label: "Mock exam", desc: "A timed paper of real exam problems. No hints, marked at the end.", icon: <ClipboardCheckIcon className="size-4" /> },
];

/** The dialog's pure body: the render-test seam (state lives in the wrapper). */
export function StartDialogBody({
	mode,
	topic,
	due,
	notes,
	minutes,
	examMinutes = DEFAULT_EXAM_LENGTH,
	pickedNotes = [],
	busy,
	error,
	onMode,
	onMinutes,
	onExamMinutes = () => {},
	warmup = true,
	onWarmup,
	classes = [],
	classKey = null,
	onClass = () => {},
	onTopic,
	onStart,
	onNote,
	onPickNote = () => {},
	onClose,
}: {
	mode: StartMode;
	topic: string;
	/** Topics due for review; null while loading. */
	due: number | null;
	/** The most recent saved notes, offered as one-click starts. */
	notes: NoteChip[];
	/** The session length, for Learn and Practice (sets the session timer). */
	minutes: number;
	/** Mock exam: the time limit, and the notes it is written from. */
	examMinutes?: number;
	pickedNotes?: string[];
	busy: boolean;
	error: string | null;
	onMode: (mode: StartMode) => void;
	onMinutes: (minutes: number) => void;
	onExamMinutes?: (minutes: number) => void;
	/** Open Learn and Practice with a warm-up on due topics (warm-up recall). */
	warmup?: boolean;
	onWarmup?: (on: boolean) => void;
	/** Classes to study; picking one fills the topic and offers its notes. */
	classes?: StartClass[];
	classKey?: string | null;
	onClass?: (key: string | null) => void;
	onTopic: (text: string) => void;
	onStart: () => void;
	onNote: (name: string) => void;
	onPickNote?: (id: string) => void;
	onClose: () => void;
}) {
	const topicRef = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		if (mode !== "review") topicRef.current?.focus();
	}, [mode]);
	const canStart =
		!busy &&
		(mode === "review" ? (due ?? 0) > 0 : mode === "exam" ? topic.trim().length > 0 || pickedNotes.length > 0 : topic.trim().length > 0);
	const verb = mode === "learn" ? "Start learning" : mode === "practice" ? "Start practice" : mode === "exam" ? "Write my exam" : "Start review";
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-labelledby="start-title"
			data-testid="start-dialog"
			className="flex w-full max-w-xl flex-col gap-6 rounded-2xl bg-surface px-7 pb-6 pt-7 shadow-2xl"
		>
			<div className="flex items-start justify-between gap-3">
				<h2 id="start-title" className="lh-page-title text-[28px] leading-tight">
					What would you like to do?
				</h2>
				<button
					type="button"
					aria-label="Close"
					onClick={onClose}
					className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</div>

			<div role="group" aria-label="Kind of session" className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
				{MODES.map((m) => {
					const badge = m.id === "review" && due !== null && due > 0 ? `${due} due` : null;
					return (
						<button
							key={m.id}
							type="button"
							aria-pressed={mode === m.id}
							data-testid={`start-mode-${m.id}`}
							onClick={() => onMode(m.id)}
							className={cn(
								"flex flex-col gap-2 rounded-xl border-[1.5px] p-3.5 text-left transition-colors",
								mode === m.id ? "border-good bg-good-soft" : "border-border/70 bg-background hover:bg-accent/60",
							)}
						>
							<span className="flex items-center gap-2">
								{m.icon}
								<span className="flex-1 text-base font-semibold">{m.label}</span>
								{badge && <span className="rounded-full bg-warn-soft px-2 py-px text-xs font-semibold text-warn-ink">{badge}</span>}
							</span>
							<span className="text-sm leading-snug text-foreground/70">{m.desc}</span>
						</button>
					);
				})}
			</div>

			{mode === "review" ? (
				<p data-testid="start-review-note" className="text-base text-foreground/80">
					{due === null
						? "Checking what is due…"
						: due === 0
							? "Nothing is due right now. Your memory of every tested topic is still above the target."
							: `${Math.min(due, REVIEW_SESSION_SIZE)} of your ${due} due ${due === 1 ? "topic" : "topics"}, weakest first. Recall from memory, no notes: each answer moves the topic's next review.`}
				</p>
			) : (
				<div className="flex flex-col gap-2.5">
					<label htmlFor="start-topic" className="text-sm font-semibold">
						{mode === "practice" ? "What do you want to practise?" : mode === "exam" ? "What does the exam cover?" : "What do you want to learn?"}
					</label>
					{classes.length > 0 && (
						<div className="flex flex-wrap items-center gap-2" data-testid="start-classes">
							<span className="text-sm text-muted-foreground">A class:</span>
							{classes.map((c) => (
								<button
									key={c.key}
									type="button"
									aria-pressed={classKey === c.key}
									disabled={busy}
									onClick={() => onClass(classKey === c.key ? null : c.key)}
									className={cn(
										`cal-c${c.color}`,
										"flex h-8 max-w-56 items-center gap-1.5 rounded-full px-3 text-sm transition-colors disabled:opacity-50",
										classKey === c.key ? "bg-good-soft font-semibold text-good-ink ring-1 ring-good" : "bg-accent hover:bg-accent/70",
									)}
								>
									<span className="size-2 shrink-0 rounded-[3px]" style={{ background: "var(--bar)" }} />
									<span className="truncate">{c.label}</span>
								</button>
							))}
						</div>
					)}
					<textarea
						id="start-topic"
						ref={topicRef}
						data-testid="start-topic"
						value={topic}
						rows={2}
						onChange={(e) => onTopic(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								if (canStart) onStart();
							}
						}}
						placeholder={
							mode === "practice"
								? "e.g. entropy change problems"
								: mode === "exam"
									? "e.g. Thermodynamics, chapters 2 and 3: first law, enthalpy, calorimetry"
									: "e.g. the Calvin cycle, or paste a question from your course"
						}
						className="lh-input resize-none rounded-xl border bg-background px-3.5 py-3 font-prose text-lg outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
					/>
					{mode === "exam" && notes.length > 0 && (
						<div className="flex flex-wrap items-center gap-2" data-testid="start-exam-notes">
							<span className="text-sm text-muted-foreground">Write it from your notes (up to {EXAM_MAX_NOTES}):</span>
							{notes.map((n) => (
								<button
									key={n.id}
									type="button"
									aria-pressed={pickedNotes.includes(n.id)}
									disabled={busy}
									onClick={() => onPickNote(n.id)}
									className={cn(
										"h-8 max-w-56 truncate rounded-full px-3 text-sm transition-colors disabled:opacity-50",
										pickedNotes.includes(n.id) ? "bg-good-soft font-semibold text-good-ink ring-1 ring-good" : "bg-accent hover:bg-accent/70",
									)}
								>
									{n.name}
								</button>
							))}
						</div>
					)}
					{mode !== "exam" && notes.length > 0 && (
						<div className="flex flex-wrap items-center gap-2" data-testid="start-notes">
							<span className="text-sm text-muted-foreground">From your notes:</span>
							{notes.slice(0, 3).map((n) => (
								<button
									key={n.id}
									type="button"
									disabled={busy}
									onClick={() => onNote(n.name)}
									className="h-8 max-w-56 truncate rounded-full bg-accent px-3 text-sm transition-colors hover:bg-accent/70 disabled:opacity-50"
								>
									{n.name}
								</button>
							))}
						</div>
					)}
				</div>
			)}

			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}

			{mode === "exam" && (
				<div className="flex flex-col gap-2">
					<div className="flex flex-wrap items-center gap-3">
						<span id="start-exam-length-label" className="text-sm font-semibold">
							Time limit
						</span>
						<div role="group" aria-labelledby="start-exam-length-label" data-testid="start-exam-length" className="flex gap-0.5 rounded-lg bg-accent/70 p-0.5">
							{EXAM_LENGTHS.map((m) => (
								<button
									key={m}
									type="button"
									aria-pressed={examMinutes === m}
									onClick={() => onExamMinutes(m)}
									className={cn(
										"h-8 rounded-md px-3 text-sm tabular-nums transition-colors",
										examMinutes === m ? "bg-surface font-semibold text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
									)}
								>
									{m} min
								</button>
							))}
						</div>
					</div>
					<p className="text-sm text-muted-foreground">
						{problemCountFor(examMinutes)} {problemCountFor(examMinutes) === 1 ? "problem" : "problems"}, each a scenario with several questions. Writing and
						checking the paper takes a minute or two; the clock starts when you open it.
					</p>
				</div>
			)}

			{mode !== "review" && mode !== "exam" && (
				<div className="flex flex-wrap items-center gap-3">
					<span id="start-length-label" className="text-sm font-semibold">
						How long?
					</span>
					<div role="group" aria-labelledby="start-length-label" data-testid="start-length" className="flex gap-0.5 rounded-lg bg-accent/70 p-0.5">
						{SESSION_LENGTHS.map((m) => (
							<button
								key={m}
								type="button"
								aria-pressed={minutes === m}
								onClick={() => onMinutes(m)}
								className={cn(
									"h-8 rounded-md px-3 text-sm tabular-nums transition-colors",
									minutes === m ? "bg-surface font-semibold text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
								)}
							>
								{m} min
							</button>
						))}
					</div>
				</div>
			)}

			{(mode === "learn" || mode === "practice") && minutes !== QUICK_SESSION_MINUTES && due !== null && due > 0 && onWarmup && (
				<label data-testid="start-warmup" className="flex cursor-pointer items-start gap-2.5 text-sm">
					<input
						type="checkbox"
						checked={warmup}
						onChange={(e) => onWarmup(e.target.checked)}
						className="mt-0.5 size-4 shrink-0 cursor-pointer accent-primary"
					/>
					<span>
						<span className="font-semibold">Warm up first</span>
						<span className="text-foreground/70">
							{" "}
							· {Math.min(due, WARMUP_SIZE)} quick {Math.min(due, WARMUP_SIZE) === 1 ? "question" : "questions"} on earlier topics you are starting to forget
						</span>
					</span>
				</label>
			)}

			<div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-5">
				{mode === "practice" ? (
					<Link href="/chat/new?mode=practice" onClick={onClose} className="text-sm text-muted-foreground underline-offset-2 hover:underline">
						Pick topics from your map instead
					</Link>
				) : (
					<span />
				)}
				<button
					type="button"
					data-testid="start-go"
					disabled={!canStart}
					onClick={onStart}
					className="flex h-12 items-center gap-2.5 rounded-xl bg-primary px-6 text-base font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
				>
					{busy ? <Loader2Icon className="size-4 animate-spin" /> : <PlayIcon className="size-4 fill-current" />}
					{verb}
				</button>
			</div>
		</div>
	);
}
