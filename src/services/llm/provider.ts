import type { ChatMessage, StreamCallbacks, StreamOptions } from "@/types/llm";
import { BaseLLMProvider, LLMError } from "./base";
import { streamJsonViaTauri } from "./tauri-proxy";
import { createSseJsonEventParser } from "./openai-shared";

// ── Minimal shapes for the Messages API (the provider) SSE events ────────── //

interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  delta: { type: "text_delta"; text: string };
}

interface MessageStopEvent {
  type: "message_stop";
}

type MessagesSSEEvent = ContentBlockDeltaEvent | MessageStopEvent | { type: string };

/**
 * Messages-API streaming provider (the provider's the assistant family and any
 * server speaking the same protocol).
 *
 * Note: our agent runner uses a custom JSON-in-text protocol for tool calls,
 * so we don't bind to the provider's native `tool_use` / `tool_result` blocks.
 * Tool messages emitted by the agent are flattened into plain `user` turns
 * with a clear envelope, which works on every Messages-API model.
 */
export class MessagesProvider extends BaseLLMProvider {
  async stream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    _options?: StreamOptions,
  ): Promise<void> {
    this.abortController = new AbortController();

    const systemMessage = messages.find((m) => m.role === "system");
    const rest = messages.filter((m) => m.role !== "system");
    const systemContent = systemMessage?.content ?? this.config.systemPrompt ?? undefined;

    type MessagesMsg = { role: "user" | "assistant"; content: string };
    const conversationMessages: MessagesMsg[] = rest.map((message): MessagesMsg => {
      if (message.role === "tool") {
        return {
          role: "user",
          content:
            `[tool_result name=${message.toolName ?? "unknown"} id=${message.toolCallId ?? "?"}]\n` +
            message.content,
        };
      }
      if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: message.content || JSON.stringify({ tool_calls: message.toolCalls }),
        };
      }
      return {
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      };
    });

    if (conversationMessages.length === 0) {
      conversationMessages.push({ role: "user", content: "" });
    }
    if (conversationMessages[0].role === "assistant") {
      conversationMessages.unshift({ role: "user", content: "(continuing)" });
    }
    // Coalesce consecutive same-role messages — required by the API.
    const collapsed: MessagesMsg[] = [];
    for (const msg of conversationMessages) {
      const last = collapsed[collapsed.length - 1];
      if (last && last.role === msg.role) {
        last.content = `${last.content}\n\n${msg.content}`;
      } else {
        collapsed.push({ ...msg });
      }
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: true,
      max_tokens: this.config.maxTokens ?? 4096,
      messages: collapsed,
    };
    if (systemContent) body.system = systemContent;
    if (this.config.temperature !== undefined) body.temperature = this.config.temperature;

    let fullText = "";
    let sawSseEvent = false;
    const sseParser = createSseJsonEventParser((json) => {
      sawSseEvent = true;
      const event = json as MessagesSSEEvent;
      if (event.type !== "content_block_delta") return;
      const deltaEvent = event as ContentBlockDeltaEvent;
      if (
        deltaEvent.delta.type === "text_delta" &&
        typeof deltaEvent.delta.text === "string" &&
        deltaEvent.delta.text.length > 0
      ) {
        fullText += deltaEvent.delta.text;
        callbacks.onToken(deltaEvent.delta.text);
      }
    });

    let response;
    try {
      response = await streamJsonViaTauri(
        buildMessagesEndpoint(this.config.baseUrl),
        {
          "Content-Type": "application/json",
          "x-api-key": this.config.apiKey,
          "anthropic-version": "2023-06-01",
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
      const text = response.text;
      callbacks.onError(
        new LLMError(
          `HTTP ${response.status} ${response.statusText}: ${text}`,
          response.status,
        ),
      );
      return;
    }

    try {
      if (!sawSseEvent) fullText = parseMessagesSseText(response.text);
      if (!fullText) {
        const json = JSON.parse(response.text) as {
          content?: Array<{ type?: string; text?: string }>;
        };
        fullText = json.content?.map((part) => part.text ?? "").join("") ?? "";
      }
      if (!fullText) {
        callbacks.onError(new Error("LLM 返回为空：Messages API 成功响应但未包含文本内容"));
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

function parseMessagesSseText(text: string): string {
  let fullText = "";
  const parser = createSseJsonEventParser((json) => {
    const event = json as MessagesSSEEvent;
    if (event.type !== "content_block_delta") return;
    const deltaEvent = event as ContentBlockDeltaEvent;
    if (
      deltaEvent.delta.type === "text_delta" &&
      typeof deltaEvent.delta.text === "string"
    ) {
      fullText += deltaEvent.delta.text;
    }
  });
  parser.feed(text);
  parser.flush();
  return fullText;
}

function buildMessagesEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "") || "https://api.anthropic.com/v1";
  if (trimmed.toLowerCase().endsWith("/messages")) return trimmed;
  return `${trimmed}/messages`;
}
