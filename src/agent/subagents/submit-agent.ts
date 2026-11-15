/**
 * runSubmitAgent — the shared single-submit agent seam (moved verbatim from
 * extraction.ts): one TypeBox-validated submit
 * call is the whole deliverable (a pi agent purely so the model can retry a
 * schema-invalid call). The submitted value is captured from the execute
 * seam, which only fires on a schema-valid call — the ??-fill (the old zod
 * defaults) applies at the capture.
 */

import type { Usage } from "../../llm/index.ts";
import type { AgentMessage, AgentTool, AssistantMessage, ToolResultMessage } from "../../llm/index.ts";
import type { TSchema } from "typebox";
import { invalidInputResult, toToolResult } from "../tool-execute.ts";
import type { ModelRole } from "../../../config.ts";
import type { PiEngine } from "../models.ts";
import { runSubagent } from "./pi-run.ts";
import { healToolRecord } from "../tools/heal.ts";
import { healEncodedArguments } from "../../core/argument-heal.ts";

// ── the weak-model string-heal (owner, 2026-09-28; moved here from
// extraction.ts with the digest-aware redesign, 2026-09-30 — the heal
// is wire-format medicine shared by every submit agent) ──
//
// OpenRouter log evidence: weak models under a big submit payload often
// emit a whole array as ONE JSON-STRING instead of a native array
// ("propositions.0: must be object"). pi-agent-core runs
// `prepareArguments` BEFORE TypeBox validation — the sanctioned shim
// point (same doctrine as restoreMathEscapes at the display seam: heal
// weak-model wire behavior, don't punish it with a retry). Best-effort:
// heal only a string that parses to an array; anything else passes
// through untouched and fails validation exactly as before.
export function healStringifiedArrays(raw: unknown): unknown {
	if (typeof raw !== "object" || raw === null) return raw;
	const out: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
	for (const key of ["propositions", "chains"]) {
		const v = out[key];
		if (typeof v !== "string" || v.trim().length === 0) continue;
		try {
			const parsed: unknown = JSON.parse(v);
			if (Array.isArray(parsed)) out[key] = parsed;
		} catch {
			// not a clean stringify (e.g. truncated) — leave for validation
		}
	}
	return out;
}

