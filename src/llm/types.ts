/**
 * Socrates' LLM types (formerly the pi-ai package's types). Trimmed to what the
 * app uses: Gemini is the only provider. Message/usage shapes are unchanged so
 * saved sessions keep loading.
 */
import type { TSchema } from "typebox";
import type { AssistantMessageEventStream } from "./vendor/event-stream.ts";

export type { AssistantMessageEventStream };
export type Api = "google-generative-ai" | (string & {});
export type ProviderId = "google" | (string & {});
export type ModelInputModality = "text" | "image";
export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ReasoningLevel = Exclude<ModelThinkingLevel, "off">;
export type ThinkingLevelMap = Partial<Record<ModelThinkingLevel, string | null>>;
export interface ModelCostRates { input: number; output: number; cacheRead: number; cacheWrite: number }
export interface ModelCostTier extends ModelCostRates { inputTokensAbove: number }
export interface ModelCost extends ModelCostRates { tiers?: ModelCostTier[] }
export interface ModelInputLimits { maxRequestBytes?: number }
export interface ClientIdentity { userAgent?: "short" | "detailed" | { custom: string }; attribution?: { name?: string; url?: string; categories?: string[] }; version?: string }
export interface AssistantMessageDiagnostic { type: string; timestamp: number; error?: { name?: string; message: string; stack?: string; code?: string | number }; details?: JsonObject }
export type ToolChoice = "auto" | "none";
export type ProviderEnv = Record<string, string>;
export interface ProviderResponse { status: number; headers: Record<string, string> }

