/**
 * THE ASIDE CALL (2026-11-04): the learner asks the tutor something while a
 * quiz question is still waiting. One tool-less model call answers at once
 * from the session so far; the question stays open and the exchange lands
 * in the record's asides log (core/asides.ts), never in `messages`.
 *
 * Not a turn: no beginTurn, no write-ahead, no extraction. The call is
 * refused (409) when no question is open or a turn is running, and the
 * client falls back to its normal send / steer paths.
 */
import type { Usage } from "@earendil-works/pi-ai";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import { piEngineForSpec } from "../agent/models.ts";
import {
	ASIDE_MAX_CHARS,
	ASIDE_SYSTEM_PROMPT,
	asidesForQuestion,
	buildAsidePrompt,
	danglingQuestionOf,
	serializeForSummary,
	type ChatAside,
} from "../core/index.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing } from "../core/settings.ts";
import { providerKeyPresent } from "./keys.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";

/** How much of the session the call reads (characters, newest kept). */
const TRANSCRIPT_MAX_CHARS = 90_000;

export interface AsideInput {
	id: string;
	text: string;
}

export function parseAsideInput(input: unknown): AsideInput | string {
	if (typeof input !== "object" || input === null) return "input must be an object";
	const i = input as Record<string, unknown>;
	if (typeof i.id !== "string" || i.id.length === 0) return "aside input requires a client-minted id";
	if (typeof i.text !== "string" || i.text.trim().length === 0) return "aside input requires non-empty text";
	if (i.text.length > ASIDE_MAX_CHARS) return `aside text is limited to ${ASIDE_MAX_CHARS} characters`;
	return { id: i.id, text: i.text.trim() };
}

export async function handleAside(chatId: string, input: AsideInput): Promise<Response> {
	const record = stores.chatStore.getChat(chatId);
	if (!record) return Response.json({ error: "unknown chat" }, { status: 404 });
	const pending = danglingQuestionOf(record.messages);
	if (!pending) return Response.json({ error: "no open question" }, { status: 409 });
	if (isTurnRunning(chatId)) return Response.json({ error: "a turn is running" }, { status: 409 });
	// A re-sent id answers from the log, never a second model call.
	const existing = record.asides?.find((a) => a.id === input.id);
	if (existing) return Response.json({ aside: existing });

	const conversation = resolveConversationSpec(record.settings, effectiveSettings().models.strong);
	if (!conversation) return Response.json(modelsNotConfigured(["strong"]), { status: 503 });
	if (!providerKeyPresent(conversation.provider)) {
		return Response.json(providerKeyMissing(conversation.provider, ["strong"]), { status: 503 });
	}
	let engine;
	try {
		engine = piEngineForSpec(conversation, false);
	} catch {
		return Response.json({ error: "The selected model is unavailable." }, { status: 503 });
	}

	let transcript = serializeForSummary(record.messages);
	if (transcript.length > TRANSCRIPT_MAX_CHARS) transcript = `…${transcript.slice(-TRANSCRIPT_MAX_CHARS)}`;
	const prompt = buildAsidePrompt({
		transcript,
		openQuestion: JSON.stringify(pending.input),
		earlier: asidesForQuestion(record.asides, pending.toolCallId),
		text: input.text,
	});

	const steps: Usage[] = [];
	let reply: string;
	try {
		const { text } = await runSubagent([], {
			// One-shot text job on the chat's own conversation engine; the
			// role label only names the job (the engine override always wins).
			role: "researcher" as never,
			prompt,
			engine,
			systemPrompt: ASIDE_SYSTEM_PROMPT,
			maxTurns: 1,
			onUsage: (u) => steps.push(u),
		});
		reply = text.trim();
	} catch (err) {
		console.error(`[chat ${chatId}] aside failed:`, err);
		return Response.json({ error: (err as Error).message || "The tutor could not answer." }, { status: 502 });
	}
	if (!reply) return Response.json({ error: "The tutor returned an empty answer." }, { status: 502 });

	const aside: ChatAside = {
		id: input.id,
		questionCallId: pending.toolCallId,
		text: input.text,
		reply,
		at: new Date().toISOString(),
	};
	stores.chatStore.appendAside(chatId, aside);
	if (steps.length > 0) {
		// Real spend: it joins the usage log under its own turn id. The
		// provenance message is the question's assistant message.
		const owner = [...record.messages].reverse().find((m) => (m as { role?: string }).role === "assistant");
		stores.chatStore.appendTurnUsage(chatId, {
			id: `aside_${input.id}`,
			messageId: (owner as { id?: string } | undefined)?.id ?? input.id,
			at: aside.at,
			model: `${engine.model.provider}:${engine.model.id}`,
			steps: steps.map((u) => ({
				inputTokens: u.input,
				outputTokens: u.output,
				cacheReadTokens: u.cacheRead,
				cacheWriteTokens: u.cacheWrite,
				cacheWrite1hTokens: u.cacheWrite1h ?? 0,
				reasoningTokens: u.reasoning ?? 0,
			})),
		});
	}
	return Response.json({ aside });
}
