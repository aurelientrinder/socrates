"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2Icon, MicIcon } from "lucide-react";
import { useSettingsDialog } from "@/components/settings/settings-dialog";
import { Hint } from "@/components/ui/hint";
import { BATCH_DICTATION_MAX_SECONDS, type DictationSession } from "@/src/core";

/**
 * Voice dictation — Gemini batch engine.
 *
 * The renderer captures mic audio in an AudioWorklet
 * (public/worklets/pcm-capture.js → linear16 16kHz mono) and keeps the
 * run's frames. At stop it POSTs them to /api/stt/transcribe, which asks
 * Gemini (the user's existing GEMINI_API_KEY) for a verbatim transcript.
 * The transcript lands in the PRIMARY INPUT (see below) once, when the run
 * ends — nothing textual renders while recording, only the meter.
 *
 * Patterns carried over from the owner's pi `dictate` extension:
 *   - generation counter: every start/stop increments it; all async
 *     handlers no-op when stale, so a dying run can never tear down the
 *     current one.
 *   - meter: latest-RMS-never-resets — the level ref keeps the last
 *     observed value, so a tick with no fresh audio re-renders the last
 *     level instead of dropping to silence (60ms tick samples the ref).
 *   - dB mapping floor −50 / ceiling −10: the sweet spot for showing
 *     conversational speech as mid-height bars without pegging.
 *   - stop: mic dies FIRST (no more audio enqueues), then the request.
 *
 * ONE primary transcription input at all times: the pending quiz/ask
 * question's field while one waits (text mode → the answer field, select
 * modes → "Your thinking"), else the page's composer. Implemented as a
 * module-level registry the question form claims on mount — see
 * useDictationTarget below.
 *
 * Click → meter IMMEDIATELY (optimistic): the meter strip renders from the
 * click, the session lookup and mic acquisition run CONCURRENTLY behind it.
 * Frames captured before the session resolves queue in pendingRef and move
 * into the recording once it does. A run stops itself at
 * BATCH_DICTATION_MAX_SECONDS (the request ceiling) and keeps the
 * transcript.
 *
 * Persistent capture graph: one app-lifetime AudioContext + a memoized
 * worklet module — per-run contexts would pay context creation and a
 * worklet-module fetch on every start. getUserMedia can't be pre-warmed
 * (the mic indicator would stay lit) — hence the optimistic meter.
 *
 * Meter rendering lives in <DictationBar> (own 60ms timer over the level
 * ref) so the 16-renders/sec never touch the page component — only the
 * tiny bar strip repaints.
 */

/** One second of the worklet's linear16 16kHz mono, in bytes. */
const PCM_BYTES_PER_SECOND = 16000 * 2;

/** Meter tuning — the owner's tested values, see the file header. */
const METER_FLOOR_DB = -50;
const METER_CEILING_DB = -10;
export const METER_TICK_MS = 60;
/** Rolling history: 48 cells × 60ms ≈ 2.9s of recent loudness. */
export const METER_CELLS = 48;

/** The Gemini key's id in the keys store (the env-var name — the Keys
 *  section's openRow state and the PUT /api/keys/:id seam). */
export const GEMINI_KEY_ID = "GEMINI_API_KEY";

/** The client-authored KEYLESS line: the session route's raw 503 message
 * is dev-speak ("add it to auth.json (desktop) or .env.local (dev)") — the
 * surface says the short truth instead. Exported for pins; the errored
 * idle button's click recognizes it and deep-links Settings → Keys → the
 * Gemini row. */
export const DICTATION_KEYLESS = "Dictation needs a Gemini key";

/** Look up the run's session — engine and language; the route holds the
 *  key server-side. The keyless 503 (no engine keyed) is the route's ONLY
 *  503 — its message is dev-speak, so the error becomes the short
 *  client-authored line. */
async function fetchSession(): Promise<DictationSession> {
	const res = await fetch("/api/stt/token");
	const data = (await res.json()) as Partial<DictationSession> & { message?: string };
	if (!res.ok || !data.engine) {
		if (res.status === 503) throw new Error(DICTATION_KEYLESS);
		throw new Error(data.message ?? `session route ${res.status}`);
	}
	return { engine: data.engine, language: data.language ?? null };
}