/** Request options. Gemini honors apiKey, signal, sessionId (ignored), onPayload and onProviderStreamEvent. */
export interface StreamOptions {
    signal?: AbortSignal;
    apiKey?: string;
    onPayload?: (payload: unknown, model: Model<Api>) => unknown | undefined | Promise<unknown | undefined>;
    onResponse?: (response: ProviderResponse, model: Model<Api>) => void | Promise<void>;
    onProviderStreamEvent?: (data: unknown, model: Model<Api>) => void | Promise<void>;
    identity?: ClientIdentity;
    headers?: Record<string, string | null>;
    timeoutMs?: number;
    maxRetries?: number;
    temperature?: number;
    maxTokens?: number;
    sessionId?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
}
export interface SimpleStreamOptions extends StreamOptions {
    toolChoice?: ToolChoice;
    reasoning?: ReasoningLevel;
}
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (model: Model<TApi>, context: TranscriptContext, options?: TOptions) => AssistantMessageEventStream;
export interface TextSignatureV1 {
    v: 1;
    id: string;
    phase?: "commentary" | "final_answer";
}
export interface TextContent {
    type: "text";
    text: string;
    textSignature?: string;
}
export interface ThinkingContent {
    type: "thinking";
    thinking: string;
    thinkingSignature?: string;
    /** When true, the thinking content was redacted by safety filters. The opaque
     *  encrypted payload is stored in `thinkingSignature` so it can be passed back
     *  to the API for multi-turn continuity. */
    redacted?: boolean;
}
export interface ImageContent {
    type: "image";
    data: string;
    mimeType: string;
}
export interface ToolCall {
    type: "toolCall";
    id: string;
    name: string;
    arguments: JsonObject;
    thoughtSignature?: string;
    /** OpenAI Responses namespace for calls to dynamically loaded or namespaced tools. */
    namespace?: string;
    /**
     * Set when the model's complete arguments text was not a valid JSON object. `arguments` is then `{}`.
     * Describes the problem and includes the text the model sent; tool argument validation fails with it.
     */
    argumentsError?: string;
}
export interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    /** Subset of `cacheWrite` written with 1h retention. Only Anthropic reports this split. */
    cacheWrite1h?: number;
    /**
     * Reasoning/thinking tokens, when the provider reports them. This is a subset of
     * `output`: `output` already includes these tokens. Set to a number (possibly 0) by
     * providers that expose a reasoning breakdown; left undefined by providers that don't.
     */
    reasoning?: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
}
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = {
    [key: string]: JsonValue;
};
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsExactlyJsonValue<T> = [T] extends [JsonValue] ? ([JsonValue] extends [T] ? true : false) : false;
type IsJsonProperty<T> = IsAny<T> extends true ? false : unknown extends T ? false : [Exclude<T, undefined>] extends [never] ? true : IsJsonCompatible<Exclude<T, undefined>>;
type InvalidJsonKeys<T extends object> = {
    [TKey in keyof T]-?: TKey extends string | number ? (IsJsonProperty<T[TKey]> extends true ? never : TKey) : TKey;
}[keyof T];
type IsJsonCompatible<T> = IsAny<T> extends true ? false : unknown extends T ? false : IsExactlyJsonValue<T> extends true ? true : T extends null | boolean | number | string ? true : T extends undefined ? false : T extends readonly (infer TItem)[] ? IsJsonCompatible<TItem> : T extends (...args: never[]) => unknown ? false : T extends object ? [InvalidJsonKeys<T>] extends [never] ? true : false : false;
/** The JSON representation of a typed in-memory value. Optional object properties remain optional. */
export type JsonRepresentation<T> = IsAny<T> extends true ? JsonValue : unknown extends T ? JsonValue : [T] extends [JsonValue] ? T : T extends readonly unknown[] ? {
    [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>>;
} : T extends object ? {
    [TKey in keyof T]: JsonRepresentation<Exclude<T[TKey], undefined>>;
} : never;
export interface DeferredHandle {
    provider: string;
    modelId: string;
    api: string;
    /** Provider token, such as a response id or batch id plus row id. */
    id: string;
    expiresAt?: number;
    pollAfterMs?: number;
    /** Provider conversion data required to reconstruct the final assistant message. */
    data?: JsonValue;
}
/**
 * System instructions and tool declarations at one point in the transcript.
 *
 * The leading system message is the system prompt. Later system messages change it:
 * `content` adds instructions from that point on, `sections` replace or remove named
 * prompt sections, and `toolsAdded`/`toolsRemoved` change the tool set. Replaying
 * every system message in order yields the current prompt and tools. Providers that
 * accept system messages mid-conversation send each one in place; other providers
 * rebuild the leading system message from the replayed state.
 */
export interface SystemMessage {
    role: "system";
    /** Instruction text. On the leading message this is the base prompt; later, additional instructions. */
    content: string | TextContent[];
    /**
     * Named, ordered prompt sections rendered verbatim after `content`. The leading message
     * declares them; later messages replace sections by name, and `null` removes one. Keep
     * each section self-delimiting (a tag, a heading) so the model can relate an update to
     * the original. Avoid integer-like names; JSON objects reorder those.
     */
    sections?: Record<string, string | null>;
    /** Complete definitions of tools that become available at this point. */
    toolsAdded?: Tool[];
    /** Tools that stop being available at this point. */
    toolsRemoved?: ToolReference[];
    timestamp: number;
}
export interface UserMessage {
    role: "user";
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
}
export interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    api: Api;
    provider: ProviderId;
    model: string;
    responseModel?: string;
    responseId?: string;
    /** Exact provider-native effort level used for this response. Absent for legacy or unmanaged responses. */
    providerThinkingLevel?: string;
    /** Pi thinking level the agent loop requested for this response. Absent outside the agent loop and for legacy responses. */
    thinkingLevel?: ModelThinkingLevel;
    diagnostics?: AssistantMessageDiagnostic[];
    usage: Usage;
    stopReason: StopReason;
    deferred?: DeferredHandle;
    errorMessage?: string;
    rawStopReason?: string;
    /**
     * Provider indication of whether the model explicitly ended its turn.
     * Preserved for debugging and does not currently affect agent control flow.
     */
    endTurn?: boolean;
    /** Unix timestamp in milliseconds when the request started. */
    timestamp: number;
    /**
     * Milliseconds from `timestamp` until the response ended, measured with a monotonic clock. Set by
     * `AssistantMessageEventStream` on the final message of a response it saw start; absent for legacy messages and
     * for deferred results fetched later.
     */
    durationMs?: number;
}
/** A tool call that another tool made while it ran, for example from a codemode script. */
export interface NestedToolCallRecord {
    id: string;
    name: string;
    /** Omitted when over the size limits; `argumentsBytes` then gives their size. */
    arguments?: JsonObject;
    /** UTF-8 size of the arguments as JSON, set when `arguments` is omitted. */
    argumentsBytes?: number;
    /** `unfinished`: the call was still running when the calling tool finished. */
    status: "ok" | "error" | "unfinished";
    durationMs?: number;
    /** Error text, truncated. */
    error?: string;
}
/** Bounded record of the nested calls a tool made. Results are not recorded. */
export interface NestedToolCalls {
    calls: NestedToolCallRecord[];
    /** False when calls were dropped, arguments omitted, or calls had not finished. */
    complete: boolean;
}
export type ToolResultMessage<TDetails = JsonValue> = IsJsonCompatible<TDetails> extends true ? {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: (TextContent | ImageContent)[];
    details?: JsonRepresentation<TDetails>;
    /** Usage from the tool execution itself, if available. Not part of main LLM context accounting. */
    usage?: Usage;
    /** Calls this tool made to other tools. Kept for the session record; not sent to the model. */
    nestedCalls?: NestedToolCalls;
    isError: boolean;
    /** Unix timestamp in milliseconds when the result was created. */
    timestamp: number;
    /** Milliseconds the tool's execution took, measured with a monotonic clock. Absent for legacy results. */
    durationMs?: number;
} : never;
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
export interface Tool<TParameters extends TSchema = TSchema> {
    name: string;
    description: string;
    parameters: TParameters;
}
export interface ToolReference {
    name: string;
}
/**
 * Request input accepted by the public stream entry points (`Models.stream()`,
 * `streamSimple()`, ...). `systemPrompt` and `tools` are shorthand for a leading
 * system message; `normalizeContext()` folds them into one before the request
 * reaches a provider.
 */
