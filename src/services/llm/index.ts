import type { LLMConfig } from "@/types/llm";
import { DeepSeekMessagesProvider } from "./deepseek-messages";
import { PiProvider } from "./pi-provider";
import { NativePiProvider } from "./native-pi-provider";
import { GeminiProvider } from "./gemini";
import { BedrockProvider } from "./bedrock";
import { BaseLLMProvider } from "./base";
import { OpenAIChatCompletionsProvider } from "./openai";

/**
 * Explicit protocol factory. Each API shape has its own adapter so errors
 * reveal the selected protocol instead of silently trying another one.
 */
export function createLLMProvider(config: LLMConfig): BaseLLMProvider {
  if (!config.profileId && config.provider !== "deepseek") throw new Error("第三方提供商必须使用已保存的模型配置。");
  if (config.profileId && config.protocol === "pi-ai") return new NativePiProvider(config);
  if (config.provider === "deepseek" && config.protocol === "anthropic-messages") return new DeepSeekMessagesProvider(config);
  if (!config.profileId) return new OpenAIChatCompletionsProvider(config);
  if (config.protocol === "google-generative-ai") return new GeminiProvider(config);
  if (config.protocol === "bedrock-converse") return new BedrockProvider(config);
  return new PiProvider(config);
}

export { BaseLLMProvider };
export { LLMError, LLMOutputLimitError } from "./base";
export type { LLMConfig, ChatMessage, StreamCallbacks } from "@/types/llm";
