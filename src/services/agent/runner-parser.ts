import { nanoid } from "nanoid";
import type { ToolCall } from "@/types/llm";

export interface ParsedAgentTurn {
  thought?: string;
  toolCalls?: ToolCall[];
  finalAnswer?: string;
  /** True when no JSON could be parsed; caller should treat the entire
   *  assistant text as the final answer (graceful degradation). */
  unstructured: boolean;
}

export function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{")) return inner;
  }

  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

function repairJsonStringEscapes(text: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (!inString) {
      repaired += char;
      if (char === '"') {
        inString = true;
        escaped = false;
      }
      continue;
    }

    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      const next = text[i + 1];
      const isSimpleEscape =
        next !== undefined && /["\\/bfnrt]/.test(next);
      const isUnicodeEscape =
        next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6));

      if (isSimpleEscape || isUnicodeEscape) {
        repaired += char;
        escaped = true;
      } else {
        repaired += "\\\\";
      }
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === "\n") {
      repaired += "\\n";
      continue;
    }
    if (char === "\r") {
      repaired += "\\r";
      continue;
    }
    if (char === "\t") {
      repaired += "\\t";
      continue;
    }

    if (char < " ") {
      repaired += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }

    repaired += char;
  }

  return repaired;
}

export function tryParseJsonWithRepair(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const repaired = repairJsonStringEscapes(text);
    if (repaired === text) return null;
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

function parseXmlLikeToolCalls(rawText: string): ToolCall[] | null {
  const toolCallBlocks = [...rawText.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)];
  if (toolCallBlocks.length === 0) return null;

  const toolCalls: ToolCall[] = [];
  for (const blockMatch of toolCallBlocks) {
    const block = blockMatch[1];
    const functionMatch = block.match(/<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/i);
    if (!functionMatch) continue;

    const name = functionMatch[1]?.trim();
    const body = functionMatch[2] ?? "";
    if (!name) continue;

    const args: Record<string, unknown> = {};
    const parameterMatches = body.matchAll(
      /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gi,
    );
    for (const parameterMatch of parameterMatches) {
      const key = parameterMatch[1]?.trim();
      const value = parameterMatch[2]?.trim() ?? "";
      if (!key) continue;
      args[key] = value;
    }

    toolCalls.push({
      id: `tc_${nanoid(8)}`,
      name,
      arguments: args,
      rawArguments: JSON.stringify(args),
    });
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

export function parseAgentTurn(rawText: string): ParsedAgentTurn {
  const json = extractJsonObject(rawText);
  if (!json) {
    const xmlLikeToolCalls = parseXmlLikeToolCalls(rawText);
    if (xmlLikeToolCalls) {
      return {
        unstructured: false,
        toolCalls: xmlLikeToolCalls,
      };
    }
    const bestEffortAnswer = extractProtocolStringValue(rawText, ["final_answer", "answer"]);
    if (bestEffortAnswer) {
      return {
        unstructured: false,
        thought: extractProtocolStringValue(rawText, ["thought"]) ?? undefined,
        finalAnswer: bestEffortAnswer,
      };
    }
    return { unstructured: true, finalAnswer: rawText };
  }

  const parsed = tryParseJsonWithRepair(json);
  if (parsed === null) {
    const xmlLikeToolCalls = parseXmlLikeToolCalls(rawText);
    if (xmlLikeToolCalls) {
      return {
        unstructured: false,
        toolCalls: xmlLikeToolCalls,
      };
    }
    const bestEffortAnswer = extractProtocolStringValue(rawText, ["final_answer", "answer"]);
    if (bestEffortAnswer) {
      return {
        unstructured: false,
        thought: extractProtocolStringValue(rawText, ["thought"]) ?? undefined,
        finalAnswer: bestEffortAnswer,
      };
    }
    return { unstructured: true, finalAnswer: rawText };
  }
  if (!parsed || typeof parsed !== "object") {
    return { unstructured: true, finalAnswer: rawText };
  }

  const obj = parsed as Record<string, unknown>;
  const thought = typeof obj.thought === "string" ? obj.thought : undefined;
  const finalAnswer =
    typeof obj.final_answer === "string"
      ? obj.final_answer
      : typeof obj.answer === "string"
        ? obj.answer
        : undefined;
  const rawCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];

  const toolCalls: ToolCall[] = [];
  for (const entry of rawCalls) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : null;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    let raw: string | undefined;
    if (e.arguments && typeof e.arguments === "object" && !Array.isArray(e.arguments)) {
      args = e.arguments as Record<string, unknown>;
      raw = JSON.stringify(args);
    } else if (typeof e.arguments === "string") {
      raw = e.arguments;
      const parsedArgs = tryParseJsonWithRepair(e.arguments);
      if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
        args = parsedArgs as Record<string, unknown>;
      } else {
        args = { _raw: e.arguments };
      }
    }
    toolCalls.push({
      id: typeof e.id === "string" ? e.id : `tc_${nanoid(8)}`,
      name,
      arguments: args,
      rawArguments: raw,
    });
  }

  if (toolCalls.length === 0 && finalAnswer === undefined) {
    return { unstructured: true, finalAnswer: rawText, thought };
  }

  return {
    unstructured: false,
    thought,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finalAnswer,
  };
}

export function extractProtocolStringValue(text: string, keys: string[]): string | null {
  for (const key of keys) {
    const marker = `"${key}"`;
    const keyIndex = text.lastIndexOf(marker);
    if (keyIndex < 0) continue;
    const colonIndex = text.indexOf(":", keyIndex + marker.length);
    if (colonIndex < 0) continue;
    const quoteStart = text.indexOf('"', colonIndex + 1);
    if (quoteStart < 0) continue;

    let value = "";
    let escaped = false;
    for (let index = quoteStart + 1; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        if (char === "n") value += "\n";
        else if (char === "r") value += "\r";
        else if (char === "t") value += "\t";
        else if (char === '"') value += '"';
        else if (char === "\\") value += "\\";
        else if (char === "/") value += "/";
        else value += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        return value.trim() ? value : null;
      }
      value += char;
    }
    if (value.trim()) return value;
  }

  return null;
}
