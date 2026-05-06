import type { AgentStep, AgentTrace, ToolResult } from "@/types/llm";

export interface AgentCheckpoint {
  id: string;
  goal: string;
  outcome: AgentTrace["outcome"];
  stepCount: number;
  toolCallCount: number;
  finalAnswerPreview: string;
  pendingChoiceQuestion?: string;
  lastStep?: {
    index: number;
    finishReason: AgentStep["finishReason"];
    assistantPreview: string;
    toolNames: string[];
    toolResults: Array<{
      toolName: string;
      ok: boolean;
      error?: string;
    }>;
  };
  updatedAt: number;
}

const CHECKPOINT_LIMIT = 20;
const PREVIEW_LIMIT = 1200;
const STORAGE_KEY = "eaicoding-agent-checkpoints";

function preview(text: string, limit = PREVIEW_LIMIT): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= limit) return compact;
  return `${compact.slice(0, limit - 1)}...`;
}

function summarizeToolResult(result: ToolResult | undefined) {
  return {
    toolName: result?.toolName ?? "unknown",
    ok: result?.ok ?? false,
    error: result?.error,
  };
}

export function createAgentCheckpoint(trace: AgentTrace): AgentCheckpoint {
  const lastStep = trace.steps.at(-1);
  return {
    id: `${trace.startedAt}:${trace.goal}`,
    goal: trace.goal,
    outcome: trace.outcome,
    stepCount: trace.steps.length,
    toolCallCount: trace.toolCallCount,
    finalAnswerPreview: preview(trace.finalAnswer),
    pendingChoiceQuestion: trace.pendingUserChoice?.question,
    lastStep: lastStep
      ? {
          index: lastStep.index,
          finishReason: lastStep.finishReason,
          assistantPreview: preview(lastStep.assistantText, 800),
          toolNames: lastStep.toolCalls.map((call) => call.name),
          toolResults: lastStep.toolResults.map(summarizeToolResult),
        }
      : undefined,
    updatedAt: Date.now(),
  };
}

function readCheckpoints(): AgentCheckpoint[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveAgentCheckpoint(trace: AgentTrace): void {
  if (typeof localStorage === "undefined") return;
  const checkpoint = createAgentCheckpoint(trace);
  const rest = readCheckpoints().filter((item) => item.id !== checkpoint.id);
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify([checkpoint, ...rest].slice(0, CHECKPOINT_LIMIT)),
  );
}

export function getAgentCheckpoints(): AgentCheckpoint[] {
  return readCheckpoints();
}

export function clearAgentCheckpoints(): void {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}
