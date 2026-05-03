export type LLMProvider = "openai" | "provider" | "gemini";

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export type ChatRole = "user" | "assistant" | "system" | "tool";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  /** Linked tool-call id when role === "tool" */
  toolCallId?: string;
  /** Tool name when role === "tool" */
  toolName?: string;
  /** Pending tool calls emitted by assistant during this turn */
  toolCalls?: ToolCall[];
  /** Optional structured trace produced by the agent runner */
  agentTrace?: AgentTrace;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  config?: Partial<LLMConfig>;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  onComplete: (fullText: string) => void;
  onError: (error: Error) => void;
  /** Native provider tool call, when the upstream API supports function tools. */
  onToolCall?: (call: ToolCall) => void;
}

export interface StreamOptions {
  tools?: ToolDefinition[];
  /** Some OpenAI-compatible vendors repeatedly emit native tool_calls with
   *  empty visible content after tool results. The agent can disable native
   *  tools on later ReAct turns and rely on its text JSON protocol instead. */
  nativeTools?: boolean;
}

// ---------------------------------------------------------------------------
// Agent / MCP-style tool primitives
// ---------------------------------------------------------------------------

/** JSON-Schema-lite describing a tool parameter. */
export interface ToolParameter {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  nullable?: boolean;
}

export interface ToolDefinition {
  /** Stable identifier — `domain.action` style is encouraged. */
  name: string;
  /** Short single-line description, shown to the LLM. */
  description: string;
  /** JSON-Schema-lite for the arguments object. */
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
}

/** A tool invocation emitted by the assistant model. */
export interface ToolCall {
  id: string;
  name: string;
  /** Already JSON-parsed arguments. */
  arguments: Record<string, unknown>;
  /** Raw arguments string as produced by the model (debug / display). */
  rawArguments?: string;
}

/** Result of executing a tool call. */
export interface ToolResult {
  toolCallId: string;
  toolName: string;
  /** True when execution succeeded — this does **not** imply the underlying
   *  ecl/e2txt operation succeeded; that is encoded in the payload. */
  ok: boolean;
  /** Compact JSON-friendly content shown to the model on the next turn. */
  content: unknown;
  /** Optional error message when ok=false. */
  error?: string;
  /** Wallclock duration in milliseconds. */
  durationMs: number;
}

/** A single step inside a ReAct trace: an assistant turn that may
 *  contain tool calls plus the tool results that followed. */
export interface AgentStep {
  index: number;
  /** Visible reasoning / answer tokens streamed from the assistant. */
  assistantText: string;
  /** Tool calls emitted by the assistant on this step (may be empty). */
  toolCalls: ToolCall[];
  /** Tool execution results — paired with `toolCalls` by `toolCallId`. */
  toolResults: ToolResult[];
  /** Reason this step ended: "tool_call" | "answer" | "stop" | "error" */
  finishReason: "tool_call" | "answer" | "stop" | "error" | "max_steps" | "format_retry";
  startedAt: number;
  endedAt: number;
}

/** Full agent execution trace, persisted on the assistant message. */
export interface AgentTrace {
  goal: string;
  steps: AgentStep[];
  finalAnswer: string;
  /** "answer" → 模型给出最终回答；"max_steps" → 达到上限；"error" → 异常 */
  outcome: "answer" | "max_steps" | "error" | "aborted";
  startedAt: number;
  endedAt: number;
  /** Total tool-call count across all steps. */
  toolCallCount: number;
}
