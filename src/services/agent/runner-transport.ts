import type { LLMConfig } from "@/types/llm";

export type AgentToolTransport = "text-json" | "native-openai-tools";

export function selectAgentToolTransport(_config: LLMConfig): AgentToolTransport {
  // OpenAI-compatible coding providers differ a lot in tool-call behavior.
  // Keep the runner on the text JSON ReAct protocol unless model capability
  // metadata explicitly proves native tools are reliable for that provider.
  return "text-json";
}
