// DeepSeek Harness Messages wire contract (llm-deepseek serialize/translate, MIT).
import type {
  ChatMessage,
  StreamCallbacks,
  StreamOptions,
  ToolCall,
} from "@/types/llm";
import { BaseLLMProvider, LLMError, LLMOutputLimitError } from "./base";
import { createSseJsonEventParser } from "./openai-shared";
import { providerFetch } from "./provider-fetch";

type Block = {
  type: string;
  text?: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
};

/** Like Harness, reasoning is durable content; signatures are model-specific replay metadata. */
function thinkingBlocks(message: ChatMessage, model: string): Block[] {
  if (message.role !== "assistant") return [];
  const saved = message.providerMessage as { deepseekModel?: string; deepseekBlocks?: unknown } | undefined;
  const native: Block[] = Array.isArray(saved?.deepseekBlocks)
    ? saved.deepseekBlocks.filter((block): block is Block =>
        block?.type === "thinking" && typeof block.thinking === "string")
    : [];
  const nativeReasoning = native.map(block => block.thinking).join("");
  // Older sessions may only have the native blocks. Never discard their text
  // just because the signature is unusable after a model switch.
  if (native.length && (!message.reasoningContent || message.reasoningContent === nativeReasoning)) {
    return native.map(block => ({
      type: "thinking", thinking: block.thinking,
      ...(saved?.deepseekModel === model && typeof block.signature === "string"
        ? { signature: block.signature } : {}),
    }));
  }
  return message.reasoningContent ? [{ type: "thinking", thinking: message.reasoningContent }] : [];
}

