import type { ToolCall } from "@/types/llm";

export function buildOpenAIEndpoint(
  baseUrl: string,
  endpoint: "chat/completions" | "responses",
): string {
  const cleanEndpoint = endpoint.replace(/^\/+/, "");
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return `/${cleanEndpoint}`;

  try {
    const url = new URL(trimmed);
    const knownSuffixes = [
      "/chat/completions",
      "/responses",
      "/messages",
      "/models",
    ];
    const lowerPath = url.pathname.replace(/\/+$/, "").toLowerCase();
    const matchedSuffix = knownSuffixes.find((suffix) => lowerPath.endsWith(suffix));
    if (matchedSuffix) {
      url.pathname = url.pathname.slice(0, url.pathname.length - matchedSuffix.length);
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/${cleanEndpoint}`;
      return url.toString();
    }
  } catch {
    // Request layer will report invalid custom URLs.
  }

  const lowerTrimmed = trimmed.toLowerCase();
  if (lowerTrimmed.endsWith(`/${cleanEndpoint.toLowerCase()}`)) return trimmed;
  return `${trimmed}/${cleanEndpoint}`;
}

export function parseOpenAIResponseText(text: string): { text: string; toolCalls: ToolCall[] } {
  const payloads = text.includes("data:")
    ? parseSseJsonEvents(text).filter((json) => !isOpenAIUsageOnlyChunk(json))
    : [safeParseJson(text)];
  return {
    text: payloads.map(extractTextFromOpenAIJson).join(""),
    toolCalls: payloads.flatMap(extractToolCallsFromOpenAIJson),
  };
}

export function parseSseJsonEvents(text: string): unknown[] {
  const events: unknown[] = [];
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const json = parseSseJsonBlock(block);
    if (json !== null) events.push(json);
  }
  return events;
}

export function createSseJsonEventParser(onEvent: (json: unknown) => void): {
  feed: (chunk: string) => void;
  flush: () => void;
} {
  let buffer = "";

  const consumeBlock = (block: string) => {
    const json = parseSseJsonBlock(block);
    if (json !== null) onEvent(json);
  };

  return {
    feed(chunk: string) {
      buffer += chunk;
      while (true) {
        const boundary = findSseBoundary(buffer);
        if (!boundary) break;
        consumeBlock(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary.length);
      }
    },
    flush() {
      if (buffer.trim()) consumeBlock(buffer);
      buffer = "";
    },
  };
}

function findSseBoundary(text: string): { index: number; length: number } | null {
  const lf = text.indexOf("\n\n");
  const crlf = text.indexOf("\r\n\r\n");
  if (lf === -1 && crlf === -1) return null;
  if (lf === -1) return { index: crlf, length: 4 };
  if (crlf === -1) return { index: lf, length: 2 };
  return crlf <= lf ? { index: crlf, length: 4 } : { index: lf, length: 2 };
}

function parseSseJsonBlock(block: string): unknown | null {
  const data = block
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.replace(/^data:\s?/, ""))
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

export function isOpenAIUsageOnlyChunk(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const obj = json as Record<string, unknown>;
  const choices = Array.isArray(obj.choices) ? obj.choices : null;
  return Boolean(choices && choices.length === 0 && obj.usage);
}

export function extractTextFromOpenAIJson(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const obj = json as Record<string, unknown>;

  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const choiceTexts = choices
    .map((choice) => {
      if (!choice || typeof choice !== "object") return "";
      const entry = choice as Record<string, unknown>;
      const message = entry.message as Record<string, unknown> | undefined;
      const delta = entry.delta as Record<string, unknown> | undefined;
      return [
        extractTextValue(message?.content),
        extractTextValue(delta?.content),
        extractTextValue(entry.text),
      ].join("");
    })
    .join("");
  if (choiceTexts) return choiceTexts;

  for (const key of ["output_text", "text", "content"]) {
    const text = extractTextValue(obj[key]);
    if (text) return text;
  }

  const output = Array.isArray(obj.output) ? obj.output : [];
  const outputText = output.map((item) => {
    if (!item || typeof item !== "object") return "";
    const entry = item as Record<string, unknown>;
    return [
      extractTextValue(entry.content),
      extractTextValue(entry.text),
      extractTextValue(entry.summary),
    ].join("");
  }).join("");
  if (outputText) return outputText;

  return "";
}

export function extractToolCallsFromOpenAIJson(json: unknown): ToolCall[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;

  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const choiceToolCalls = choices.flatMap((choice) => {
    if (!choice || typeof choice !== "object") return [];
    const entry = choice as Record<string, unknown>;
    const message = entry.message as Record<string, unknown> | undefined;
    const delta = entry.delta as Record<string, unknown> | undefined;
    const messageCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const deltaCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
    const functionCall =
      message?.function_call && typeof message.function_call === "object"
        ? [{ id: "call_legacy", function: message.function_call }]
        : [];
    return [...messageCalls, ...deltaCalls, ...functionCall];
  });

  const output = Array.isArray(obj.output) ? obj.output : [];
  const responseToolCalls = output.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const entry = item as Record<string, unknown>;
    return entry.type === "function_call" || entry.type === "tool_call";
  });

  return [...choiceToolCalls, ...responseToolCalls]
    .map(toToolCall)
    .filter((call): call is ToolCall => call !== null);
}

export function summarizeOpenAIJson(json: unknown, rawText: string): string {
  const sseEvents = rawText.includes("data:") ? parseSseJsonEvents(rawText) : [];
  const parsed = json ?? (sseEvents.length ? sseEvents[sseEvents.length - 1] : safeParseJson(rawText));
  if (!parsed || typeof parsed !== "object") {
    return `响应不是 JSON，长度 ${rawText.length}。`;
  }
  const obj = parsed as Record<string, unknown>;
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = choice?.message as Record<string, unknown> | undefined;
  const delta = choice?.delta as Record<string, unknown> | undefined;
  const output = Array.isArray(obj.output) ? obj.output : [];
  const parts = [
    `顶层字段: ${Object.keys(obj).slice(0, 10).join(", ") || "无"}`,
    `choices: ${choices.length}`,
    isOpenAIUsageOnlyChunk(obj) ? "仅收到 usage 统计块，未收到模型正文块" : "",
    choice ? `finish_reason: ${String(choice.finish_reason ?? "无")}` : "",
    message ? `message字段: ${Object.keys(message).join(", ") || "无"}` : "",
    message ? `content长度: ${extractTextValue(message.content).length}` : "",
    message ? `reasoning长度: ${extractTextValue(message.reasoning_content).length}` : "",
    delta ? `delta字段: ${Object.keys(delta).join(", ") || "无"}` : "",
    output.length ? `output: ${output.length}` : "",
  ].filter(Boolean);
  return parts.join("；") + "。";
}

export function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function toToolCall(entry: unknown): ToolCall | null {
  if (!entry || typeof entry !== "object") return null;
  const call = entry as Record<string, unknown>;
  const fn = call.function as Record<string, unknown> | undefined;
  const name =
    typeof fn?.name === "string"
      ? fn.name
      : typeof call.name === "string"
        ? call.name
        : "";
  if (!name) return null;

  const rawArguments =
    typeof fn?.arguments === "string"
      ? fn.arguments
      : typeof call.arguments === "string"
        ? call.arguments
        : fn?.arguments
          ? JSON.stringify(fn.arguments)
          : call.arguments
            ? JSON.stringify(call.arguments)
            : "{}";

  return {
    id: typeof call.id === "string" ? call.id : `call_${name}`,
    name,
    arguments: parseToolArguments(fn?.arguments ?? call.arguments),
    rawArguments,
  };
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw !== "string") return {};
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { _raw: trimmed };
  } catch {
    return { _raw: trimmed };
  }
}

function extractTextValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value) return "";
  if (Array.isArray(value)) return value.map(extractTextValue).join("");
  if (typeof value !== "object") return "";

  const obj = value as Record<string, unknown>;
  for (const key of ["text", "content", "output_text", "value"]) {
    const text = extractTextValue(obj[key]);
    if (text) return text;
  }
  return "";
}
