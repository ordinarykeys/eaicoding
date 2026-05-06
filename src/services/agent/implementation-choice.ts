import type { AgentUserChoiceRequest, ToolResult } from "@/types/llm";

type RouteType =
  | "function_family"
  | "object_workflow"
  | "namespace_overview"
  | "candidate_pool"
  | string;

interface RawImplementationOption {
  name?: unknown;
  category?: unknown;
  class_name?: unknown;
  return_type?: unknown;
  signature?: unknown;
  description?: unknown;
}

interface RawImplementationRoute {
  family?: unknown;
  route_type?: unknown;
  summary?: unknown;
  primary_options?: unknown;
  primary_items?: unknown;
  options?: unknown;
  items?: unknown;
}

interface ChoiceCandidate {
  label: string;
  value: string;
  description?: string;
}

function contentObject(result: ToolResult | undefined): Record<string, unknown> | null {
  if (!result?.ok || !result.content || typeof result.content !== "object") return null;
  if (Array.isArray(result.content)) return null;
  const payload = result.content as Record<string, unknown>;
  if (payload.success === false) return null;
  return payload;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1))}…`;
}

function rawPrimaryOptions(route: RawImplementationRoute): RawImplementationOption[] {
  const primary = Array.isArray(route.primary_options)
    ? route.primary_options
    : Array.isArray(route.primary_items)
      ? route.primary_items
      : Array.isArray(route.options)
        ? route.options
        : Array.isArray(route.items)
          ? route.items
          : [];

  return primary.filter(
    (item): item is RawImplementationOption =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function optionLabel(option: RawImplementationOption): string {
  const name = text(option.name);
  const className = text(option.class_name);
  if (!name) return "";
  return className ? `${className}.${name}` : name;
}

function optionDescription(option: RawImplementationOption): string | undefined {
  const signature = text(option.signature);
  const description = text(option.description);
  const returnType = text(option.return_type);
  const parts = [
    signature,
    description && description !== signature ? description : "",
    returnType ? `返回：${returnType}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? compactText(parts.join("；"), 180) : undefined;
}

function routeDescription(route: RawImplementationRoute, options: RawImplementationOption[]): string {
  const summary = text(route.summary);
  const primaryNames = options.map(optionLabel).filter(Boolean).slice(0, 4);
  return compactText(
    [summary, primaryNames.length > 0 ? `调用链：${primaryNames.join(" → ")}` : ""]
      .filter(Boolean)
      .join("；"),
    180,
  );
}

function uniqueCandidates(candidates: ChoiceCandidate[]): ChoiceCandidate[] {
  const seen = new Set<string>();
  const unique: ChoiceCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.value || candidate.label;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
    if (unique.length >= 6) break;
  }
  return unique;
}

function userAlreadyNamedCandidate(userInput: string, candidates: ChoiceCandidate[]): boolean {
  const input = userInput.trim();
  if (!input) return false;
  return candidates.some((candidate) => {
    const names = [candidate.value, candidate.label]
      .map((item) => item.trim())
      .filter((item) => item.length >= 2);
    return names.some((name) => input.includes(name));
  });
}

function routeChoice(route: RawImplementationRoute): ChoiceCandidate | null {
  const family = text(route.family);
  if (!family) return null;
  const primary = rawPrimaryOptions(route);
  return {
    label: family,
    value: family,
    description: routeDescription(route, primary),
  };
}

function choiceableRoutes(routes: RawImplementationRoute[]): RawImplementationRoute[] {
  return routes.filter((route) => {
    const routeType = text(route.route_type) as RouteType;
    return routeType === "function_family" || routeType === "object_workflow";
  });
}

function allRouteCandidates(routes: RawImplementationRoute[]): ChoiceCandidate[] {
  const candidates: ChoiceCandidate[] = [];
  for (const route of choiceableRoutes(routes)) {
    candidates.push(...peerFunctionChoices(route));
    const candidate = routeChoice(route);
    if (candidate) candidates.push(candidate);
  }
  return uniqueCandidates(candidates);
}

function peerFunctionChoices(route: RawImplementationRoute): ChoiceCandidate[] {
  return uniqueCandidates(
    rawPrimaryOptions(route)
      .map((option): ChoiceCandidate | null => {
        const label = optionLabel(option);
        if (!label) return null;
        const candidate: ChoiceCandidate = {
          label,
          value: text(option.name) || label,
        };
        const description = optionDescription(option);
        if (description) candidate.description = description;
        return candidate;
      })
      .filter((item): item is ChoiceCandidate => Boolean(item)),
  );
}

function buildChoiceRequest(
  family: string,
  candidates: ChoiceCandidate[],
  userInput: string,
): AgentUserChoiceRequest | null {
  const choices = uniqueCandidates(candidates);
  if (choices.length < 2) return null;
  if (userAlreadyNamedCandidate(userInput, choices)) return null;

  return {
    question: `请选择 ${family} 的实现方式`,
    context: "知识库检索到多个可行入口；选择后我会按该方案继续生成代码。",
    allowCustom: true,
    options: choices.map((choice, index) => ({
      id: `impl_${index + 1}`,
      label: choice.label,
      value: choice.value,
      description: choice.description,
    })),
  };
}

export function createJingyiImplementationChoiceRequest(
  searchResult: unknown,
  userInput: string,
): AgentUserChoiceRequest | null {
  if (!searchResult || typeof searchResult !== "object" || Array.isArray(searchResult)) {
    return null;
  }

  const payload = searchResult as Record<string, unknown>;
  const routes = Array.isArray(payload.implementation_options)
    ? payload.implementation_options.filter(
        (route): route is RawImplementationRoute =>
          Boolean(route) && typeof route === "object" && !Array.isArray(route),
      )
    : [];
  if (userAlreadyNamedCandidate(userInput, allRouteCandidates(routes))) return null;

  const routeLevelChoices: ChoiceCandidate[] = [];

  for (const route of choiceableRoutes(routes)) {
    const family = text(route.family);
    if (!family) continue;
    const routeType = text(route.route_type) as RouteType;

    if (routeType === "function_family") {
      const candidates = peerFunctionChoices(route);
      const request = buildChoiceRequest(family, candidates, userInput);
      if (request) return request;
      const singleRouteChoice = routeChoice(route);
      if (singleRouteChoice) routeLevelChoices.push(singleRouteChoice);
      continue;
    }

    if (routeType === "object_workflow") {
      const candidate = routeChoice(route);
      if (candidate) routeLevelChoices.push(candidate);
    }
  }

  return buildChoiceRequest("当前功能", routeLevelChoices, userInput);
}

export function createJingyiImplementationChoiceRequestFromToolResults(
  results: ToolResult[],
  userInput: string,
): AgentUserChoiceRequest | null {
  for (const result of results) {
    if (result.toolName !== "search_jingyi_module") continue;
    const payload = contentObject(result);
    const request = createJingyiImplementationChoiceRequest(payload, userInput);
    if (request) return request;
  }
  return null;
}
