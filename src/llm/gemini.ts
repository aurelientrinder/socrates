/**
 * Gemini streaming over Google's official SDK (`@google/genai`): the only
 * model provider in Socrates. Converts the app's transcript (messages with
 * thinking blocks, tool calls and results) to Gemini `contents`, streams
 * `generateContentStream`, and maps the chunks back to the app's
 * AssistantMessage events.
 */
import {
	FinishReason,
	FunctionCallingConfigMode,
	GoogleGenAI,
	ThinkingLevel as SdkThinkingLevel,
	type Content,
	type GenerateContentParameters,
	type Part,
} from "@google/genai";
import { calculateCost, clampThinkingLevel, GOOGLE_API, GOOGLE_PROVIDER } from "./catalog.ts";
import type {
	Api,
	AssistantMessage,
	JsonObject,
	Message,
	Model,
	ReasoningLevel,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	Tool,
	ToolCall,
	TranscriptContext,
} from "./types.ts";
import { AssistantMessageEventStream } from "./vendor/event-stream.js";
import { getSystemMessageText } from "./vendor/text.js";
import { collapseSystemMessages, getCurrentTools, getInitialSystemMessage, withoutInitialSystemMessage } from "./vendor/transcript.js";

// ─── helpers ────────────────────────────────────────────────────────────────

/** Unpaired surrogates break JSON serialization on the wire. */
export function sanitizeSurrogates(text: string): string {
	return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

/** The API key: explicit option, else the environment (the keys seam reflects saved keys into env). */
export function geminiApiKey(explicit?: string): string | undefined {
	return explicit || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined;
}

function geminiMajorVersion(modelId: string): number | undefined {
	const match = modelId.toLowerCase().match(/^gemini(?:-live)?-(\d+)/);
	return match ? Number.parseInt(match[1]!, 10) : undefined;
}

/** Gemini 3+ requires explicit function call ids in replayed calls/responses. */
function requiresToolCallId(modelId: string): boolean {
	const major = geminiMajorVersion(modelId);
	return major !== undefined && major >= 3;
}

function supportsMultimodalFunctionResponse(modelId: string): boolean {
	const major = geminiMajorVersion(modelId);
	return major === undefined ? true : major >= 3;
}

/** Whether the model takes Gemini's discrete `thinkingLevel` instead of a token budget. */
function usesThinkingLevel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	return (
		/gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
		/gemini-(?:[4-9]|[1-9]\d)/.test(id) ||
		id === "gemini-flash-latest" ||
		id === "gemini-flash-lite-latest" ||
		/gemma-?4/.test(id)
	);
}

const SDK_LEVEL: Record<string, SdkThinkingLevel> = {
	minimal: SdkThinkingLevel.MINIMAL,
	low: SdkThinkingLevel.LOW,
	medium: SdkThinkingLevel.MEDIUM,
	high: SdkThinkingLevel.HIGH,
};

function resolveLevel(model: Model<Api>, level: string): string {
	const mapped = model.thinkingLevelMap?.[level as keyof NonNullable<Model<Api>["thinkingLevelMap"]>];
	const resolved = typeof mapped === "string" ? mapped.toLowerCase() : level;
	if (!(resolved in SDK_LEVEL)) {
		throw new Error(`Unsupported Gemini thinking level for ${model.id}: ${level} -> ${String(mapped)}`);
	}
	return resolved;
}

function tokenBudget(modelId: string, level: string): number {
	const table = (minimal: number, low: number, medium: number, high: number) => ({ minimal, low, medium, high }) as Record<string, number>;
	if (modelId.includes("2.5-pro")) return table(128, 2048, 8192, 32768)[level] ?? -1;
	if (modelId.includes("2.5-flash-lite")) return table(512, 2048, 8192, 24576)[level] ?? -1;
	if (modelId.includes("2.5-flash")) return table(128, 2048, 8192, 24576)[level] ?? -1;
	return -1;
}

// Thought signatures must be base64 (TYPE_BYTES).
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
function validSignature(signature: string | undefined, sameModel: boolean): string | undefined {
	if (!sameModel || !signature || signature.length % 4 !== 0 || !BASE64.test(signature)) return undefined;
	return signature;
}

/** Google's documented dummy signature: it satisfies the "functionCall parts
 *  need a thought_signature" check for calls that carry no real one. */
