import type { AgentStep, AgentTrace, ChatMessage, ToolResult } from "@/types/llm";

const MAX_TRACE_COUNT = 4;
const MAX_TOOL_EVENTS_PER_TRACE = 14;
const MAX_CONTEXT_CHARS = 7_500;
const MAX_PATHS_PER_TRACE = 18;

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\btp-[A-Za-z0-9_-]{12,}\b/g,
  /(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._-]{12,}/gi,
  /("apiKey"\s*:\s*")[^"]+(")/gi,
];

const IMPORTANT_PAYLOAD_KEYS = new Set([
  "success",
  "source_path",
  "sourcePath",
  "file_path",
  "filePath",
  "path",
  "output_path",
  "outputPath",
  "ecode_dir",
  "ecodeDir",
  "encoding",
  "bytes",
  "truncated",
  "count",
  "exact_count",
  "indexed_count",
  "summary",
  "metrics",
  "findings",
  "duplicate_groups",
  "recommended_next_reads",
  "recommended_full_reads",
  "stage",
  "generated",
  "compiled",
  "module_paths_used",
  "error",
]);

function redactSecrets(text: string): string {
  let redacted = text;
  for (const pattern of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match, prefix?: string, suffix?: string) => {
      if (prefix && suffix) return `${prefix}[REDACTED]${suffix}`;
      if (prefix) return `${prefix}[REDACTED]`;
      return "[REDACTED]";
    });
  }
  return redacted;
}

function oneLine(text: string): string {
  return redactSecrets(text).replace(/\s+/g, " ").trim();
}

function limit(text: string, maxChars: number): string {
  const clean = oneLine(text);
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1))}…`;
}

function resultSucceeded(result: ToolResult | undefined): boolean {
  if (!result?.ok) return false;
  if (result.content && typeof result.content === "object" && !Array.isArray(result.content)) {
    const success = (result.content as Record<string, unknown>).success;
    if (success === false) return false;
  }
  return true;
}

function isPathKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("path") ||
    normalized.endsWith("dir") ||
    normalized === "files" ||
    normalized === "file"
  );
}

function looksLikeLocalPath(value: string): boolean {
  return /^[A-Za-z]:\\/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

function collectPaths(value: unknown, paths: Set<string>, parentKey = "", depth = 0): void {
  if (paths.size >= MAX_PATHS_PER_TRACE || depth > 5 || value == null) return;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((isPathKey(parentKey) || looksLikeLocalPath(trimmed)) && looksLikeLocalPath(trimmed)) {
      paths.add(redactSecrets(trimmed));
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, paths, parentKey, depth + 1);
    return;
  }

  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectPaths(child, paths, key, depth + 1);
    }
  }
}

function summarizePayloadValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return limit(value, 180);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `数组(${value.length})`;
  if (typeof value === "object") return `对象(${Object.keys(value).length})`;
  return null;
}

function summarizeToolResult(result: ToolResult | undefined): string {
  if (!result) return "未返回结果";

  const parts: string[] = [resultSucceeded(result) ? "成功" : "失败"];
  if (result.error) parts.push(`error=${limit(result.error, 180)}`);

  const content = result.content;
  if (content && typeof content === "object" && !Array.isArray(content)) {
    const payload = content as Record<string, unknown>;
    const entries = Object.entries(payload)
      .filter(([key]) => IMPORTANT_PAYLOAD_KEYS.has(key))
      .slice(0, 8);

    for (const [key, value] of entries) {
      const summary = summarizePayloadValue(value);
      if (summary) parts.push(`${key}=${summary}`);
    }

    const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
    const stderr = typeof payload.stderr === "string" ? payload.stderr : "";
    if (stderr.trim()) parts.push(`stderr=${limit(stderr, 240)}`);
    else if (stdout.trim()) parts.push(`stdout=${limit(stdout, 160)}`);
  } else if (typeof content === "string") {
    parts.push(limit(content, 220));
  }

  return parts.join("；");
}

function summarizeToolEvents(trace: AgentTrace): string[] {
  const events: string[] = [];

  for (const step of trace.steps) {
    for (let index = 0; index < step.toolCalls.length; index += 1) {
      const call = step.toolCalls[index];
      const result = step.toolResults[index];
      events.push(
        `S${step.index}.${index + 1} ${call.name}: ${summarizeToolResult(result)}`,
      );
      if (events.length >= MAX_TOOL_EVENTS_PER_TRACE) return events;
    }
  }

  return events;
}

function collectTracePaths(trace: AgentTrace): string[] {
  const paths = new Set<string>();
  for (const step of trace.steps) {
    for (const result of step.toolResults) {
      collectPaths(result.content, paths);
      collectPaths(result.error, paths);
    }
  }
  return [...paths].slice(0, MAX_PATHS_PER_TRACE);
}

function lastMeaningfulStep(trace: AgentTrace): AgentStep | null {
  for (let index = trace.steps.length - 1; index >= 0; index -= 1) {
    const step = trace.steps[index];
    if (
      step.toolCalls.length > 0 ||
      step.finishReason === "error" ||
      step.finishReason === "max_steps" ||
      step.assistantText.trim()
    ) {
      return step;
    }
  }
  return null;
}

function summarizeTrace(trace: AgentTrace, ordinal: number): string {
  const lines: string[] = [];
  const lastStep = lastMeaningfulStep(trace);
  const toolEvents = summarizeToolEvents(trace);
  const paths = collectTracePaths(trace);

  lines.push(`### 历史任务 ${ordinal}`);
  lines.push(`- 目标：${limit(trace.goal, 220)}`);
  lines.push(`- 结果：${trace.outcome}，工具调用 ${trace.toolCallCount} 次，步骤 ${trace.steps.length} 个`);
  if (lastStep) {
    const lastTools = lastStep.toolCalls.map((call) => call.name).join(", ");
    lines.push(
      `- 最近观察：第 ${lastStep.index} 步 ${lastStep.finishReason}` +
        (lastTools ? `，工具 ${lastTools}` : ""),
    );
  }
  if (trace.finalAnswer.trim()) {
    lines.push(`- 最终回复摘要：${limit(trace.finalAnswer, 320)}`);
  }
  if (paths.length > 0) {
    lines.push(`- 关键路径：${paths.join(" | ")}`);
  }
  if (toolEvents.length > 0) {
    lines.push("- 工具观察：");
    for (const event of toolEvents) lines.push(`  - ${event}`);
  }

  return lines.join("\n");
}

