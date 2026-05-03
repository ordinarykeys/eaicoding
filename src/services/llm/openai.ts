import type {
  ChatMessage,
  StreamCallbacks,
  StreamOptions,
  ToolCall,
  ToolDefinition,
} from "@/types/llm";
import { BaseLLMProvider, LLMError } from "./base";
import { postJsonViaTauri } from "./tauri-proxy";

/**
 * OpenAI-compatible streaming provider.
 * Works with OpenAI, DeepSeek, OpenRouter and any API that implements the
 * POST /chat/completions + SSE streaming protocol.
 *
 * The agent runner emits messages with the extra roles `tool` and assistant
 * messages that may carry `toolCalls`. We translate them into OpenAI's
 * native shape:
 *   - role=tool    →  { role: "tool", tool_call_id, content }
 *   - assistantWithToolCalls → { role: "assistant", content, tool_calls: [...] }
 *
 * Models that don't natively support tool messages still accept this shape
 * (most OpenAI-compatible servers do); those that strictly reject the
 * extension will simply 4xx and we let the error propagate.
 */
export class OpenAIProvider extends BaseLLMProvider {
  async stream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options?: StreamOptions,
  ): Promise<void> {
    this.abortController = new AbortController();

    // ------------------------------------------------------------------ //
    //  Translate messages into OpenAI native format
    // ------------------------------------------------------------------ //
    type OpenAIToolCall = {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    };
    type OpenAIMsg =
      | { role: "system" | "user"; content: string }
      | { role: "assistant"; content: string; tool_calls?: OpenAIToolCall[] }
      | { role: "tool"; tool_call_id: string; content: string };

    const nativeToolsEnabled = options?.nativeTools !== false;
    const apiMessages: OpenAIMsg[] = messages.map((message): OpenAIMsg => {
      if (message.role === "tool") {
        if (!nativeToolsEnabled) {
          return {
            role: "user",
            content:
              `[tool_result name=${message.toolName ?? "unknown"} id=${message.toolCallId ?? "?"}]\n` +
              message.content,
          };
        }
        return {
          role: "tool",
          tool_call_id: message.toolCallId ?? "unknown",
          content: message.content,
        };
      }
      if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
        if (!nativeToolsEnabled) {
          return {
            role: "assistant",
            content: message.content || JSON.stringify({ tool_calls: message.toolCalls }),
          };
        }
        return {
          role: "assistant",
          content: message.content ?? "",
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: {
              name: call.name,
              arguments: call.rawArguments ?? JSON.stringify(call.arguments ?? {}),
            },
          })),
        };
      }
      // Default: system / user / plain assistant
      return {
        role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
        content: message.content,
      };
    });

    // Inject system prompt at the front when no system message present.
    if (
      this.config.systemPrompt &&
      !apiMessages.some((m) => m.role === "system")
    ) {
      apiMessages.unshift({
        role: "system",
        content: this.config.systemPrompt,
      });
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: false,
      messages: apiMessages,
    };
    const openaiTools = nativeToolsEnabled
      ? (options?.tools ?? []).map(toOpenAIFunctionTool)
      : [];
    if (openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = "auto";
      body.parallel_tool_calls = true;
    }
    if (this.config.maxTokens !== undefined) body.max_tokens = this.config.maxTokens;
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;

    const streamViaResponses = async (): Promise<boolean> => {
      if (!shouldTryResponsesEndpoint(this.config.baseUrl)) return false;

      const systemMessage = messages.find((message) => message.role === "system");
      const transcript = messages
        .filter((message) => message.role !== "system")
        .map((message) => {
          const role =
            message.role === "tool"
              ? `tool:${message.toolName ?? "unknown"}`
              : message.role;
          return `<${role}>\n${message.content}`;
        })
        .join("\n\n");

      const responseBody: Record<string, unknown> = {
        model: this.config.model,
        input: transcript || " ",
        instructions: systemMessage?.content ?? this.config.systemPrompt,
        store: false,
      };
      if (this.config.maxTokens !== undefined) {
        responseBody.max_output_tokens = this.config.maxTokens;
      }
      if (this.config.temperature !== undefined) {
        responseBody.temperature = this.config.temperature;
      }

      let response;
      try {
        response = await postJsonViaTauri(
          buildProviderEndpoint(this.config.baseUrl, "responses"),
          {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          responseBody,
        );
      } catch (err) {
        if ((err as Error).name === "AbortError") return true;
        return false;
      }

      if (this.abortController?.signal.aborted) return true;
      if (response.status < 200 || response.status >= 300) return false;

      const json = (() => {
        try {
          return JSON.parse(response.text);
        } catch {
          return null;
        }
      })();
      const text = extractTextFromOpenAICompatJson(json);

      if (!text) return false;
      callbacks.onToken(text);
      callbacks.onComplete(text);
      return true;
    };

    // ------------------------------------------------------------------ //
    //  Fetch
    // ------------------------------------------------------------------ //
    const requestChatCompletions = async (requestBody: Record<string, unknown>) => {
      return postJsonViaTauri(
        buildProviderEndpoint(this.config.baseUrl, "chat/completions"),
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        requestBody,
      );
    };

    let response;
    try {
      response = await requestChatCompletions(body);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (this.abortController.signal.aborted) return;

    if (
      response.status >= 400 &&
      openaiTools.length > 0 &&
      shouldUseTextToolProtocol(response.status, response.text)
    ) {
      const textProtocolBody = { ...body };
      delete textProtocolBody.tools;
      delete textProtocolBody.tool_choice;
      delete textProtocolBody.parallel_tool_calls;
      try {
        response = await requestChatCompletions(textProtocolBody);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        callbacks.onError(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (this.abortController.signal.aborted) return;
    }

    if (response.status < 200 || response.status >= 300) {
      const text = response.text;
      if (await streamViaResponses()) return;
      callbacks.onError(
        new LLMError(
          `HTTP ${response.status} ${response.statusText}: ${text}`,
          response.status,
        ),
      );
      return;
    }

    let fullText = "";
    let nativeToolCalls: ToolCall[] = [];
    let parsedResponseJson: unknown = null;

    try {
      if (response.text.includes("data:")) {
        const lines = response.text.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trimEnd();
          if (!trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice("data: ".length);
          if (!payload || payload === "[DONE]") continue;

          let json: unknown;
          try {
            json = JSON.parse(payload);
          } catch {
            continue;
          }

          fullText += extractTextFromOpenAICompatJson(json);
          nativeToolCalls.push(...extractToolCallsFromOpenAICompatJson(json));
        }
      }

      if (!fullText) {
        parsedResponseJson = JSON.parse(response.text);
        fullText = extractTextFromOpenAICompatJson(parsedResponseJson);
        nativeToolCalls = extractToolCallsFromOpenAICompatJson(parsedResponseJson);
      }

      if (nativeToolCalls.length > 0) {
        for (const call of nativeToolCalls) {
          callbacks.onToolCall?.(call);
        }
        callbacks.onComplete(fullText);
        return;
      }
      if (!fullText) {
        const recovered = await recoverEmptyChatCompletion({
          request: requestChatCompletions,
          body,
          apiMessages,
          callbacks,
          responseJson: parsedResponseJson,
          responseText: response.text,
        });
        if (recovered) return;
      }
      if (!fullText && (await streamViaResponses())) return;
      if (!fullText) {
        const summary = summarizeOpenAICompatJson(parsedResponseJson, response.text);
        console.warn("[eaicoding] Empty OpenAI-compatible response", summary);
        callbacks.onError(
          new Error(
            `LLM 返回为空：/chat/completions 成功响应，但未包含可见文本或工具调用。${summary}`,
          ),
        );
        return;
      }
      callbacks.onToken(fullText);
      callbacks.onComplete(fullText);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

function toOpenAIFunctionTool(definition: ToolDefinition) {
  return {
    type: "function",
    function: {
      name: definition.name,
      description: definition.description,
      parameters: sanitizeToolSchema(definition.parameters),
    },
  };
}

function sanitizeToolSchema(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sanitizeToolSchema);
  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(source)) {
    if (key === "nullable") continue;
    target[key] = sanitizeToolSchema(child);
  }
  return target;
}

function shouldUseTextToolProtocol(status: number, text: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /tools|tool_choice|function|parallel_tool_calls|unsupported|unrecognized|unknown parameter|invalid_request/i.test(text);
}

function shouldTryResponsesEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(buildProviderEndpoint(baseUrl, "responses")).host.toLowerCase();
    return host === "api.openai.com" || host.endsWith(".api.openai.com");
  } catch {
    return false;
  }
}

function buildProviderEndpoint(baseUrl: string, endpoint: "chat/completions" | "responses"): string {
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
    // Fall through to plain prefix concatenation for custom schemes / invalid
    // partial URLs. The request layer will surface a clearer error if needed.
  }

  const lowerTrimmed = trimmed.toLowerCase();
  if (lowerTrimmed.endsWith(`/${cleanEndpoint.toLowerCase()}`)) return trimmed;
  return `${trimmed}/${cleanEndpoint}`;
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

function extractToolCallsFromOpenAICompatJson(json: unknown): ToolCall[] {
  if (!json || typeof json !== "object") return [];
  const obj = json as Record<string, unknown>;
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const rawToolCalls = choices.flatMap((choice) => {
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

  const calls: ToolCall[] = [];
  for (const entry of rawToolCalls) {
    if (!entry || typeof entry !== "object") continue;
    const call = entry as Record<string, unknown>;
    const fn = call.function as Record<string, unknown> | undefined;
    const name = typeof fn?.name === "string" ? fn.name : "";
    if (!name) continue;
    const rawArguments = typeof fn?.arguments === "string"
      ? fn.arguments
      : fn?.arguments
        ? JSON.stringify(fn.arguments)
        : "{}";
    calls.push({
      id: typeof call.id === "string" ? call.id : `call_${calls.length + 1}`,
      name,
      arguments: parseToolArguments(fn?.arguments),
      rawArguments,
    });
  }

  return calls;
}

function extractTextFromOpenAICompatJson(json: unknown): string {
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

  const candidates = Array.isArray(obj.candidates) ? obj.candidates : [];
  const candidateText = candidates.map((candidate) => {
    if (!candidate || typeof candidate !== "object") return "";
    const entry = candidate as Record<string, unknown>;
    const content = entry.content as Record<string, unknown> | undefined;
    return extractTextValue(content?.parts);
  }).join("");
  if (candidateText) return candidateText;

  return "";
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

async function recoverEmptyChatCompletion(args: {
  request: (requestBody: Record<string, unknown>) => Promise<{
    status: number;
    statusText: string;
    text: string;
  }>;
  body: Record<string, unknown>;
  apiMessages: Array<Record<string, unknown>>;
  callbacks: StreamCallbacks;
  responseJson: unknown;
  responseText: string;
}): Promise<boolean> {
  const reasoningText = extractReasoningText(args.responseJson);
  if (reasoningText && isProtocolLikeText(reasoningText)) {
    args.callbacks.onToken(reasoningText);
    args.callbacks.onComplete(reasoningText);
    return true;
  }

  const nudgedMessages = [
    ...args.apiMessages,
    {
      role: "user",
      content:
        "上一轮接口返回成功但没有可见正文。请直接输出用户可见的结果；不要只产出 reasoning_content。如果任务还需要工具调用，请按工具 JSON 协议输出。",
    },
  ];
  const retryBody: Record<string, unknown> = {
    ...args.body,
    messages: nudgedMessages,
    tools: undefined,
    tool_choice: undefined,
    parallel_tool_calls: undefined,
  };
  delete retryBody.tools;
  delete retryBody.tool_choice;
  delete retryBody.parallel_tool_calls;
  if (typeof retryBody.max_tokens === "number") {
    retryBody.max_tokens = Math.max(retryBody.max_tokens, 8192);
  }

  const retry = await args.request(retryBody);
  if (retry.status >= 200 && retry.status < 300) {
    const retryJson = safeParseJson(retry.text);
    const retryText = extractTextFromOpenAICompatJson(retryJson);
    const retryToolCalls = extractToolCallsFromOpenAICompatJson(retryJson);
    if (retryToolCalls.length > 0) {
      for (const call of retryToolCalls) {
        args.callbacks.onToolCall?.(call);
      }
      args.callbacks.onComplete(retryText);
      return true;
    }
    if (retryText) {
      args.callbacks.onToken(retryText);
      args.callbacks.onComplete(retryText);
      return true;
    }
  }

  return false;
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractReasoningText(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const obj = json as Record<string, unknown>;
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const choiceText = choices.map((choice) => {
    if (!choice || typeof choice !== "object") return "";
    const entry = choice as Record<string, unknown>;
    const message = entry.message as Record<string, unknown> | undefined;
    const delta = entry.delta as Record<string, unknown> | undefined;
    return [
      extractTextValue(message?.reasoning_content),
      extractTextValue(delta?.reasoning_content),
      extractTextValue(message?.reasoning),
      extractTextValue(delta?.reasoning),
    ].join("");
  }).join("");
  if (choiceText) return choiceText;

  const output = Array.isArray(obj.output) ? obj.output : [];
  return output.map((item) => {
    if (!item || typeof item !== "object") return "";
    const entry = item as Record<string, unknown>;
    return extractTextValue(entry.summary);
  }).join("");
}

function isProtocolLikeText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return true;
  return /"tool_calls"\s*:|"final_answer"\s*:|<tool_call>/i.test(trimmed);
}

function summarizeOpenAICompatJson(json: unknown, rawText: string): string {
  const parsed = json ?? safeParseJson(rawText);
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
    choice ? `finish_reason: ${String(choice.finish_reason ?? "无")}` : "",
    message ? `message字段: ${Object.keys(message).join(", ") || "无"}` : "",
    message ? `content长度: ${extractTextValue(message.content).length}` : "",
    message ? `reasoning长度: ${extractTextValue(message.reasoning_content).length}` : "",
    delta ? `delta字段: ${Object.keys(delta).join(", ") || "无"}` : "",
    output.length ? `output: ${output.length}` : "",
  ].filter(Boolean);
  return parts.join("；") + "。";
}
