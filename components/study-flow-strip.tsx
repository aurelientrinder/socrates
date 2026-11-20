"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowRightIcon, CheckCircle2Icon, CheckIcon, SparklesIcon, XIcon } from "lucide-react";
import type { StudyFlowPlan } from "@/src/core";
import { setSessionBudget } from "@/components/session-timer";
import { cn } from "@/lib/utils";

interface StoredFlow {
	plan: StudyFlowPlan;
	startedAt: number;
	learnChatId: string;
	practiceChatId?: string;
	completed?: boolean;
}

const flowKey = (flowId: string) => `lh:study-flow:${flowId}`;
const chatFlowKey = (chatId: string) => `lh:chat-flow:${chatId}`;

/** Persist a newly created Study Flow before navigating to its Stage 1+2 Learn chat. */
export function saveActiveFlow(plan: StudyFlowPlan, learnChatId: string): void {
	const record: StoredFlow = { plan, startedAt: Date.now(), learnChatId };
	try {
		localStorage.setItem(flowKey(plan.id), JSON.stringify(record));
		localStorage.setItem(chatFlowKey(learnChatId), plan.id);
	} catch {
		// storage blocked
	}
}

function readFlowForChat(chatId: string): StoredFlow | null {
	try {
		const flowId = localStorage.getItem(chatFlowKey(chatId));
		if (!flowId) return null;
		const raw = localStorage.getItem(flowKey(flowId));
		return raw ? (JSON.parse(raw) as StoredFlow) : null;
	} catch {
		return null;
	}
}

function writeFlow(record: StoredFlow): void {
	try {
		localStorage.setItem(flowKey(record.plan.id), JSON.stringify(record));
		localStorage.setItem(chatFlowKey(record.learnChatId), record.plan.id);
		if (record.practiceChatId) localStorage.setItem(chatFlowKey(record.practiceChatId), record.plan.id);
	} catch {
		// storage blocked
	}
}

function clearFlowForChat(chatId: string, record: StoredFlow): void {
	try {
		localStorage.removeItem(chatFlowKey(chatId));
		localStorage.removeItem(chatFlowKey(record.learnChatId));
		if (record.practiceChatId) localStorage.removeItem(chatFlowKey(record.practiceChatId));
		localStorage.removeItem(flowKey(record.plan.id));
	} catch {
		// storage blocked
	}
}

/**
 * Slim persistent stepper bar rendered below TopBar whenever the active
 * session belongs to an Adaptive Study Flow (Warm-up → Learn → Practice).
 */
