import type { ChatMessage, StreamCallbacks, StreamOptions } from "@/types/llm";
import { BaseLLMProvider, LLMError } from "./base";
import { postJsonViaTauri } from "./tauri-proxy";

type GeminiStreamCandidate = {
  content?: {
    parts?: Array<{
      text?: string;
    }>;
  };
};

type GeminiStreamChunk = {
  candidates?: GeminiStreamCandidate[];
};

function normalizeGeminiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "") || "https://generativelanguage.googleapis.com/v1beta";
}

export class GeminiProvider extends BaseLLMProvider {
  async stream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    _options?: StreamOptions,
  ): Promise<void> {
    this.abortController = new AbortController();

    const systemText =
      messages.find((message) => message.role === "system")?.content ??
      this.config.systemPrompt ??
      "";

    // Build Gemini contents: only "user" / "model" roles allowed.
    // The ReAct loop may inject "tool" and "assistant+toolCalls" messages —
    // flatten them so the conversation remains strictly alternating.
    type GeminiMsg = { role: "user" | "model"; parts: Array<{ text: string }> };
    const rawContents: GeminiMsg[] = [];
    for (const message of messages) {
      if (message.role === "system") continue;
      if (message.role === "tool") {
        // Tool result: append to the previous user message or start a new one.
        const toolText =
          `[tool_result name=${message.toolName ?? "tool"} id=${message.toolCallId ?? "?"}]\n` +
          message.content;
        const last = rawContents[rawContents.length - 1];
        if (last && last.role === "user") {
          last.parts.push({ text: "\n\n" + toolText });
        } else {
          rawContents.push({ role: "user", parts: [{ text: toolText }] });
        }
        continue;
      }
      if (message.role === "assistant") {
        rawContents.push({ role: "model", parts: [{ text: message.content }] });
        continue;
      }
      // role === "user"
      rawContents.push({ role: "user", parts: [{ text: message.content }] });
    }

    // Coalesce consecutive same-role messages (Gemini requires strict alternation).
    const contents: GeminiMsg[] = [];
    for (const msg of rawContents) {
      const last = contents[contents.length - 1];
      if (last && last.role === msg.role) {
        for (const part of msg.parts) last.parts.push(part);
      } else {
        contents.push({ role: msg.role, parts: [...msg.parts] });
      }
    }
    // Gemini requires the conversation to start with "user".
    if (contents.length > 0 && contents[0].role === "model") {
      contents.unshift({ role: "user", parts: [{ text: "(continuing)" }] });
    }

    const body: Record<string, unknown> = {
      contents,
      generationConfig: {
        maxOutputTokens: this.config.maxTokens,
        temperature: this.config.temperature,
      },
    };

    if (systemText) {
      body.systemInstruction = {
        parts: [{ text: systemText }],
      };
    }

    let response;
    try {
      response = await postJsonViaTauri(
        `${normalizeGeminiBaseUrl(this.config.baseUrl)}/models/${encodeURIComponent(
          this.config.model,
        )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.config.apiKey)}`,
        {
          "Content-Type": "application/json",
        },
        body,
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    if (this.abortController.signal.aborted) return;

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

    let fullText = "";

    try {
      const lines = response.text.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trimEnd();
        if (!trimmed.startsWith("data: ")) continue;

        const payload = trimmed.slice("data: ".length);
        if (!payload || payload === "[DONE]") continue;

        let chunk: GeminiStreamChunk;
        try {
          chunk = JSON.parse(payload) as GeminiStreamChunk;
        } catch {
          continue;
        }

        const text = chunk.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? "")
          .join("");
        if (text) fullText += text;
      }
      if (!fullText) {
        const json = JSON.parse(response.text) as GeminiStreamChunk;
        fullText =
          json.candidates?.[0]?.content?.parts
            ?.map((part) => part.text ?? "")
            .join("") ?? "";
      }
      if (!fullText) {
        callbacks.onError(new Error("LLM 返回为空：Gemini 成功响应但未包含候选文本"));
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