export const GEMINI_SKIP_SIGNATURE = "skip_thought_signature_validator";

/** Gemini 3 thinking models reject any replayed functionCall part that has
 *  no thoughtSignature (HTTP 400). A chat that switched models (or holds a
 *  pre-signature record) would fail on its first tool call, so fill the gap
 *  with the documented dummy; real signatures are left untouched. Pure;
 *  mutates the payload in place and returns it. */
export function fillGeminiThoughtSignatures(payload: unknown): unknown {
	const contents = (payload as { contents?: unknown } | null)?.contents;
	if (!Array.isArray(contents)) return payload;
	for (const turn of contents) {
		const parts = (turn as { role?: string; parts?: unknown } | null)?.parts;
		if (!Array.isArray(parts) || (turn as { role?: string }).role !== "model") continue;
		for (const part of parts) {
			const p = part as { functionCall?: unknown; thoughtSignature?: string };
			if (p?.functionCall && !p.thoughtSignature) p.thoughtSignature = GEMINI_SKIP_SIGNATURE;
		}
	}
	return payload;
}

// ─── transcript → Gemini contents ───────────────────────────────────────────

const NON_VISION_USER_IMAGE = "(image omitted: model does not support images)";
const NON_VISION_TOOL_IMAGE = "(tool image omitted: model does not support images)";

type Block = { type: string; text?: string; [k: string]: unknown };

function replaceImages<T extends Block>(content: T[], placeholder: string): T[] {
	const out: T[] = [];
	let prevPlaceholder = false;
	for (const block of content) {
		if (block.type === "image") {
			if (!prevPlaceholder) out.push({ type: "text", text: placeholder } as T);
			prevPlaceholder = true;
			continue;
		}
		out.push(block);
		prevPlaceholder = block.text === placeholder;
	}
	return out;
}

/** Normalize a transcript for replay: image downgrade for non-vision models,
 *  cross-model thinking/signature drop, id normalization, synthetic results
 *  for orphaned tool calls, and errored/aborted assistant turns skipped. */
export function transformMessages(messages: Message[], model: Model<Api>, normalizeToolCallId?: (id: string) => string): Message[] {
	const idMap = new Map<string, string>();
	const withContent = messages.map((m) => ((m as { content?: unknown }).content == null ? ({ ...m, content: [] } as Message) : m));
	const imageAware = model.input.includes("image")
		? withContent
		: withContent.map((m) => {
				if (m.role === "user" && Array.isArray(m.content)) return { ...m, content: replaceImages(m.content as Block[], NON_VISION_USER_IMAGE) } as Message;
				if (m.role === "toolResult") return { ...m, content: replaceImages(m.content as Block[], NON_VISION_TOOL_IMAGE) } as Message;
				return m;
			});

	const transformed = imageAware.map((msg): Message => {
		if (msg.role === "system" || msg.role === "user") return msg;
		if (msg.role === "toolResult") {
			const normalized = idMap.get(msg.toolCallId);
			return normalized && normalized !== msg.toolCallId ? { ...msg, toolCallId: normalized } : msg;
		}
		const assistant = msg as AssistantMessage;
		const sameModel = assistant.provider === model.provider && assistant.api === model.api && assistant.model === model.id;
		const content = assistant.content.flatMap((block) => {
			if (block.type === "thinking") {
				if (!sameModel) return [];
				if (block.redacted || block.thinkingSignature) return block;
				if (!block.thinking || block.thinking.trim() === "") return [];
				return block;
			}
			if (block.type === "text") return sameModel ? block : { type: "text" as const, text: block.text };
			if (block.type === "toolCall") {
				let call: ToolCall = block;
				if (!sameModel && call.thoughtSignature) {
					call = { ...call };
					delete call.thoughtSignature;
				}
				if (!sameModel && normalizeToolCallId) {
					const id = normalizeToolCallId(block.id);
					if (id !== block.id) {
						idMap.set(block.id, id);
						call = { ...call, id };
					}
				}
				return call;
			}
			return block;
		});
		return { ...assistant, content };
	});

	const result: Message[] = [];
	let pending: ToolCall[] = [];
	let answered = new Set<string>();
	const heldSystem: Message[] = [];
	const closePending = () => {
		for (const call of pending) {
			if (!answered.has(call.id)) {
				result.push({
					role: "toolResult",
					toolCallId: call.id,
					toolName: call.name,
					content: [{ type: "text", text: "No result provided" }],
					isError: true,
					timestamp: Date.now(),
				});
			}
		}
		pending = [];
		answered = new Set();
		result.push(...heldSystem);
		heldSystem.length = 0;
	};
	for (const msg of transformed) {
		if (msg.role === "assistant") {
			closePending();
			if (msg.stopReason === "error" || msg.stopReason === "aborted") continue;
			const calls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
			if (calls.length > 0) {
				pending = calls;
				answered = new Set();
			}
			result.push(msg);
		} else if (msg.role === "toolResult") {
			answered.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "system") {
			if (pending.length > 0) heldSystem.push(msg);
			else result.push(msg);
		} else {
			closePending();
			result.push(msg);
		}
	}
	closePending();
	return result;
}

