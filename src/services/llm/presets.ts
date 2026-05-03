import type { LLMProvider } from "@/types/llm";

export interface LLMProviderPreset {
  id: string;
  name: string;
  provider: LLMProvider;
  baseUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  description: string;
}

export const LLM_PROVIDER_PRESETS: LLMProviderPreset[] = [
  {
    id: "xiaomi-mimo",
    name: "小米 MiMo",
    provider: "openai",
    baseUrl: "https://api.xiaomimimo.com/v1",
    model: "mimo-v2.5-pro",
    maxTokens: 4096,
    temperature: 0.2,
    description: "小米 MiMo 标准 OpenAI 兼容接口，适合默认易语言 coding 任务。",
  },
  {
    id: "xiaomi-token-plan-cn",
    name: "小米 Token Plan",
    provider: "openai",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    model: "mimo-v2.5-pro",
    maxTokens: 4096,
    temperature: 0.2,
    description: "小米 Token Plan 中国区 OpenAI 兼容接口，通常使用 tp- key。",
  },
  {
    id: "openai-compatible",
    name: "OpenAI 兼容网关",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    maxTokens: 4096,
    temperature: 0.2,
    description: "OpenAI、NewAPI、OpenRouter、聚合网关等 /chat/completions 协议。",
  },
  {
    id: "anthropic",
    name: "Claude / Anthropic",
    provider: "provider",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
    maxTokens: 4096,
    temperature: 0.2,
    description: "Anthropic Messages API 协议。",
  },
  {
    id: "gemini",
    name: "Gemini",
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-pro",
    maxTokens: 4096,
    temperature: 0.2,
    description: "Google Gemini generateContent 协议。",
  },
];

export function findLLMProviderPreset(id: string): LLMProviderPreset | undefined {
  return LLM_PROVIDER_PRESETS.find((preset) => preset.id === id);
}