export async function runSubmitAgent<T>(opts: {
	role: ModelRole;
	toolName: string;
	toolDescription: string;
	parameters: TSchema;
	/** Weak-model tolerance: the old zod `.default()`s, applied to the
	 *  schema-valid raw input at the submit seam. */
	fill: (input: any) => T;
	systemPrompt: string;
	prompt: string;
	engine: PiEngine | undefined;
	signal: AbortSignal | undefined;
	onStep: (usage: Usage, model: string, step: number, finishReason: string, tools: string) => void;
	neverSubmitted: string;
	/** Extra tools beside the submit call (the auditor's graph-exploration
	 *  set, 2026-09-27): a small agentic loop instead of a bare retry. */
	extraTools?: Record<string, AgentTool<any>>;
	/** Turn budget for the loop (default 4 = retry-only; the auditor runs
	 *  an exploration loop instead — 16). */
	maxTurns?: number;
	/** Debug: raw provider-event recording key (LH_PROVIDER_EVENTS=1). */
	chatId?: string;
	/** Weak-model argument heal at pi's prepareArguments seam (runs BEFORE
	 *  TypeBox validation — the sanctioned shim point). Identity by
	 *  default; extraction wires healStringifiedArrays here. */
	prepareArguments?: (args: unknown) => unknown;
	/** Semantic validation at the submit seam: the value is schema-valid
	 *  but may violate a PIPELINE law (coverage, echo-equality). Returning
	 *  a problem string yields an isError result (invalidInputResult) →
	 *  the model retries within maxTurns. null = accept. */
	validate?: (value: T) => string | null;
	/** Extra rounds after a run that ended WITHOUT a valid submit (the model
	 *  answered in prose, spent its turns exploring, kept failing the
	 *  checks, or sent a malformed call): the transcript continues with a
	 *  "submit now" message and only the submit tool. Default 0 (the old
	 *  single-run behavior). Gemini, 2026-11-15: the mock-exam author ended
	 *  runs without a submit_exam call. */
	submitNudges?: number;
}): Promise<T> {
	let submitted: T | undefined;
	let lastProblem: string | null = null;
	const submitTool = {
		name: opts.toolName,
		label: opts.toolName,
		description: opts.toolDescription,
		parameters: opts.parameters,
		prepareArguments: (args: unknown) =>
			// The standard heal composes AFTER the caller's shim (the
			// whitehead generalization, 2026-10-09) — extraction's
			// healStringifiedArrays stays the inner pass.
			healEncodedArguments(
				opts.prepareArguments ? opts.prepareArguments(args) : args,
				opts.parameters,
			) as never,
		execute: async (_toolCallId: string, input: unknown) => {
			const value = opts.fill(input);
			const problem = opts.validate?.(value) ?? null;
			if (problem) {
				lastProblem = problem;
				return invalidInputResult(opts.toolName, [problem]);
			}
			submitted = value;
			return toToolResult(submitted);
		},
	} satisfies AgentTool<any>;
	const runOptions = {
		role: opts.role,
		engine: opts.engine,
		systemPrompt: opts.systemPrompt,
		abortSignal: opts.signal,
		chatId: opts.chatId,
		onAssistantMessage: (message: AssistantMessage, step: number) =>
			opts.onStep(
				message.usage,
				// Provider-qualified stamp (model slots wave, 2026-09-20):
				// pi reports the bare id; usage stamps carry provider:id to
				// match the price table's uniform keys.
				`${message.provider}:${message.model}`,
				step,
				message.stopReason,
				message.content.filter((c) => c.type === "toolCall").map((c) => (c as { name: string }).name).join(", ") || "(none)",
			),
		shouldStop: (_message: AssistantMessage, toolResults: ToolResultMessage[]) =>
			toolResults.some((r) => r.toolName === opts.toolName && !r.isError),
	};

	const nudges = opts.submitNudges ?? 0;
	let transcript: AgentMessage[] | null = null;
	let malformed = false;
	try {
		transcript = (
			await runSubagent([...(opts.extraTools ? Object.values(healToolRecord(opts.extraTools)) : []), submitTool], {
				...runOptions,
				prompt: opts.prompt,
				maxTurns: opts.maxTurns ?? 4,
			})
		).newMessages;
	} catch (err) {
		if (nudges === 0 || !isMalformedCallError(err)) throw err;
		malformed = true;
	}
	for (let round = 0; !submitted && round < nudges; round++) {
		if (opts.signal?.aborted) break;
		const nudge = submitNudge(opts.toolName, lastProblem, malformed);
		const messages: AgentMessage[] = transcript
			? [...transcript, { role: "user", content: nudge, timestamp: Date.now() } as AgentMessage]
			: [{ role: "user", content: `${opts.prompt}\n\n${nudge}`, timestamp: Date.now() } as AgentMessage];
		malformed = false;
		try {
			transcript = (await runSubagent([submitTool], { ...runOptions, messages, maxTurns: 3 })).newMessages;
			// newMessages excludes the seeded input: keep the whole history.
			transcript = [...messages, ...transcript];
		} catch (err) {
			if (!isMalformedCallError(err)) throw err;
			malformed = true;
		}
	}
	if (!submitted) {
		if (lastProblem) console.info(`[${opts.toolName}] never accepted; last check: ${String(lastProblem).slice(0, 600)}`);
		throw new Error(opts.neverSubmitted);
	}
	return submitted;
}

/** Gemini's finish reasons for a tool call it could not form (huge or
 *  badly escaped arguments): the turn is lost, not the run. */
export function isMalformedCallError(err: unknown): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return /MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL|TOO_MANY_TOOL_CALLS/.test(message);
}

/** The "submit now" turn after a run that ended without a valid submit. */
export function submitNudge(toolName: string, lastProblem: string | null, malformed: boolean): string {
	const lines = [
		`You have not completed your task: nothing was accepted through ${toolName}. Call ${toolName} NOW with your complete answer.`,
		"Do not reply in prose and do not call any other tool: the submit call is the only thing that counts.",
	];
	if (malformed) lines.push("Your last call was malformed: send ONE call whose arguments are valid JSON matching the schema (escape backslashes in LaTeX).");
	if (lastProblem) lines.push(`Your last submission was refused for these reasons; fix exactly these:\n${lastProblem}`);
	return lines.join("\n");
}