/* Persistent capture graph: one app-lifetime AudioContext + a module-load memo. Created under the
 * click gesture (autoplay policy) and NEVER closed — per-run nodes
 * (source, worklet) disconnect at teardown instead. */
let sharedCtx: AudioContext | null = null;
let workletModule: Promise<void> | null = null;

function ensureAudioGraph(): { ctx: AudioContext; module: Promise<void> } {
	if (!sharedCtx) sharedCtx = new AudioContext({ sampleRate: 16000 });
	if (!workletModule) {
		workletModule = sharedCtx.audioWorklet.addModule("/worklets/pcm-capture.js").catch((e: unknown) => {
			workletModule = null; // failed load: retry next run
			throw e;
		});
	}
	return { ctx: sharedCtx, module: workletModule };
}

/** RMS (0..1) → normalized 0..1 across the audible dB window. */
export function rmsToMeter(rms: number): number {
	if (rms <= 0) return 0;
	const db = 20 * Math.log10(rms);
	const t = (db - METER_FLOOR_DB) / (METER_CEILING_DB - METER_FLOOR_DB);
	return Math.max(0, Math.min(1, t));
}

/**
 * The primary-input registry: at most ONE non-composer input can claim the
 * dictation target while mounted — the pending question's answer/thinking
 * field (question-dock.tsx). The page's `append` (the composer) is the
 * fallback when nobody claims. Module-level by design: the claimant is a
 * sibling subtree far from the hook's owner, and there is exactly one
 * window, one pending question, one target at a time.
 */
let questionTarget: ((text: string) => void) | null = null;

/* Is a dictation run live on this page? The Esc chain (keyboard wave A,
 * components/keyboard-shortcuts.tsx) needs a SYNCHRONOUS answer — the
 * stop handler can't report back through a CustomEvent. Set at start(),
 * cleared in cleanup() (every terminal path runs through cleanup). */
let dictationActiveFlag = false;

export function isDictationActive(): boolean {
	return dictationActiveFlag;
}

/* The finisher registry: submit paths FAR from the hook's owner (the
 * pending question's dock) need finish() without a prop bridge. Same
 * module-level pattern as questionTarget — one window, one instance,
 * one finisher. Empty registry (no hook mounted) → resolve immediately. */
let dictationFinisher: (() => Promise<void>) | null = null;

/** Finish any live dictation run before continuing (see Dictation.finish). */
export function finishDictation(): Promise<void> {
	return dictationFinisher ? dictationFinisher() : Promise.resolve();
}

/** Join a dictated final onto the current text (shared separator rule). */
export function joinDictation(current: string, final: string): string {
	return current ? current.replace(/\s+$/, "") + " " + final : final;
}

/**
 * Claim the dictation target while mounted (and `claimed` is true). The
 * unmount guard is identity-based so dev-mode double-invoked effects
 * can't clear another claimant.
 */
export function useDictationTarget(append: (text: string) => void, claimed: boolean) {
	useEffect(() => {
		if (!claimed) return;
		questionTarget = append;
		return () => {
			if (questionTarget === append) questionTarget = null;
		};
	}, [append, claimed]);
}

export type DictationPhase = "idle" | "connecting" | "recording" | "stopping";

export type Dictation = {
	phase: DictationPhase;
	/** Terminal-state explanation, shown inside the wide button (cleared on the next start). */
	error: string | null;
	/** Latest observed RMS, 0..1 — sampled by the meter's own tick, never reset. */
	levelRef: { current: number };
	/** Not idle — from the click until the stop completes (the optimistic window). */
	active: boolean;
	/** End + KEEP the transcript: flush the deferred buffer into the primary
	 *  input (the Stop pill and ⌘D). */
	toggle: () => void;
	stop: () => void;
	/** FINISH, THEN CONTINUE (owner, 2026-10-01 "nothing gets lost" round):
	 *  if a run is live, stop it and resolve only when the run has fully
	 *  ended — the transcript has landed in the target field. A
	 *  submit path awaits this before building its payload, so a learner
	 *  who forgets to stop dictation before Enter never loses the spoken
	 *  reasoning. Idle → resolves immediately (the common no-run submit
	 *  pays nothing). Every terminal path runs cleanup(), and cleanup()
	 *  resolves the waiters — cancel (Esc) resolves them too, by its
	 *  discard semantics. */
	finish: () => Promise<void>;
	/** End + DISCARD the transcript: no flush, immediate teardown. The Esc
	 *  semantics (owner, 2026-09-17 round 3): Esc is a cancel, not a stop —
	 *  before, it flushed exactly like the toggle did. */
	cancel: () => void;
	/** Clear the terminal error without starting a run (zero-keys wave):
	 * the keyless click leaves for Settings and the surface must come
	 * back clean. */
	clearError: () => void;
};