export function convertMessages(model: Model<Api>, context: TranscriptContext): Content[] {
	const conversation = withoutInitialSystemMessage(collapseSystemMessages(context).messages) as Message[];
	const contents: Content[] = [];
	const needsId = requiresToolCallId(model.id);
	const normalizeId = (id: string) => (needsId ? id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) : id);

	for (const msg of transformMessages(conversation, model, normalizeId)) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				contents.push({ role: "user", parts: [{ text: sanitizeSurrogates(msg.content) }] });
			} else {
				const parts: Part[] = msg.content.map((item) =>
					item.type === "text" ? { text: sanitizeSurrogates(item.text) } : { inlineData: { mimeType: item.mimeType, data: item.data } },
				);
				if (parts.length > 0) contents.push({ role: "user", parts });
			}
		} else if (msg.role === "assistant") {
			const parts: Part[] = [];
			const same = msg.provider === model.provider && msg.model === model.id;
			for (const block of msg.content) {
				if (block.type === "text") {
					const signature = validSignature(block.textSignature, same);
					if ((!block.text || block.text.trim() === "") && !signature) continue;
					parts.push({ text: sanitizeSurrogates(block.text), ...(signature && { thoughtSignature: signature }) });
				} else if (block.type === "thinking") {
					const signature = validSignature(block.thinkingSignature, same);
					if ((!block.thinking || block.thinking.trim() === "") && !signature) continue;
					if (same) parts.push({ thought: true, text: sanitizeSurrogates(block.thinking), ...(signature && { thoughtSignature: signature }) });
					else parts.push({ text: sanitizeSurrogates(block.thinking) });
				} else if (block.type === "toolCall") {
					const signature = validSignature(block.thoughtSignature, same);
					parts.push({
						functionCall: { name: block.name, args: block.arguments ?? {}, ...(needsId ? { id: block.id } : {}) },
						...(signature && { thoughtSignature: signature }),
					});
				}
			}
			if (parts.length > 0) contents.push({ role: "model", parts });
		} else if (msg.role === "toolResult") {
			const text = msg.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n");
			const images = model.input.includes("image") ? msg.content.filter((c) => c.type === "image") : [];
			const hasText = text.trim().length > 0;
			const imageParts: Part[] = images.map((b) => ({ inlineData: { mimeType: (b as { mimeType: string }).mimeType, data: (b as { data: string }).data } }));
			const value = hasText ? sanitizeSurrogates(text) : images.length > 0 ? "(see attached image)" : "";
			const multimodal = supportsMultimodalFunctionResponse(model.id);
			const responsePart: Part = {
				functionResponse: {
					name: msg.toolName,
					response: msg.isError ? { error: value } : { output: value },
					...(images.length > 0 && multimodal ? { parts: imageParts as never } : {}),
					...(needsId ? { id: msg.toolCallId } : {}),
				},
			};
			const last = contents[contents.length - 1];
			if (last?.role === "user" && last.parts?.some((p) => p.functionResponse)) last.parts.push(responsePart);
			else contents.push({ role: "user", parts: [responsePart] });
			if (images.length > 0 && !multimodal) contents.push({ role: "user", parts: [{ text: "Tool result image:" }, ...imageParts] });
		}
	}
	return contents;
}

