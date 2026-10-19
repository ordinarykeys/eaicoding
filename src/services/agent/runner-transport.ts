import type { LLMConfig } from "@/types/llm";

export type AgentToolTransport = "text-json" | "native-openai-tools";

export function selectAgentToolTransport(config: LLMConfig): AgentToolTransport {
  return ["openai-chat-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "bedrock-converse", "pi-ai"].includes(config.protocol)
    ? "native-openai-tools" : "text-json";
}