/** Keep the server's useful validation message without dumping response bodies or credentials. */
function errorDetail(text: string): string {
  let detail = "";
  try {
    const value = JSON.parse(text);
    const error = value?.error;
    detail = typeof error?.message === "string" ? error.message
      : typeof value?.message === "string" ? value.message : "";
  } catch { /* HTML/proxy error pages are not useful validation messages. */ }
  detail = detail.replace(/Bearer\s+\S+|\bsk-[A-Za-z0-9_-]+/gi, "[已隐藏]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 1200);
  return detail;
}

function httpError(status: number, text: string): LLMError {
  const detail = errorDetail(text);
  return new LLMError(`DeepSeek HTTP ${status}${detail ? `：${detail}` : ""}`, status);
}
export class DeepSeekMessagesProvider extends BaseLLMProvider {
  async stream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options?: StreamOptions,
  ): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const history: { role: string; content: Block[] }[] = [];
      for (const message of messages.filter((m) => m.role !== "system")) {
        const content: Block[] =
          message.role === "tool"
            ? [
                {
                  type: "tool_result",
                  tool_use_id: message.toolCallId,
                  content: message.content,
                },
              ]
            : [
                ...thinkingBlocks(message, this.config.model),
                ...(message.content
                  ? [{ type: "text", text: message.content }]
                  : []),
                ...(message.toolCalls ?? []).map((call) => ({
                  type: "tool_use",
                  id: call.id,
                  name: call.name,
                  input: call.arguments,
                })),
              ];
        if (!content.length) continue;
        const role = message.role === "assistant" ? "assistant" : "user";
        const previous = history.at(-1);
        if (previous?.role === role) previous.content.push(...content);
        else history.push({ role, content });
      }
      // Messages requires tool results before any user text in the same turn.
      for (const message of history)
        if (message.role === "user")
          message.content.sort(
            (a, b) =>
              Number(b.type === "tool_result") -
              Number(a.type === "tool_result"),
          );
      // Match Harness's local validation before sending malformed tool history.
      let pending = new Set<string>();
      for (const message of history) {
        if (message.role === "assistant") {
          const calls = message.content.filter(block => block.type === "tool_use");
          pending = new Set(calls.map(block => block.id!));
          if (pending.size !== calls.length || calls.some(block => !block.id))
            throw new Error("对话历史存在重复或无效的工具调用编号。请新建任务后重试。");
        } else {
          for (const result of message.content.filter(block => block.type === "tool_result")) {
            if (!result.tool_use_id || !pending.delete(result.tool_use_id))
              throw new Error("对话历史中的工具结果缺少对应调用。请新建任务后重试。");
          }
          if (pending.size) throw new Error("对话历史中的工具调用缺少结果，尚不能继续请求模型。");
        }
      }
      if (pending.size) throw new Error("对话历史末尾仍有未完成的工具调用，尚不能继续请求模型。");
      const effort = this.config.reasoningEffort ?? "high";
      if (!["off", "low", "high", "max"].includes(effort))
        throw new Error(`DeepSeek 不支持推理强度 ${effort}`);
      const body = {
        model: this.config.model,
        stream: true,
        messages: history,
        max_tokens: this.config.maxTokens ?? 256000,
        thinking: { type: effort === "off" ? "disabled" : "enabled" },
        ...(effort === "off" ? {} : { output_config: { effort } }),
        system:
          messages
            .filter((m) => m.role === "system")
            .map((m) => m.content)
            .join("\n\n") ||
          this.config.systemPrompt ||
          "",
        ...(this.config.temperature === undefined
          ? {}
          : { temperature: this.config.temperature }),
        ...(options?.tools?.length
          ? {
              tools: options.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.parameters,
              })),
            }
          : {}),
      };
      const response = await providerFetch(
        this.config.profileId,
        this.config.protocol,
      )(`${this.config.baseUrl.replace(/\/+$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok)
        throw httpError(response.status, await response.text());
      const blocks: Block[] = [],
        args = new Map<number, string>();
      const closed = new Set<number>();
      let text = "",
        reasoning = "",
        stopReason: string | undefined,
        ended = false;
      const parser = createSseJsonEventParser((value) => {
        const event = value as {
          type: string;
          index?: number;
          content_block?: Block;
          delta?: {
            type?: string;
            text?: string;
            thinking?: string;
            signature?: string;
            partial_json?: string;
            stop_reason?: string;
          };
          message?: { stop_reason?: string };
          error?: { message?: string };
        };
        const index = event.index ?? 0;
        if (event.type === "error")
          throw new Error(`DeepSeek 流返回错误：${errorDetail(JSON.stringify({ error: event.error })) || "本轮工具未执行。"}`);
        if (event.type === "content_block_start" && event.content_block) {
          blocks[index] = { ...event.content_block };
          if (event.content_block.type === "text" && event.content_block.text) {
            text += event.content_block.text;
            callbacks.onToken(event.content_block.text);
          }
          if (
            event.content_block.type === "thinking" &&
            event.content_block.thinking
          ) {
            reasoning += event.content_block.thinking;
            callbacks.onReasoningToken?.(event.content_block.thinking);
          }
        }
        if (event.type === "content_block_stop") closed.add(index);
        if (event.type === "content_block_delta") {
          const block = blocks[index];
          if (!block) throw new Error("DeepSeek 返回了不完整的内容块。");
          if (event.delta?.type === "text_delta") {
            const delta = event.delta.text ?? "";
            text += delta;
            block.text = (block.text ?? "") + delta;
            callbacks.onToken(delta);
          }
          if (event.delta?.type === "thinking_delta") {
            const delta = event.delta.thinking ?? "";
            reasoning += delta;
            block.thinking = (block.thinking ?? "") + delta;
            callbacks.onReasoningToken?.(delta);
          }
          if (event.delta?.type === "signature_delta")
            block.signature =
              (block.signature ?? "") + (event.delta.signature ?? "");
          if (event.delta?.type === "input_json_delta")
            args.set(
              index,
              (args.get(index) ?? "") + (event.delta.partial_json ?? ""),
            );
        }
        if (event.type === "message_delta")
          stopReason = event.delta?.stop_reason ?? stopReason;
        if (event.type === "message_start")
          stopReason = event.message?.stop_reason ?? stopReason;
        if (event.type === "message_stop") ended = true;
      });
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        parser.feed(decoder.decode(next.value, { stream: true }));
      }
      parser.feed(decoder.decode());
      parser.flush();
      if (stopReason === "max_tokens")
        throw new LLMOutputLimitError(this.config.maxTokens);
      if (
        !ended ||
        !["end_turn", "tool_use", "stop_sequence"].includes(stopReason ?? "")
      )
        throw new Error("DeepSeek 响应未完整结束，本轮工具未执行。");
      const calls: ToolCall[] = [];
      for (const [index, block] of blocks.entries()) {
        if (!block || !closed.has(index))
          throw new Error("DeepSeek 响应缺少完整内容块。");
        if (block.type !== "tool_use") continue;
        if (args.has(index)) block.input = JSON.parse(args.get(index)!);
        if (
          !block.id ||
          !block.name ||
          !block.input ||
          typeof block.input !== "object" ||
          Array.isArray(block.input)
        )
          throw new Error("DeepSeek 工具参数不完整。");
        calls.push({ id: block.id, name: block.name, arguments: block.input });
      }
      for (const call of calls) callbacks.onToolCall?.(call);
      callbacks.onComplete(text, {
        reasoningContent: reasoning,
        providerMessage: {
          deepseekBlocks: blocks,
          deepseekModel: this.config.model,
        },
      });
    } catch (error) {
      if (!controller.signal.aborted)
        callbacks.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
    }
  }
}
