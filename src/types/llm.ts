export type LLMProvider = "deepseek";

export type LLMProtocol = "openai-chat-completions";

export interface LLMConfig {
  provider: LLMProvider;
  protocol: LLMProtocol;
  /** Kept for legacy provider fixtures; desktop account requests leave this empty. */
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
  /** Provider replay state for the current tool sequence; never shown as answer text. */
  reasoningContent?: string;
  /** Optional structured trace produced by the agent runner */
  agentTrace?: AgentTrace;
  /** Transient tool currently executing in this assistant turn. */
  activeToolCallId?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
  config?: Partial<LLMConfig>;
  workspacePath?: string;
}

export interface StreamCallbacks {
  onToken: (token: string) => void;
  /** Provider-supplied reasoning deltas, rendered separately from the answer. */
  onReasoningToken?: (token: string) => void;
  onComplete: (fullText: string, metadata?: { reasoningContent?: string }) => void;
  onError: (error: Error) => void;
  /** Native provider tool call, when the upstream API supports function tools. */
  onToolCall?: (call: ToolCall) => void;
}

export interface StreamOptions {
  tools?: ToolDefinition[];
  /** Disable only for structured reviewers that do not use tools. */
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

export interface AgentChoiceOption {
  id?: string;
  label: string;
  value?: string;
  description?: string;
}

export interface AgentUserChoiceRequest {
  question: string;
  options: AgentChoiceOption[];
  allowCustom?: boolean;
  context?: string;
}

/** A write/build tool call awaiting user approval before it executes. Only
 *  raised when the run is started with an approval callback (opt-in gate). */
export interface AgentApprovalRequest {
  toolName: string;
  /** Human-readable one-line description of what the call will do. */
  summary: string;
  /** Target file path when the call writes source (save_text_file /
   *  apply_search_replace), else undefined. */
  targetPath?: string;
  /** Unified-diff-ish preview of the pending change, when derivable. */
  diffPreview?: string;
  /** EL syntax pre-flight findings on the pending content (control-structure
   *  pairing, repeated statements). Surfaced so the user can reject a patch
   *  the compiler would later reject, before the expensive .e round-trip. */
  diagnostics?: string[];
}

/** User's answer to an AgentApprovalRequest. "pause" suspends the run until
 *  resume() is called; "reject" feeds a rejection note back to the model. */
export type AgentApprovalDecision =
  | { verdict: "approve" }
  | { verdict: "reject"; reason?: string }
  | { verdict: "pause" };

/** A single step inside a ReAct trace: an assistant turn that may
 *  contain tool calls plus the tool results that followed. */
export interface AgentStep {
  index: number;
  /** Visible reasoning / answer tokens streamed from the assistant. */
  assistantText: string;
  reasoningContent?: string;
  /** Tool calls emitted by the assistant on this step (may be empty). */
  toolCalls: ToolCall[];
  /** Tool execution results — paired with `toolCalls` by `toolCallId`. */
  toolResults: ToolResult[];
  /** Reason this step ended: "tool_call" | "answer" | "stop" | "error" */
  finishReason: "tool_call" | "answer" | "stop" | "error" | "max_steps" | "format_retry" | "needs_input";
  startedAt: number;
  endedAt: number;
}

export type AgentPlanItemStatus = "pending" | "in_progress" | "done" | "skipped";

/** One visible TODO item in the agent's execution plan. For EL tasks these
 *  map to closed-loop stages (parse → export → map → analyze → baseline →
 *  read → edit → build → verify), but the title is free-form. */
export interface AgentPlanItem {
  /** 1-based position, stable within a plan revision. */
  id: number;
  title: string;
  status: AgentPlanItemStatus;
}

/** The agent's self-declared plan, updated via the update_plan tool. */
export interface AgentPlan {
  items: AgentPlanItem[];
  updatedAt: number;
}

/** Full agent execution trace, persisted on the assistant message. */
export interface AgentTrace {
  goal: string;
  steps: AgentStep[];
  finalAnswer: string;
  /** "answer" → 模型给出最终回答；"max_steps" → 达到上限；"error" → 异常 */
  outcome: "answer" | "max_steps" | "error" | "aborted" | "needs_input";
  pendingUserChoice?: AgentUserChoiceRequest;
  /** Latest execution plan declared by the model (visible TODO checklist). */
  plan?: AgentPlan;
  startedAt: number;
  endedAt: number;
  /** Total tool-call count across all steps. */
  toolCallCount: number;
}
