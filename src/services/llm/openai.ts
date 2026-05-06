import type {
  ChatMessage,
  StreamCallbacks,
  StreamOptions,
  ToolCall,
  ToolDefinition,
} from "@/types/llm";
import { BaseLLMProvider, LLMError } from "./base";
import {
  buildOpenAIEndpoint,
  createSseJsonEventParser,
  extractTextFromOpenAIJson,
  extractToolCallsFromOpenAIJson,
  isOpenAIUsageOnlyChunk,
  parseSseJsonEvents,
  safeParseJson,
  summarizeOpenAIJson,
} from "./openai-shared";
import { streamJsonViaTauri } from "./tauri-proxy";

export class OpenAIChatCompletionsProvider extends BaseLLMProvider {
  async stream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options?: StreamOptions,
  ): Promise<void> {
    this.abortController = new AbortController();

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

      return {
        role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
        content: message.content,
      };
    });

    if (this.config.systemPrompt && !apiMessages.some((message) => message.role === "system")) {
      apiMessages.unshift({
        role: "system",
        content: this.config.systemPrompt,
      });
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: true,
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

    const requestChatCompletions = async (requestBody: Record<string, unknown>) =>
      streamJsonViaTauri(
        buildOpenAIEndpoint(this.config.baseUrl, "chat/completions"),
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        requestBody,
        handleStreamChunk,
      );

    let fullText = "";
    let nativeToolCalls: ToolCall[] = [];
    let parsedResponseJson: unknown = null;
    let sawSseEvent = false;
    const sseParser = createSseJsonEventParser((json) => {
      sawSseEvent = true;
      parsedResponseJson = json;
      if (isOpenAIUsageOnlyChunk(json)) return;
      const text = extractTextFromOpenAIJson(json);
      if (text) {
        fullText += text;
        callbacks.onToken(text);
      }
      nativeToolCalls.push(...extractToolCallsFromOpenAIJson(json));
    });

    function handleStreamChunk(chunk: string) {
      sseParser.feed(chunk);
    }

    let response;
    try {
      response = await requestChatCompletions(body);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (this.abortController.signal.aborted) return;
    sseParser.flush();

    if (response.status < 200 || response.status >= 300) {
      callbacks.onError(
        new LLMError(
          `HTTP ${response.status} ${response.statusText}: ${response.text}`,
          response.status,
        ),
      );
      return;
    }

    try {
      const isSseResponse = sawSseEvent || response.text.includes("data:");
      if (isSseResponse) {
        if (!sawSseEvent) {
          const events = parseSseJsonEvents(response.text);
          for (const json of events) {
            parsedResponseJson = json;
            if (isOpenAIUsageOnlyChunk(json)) continue;
            fullText += extractTextFromOpenAIJson(json);
            nativeToolCalls.push(...extractToolCallsFromOpenAIJson(json));
          }
        }
      } else {
        parsedResponseJson = safeParseJson(response.text);
        fullText = extractTextFromOpenAIJson(parsedResponseJson);
        nativeToolCalls = extractToolCallsFromOpenAIJson(parsedResponseJson);
      }

      if (nativeToolCalls.length > 0) {
        for (const call of nativeToolCalls) {
          callbacks.onToolCall?.(call);
        }
        callbacks.onComplete(fullText);
        return;
      }

      if (!fullText) {
        const summary = summarizeOpenAIJson(parsedResponseJson, response.text);
        console.warn("[eaicoding] Empty OpenAI chat completion response", summary);
        callbacks.onError(
          new Error(
            `LLM 返回为空：当前协议为 OpenAI Chat Completions（/chat/completions），请求已使用 stream=true，但成功响应未包含可见文本或工具调用。${summary}`,
          ),
        );
        return;
      }

      if (!sawSseEvent) callbacks.onToken(fullText);
      callbacks.onComplete(fullText);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

export { OpenAIChatCompletionsProvider as OpenAIProvider };

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
