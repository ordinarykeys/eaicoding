import type { ChatMessage, StreamCallbacks, StreamOptions, ToolCall } from "@/types/llm";
import { BaseLLMProvider, LLMError } from "./base";
import {
  buildOpenAIEndpoint,
  createSseJsonEventParser,
  extractTextFromOpenAIJson,
  extractToolCallsFromOpenAIJson,
  isOpenAIUsageOnlyChunk,
  parseOpenAIResponseText,
  summarizeOpenAIJson,
} from "./openai-shared";
import { streamJsonViaTauri } from "./tauri-proxy";

export class OpenAIResponsesProvider extends BaseLLMProvider {
  async stream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    _options?: StreamOptions,
  ): Promise<void> {
    this.abortController = new AbortController();

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

    const body: Record<string, unknown> = {
      model: this.config.model,
      input: transcript || " ",
      instructions: systemMessage?.content ?? this.config.systemPrompt,
      stream: true,
      store: false,
    };
    if (this.config.maxTokens !== undefined) {
      body.max_output_tokens = this.config.maxTokens;
    }
    if (this.config.temperature !== undefined) {
      body.temperature = this.config.temperature;
    }

    let fullText = "";
    let sawSseEvent = false;
    const toolCalls: ToolCall[] = [];
    const sseParser = createSseJsonEventParser((json) => {
      sawSseEvent = true;
      if (isOpenAIUsageOnlyChunk(json)) return;
      const text = extractTextFromOpenAIJson(json);
      if (text) {
        fullText += text;
        callbacks.onToken(text);
      }
      toolCalls.push(...extractToolCallsFromOpenAIJson(json));
    });

    let response;
    try {
      response = await streamJsonViaTauri(
        buildOpenAIEndpoint(this.config.baseUrl, "responses"),
        {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body,
        (chunk) => sseParser.feed(chunk),
      );
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

    const parsed = sawSseEvent
      ? { text: fullText, toolCalls }
      : parseOpenAIResponseText(response.text);
    if (parsed.toolCalls.length > 0) {
      for (const call of parsed.toolCalls) {
        callbacks.onToolCall?.(call);
      }
      callbacks.onComplete(parsed.text);
      return;
    }

    if (!parsed.text) {
      const summary = summarizeOpenAIJson(null, response.text);
      callbacks.onError(
        new Error(
          `LLM 返回为空：当前协议为 OpenAI Responses（/responses），成功响应但未包含可见文本或工具调用。${summary}`,
        ),
      );
      return;
    }

    if (!sawSseEvent) callbacks.onToken(parsed.text);
    callbacks.onComplete(parsed.text);
  }
}
