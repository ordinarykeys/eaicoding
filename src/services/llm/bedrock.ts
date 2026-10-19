import type {
  ChatMessage,
  StreamCallbacks,
  StreamOptions,
  ToolCall,
} from "@/types/llm";
import { BaseLLMProvider, LLMError, LLMOutputLimitError } from "./base";
import { providerFetch } from "./provider-fetch";
/** Bedrock's bearer-token Converse API; native AWS profile/SigV4 login is not advertised. */
export class BedrockProvider extends BaseLLMProvider {
  async stream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options?: StreamOptions,
  ): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const conversation: { role: string; content: unknown[] }[] = [];
      for (const m of messages.filter((m) => m.role !== "system")) {
        const content: unknown[] =
          m.role === "tool"
            ? [
                {
                  toolResult: {
                    toolUseId: m.toolCallId,
                    content: [{ text: m.content }],
                    status: "success",
                  },
                },
              ]
            : [
                ...(m.content ? [{ text: m.content }] : []),
                ...(m.toolCalls ?? []).map((c) => ({
                  toolUse: {
                    toolUseId: c.id,
                    name: c.name,
                    input: c.arguments,
                  },
                })),
              ];
        const role = m.role === "assistant" ? "assistant" : "user";
        const last = conversation.at(-1);
        if (last?.role === role) last.content.push(...content);
        else conversation.push({ role, content });
      }
      const body: Record<string, unknown> = {
        messages: conversation,
        system: messages
          .filter((m) => m.role === "system")
          .map((m) => ({ text: m.content })),
        inferenceConfig: {
          maxTokens: this.config.maxTokens,
          temperature: this.config.temperature,
        },
      };
      if (options?.tools?.length)
        body.toolConfig = {
          tools: options.tools.map((t) => ({
            toolSpec: {
              name: t.name,
              description: t.description,
              inputSchema: { json: t.parameters },
            },
          })),
        };
      const response = await providerFetch(
        this.config.profileId,
        this.config.protocol,
      )(
        `${this.config.baseUrl.replace(/\/+$/, "")}/model/${encodeURIComponent(this.config.model)}/converse`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (!response.ok)
        throw new LLMError(`Bedrock HTTP ${response.status}`, response.status);
      const value = await response.json();
      if (value.stopReason === "max_tokens")
        throw new LLMOutputLimitError(this.config.maxTokens);
      if (!["end_turn", "tool_use", "stop_sequence"].includes(value.stopReason))
        throw new Error(`Bedrock 停止：${value.stopReason ?? "响应不完整"}`);
      let text = "";
      const calls: ToolCall[] = [];
      for (const part of value.output?.message?.content ?? []) {
        if (typeof part.text === "string") text += part.text;
        if (part.toolUse)
          calls.push({
            id: part.toolUse.toolUseId,
            name: part.toolUse.name,
            arguments: part.toolUse.input,
          });
      }
      if (text) callbacks.onToken(text);
      for (const call of calls) callbacks.onToolCall?.(call);
      callbacks.onComplete(text);
    } catch (error) {
      if (!controller.signal.aborted)
        callbacks.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
    }
  }
}
