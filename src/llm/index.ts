/**
 * Socrates' model layer: the app's own message types, agent loop and the
 * Gemini provider (Google's official `@google/genai` SDK). Replaces the
 * former pi-ai and pi-agent-core packages. The agent loop, transcript and
 * event-stream helpers under ./vendor are adapted from those MIT-licensed
 * packages (see ./vendor/NOTICE).
 */
export * from "./types.ts";
export type {
	AfterToolCallContext,
	AfterToolCallResult,
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentState,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	BeforeToolCallContext,
	BeforeToolCallResult,
	FinishTurn,
	StreamFn,
	ThinkingLevel,
	ToolExecutionMode,
} from "./vendor/types.ts";
export { Agent } from "./vendor/agent.js";
export { AssistantMessageEventStream, EventStream, createAssistantMessageEventStream } from "./vendor/event-stream.js";
export { normalizeContext } from "./vendor/transcript.js";
export { validateToolArguments } from "./vendor/validation.js";
export { createFauxCore, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from "./vendor/faux.js";
export type { FauxResponseFactory, FauxResponseStep } from "./vendor/faux.js";
export {
	calculateCost,
	clampThinkingLevel,
	getModel,
	getSupportedThinkingLevels,
	listBakedModels,
	listDiscoveredModels,
	listModels,
	setDiscoveredModels,
} from "./catalog.ts";
export { streamGemini, streamSimpleGemini, transformMessages } from "./gemini.ts";