export interface Context {
    systemPrompt?: string;
    messages: Message[];
    tools?: Tool[];
}
declare const transcriptContextBrand: unique symbol;
/**
 * Normalized request context passed to providers and API implementations. The
 * prompt and tool declarations are carried by the transcript's system messages.
 * Only `normalizeContext()` produces this type, so a raw `Context` cannot reach
 * provider code by accident.
 */
export type TranscriptContext = {
    messages: Message[];
    readonly [transcriptContextBrand]: true;
};
/**
 * Event protocol for AssistantMessageEventStream.
 *
 * Successful streams emit `start` before partial updates and terminate with
 * `done`. A stream may terminate directly with `error` when request setup fails
 * before generation starts; after `start`, failures also terminate with `error`.
 * Direct `streamSimple()` calls throw synchronously when request auth is missing.
 * Updates and `done` must never appear before `start`.
 *
 * `partial` is the shared live response-so-far helper, not an event-time
 * snapshot. Text and thinking blocks are empty when their `*_start` event is
 * emitted and grow only through their corresponding `*_delta` events until the
 * authoritative `*_end`. Redacted thinking may be complete at start and emit no
 * deltas. Tool-call arguments at `toolcall_start` are provider-specific;
 * `toolcall_delta` carries subsequent JSON updates.
 */
export type AssistantMessageEvent = {
    type: "start";
    partial: AssistantMessage;
} | {
    type: "text_start";
    contentIndex: number;
    partial: AssistantMessage;
} | {
    type: "text_delta";
    contentIndex: number;
    delta: string;
    partial: AssistantMessage;
} | {
    type: "text_end";
    contentIndex: number;
    content: string;
    partial: AssistantMessage;
} | {
    type: "thinking_start";
    contentIndex: number;
    partial: AssistantMessage;
} | {
    type: "thinking_delta";
    contentIndex: number;
    delta: string;
    partial: AssistantMessage;
} | {
    type: "thinking_end";
    contentIndex: number;
    content: string;
    partial: AssistantMessage;
} | {
    type: "toolcall_start";
    contentIndex: number;
    partial: AssistantMessage;
} | {
    type: "toolcall_delta";
    contentIndex: number;
    delta: string;
    partial: AssistantMessage;
} | {
    type: "toolcall_end";
    contentIndex: number;
    toolCall: ToolCall;
    partial: AssistantMessage;
} | {
    type: "done";
    reason: Extract<StopReason, "stop" | "length" | "toolUse" | "deferred">;
    message: AssistantMessage;
} | {
    type: "error";
    reason: Extract<StopReason, "aborted" | "error">;
    error: AssistantMessage;
};
/** Fields shared by every catalog entry, regardless of what you can do with it. */

export interface Model<TApi extends Api = Api> {
    id: string;
    name: string;
    api: TApi;
    provider: ProviderId;
    baseUrl: string;
    input: ModelInputModality[];
    inputLimits?: ModelInputLimits;
    cost: ModelCost;
    headers?: Record<string, string>;
    type?: "chat";
    reasoning: boolean;
    thinkingLevelMap?: ThinkingLevelMap;
    contextWindow: number;
    maxTokens: number;
}

export interface ThinkingBudgets { minimal?: number; low?: number; medium?: number; high?: number }
export type Transport = "sse" | "websocket" | "websocket-cached" | "auto";
export interface DeferredFetchOptions extends StreamOptions { wait?: number }
export type DeferredCancelOptions = StreamOptions;
