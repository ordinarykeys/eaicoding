import type { LLMConfig, ChatMessage, StreamCallbacks, StreamOptions } from "@/types/llm";

export class LLMError extends Error {
  status: number;
  retryable: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.retryable = status === 429 || status >= 500;
  }
}

/** A complete response with an explicit length stop; never a usable tool turn. */
export class LLMOutputLimitError extends LLMError {
  constructor(readonly maxTokens?: number) {
    super("模型输出达到 Token 上限，结果不完整，未执行本轮工具调用。", 400);
    this.name = "LLMOutputLimitError";
  }
}

export abstract class BaseLLMProvider {
  protected config: LLMConfig;
  protected abortController: AbortController | null = null;

  constructor(config: LLMConfig) {
    this.config = config;
  }

  abstract stream(
    messages: ChatMessage[],
    callbacks: StreamCallbacks,
    options?: StreamOptions,
  ): Promise<void>;

  abort() {
    this.abortController?.abort();
    this.abortController = null;
  }

  updateConfig(config: Partial<LLMConfig>) {
    this.config = { ...this.config, ...config };
  }
}
