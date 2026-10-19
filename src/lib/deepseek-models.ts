/** Keep settings, the composer and API requests on the same supported catalog. */
// Same output allowance as deepseek-harness; this is a ceiling, not a target.
export const DEEPSEEK_DEFAULT_MAX_TOKENS = 256_000;

export const DEEPSEEK_MODELS = [
  { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", ownedBy: "DeepSeek" },
  { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", ownedBy: "DeepSeek" },
] as const;

export function normalizeDeepSeekModel(id: string): string {
  return id === "deepseek-v4-pro" || id === "deepseek-reasoner"
    ? "deepseek-v4-pro" : "deepseek-flash";
}

export function deepSeekModelLabel(id: string): string {
  return DEEPSEEK_MODELS.find(model => model.id === normalizeDeepSeekModel(id))!.name;
}

export const deepSeekModelCatalog = () => DEEPSEEK_MODELS.map(({ id, name, ownedBy }) => ({
  id, name, ownedBy, reasoning: true, defaultEffort: "high",
  thinkingLevelMap: { off: "off", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
}));