export function StudyFlowStrip({
	chatId,
	kind,
	warmingUp,
}: {
	chatId: string;
	kind: "teach" | "practice" | "review";
	warmingUp: boolean;
}) {
	const router = useRouter();
	const [flow, setFlow] = useState<StoredFlow | null>(null);
	const [elapsedMin, setElapsedMin] = useState(0);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const loaded = readFlowForChat(chatId);
		setFlow(loaded);
		if (!loaded) return;
		const tick = () => setElapsedMin(Math.max(0, Math.floor((Date.now() - loaded.startedAt) / 60_000)));
		tick();
		const id = window.setInterval(tick, 15_000);
		return () => window.clearInterval(id);
	}, [chatId]);

	if (!flow) return null;

	const { plan } = flow;
	const activeStage = flow.completed
		? "done"
		: kind === "practice"
			? "practice"
			: warmingUp
				? "warmup"
				: "learn";

	async function startPracticeStage() {
		if (!flow || busy) return;
		setBusy(true);
		try {
			const res = await fetch("/api/chats", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: `Practice: ${plan.topic}`,
					kind: "practice",
					warmup: false,
				}),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const created = (await res.json()) as { id: string };
			const updated: StoredFlow = { ...flow, practiceChatId: created.id };
			writeFlow(updated);
			setFlow(updated);
			const remaining = Math.max(5, plan.budgetMinutes - elapsedMin);
			const href = `/chat/${created.id}?prompt=${encodeURIComponent(plan.practicePrompt)}`;
			setSessionBudget(href, remaining);
			router.push(href);
		} catch {
			setBusy(false);
		}
	}

	function finishFlow() {
		if (!flow) return;
		const done: StoredFlow = { ...flow, completed: true };
		writeFlow(done);
		setFlow(done);
	}

	function dismissFlow() {
		if (!flow) return;
		clearFlowForChat(chatId, flow);
		setFlow(null);
	}

	if (activeStage === "done") {
		return (
			<div
				data-testid="study-flow-complete"
				className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2 text-xs"
			>
				<div className="flex items-center gap-2 font-medium text-foreground">
					<CheckCircle2Icon className="size-4 text-good" />
					<span>
						Study Flow complete · {plan.topic} ({Math.max(1, elapsedMin)} min)
					</span>
				</div>
				<div className="flex items-center gap-2">
					<Link href="/" className="rounded-md border border-border bg-surface px-2.5 py-1 hover:bg-accent">
						Today
					</Link>
					<Link href="/progress" className="rounded-md border border-border bg-surface px-2.5 py-1 hover:bg-accent">
						Progress
					</Link>
					<button
						type="button"
						onClick={dismissFlow}
						aria-label="Dismiss flow summary"
						className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<XIcon className="size-3.5" />
					</button>
				</div>
			</div>
		);
	}

	const steps = [
		...(plan.hasWarmup
			? [{ id: "warmup" as const, label: `Warm-up · ${plan.warmupMinutes}m`, done: activeStage !== "warmup" }]
			: []),
		{ id: "learn" as const, label: `Learn · ${plan.learnMinutes}m`, done: activeStage === "practice" },
		{ id: "practice" as const, label: `Practice · ${plan.practiceMinutes}m`, done: false },
	];

	return (
		<div
			data-testid="study-flow-strip"
			className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface/80 px-4 py-1.5 text-xs"
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="inline-flex items-center gap-1 font-medium text-foreground">
					<SparklesIcon className="size-3.5 text-muted-foreground" />
					Flow
				</span>
				<span className="text-muted-foreground tabular-nums">
					{elapsedMin} / {plan.budgetMinutes}m
				</span>
				<span className="text-border">·</span>
				<ol className="flex items-center gap-1.5">
					{steps.map((s, i) => {
						const isCurrent = s.id === activeStage;
						return (
							<li key={s.id} className="flex items-center gap-1.5">
								{i > 0 && <span className="text-border">→</span>}
								<span
									className={cn(
										"inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 tabular-nums",
										isCurrent
											? "bg-accent font-medium text-foreground"
											: s.done
												? "text-muted-foreground line-through"
												: "text-muted-foreground",
									)}
								>
									{s.done && <CheckIcon className="size-3" />}
									{s.label}
								</span>
							</li>
						);
					})}
				</ol>
			</div>

			<div className="flex items-center gap-2">
				{activeStage !== "practice" ? (
					<button
						type="button"
						disabled={busy}
						onClick={() => void startPracticeStage()}
						className="inline-flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1 font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
					>
						{busy ? "Starting practice…" : "Next: Practice"}
						<ArrowRightIcon className="size-3" />
					</button>
				) : (
					<button
						type="button"
						onClick={finishFlow}
						className="inline-flex items-center gap-1 rounded-md bg-foreground px-2.5 py-1 font-medium text-background transition-opacity hover:opacity-90"
					>
						Finish Flow
						<CheckIcon className="size-3" />
					</button>
				)}
				<button
					type="button"
					onClick={dismissFlow}
					aria-label="Exit Study Flow"
					className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-3.5" />
				</button>
			</div>
		</div>
	);
}

const DURATIONS = [15, 25, 45] as const;

/**
 * 1-click "Start 25-min Flow" card for Today: picks duration (15/25/45 min),
 * calls POST /api/flow to build a personalized 3-stage block, persists it,
 * and opens Stage 1+2 immediately.
 */
export function StudyFlowLauncher({ onNavigate }: { onNavigate?: (href: string) => void }) {
	const [minutes, setMinutes] = useState<(typeof DURATIONS)[number]>(25);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function startFlow() {
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/flow", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ budgetMinutes: minutes }),
			});
			const data = (await res.json()) as { plan?: StudyFlowPlan; chatId?: string; href?: string; error?: string };
			if (!res.ok || !data.plan || !data.chatId || !data.href) {
				throw new Error(data.error ?? `HTTP ${res.status}`);
			}
			saveActiveFlow(data.plan, data.chatId);
			setSessionBudget(data.href, data.plan.budgetMinutes);
			if (onNavigate) onNavigate(data.href);
			else window.location.assign(data.href);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not start Study Flow.");
			setBusy(false);
		}
	}

	return (
		<section
			data-testid="study-flow-launcher"
			className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-surface px-5 py-4"
		>
			<div className="min-w-0 flex-1">
				<p className="flex items-center gap-1.5 text-sm font-semibold">
					<SparklesIcon className="size-4 text-muted-foreground" />
					Adaptive Study Flow
				</p>
				<p className="text-xs text-muted-foreground">
					One auto-piloted block: retrieval warm-up → frontier Learn → Practice lock-in.
				</p>
				{error && (
					<p role="alert" className="mt-1 text-xs text-destructive">
						{error}
					</p>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<div className="flex rounded-lg border border-border bg-card p-0.5 text-xs tabular-nums">
					{DURATIONS.map((m) => (
						<button
							key={m}
							type="button"
							disabled={busy}
							onClick={() => setMinutes(m)}
							className={cn(
								"rounded-md px-2 py-1 transition-colors",
								minutes === m ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
							)}
						>
							{m}m
						</button>
					))}
				</div>
				<button
					type="button"
					disabled={busy}
					onClick={() => void startFlow()}
					data-testid="start-study-flow"
					className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-foreground px-3.5 text-xs font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
				>
					{busy ? "Building flow…" : `Start ${minutes}-min Flow`}
					<ArrowRightIcon className="size-3.5" />
				</button>
			</div>
		</section>
	);
}
