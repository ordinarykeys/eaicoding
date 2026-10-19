// The same pi-ai protocol implementations used by Harness, with native credential transport.
import type {
  AssistantMessage,
  Message,
  Model,
  Api,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";
import type { LLMConfig, ChatMessage, StreamCallbacks, StreamOptions } from "@/types/llm";
import { BaseLLMProvider, LLMOutputLimitError } from "./base";
import { providerFetch } from "./provider-fetch";

const zeroUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
export class PiProvider extends BaseLLMProvider {
  async stream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options?: StreamOptions,
  ): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const config = this.config;
      const api =
        config.protocol === "openai-chat-completions"
          ? "openai-completions"
          : config.protocol;
      const adapter =
        api === "anthropic-messages"
          ? await import("@earendil-works/pi-ai/api/anthropic-messages")
          : api === "openai-responses"
            ? await import("@earendil-works/pi-ai/api/openai-responses")
            : await import("@earendil-works/pi-ai/api/openai-completions");
      if (controller.signal.aborted) return;
      const metadata = config.modelMetadata ?? {};
      const model = {
        ...metadata,
        id: config.model,
        name: metadata.name ?? config.model,
        type: "chat",
        provider: config.provider,
        api,
        baseUrl: config.baseUrl,
        reasoning: metadata.reasoning ?? false,
        input: ["text"],
        contextWindow: metadata.contextWindow ?? 128000,
        maxTokens: config.maxTokens ?? metadata.maxTokens ?? 8192,
        cost: zeroUsage.cost,
      } as unknown as Model<Api>;
      const context = piContext(messages, config, options);
      const streamOptions: SimpleStreamOptions = {
        signal: controller.signal,
        apiKey: "native-provider-key",
        fetch: providerFetch(config.profileId, config.protocol),
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        reasoning: config.reasoningEffort as SimpleStreamOptions["reasoning"],
        maxRetries: 0,
      };
      let text = "",
        reasoning = "",
        completed = false;
      const stream = adapter.streamSimple(
        model as never,
        context,
        streamOptions,
      );
      for await (const event of stream) {
        if (controller.signal.aborted) return;
        if (event.type === "text_delta") {
          text += event.delta;
          callbacks.onToken(event.delta);
        }
        if (event.type === "thinking_delta") {
          reasoning += event.delta;
          callbacks.onReasoningToken?.(event.delta);
        }
        if (event.type === "error")
          throw new Error(event.error.errorMessage || "模型请求失败");
        if (event.type === "done") {
          if (event.message.stopReason === "length")
            throw new LLMOutputLimitError(config.maxTokens);
          for (const part of event.message.content)
            if (part.type === "toolCall")
              callbacks.onToolCall?.({
                id: part.id,
                name: part.name,
                arguments: part.arguments,
                rawArguments: JSON.stringify(part.arguments),
              });
          completed = true;
          callbacks.onComplete(text, {
            reasoningContent: reasoning,
            providerMessage: event.message,
          });
        }
      }
      if (!completed && !controller.signal.aborted)
        throw new Error("模型响应在结束标记之前中断，本轮工具未执行。");
    } catch (error) {
      if (!controller.signal.aborted)
        callbacks.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
    }
  }
}

export function piContext(messages: ChatMessage[], config: LLMConfig, options?: StreamOptions) {
  const api = config.modelMetadata?.api ?? (config.protocol === "openai-chat-completions" ? "openai-completions" : config.protocol);
      const history: Message[] = messages
        .filter((m) => m.role !== "system")
        .map((m) => {
          if (m.role === "tool")
            return {
              role: "toolResult",
              toolCallId: m.toolCallId ?? "unknown",
              toolName: m.toolName ?? "tool",
              content: [{ type: "text", text: m.content }],
              isError: false,
              timestamp: m.timestamp,
            };
          if (m.role === "user")
            return { role: "user", content: m.content, timestamp: m.timestamp };
          // Preserve signatures and provider replay metadata within and across tool steps.
          if (
            m.providerMessage &&
            typeof m.providerMessage === "object" &&
            (m.providerMessage as AssistantMessage).role === "assistant" &&
            Array.isArray((m.providerMessage as AssistantMessage).content) &&
            typeof (m.providerMessage as AssistantMessage).api === "string"
          )
            return m.providerMessage as AssistantMessage;
          const content: AssistantMessage["content"] = m.content
            ? [{ type: "text", text: m.content }]
            : [];
          for (const call of m.toolCalls ?? [])
            content.push({
              type: "toolCall",
              id: call.id,
              name: call.name,
              arguments: call.arguments as never,
            });
          return {
            role: "assistant",
            content,
            api,
            provider: config.provider,
            model: config.model,
            usage: zeroUsage,
            stopReason: m.toolCalls?.length ? "toolUse" : "stop",
            timestamp: m.timestamp,
          } as AssistantMessage;
        });
      return normalizeContext({
        systemPrompt:
          messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n\n") || config.systemPrompt,
        messages: history,
        tools: (options?.tools ?? []).map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      });
}