function traceMessages(history: ChatMessage[]): ChatMessage[] {
  return history
    .filter((message) => message.role === "assistant" && message.agentTrace)
    .slice(-MAX_TRACE_COUNT);
}

export function makeAgentMemoryMessage(history: ChatMessage[]): ChatMessage | null {
  const messages = traceMessages(history);
  if (messages.length === 0) return null;

  const traces = messages
    .map((message) => message.agentTrace)
    .filter((trace): trace is AgentTrace => Boolean(trace));

  if (traces.length === 0) return null;

  const body = [
    "【会话任务状态包】",
    "下面是本会话最近几次 Agent 执行的结构化压缩记录。它只提供事实上下文，不代表当前任务一定要继续上一轮；请结合当前用户消息、历史对话和工具结果自行判断下一步。",
    ...traces.map((trace, index) => summarizeTrace(trace, index + 1)),
  ].join("\n\n");

  return {
    id: "__agent_memory__",
    role: "user",
    content: limitMemory(body),
    timestamp: Date.now(),
  };
}

export function summarizeTraceForHistory(message: ChatMessage): string {
  if (!message.agentTrace) return message.content;

  const summary = [
    "【历史 Agent 回复已压缩】",
    summarizeTrace(message.agentTrace, 1),
  ].join("\n");

  return limitMemory(summary, 1_800);
}

function limitMemory(text: string, maxChars = MAX_CONTEXT_CHARS): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= maxChars) return redacted;
  const head = redacted.slice(0, Math.floor(maxChars * 0.68));
  const tail = redacted.slice(-Math.floor(maxChars * 0.24));
  return `${head}\n\n... [任务状态包已压缩，省略 ${redacted.length - maxChars} 字符] ...\n\n${tail}`;
}
