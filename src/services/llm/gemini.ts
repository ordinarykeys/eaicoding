import type {
  ChatMessage,
  StreamCallbacks,
  StreamOptions,
  ToolCall,
} from "@/types/llm";
import { BaseLLMProvider, LLMOutputLimitError, LLMError } from "./base";
import { providerFetch } from "./provider-fetch";
import { createSseJsonEventParser } from "./openai-shared";

// pi-ai google-shared wire mapping (MIT), kept local to avoid its Node auth imports.
function usesGoogleThinkingLevel(model: { id: string }) {
  const id = model.id.toLowerCase();
  return (
    /gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id) ||
    ["gemini-flash-latest", "gemini-flash-lite-latest"].includes(id) ||
    /gemma-?4/.test(id)
  );
}
function resolveGoogleThinkingLevel(
  model: { thinkingLevelMap?: Record<string, string | null> },
  effort: string,
) {
  const level = (model.thinkingLevelMap?.[effort] ?? effort).toLowerCase();
  if (!["minimal", "low", "medium", "high"].includes(level))
    throw new Error(`Gemini 不支持推理强度 ${effort}`);
  return level;
}
function getDisabledGoogleThinkingConfig(model: {
  id: string;
  thinkingLevelMap?: Record<string, string | null>;
}) {
  if (!usesGoogleThinkingLevel(model) || model.thinkingLevelMap?.off !== null)
    return { thinkingBudget: 0 };
  const level =
    ["minimal", "low", "medium", "high"].find(
      (k) => model.thinkingLevelMap?.[k] !== null,
    ) ?? "low";
  return {
    thinkingLevel: resolveGoogleThinkingLevel(model, level).toUpperCase(),
  };
}
type Part = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args: Record<string, unknown>; id?: string };
  functionResponse?: unknown;
};
export class GeminiProvider extends BaseLLMProvider {
  async stream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options?: StreamOptions,
  ): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    try {
      const contents: { role: string; parts: Part[] }[] = [];
      const names = new Map(
        messages.flatMap((m) =>
          (m.toolCalls ?? []).map((c) => [c.id, c.name] as const),
        ),
      );
      for (const m of messages.filter((m) => m.role !== "system")) {
        const replay = m.providerMessage as
          | { geminiContent?: { parts: Part[] }; geminiModel?: string }
          | undefined;
        const parts: Part[] =
          m.role === "tool"
            ? [
                {
                  functionResponse: {
                    name: m.toolName ?? names.get(m.toolCallId ?? "") ?? "tool",
                    response: { result: m.content },
                  },
                },
              ]
            : ((replay?.geminiModel === this.config.model
                ? replay.geminiContent?.parts.map((p) => ({ ...p }))
                : undefined) ?? [
                ...(m.content ? [{ text: m.content }] : []),
                ...(m.toolCalls ?? []).map((c) => ({
                  functionCall: { name: c.name, args: c.arguments, id: c.id },
                })),
              ]);
        const role = m.role === "assistant" ? "model" : "user";
        const last = contents.at(-1);
        if (last?.role === role) last.parts.push(...parts);
        else contents.push({ role, parts });
      }
      const body: Record<string, unknown> = {
        contents,
        generationConfig: {
          maxOutputTokens: this.config.maxTokens,
          temperature: this.config.temperature,
        },
      };
      const system = messages
        .filter((m) => m.role === "system")
        .map((m) => m.content)
        .join("\n\n");
      if (system) body.systemInstruction = { parts: [{ text: system }] };
      if (options?.tools?.length)
        body.tools = [
          {
            functionDeclarations: options.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            })),
          },
        ];
      const effort = this.config.reasoningEffort;
      if (this.config.modelMetadata?.reasoning && effort) {
        const model = {
          id: this.config.model,
          thinkingLevelMap: this.config.modelMetadata.thinkingLevelMap as
            | Record<string, string | null>
            | undefined,
        };
        let thinking: Record<string, unknown>;
        if (effort === "off") thinking = getDisabledGoogleThinkingConfig(model);
        else {
          const level = resolveGoogleThinkingLevel(model, effort);
          const pro = this.config.model.includes("2.5-pro"),
            lite = this.config.model.includes("2.5-flash-lite");
          const budget: Record<string, number> = {
            minimal: lite ? 512 : 128,
            low: 2048,
            medium: 8192,
            high: pro ? 32768 : 24576,
          };
          thinking = usesGoogleThinkingLevel(model)
            ? { thinkingLevel: level.toUpperCase(), includeThoughts: true }
            : { thinkingBudget: budget[level] ?? -1, includeThoughts: true };
        }
        (body.generationConfig as Record<string, unknown>).thinkingConfig =
          thinking;
      }
      const response = await providerFetch(
        this.config.profileId,
        this.config.protocol,
      )(
        `${this.config.baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(this.config.model)}:streamGenerateContent?alt=sse`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      if (!response.ok)
        throw new LLMError(`模型接口 HTTP ${response.status}`, response.status);
      let text = "",
        reasoning = "",
        length = false,
        finished = false;
      const parts: Part[] = [];
      const calls: ToolCall[] = [];
      const parser = createSseJsonEventParser((json) => {
        const chunk = json as {
          candidates?: {
            content?: { parts?: Part[] };
            finishReason?: string;
          }[];
        };
        const candidate = chunk.candidates?.[0];
        if (candidate?.finishReason) {
          finished = true;
          if (candidate.finishReason === "MAX_TOKENS") length = true;
          else if (!["STOP"].includes(candidate.finishReason))
            throw new Error(`模型停止：${candidate.finishReason}`);
        }
        for (const part of candidate?.content?.parts ?? []) {
          parts.push(part);
          if (part.text) {
            if (part.thought) {
              reasoning += part.text;
              callbacks.onReasoningToken?.(part.text);
            } else {
              text += part.text;
              callbacks.onToken(part.text);
            }
          }
          if (part.functionCall)
            calls.push({
              id: part.functionCall.id ?? crypto.randomUUID(),
              name: part.functionCall.name,
              arguments: part.functionCall.args ?? {},
            });
        }
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        parser.feed(decoder.decode(next.value, { stream: true }));
      }
      parser.feed(decoder.decode());
      parser.flush();
      if (length) throw new LLMOutputLimitError(this.config.maxTokens);
      if (!finished)
        throw new Error("模型响应在结束标记之前中断，本轮工具未执行。");
      for (const call of calls) callbacks.onToolCall?.(call);
      callbacks.onComplete(text, {
        reasoningContent: reasoning,
        providerMessage: {
          role: "assistant",
          geminiContent: { role: "model", parts },
          geminiModel: this.config.model,
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
