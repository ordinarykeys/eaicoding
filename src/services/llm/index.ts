import type { LLMConfig } from "@/types/llm";
import { BaseLLMProvider } from "./base";
import { OpenAIChatCompletionsProvider, OpenAIProvider } from "./openai";
import { OpenAIResponsesProvider } from "./openai-responses";
import { MessagesProvider } from "./provider";
import { GeminiProvider } from "./gemini";

/**
 * Explicit protocol factory. Each API shape has its own adapter so errors
 * reveal the selected protocol instead of silently trying another one.
 */
export function createLLMProvider(config: LLMConfig): BaseLLMProvider {
  switch (config.protocol) {
    case "openai-chat-completions":
      return new OpenAIChatCompletionsProvider(config);
    case "openai-responses":
      return new OpenAIResponsesProvider(config);
    case "anthropic-messages":
      return new MessagesProvider(config);
    case "gemini-generate-content":
      return new GeminiProvider(config);
    default:
      return assertNever(config.protocol);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported LLM protocol: ${String(value)}`);
}

export {
  BaseLLMProvider,
  OpenAIProvider,
  OpenAIChatCompletionsProvider,
  OpenAIResponsesProvider,
  MessagesProvider,
  GeminiProvider,
};
export { LLMError } from "./base";
export type { LLMConfig, ChatMessage, StreamCallbacks } from "@/types/llm";