export function convertTools(tools: Tool[]) {
	if (tools.length === 0) return undefined;
	return [
		{
			functionDeclarations: tools.map((tool) => ({
				name: tool.name,
				description: tool.description,
				parametersJsonSchema: tool.parameters,
			})),
		},
	];
}

function mapStopReason(reason: FinishReason): StopReason {
	if (reason === FinishReason.STOP) return "stop";
	if (reason === FinishReason.MAX_TOKENS) return "length";
	return "error";
}

// ─── request + stream ───────────────────────────────────────────────────────

interface Thinking {
	enabled: boolean;
	level?: string;
	budgetTokens?: number;
}

function buildParams(model: Model<Api>, context: TranscriptContext, options: SimpleStreamOptions & { thinking?: Thinking }): GenerateContentParameters {
	const normalized = collapseSystemMessages(context);
	const contents = convertMessages(model, normalized);
	const initial = getInitialSystemMessage(normalized.messages);
	const tools = getCurrentTools(normalized.messages);
	const systemInstruction = initial ? getSystemMessageText(initial) : "";
	const config: NonNullable<GenerateContentParameters["config"]> = {};
	if (options.temperature !== undefined) config.temperature = options.temperature;
	config.maxOutputTokens = options.maxTokens ?? model.maxTokens;
	if (systemInstruction) config.systemInstruction = sanitizeSurrogates(systemInstruction);
	if (tools.length > 0) {
		config.tools = convertTools(tools) as never;
		if (options.toolChoice === "none") config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
		else if (options.toolChoice === "auto") config.toolConfig = { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
	}
	if (model.reasoning && options.thinking) {
		if (options.thinking.enabled) {
			const thinkingConfig: Record<string, unknown> = { includeThoughts: true };
			if (options.thinking.level !== undefined) thinkingConfig.thinkingLevel = SDK_LEVEL[options.thinking.level];
			else if (options.thinking.budgetTokens !== undefined) thinkingConfig.thinkingBudget = options.thinking.budgetTokens;
			config.thinkingConfig = thinkingConfig as never;
		} else if (!usesThinkingLevel(model.id)) {
			config.thinkingConfig = { thinkingBudget: 0 };
		} else {
			const fallback = clampThinkingLevel(model, "off");
			config.thinkingConfig = (fallback === "off" ? { thinkingBudget: 0 } : { thinkingLevel: SDK_LEVEL[resolveLevel(model, fallback)] }) as never;
		}
	}
	if (options.signal) {
		if (options.signal.aborted) throw new Error("Request aborted");
		config.abortSignal = options.signal;
	}
	return { model: model.id, contents, config };
}

let toolCallCounter = 0;

export const streamGemini: StreamFunction<Api, SimpleStreamOptions & { thinking?: Thinking }> = (model, context, options) => {
	const stream = new AssistantMessageEventStream();
	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: GOOGLE_API,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "pending",
			timestamp: Date.now(),
		};
		try {
			const apiKey = geminiApiKey(options?.apiKey);
			if (!apiKey) throw new Error("No Gemini API key: add one in Settings > API keys");
			const headers: Record<string, string> = {};
			const ua = options?.identity?.userAgent;
			if (typeof ua === "object" && ua !== null) headers["User-Agent"] = ua.custom;
			for (const [k, v] of Object.entries(options?.headers ?? {})) if (typeof v === "string") headers[k] = v;
			const client = new GoogleGenAI({
				apiKey,
				httpOptions: {
					...(model.baseUrl ? { baseUrl: model.baseUrl, apiVersion: "" } : {}),
					...(Object.keys(headers).length > 0 ? { headers } : {}),
				},
			});
			let params = buildParams(model, context, options ?? {});
			const next = await options?.onPayload?.(params, model);
			if (next !== undefined) params = next as GenerateContentParameters;

			const googleStream = await client.models.generateContentStream(params);
			stream.push({ type: "start", partial: output });

			type Current = { type: "text"; text: string; textSignature?: string } | { type: "thinking"; thinking: string; thinkingSignature?: string };
			let current: Current | null = null;
			const idx = () => output.content.length - 1;
			const closeCurrent = () => {
				if (!current) return;
				if (current.type === "text") stream.push({ type: "text_end", contentIndex: idx(), content: current.text, partial: output });
				else stream.push({ type: "thinking_end", contentIndex: idx(), content: current.thinking, partial: output });
				current = null;
			};
			const keep = (existing: string | undefined, incoming: string | undefined) => (incoming && incoming.length > 0 ? incoming : existing);

			for await (const chunk of googleStream) {
				await options?.onProviderStreamEvent?.(chunk, model);
				output.responseId ||= chunk.responseId;
				const candidate = chunk.candidates?.[0];
				for (const part of candidate?.content?.parts ?? []) {
					if (part.text !== undefined) {
						const isThinking = part.thought === true;
						if (!current || (isThinking && current.type !== "thinking") || (!isThinking && current.type !== "text")) {
							closeCurrent();
							if (isThinking) {
								current = { type: "thinking", thinking: "", thinkingSignature: undefined };
								output.content.push(current);
								stream.push({ type: "thinking_start", contentIndex: idx(), partial: output });
							} else {
								current = { type: "text", text: "" };
								output.content.push(current);
								stream.push({ type: "text_start", contentIndex: idx(), partial: output });
							}
						}
						if (current.type === "thinking") {
							current.thinking += part.text;
							current.thinkingSignature = keep(current.thinkingSignature, part.thoughtSignature);
							stream.push({ type: "thinking_delta", contentIndex: idx(), delta: part.text, partial: output });
						} else {
							current.text += part.text;
							current.textSignature = keep(current.textSignature, part.thoughtSignature);
							stream.push({ type: "text_delta", contentIndex: idx(), delta: part.text, partial: output });
						}
					}
					if (part.functionCall) {
						closeCurrent();
						const provided = part.functionCall.id;
						const clash = !provided || output.content.some((b) => b.type === "toolCall" && b.id === provided);
						const toolCall: ToolCall = {
							type: "toolCall",
							id: clash ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}` : provided!,
							name: part.functionCall.name || "",
							arguments: (part.functionCall.args ?? {}) as JsonObject,
							...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
						};
						output.content.push(toolCall);
						stream.push({ type: "toolcall_start", contentIndex: idx(), partial: output });
						stream.push({ type: "toolcall_delta", contentIndex: idx(), delta: JSON.stringify(toolCall.arguments), partial: output });
						stream.push({ type: "toolcall_end", contentIndex: idx(), toolCall, partial: output });
					}
				}
				if (candidate?.finishReason) {
					output.rawStopReason = candidate.finishReason;
					output.stopReason = mapStopReason(candidate.finishReason);
					if (output.stopReason === "stop" && output.content.some((b) => b.type === "toolCall")) output.stopReason = "toolUse";
				}
				const u = chunk.usageMetadata;
				if (u) {
					output.usage = {
						input: (u.promptTokenCount || 0) - (u.cachedContentTokenCount || 0),
						output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
						cacheRead: u.cachedContentTokenCount || 0,
						cacheWrite: 0,
						reasoning: u.thoughtsTokenCount || 0,
						totalTokens: u.totalTokenCount || 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					};
					calculateCost(model, output.usage);
				}
			}
			closeCurrent();
			if (options?.signal?.aborted) throw new Error("Request was aborted");
			if (output.stopReason === "pending") throw new Error("Gemini stream ended without a finish reason");
			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.rawStopReason ? `Provider stopped with: ${output.rawStopReason}` : "An unknown error occurred");
			}
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason as "aborted" | "error", error: output });
			stream.end();
		}
	})();
	return stream;
};

/** Reasoning-level aware entry point (what the agent loop calls). */
export const streamSimpleGemini: StreamFunction<Api, SimpleStreamOptions> = (model, context, options) => {
	const base = { ...options, toolChoice: options?.toolChoice };
	const reasoning: ReasoningLevel | undefined = options?.reasoning;
	if (!reasoning) return streamGemini(model, context, { ...base, thinking: { enabled: false } });
	const clamped = clampThinkingLevel(model, reasoning);
	if (clamped === "off") return streamGemini(model, context, { ...base, thinking: { enabled: false } });
	const level = resolveLevel(model, clamped);
	if (usesThinkingLevel(model.id)) return streamGemini(model, context, { ...base, thinking: { enabled: true, level } });
	return streamGemini(model, context, { ...base, thinking: { enabled: true, budgetTokens: tokenBudget(model.id, level) } });
};

export { GOOGLE_PROVIDER };
