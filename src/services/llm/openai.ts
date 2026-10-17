import type {
  ChatMessage,
  StreamCallbacks,
  StreamOptions,
  ToolCall,
  ToolDefinition,
} from "@/types/llm";
import { BaseLLMProvider, LLMError, LLMOutputLimitError } from "./base";
import {
  buildOpenAIEndpoint,
  createSseJsonEventParser,
  extractTextFromOpenAIJson,
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
    const controller = new AbortController();
    this.abortController = controller;

    type OpenAIToolCall = {
      id: string;
      type: "function";
      function: { name: string; arguments: string };
    };
    type OpenAIMsg =
      | { role: "system" | "user"; content: string }
      | { role: "assistant"; content: string; reasoning_content?: string; tool_calls?: OpenAIToolCall[] }
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
          ...(/^(deepseek-flash|deepseek-v4-pro|deepseek-reasoner)$/.test(this.config.model) || message.reasoningContent !== undefined
            ? { reasoning_content: message.reasoningContent ?? "" } : {}),
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
        ...(message.role === "assistant" && (message.reasoningContent !== undefined || /^(deepseek-flash|deepseek-v4-pro|deepseek-reasoner)$/.test(this.config.model))
          ? { reasoning_content: message.reasoningContent ?? "" } : {}),
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
        120,
        controller.signal,
      );

    let fullText = "";
    let nativeToolCalls: ToolCall[] = [];
    let reasoningContent = "";
    const toolFragments = new Map<number, { id: string; name: string; arguments: string }>();
    let parsedResponseJson: unknown = null;
    let outputTruncated = false;
    let sawFinish = false;
    const inspectFinish = (json: unknown) => {
      if (!json || typeof json !== "object") return;
      const choices = (json as { choices?: { finish_reason?: string }[] }).choices;
      if (Array.isArray(choices)) {
        if (choices.some(choice => Boolean(choice?.finish_reason))) sawFinish = true;
        if (choices.some(choice => choice?.finish_reason === "length")) outputTruncated = true;
      }
    };
    // DeepSeek streams names/arguments in separate deltas. Parse only after the
    // terminal event, so a partial JSON argument can never become a tool call.
    const collectToolState = (json: unknown) => {
      const choice = (json as { choices?: { delta?: Record<string, unknown>; message?: Record<string, unknown> }[] })?.choices?.[0];
      const part = choice?.delta ?? choice?.message;
      if (!part) return;
      if (typeof part.reasoning_content === "string") {
        reasoningContent += part.reasoning_content;
        callbacks.onReasoningToken?.(part.reasoning_content);
      }
      if (!Array.isArray(part.tool_calls)) return;
      part.tool_calls.forEach((raw, position) => {
        const call = raw as { index?: number; id?: string; function?: { name?: string; arguments?: string } };
        const index = call.index ?? position;
        const state = toolFragments.get(index) ?? { id: "", name: "", arguments: "" };
        if (call.id) state.id = call.id;
        if (call.function?.name) state.name += call.function.name;
        if (typeof call.function?.arguments === "string") state.arguments += call.function.arguments;
        toolFragments.set(index, state);
      });
    };
    let sawSseEvent = false;
    const sseParser = createSseJsonEventParser((json) => {
      sawSseEvent = true;
      parsedResponseJson = json;
      inspectFinish(json);
      if (isOpenAIUsageOnlyChunk(json)) return;
      const text = extractTextFromOpenAIJson(json);
      if (text) {
        fullText += text;
        callbacks.onToken(text);
      }
      collectToolState(json);
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

    if (controller.signal.aborted) return;
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
            inspectFinish(json);
            if (isOpenAIUsageOnlyChunk(json)) continue;
            fullText += extractTextFromOpenAIJson(json);
            collectToolState(json);
          }
        }
      } else {
        parsedResponseJson = safeParseJson(response.text);
        inspectFinish(parsedResponseJson);
        fullText = extractTextFromOpenAIJson(parsedResponseJson);
        collectToolState(parsedResponseJson);
      }

      if (outputTruncated) {
        callbacks.onError(new LLMOutputLimitError(this.config.maxTokens));
        return;
      }
      if (isSseResponse && !sawFinish) {
        callbacks.onError(new LLMError("DeepSeek 响应流提前断开，未收到结束标记，未执行本轮工具调用。", 502));
        return;
      }
      nativeToolCalls = [...toolFragments.entries()].sort(([a], [b]) => a - b).map(([, call]) => {
        if (!call.id || !call.name) throw new Error("DeepSeek 工具调用缺少 id 或名称，未执行本轮工具。");
        let args: unknown;
        try { args = JSON.parse(call.arguments); }
        catch { throw new Error(`DeepSeek 工具 ${call.name} 的参数不完整，未执行本轮工具。`); }
        if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error(`工具 ${call.name} 参数必须是 JSON 对象。`);
        return { id: call.id, name: call.name, arguments: args as Record<string, unknown>, rawArguments: call.arguments };
      });
      if (nativeToolCalls.length > 0) {
        for (const call of nativeToolCalls) {
          callbacks.onToolCall?.(call);
        }
        callbacks.onComplete(fullText, { reasoningContent });
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
      callbacks.onComplete(fullText, { reasoningContent });
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