/**
 * One dictation instance per composer-bearing page. `append` is the
 * composer fallback; the mounted question form's claim wins while a
 * question waits.
 */
export function useDictation({ append }: { append: (text: string) => void }): Dictation {
	const [phase, setPhase] = useState<DictationPhase>("idle");
	const [error, setError] = useState<string | null>(null);
	/** Latest RMS from the worklet — the meter samples this (dictate pattern). */
	const levelRef = useRef(0);
	/** The page's fallback append — kept fresh per render so a mid-recording
	 *  retarget (composer↔question) is honored on the very next final. */
	const appendRef = useRef(append);
	appendRef.current = append;

	// Live machinery (non-render values). The MediaStream tracks stop and
	// the per-run nodes disconnect on teardown; the AudioContext is app-lifetime.
	const streamRef = useRef<MediaStream | null>(null);
	/** Per-run graph nodes — the CONTEXT outlives runs. */
	const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
	const workletRef = useRef<AudioWorkletNode | null>(null);
	/** Frames captured before the session resolves: moved into the
	 *  recording once it does; capped at 256 frames (≈32s) with the oldest
	 *  dropped; cleared at teardown so a dead run's audio can't leak into
	 *  the next. */
	const pendingRef = useRef<ArrayBuffer[]>([]);
	const genRef = useRef(0); // stale-handler guard (dictate pattern)
	/** The deferred transcript (owner round 2): finals land here during the
	 *  run and flush into the primary input once, at teardown. */
	const bufferRef = useRef<string[]>([]);
	/** Resolvers waiting for the run to fully end (finish(), owner
	 *  2026-10-01): released by cleanup() — every terminal path runs it. */
	const waitersRef = useRef<Array<() => void>>([]);
	/** Which engine this run drives — "pending" until the session resolves
	 *  (frames queue in pendingRef meanwhile). */
	const modeRef = useRef<"pending" | "batch">("pending");
	/** The run's whole recording: every frame, POSTed once at stop. Cleared at teardown. */
	const recordedRef = useRef<ArrayBuffer[]>([]);
	const recordedBytesRef = useRef(0);
	/** The latest stop() — the worklet handler (bound once per run) calls
	 *  it when a batch run reaches its length cap. */
	const stopRef = useRef<() => void>(() => {});

	/** Flush the buffered transcript into the primary input — question claim
	 *  first, composer fallback. Called exactly once per run, at cleanup; the
	 *  buffer clears itself so double-cleanup is a no-op. */
	const flush = useCallback(() => {
		if (bufferRef.current.length === 0) return;
		const text = bufferRef.current.join(" ");
		bufferRef.current = [];
		(questionTarget ?? appendRef.current)(text);
	}, []);

	/** Full teardown of one run's machinery. Idempotent; generation-guarded by callers. */
	const cleanup = useCallback(() => {
		genRef.current++;
		dictationActiveFlag = false;
		flush(); // the deferred transcript appears when the run ends (owner round 2)
		pendingRef.current = [];
		recordedRef.current = [];
		recordedBytesRef.current = 0;
		modeRef.current = "pending";
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		workletRef.current?.disconnect();
		workletRef.current = null;
		// The AudioContext is app-lifetime — nodes die, it stays.
		setPhase("idle");
		// The finish() waiters ride until NOW — post-flush, post-teardown:
		// a submit path resuming after `await finishDictation()` reads the
		// target field with the dictated tail already in it.
		for (const w of waitersRef.current.splice(0)) w();
	}, []);

	const start = useCallback(async () => {
		dictationActiveFlag = true;
		setError(null);
		setPhase("connecting");
		bufferRef.current = []; // fresh run, fresh buffer (round 2)
		pendingRef.current = []; // fresh run, fresh queue
		recordedRef.current = [];
		recordedBytesRef.current = 0;
		modeRef.current = "pending";
		const gen = ++genRef.current;

		// The session lookup runs concurrently with the mic, which is the
		// long pole (OS audio init + permission prompt) and gates everything.
		// 127.0.0.1 is a secure context, so getUserMedia works without TLS;
		// macOS TCC prompts on first use.
		const sessionPromise = fetchSession();
		sessionPromise.catch(() => {}); // surfaced below; no unhandled rejection
		const micPromise = navigator.mediaDevices.getUserMedia({
			audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
		});
		let stream: MediaStream;
		try {
			stream = await micPromise;
			if (gen !== genRef.current) {
				for (const track of stream.getTracks()) track.stop();
				return;
			}
			streamRef.current = stream;

			// App-lifetime context + memoized worklet module.
			const { ctx, module } = ensureAudioGraph();
			await module;
			if (ctx.state === "suspended") await ctx.resume();
			if (gen !== genRef.current) return;

			const worklet = new AudioWorkletNode(ctx, "pcm-capture");
			workletRef.current = worklet;
			worklet.port.onmessage = (e) => {
				const msg = e.data as { type: string; rms?: number; buffer?: ArrayBuffer };
				if (msg.type === "level") {
					levelRef.current = msg.rms ?? 0; // never reset to zero (dictate pattern)
				} else if (msg.type === "audio") {
					if (modeRef.current === "batch") {
						recordedRef.current.push(msg.buffer!);
						recordedBytesRef.current += msg.buffer!.byteLength;
						if (recordedBytesRef.current >= BATCH_DICTATION_MAX_SECONDS * PCM_BYTES_PER_SECOND) stopRef.current();
						return;
					}
					// Session not resolved yet — queue, capped.
					pendingRef.current.push(msg.buffer!);
					if (pendingRef.current.length > 256) pendingRef.current.shift();
				}
			};
			const source = ctx.createMediaStreamSource(stream);
			sourceRef.current = source;
			source.connect(worklet);
			// Pull the graph with silence out (the worklet writes no output) —
			// an unconnected worklet node is never clocked.
			worklet.connect(ctx.destination);
		} catch (e) {
			if (gen !== genRef.current) return;
			const msg =
				e instanceof DOMException && (e.name === "NotAllowedError" || e.name === "SecurityError")
					? "Microphone permission denied"
					: e instanceof Error
						? e.message
						: "mic unavailable";
			setError(msg);
			cleanup();
			return;
		}
		if (gen !== genRef.current) return;
		try {
			await sessionPromise;
		} catch (e) {
			if (gen !== genRef.current) return;
			setError(e instanceof Error ? e.message : "dictation unavailable");
			cleanup();
			return;
		}
		if (gen !== genRef.current) return;
		// Everything queued so far is the recording's start.
		modeRef.current = "batch";
		recordedRef.current = pendingRef.current;
		recordedBytesRef.current = recordedRef.current.reduce((n, b) => n + b.byteLength, 0);
		pendingRef.current = [];
		setPhase("recording");
	}, [cleanup]);

	/** End a run: send the recording, buffer the transcript, end the
	 *  run (cleanup flushes it into the primary input). A cancel mid-request
	 *  bumps the generation, so its late answer is dropped. */
	const transcribeBatch = useCallback(
		(gen: number) => {
			const frames = recordedRef.current;
			recordedRef.current = [];
			if (frames.length === 0) {
				cleanup();
				return;
			}
			fetch("/api/stt/transcribe", {
				method: "POST",
				headers: { "content-type": "application/octet-stream" },
				body: new Blob(frames),
			})
				.then(async (res) => {
					const data = (await res.json()) as { text?: string; message?: string };
					if (!res.ok) throw new Error(data.message ?? `transcribe route ${res.status}`);
					return data.text ?? "";
				})
				.then((text) => {
					if (gen !== genRef.current) return;
					if (text) bufferRef.current.push(text);
					cleanup();
				})
				.catch((e: unknown) => {
					if (gen !== genRef.current) return;
					setError(e instanceof Error ? e.message : "Transcription failed");
					cleanup();
				});
		},
		[cleanup],
	);

	const stop = useCallback(() => {
		const gen = genRef.current;
		if (phase !== "recording" && phase !== "connecting") return;
		setPhase("stopping");

		// Mic dies FIRST — no more audio enqueues (dictate pattern). The
		// per-run nodes die with it; the AudioContext stays.
		for (const track of streamRef.current?.getTracks() ?? []) track.stop();
		streamRef.current = null;
		sourceRef.current?.disconnect();
		sourceRef.current = null;
		workletRef.current?.disconnect();
		workletRef.current = null;

		if (modeRef.current === "batch") transcribeBatch(gen);
		else cleanup(); // stopped before the session resolved — nothing recorded
	}, [phase, cleanup, transcribeBatch]);
	stopRef.current = stop;

	const cancel = useCallback(() => {
		if (phase === "idle") return;
		// Discard first, teardown second — cleanup() flushes, and the now-empty
		// buffer makes that flush a no-op. Also kills a "stopping" run: the
		// flush already underway is abandoned (its timer is cleared inside).
		bufferRef.current = [];
		cleanup();
	}, [phase, cleanup]);

	const finish = useCallback((): Promise<void> => {
		return new Promise((resolve) => {
			if (phase === "idle") {
				resolve();
				return;
			}
			waitersRef.current.push(resolve);
			// "stopping" is already ending — the waiter just rides to cleanup.
			if (phase === "recording" || phase === "connecting") stop();
		});
	}, [phase, stop]);

	// Publish finish() for the sibling subtrees (the pending question's
	// dock) — registered for as long as this page owns the hook.
	useEffect(() => {
		dictationFinisher = finish;
		return () => {
			if (dictationFinisher === finish) dictationFinisher = null;
		};
	}, [finish]);

	const toggle = useCallback(() => {
		if (phase === "idle") void start();
		else if (phase === "recording" || phase === "connecting") stop();
		// "stopping" presses are ignored — the flush is in flight.
	}, [phase, start, stop]);

	// Shortcut seams (keyboard wave A): ⌘D toggles from anywhere on the
	// page; the Esc chain lands here as a CANCEL (owner, round 3). Each
	// page owns ONE hook instance, and only the mounted page's listener is
	// attached.
	useEffect(() => {
		window.addEventListener("lh:kbd-toggle-dictation", toggle);
		return () => window.removeEventListener("lh:kbd-toggle-dictation", toggle);
	}, [toggle]);
	useEffect(() => {
		window.addEventListener("lh:kbd-cancel-dictation", cancel);
		return () => window.removeEventListener("lh:kbd-cancel-dictation", cancel);
	}, [cancel]);

	return {
		phase,
		error,
		levelRef,
		active: phase !== "idle",
		toggle,
		stop,
		finish,
		cancel,
		clearError: () => setError(null),
	};
}

