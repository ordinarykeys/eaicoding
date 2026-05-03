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
