import type { LLMConfig } from "@/types/llm";
import { BaseLLMProvider } from "./base";
import { OpenAIProvider } from "./openai";
import { MessagesProvider } from "./provider";
import { GeminiProvider } from "./gemini";

/**
 * Factory: instantiate the correct provider implementation based on
 * the `provider` field in the supplied config.
 *
 *   "openai"   → OpenAIProvider    (OpenAI Chat Completions API + compatible)
 *   "provider"   → MessagesProvider  (the assistant / the provider Messages API)
 *   "gemini"   → GeminiProvider    (Google Gemini API)
 */
export function createLLMProvider(config: LLMConfig): BaseLLMProvider {
  if (config.provider === "provider") {
    return new MessagesProvider(config);
  }
  if (config.provider === "gemini") {
    return new GeminiProvider(config);
  }
  return new OpenAIProvider(config);
}

export { BaseLLMProvider, OpenAIProvider, MessagesProvider, GeminiProvider };
export { LLMError } from "./base";
export type { LLMConfig, ChatMessage, StreamCallbacks } from "@/types/llm";