/**
 * The stats-bar dictation slot (owner placement, round 1): the row's middle
 * is one strip that is always the full free width —
 *
 *   idle      a wide, quiet "Dictate" button (mic + label, grayed out — the
 *             whole middle is the affordance, per the owner).
 *   active    optimistic from the CLICK: red stop pill + the fixed-width
 *             meter (no interim text ever shifts it). Spinner while
 *             the transcript request is in flight.
 *   error     the wide button again, label swapped for the failure reason
 *             (full text in the tooltip), cleared on the next click.
 */
export function DictationBar({ dictation }: { dictation: Dictation }) {
	const { phase, error, levelRef, toggle, active, clearError } = dictation;
	const { open: openSettings } = useSettingsDialog();
	/** The keyless click (zero-keys wave, owner dictation trio): the errored
	 *  idle button deep-links Settings → Keys → the Gemini row and clears
	 *  the error — the surface is clean when the user returns. Any other
	 *  error keeps the old behavior (click = retry, which clears). */
	const keyless = error === DICTATION_KEYLESS;
	const [levels, setLevels] = useState<number[]>(() => new Array(METER_CELLS).fill(0));
	const recording = phase === "recording" || phase === "stopping";
	/** Adaptive cell count (owner round 2): derived from the meter's
	 *  measured width — narrow rows show fewer bars instead of
	 *  overflowing under neighbors. */
	const [cellCount, setCellCount] = useState(METER_CELLS);
	const meterRef = useRef<HTMLDivElement | null>(null);

	// The meter's own heartbeat — 60ms samples of the level ref into a
	// rolling ring. Only THIS strip re-renders; the page never does.
	useEffect(() => {
		if (!active) return;
		setLevels(new Array(METER_CELLS).fill(0));
		const id = setInterval(() => {
			setLevels((ring) => {
				const next = ring.slice(1);
				next.push(rmsToMeter(levelRef.current));
				return next;
			});
		}, METER_TICK_MS);
		return () => clearInterval(id);
	}, [active, levelRef]);

	// Fit the cell count to the available width (4px pitch per cell:
	// 2px bar + 2px gap, clamped 8..48). The meter div's width is set by
	// the row's free space — cells carry no minimum width — so measuring
	// it once per activation + on resize keeps the strip honest in the
	// draft/home rows where the slider leaves little middle.
	useEffect(() => {
		if (!active) return;
		const el = meterRef.current;
		if (!el) return;
		const fit = () => {
			const w = el.clientWidth;
			setCellCount(Math.max(8, Math.min(METER_CELLS, Math.floor(w / 4))));
		};
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, [active]);

	if (!active) {
		return (
			<Hint
				// Errored: the button span truncates the line — the tooltip is its
				// full reveal (the keyless line names the Gemini key). Otherwise the
				// quiet label + the live ⌘D binding.
				label={error ?? "Dictate"}
				action={error ? undefined : "toggle-dictation"}
				side="top"
			>
				<button
					type="button"
					onClick={() => {
						if (keyless) {
							clearError();
							openSettings("keys", GEMINI_KEY_ID);
						} else {
							toggle();
						}
					}}
					aria-label={error ? `Dictation failed: ${error}` : "Start dictation"}
					data-testid="dictation-toggle"
				// Same blurring as the floating chrome (owner, fix wave round 3),
			// but lower opacity — the mic stays quieter than the model pills.
			className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border/50 bg-card/50 text-xs text-muted-foreground/70 shadow-lg backdrop-blur transition-colors hover:border-border hover:text-muted-foreground"
			>
					<MicIcon className="size-3.5" />
					<span className="max-w-full truncate">{error ?? "Dictate"}</span>
				</button>
			</Hint>
		);
	}

	return (
		<div className="flex w-full min-w-0 items-center gap-2" data-testid="dictation-bar">
			<Hint
				// The owner flagged this copy good ("Stop dictation (Esc)") —
				// kept verbatim; only the machinery moved to the styled tooltip.
				label="Stop dictation (Esc)"
				side="top"
			>
				<button
					type="button"
					onClick={toggle}
					disabled={phase === "stopping"}
					aria-label="Stop dictation"
				data-testid="dictation-toggle"
				className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-destructive/10 px-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/20"
			>
				{phase === "stopping" ? (
					<Loader2Icon className="size-3.5 animate-spin" />
				) : (
					<MicIcon className="size-3.5" />
				)}
					Stop
				</button>
			</Hint>
			<span className="size-1.5 shrink-0 animate-pulse rounded-full bg-destructive" aria-hidden />
			{/* Fixed width while recording — nothing ever appends text beside it
			    (no interims, owner round 1). Cells carry no minimum width; the
			    COUNT adapts to the measured row space (owner round 2). */}
			<div ref={meterRef} className="flex h-4 min-w-0 flex-1 items-center gap-[2px]" data-testid="dictation-meter">
				{levels.slice(-cellCount).map((v, i) => (
					<span
						key={i}
						className="min-w-0 flex-1 rounded-full bg-foreground/40"
						style={{ height: `${2 + Math.round(v * 14)}px` }}
					/>
				))}
			</div>
		</div>
	);
}
