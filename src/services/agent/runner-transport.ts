import type { LLMConfig } from "@/types/llm";

export type AgentToolTransport = "text-json" | "native-openai-tools";

export function selectAgentToolTransport(config: LLMConfig): AgentToolTransport {
  // The application now targets DeepSeek, whose Chat Completions endpoint
  // supports native function tools throughout a multi-step coding task.
  return config.provider === "deepseek" && config.protocol === "openai-chat-completions"
    ? "native-openai-tools" : "text-json";
}
