import type { LLMConfig } from "@/types/llm";
import { BaseLLMProvider } from "./base";
import { OpenAIChatCompletionsProvider } from "./openai";

/**
 * Explicit protocol factory. Each API shape has its own adapter so errors
 * reveal the selected protocol instead of silently trying another one.
 */
export function createLLMProvider(config: LLMConfig): BaseLLMProvider {
  if (config.provider !== "deepseek") throw new Error("仅支持 DeepSeek，请在设置中配置 DeepSeek API Key。");
  return new OpenAIChatCompletionsProvider(config);
}

export { BaseLLMProvider };
export { LLMError, LLMOutputLimitError } from "./base";
export type { LLMConfig, ChatMessage, StreamCallbacks } from "@/types/llm";
