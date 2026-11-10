/** Type-only re-exports of the model layer's shapes, so the browser shell can
 *  name them through the pure core barrel (it may not import src/llm). */
export type { AgentEvent, ThinkingLevel, ToolResultMessage } from "../llm/index.ts";
