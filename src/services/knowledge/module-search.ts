import { useSettingsStore } from "@/stores/settings";
import {
  loadStoredIndex,
  type StoredModuleIndex,
  type UserModuleApi,
  type UserModuleAssembly,
  type UserModuleEntry,
} from "@/services/knowledge/module-library";
import {
  embedQuery,
  searchModuleVectorIndex,
  type ModuleVectorHit,
} from "@/services/knowledge/module-vector-index";

// ---------------------------------------------------------------------------
// Public surface — mirrors `searchJingyiKnowledge` shape so the existing
// implementation-choice infrastructure (createJingyiImplementationChoiceRequest)
// can be reused via a thin wrapper in Phase 3.
// ---------------------------------------------------------------------------

export interface UserModuleMatch {
  /** Stable per-module API id (matches StoredModuleIndex.apis[].id). */
  id: string;
  module_id: string;
  module_name: string;
  module_path: string;
  name: string;
  class_name: string;
  return_type: string;
  signature: string;
  description: string;
  category: "subprogram" | "dll" | "datatype";
  is_public: boolean;
  line: number;
  score: number;
  /** Set when the hit came from semantic recall. */
  semantic_similarity?: number;
}

export interface UserModuleRoute {
  family: string;
  route_type: "function_family" | "object_workflow" | "namespace_overview";
  summary?: string;
  primary_options: UserModuleMatch[];
  supporting_options: UserModuleMatch[];
}

export interface UserModuleSearchResult {
  success: true;
  query: string;
  count: number;
  matches: UserModuleMatch[];
  /** Same key name as jingyi so the choice-request builder can be shared. */
  implementation_options: UserModuleRoute[];
  /** Diagnostic — modules actually consulted for this query. */
  searched_modules: Array<{ id: string; name: string }>;
  module_paths: string[];
  unavailable_modules: Array<{ id: string; name: string; status: string }>;
}

export interface SearchUserModulesOptions {
  /** Restrict to specific module ids; if both names and ids are given, ids win. */
  moduleIds?: string[];
  /** Restrict by friendly name (partial / case-insensitive substring match). */
  moduleNames?: string[];
  limit?: number;
  /** Default true; disable for unit tests when no extractor model is available. */
  useVector?: boolean;
}

// ---------------------------------------------------------------------------
// In-memory cache of StoredModuleIndex objects, keyed by moduleId.
// IDB load is async + JSON parse is non-trivial; cache once per session.
// ---------------------------------------------------------------------------

const indexCache = new Map<string, StoredModuleIndex>();

async function fetchIndex(moduleId: string): Promise<StoredModuleIndex | null> {
  const cached = indexCache.get(moduleId);
  if (cached) return cached;
  const stored = await loadStoredIndex(moduleId);
  if (!stored) return null;
  indexCache.set(moduleId, stored);
  return stored;
}

/** Drop a module's cache when it's rebuilt or removed. */
export function evictModuleCache(moduleId: string): void {
  indexCache.delete(moduleId);
}

// ---------------------------------------------------------------------------
// Tokenisation — CJK n-gram + Latin word + underscore-split for 易语言-style
// names like "网页_访问_对象". Mirrors jingyi_search.rs:176 tokenize().
// ---------------------------------------------------------------------------

function pushCjkTokens(text: string, out: string[]): void {
  const lower = text.toLowerCase();
  const cjkChars: string[] = [];
  for (const ch of lower) {
    if (/[一-鿿]/.test(ch)) cjkChars.push(ch);
    else if (cjkChars.length > 0) {
      flushCjkBuffer(cjkChars, out);
      cjkChars.length = 0;
    }
  }
  if (cjkChars.length > 0) flushCjkBuffer(cjkChars, out);
}

function flushCjkBuffer(buffer: string[], out: string[]): void {
  // Single chars + bigrams
  for (const ch of buffer) out.push(ch);
  for (let i = 0; i + 1 < buffer.length; i += 1) {
    out.push(buffer[i] + buffer[i + 1]);
  }
}

function pushLatinTokens(text: string, out: string[]): void {
  const matches = text.toLowerCase().match(/[a-z0-9]+/g);
  if (!matches) return;
  for (const word of matches) out.push(word);
}

function pushUnderscoreSegments(text: string, out: string[]): void {
  const segments = text.split(/[_\s,，、；。]+/);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (trimmed.length >= 2) out.push(trimmed.toLowerCase());
  }
}

export function tokenizeModuleQuery(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  pushCjkTokens(text, out);
  pushLatinTokens(text, out);
  pushUnderscoreSegments(text, out);
  return uniqueOrdered(out).filter((token) => token.length > 0).slice(0, 64);
}

function uniqueOrdered(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lexical scoring — mirrors jingyi_search.rs:456 weight table.
// ---------------------------------------------------------------------------

interface FieldText {
  field: "name" | "class" | "signature" | "params" | "description" | "return";
  text: string;
  weight: number;
}

function fieldTextsForApi(api: UserModuleApi): FieldText[] {
  return [
    { field: "name", text: api.name.toLowerCase(), weight: 18 },
    { field: "class", text: api.className.toLowerCase(), weight: 12 },
    { field: "signature", text: api.signature.toLowerCase(), weight: 10 },
    {
      field: "params",
      text: api.params.map((p) => `${p.name} ${p.type}`).join(" ").toLowerCase(),
      weight: 11,
    },
    { field: "description", text: api.description.toLowerCase(), weight: 5.5 },
    { field: "return", text: api.returnType.toLowerCase(), weight: 4.5 },
  ];
}

function tokenMatchScore(token: string, fieldText: string, weight: number): number {
  if (!token || !fieldText) return 0;
  if (fieldText === token) return weight * 3.2;
  if (fieldText.startsWith(token)) return weight * 1.7;
  if (fieldText.includes(token)) return weight;
  return 0;
}

function fullText(api: UserModuleApi): string {
  return [
    api.name,
    api.className,
    api.returnType,
    api.signature,
    api.description,
    api.params.map((p) => `${p.name} ${p.type} ${p.description}`).join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function scoreApiLexical(api: UserModuleApi, query: string, tokens: string[]): number {
  const lowerQuery = query.trim().toLowerCase();
  const lowerName = api.name.toLowerCase();
  const lowerClass = api.className.toLowerCase();

  let score = 0;
  if (lowerName === lowerQuery) score += 160;
  else if (lowerName.startsWith(lowerQuery)) score += 90;
  else if (lowerName.includes(lowerQuery)) score += 55;

  if (lowerClass) {
    if (lowerClass === lowerQuery) score += 110;
    else if (lowerClass.includes(lowerQuery)) score += 35;
  }

  const fields = fieldTextsForApi(api);
  for (const token of tokens) {
    for (const f of fields) {
      score += tokenMatchScore(token, f.text, f.weight);
    }
  }

  const text = fullText(api);
  let matched = 0;
  for (const token of tokens) {
    if (text.includes(token)) matched += 1;
  }
  if (matched > 1) score += Math.pow(matched, 1.35) * 12;

  // Param-name multi-token co-occurrence — separate boost like jingyi
  const paramHits = tokens.filter((token) =>
    api.params.some((param) => param.name.toLowerCase().includes(token)),
  ).length;
  if (paramHits > 1) score += Math.pow(paramHits, 1.45) * 24;

  // Role/structure bonus
  if (api.kind === "subprogram") score += 10;
  if (api.kind === "dll") score += 5;
  if (!api.isPublic) score -= 50;
  if (api.returnType === "无返回值") score -= 2;

  return score;
}

// ---------------------------------------------------------------------------
// Route grouping — function_family vs object_workflow — same heuristic as
// jingyi_search.rs:522 / family_for / route_type.
// ---------------------------------------------------------------------------

function familyFor(api: UserModuleApi): string {
  if (api.className) return api.className;
  if (api.name.includes("_")) {
    const parts = api.name.split("_");
    if (parts.length >= 2) return `${parts[0]}_${parts[1]}`;
  }
  return api.name;
}

function classifyRoute(family: string, members: UserModuleApi[]): UserModuleRoute["route_type"] {
  if (family.startsWith("类_") || members.some((api) => api.className === family)) {
    return "object_workflow";
  }
  return "function_family";
}

function diversifyRoutes(scoredRoutes: UserModuleRoute[], limit: number): UserModuleRoute[] {
  const seenCapability = new Set<string>();
  const out: UserModuleRoute[] = [];
  for (const route of scoredRoutes) {
    const key = route.family.toLowerCase();
    if (seenCapability.has(key)) continue;
    seenCapability.add(key);
    out.push(route);
    if (out.length >= limit) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Conversion + RRF fusion
// ---------------------------------------------------------------------------

function toMatch(
  api: UserModuleApi,
  module: { id: string; name: string; storedPath: string },
  score: number,
  semanticSim?: number,
): UserModuleMatch {
  return {
    id: api.id,
    module_id: module.id,
    module_name: module.name,
    module_path: module.storedPath,
    name: api.name,
    class_name: api.className,
    return_type: api.returnType,
    signature: api.signature,
    description: api.description,
    category: api.kind,
    is_public: api.isPublic,
    line: api.line,
    score,
    semantic_similarity: semanticSim,
  };
}

function rrfFuse(
  rankedLists: UserModuleMatch[][],
  k = 60,
): UserModuleMatch[] {
  const totals = new Map<string, { match: UserModuleMatch; score: number }>();
  for (const list of rankedLists) {
    for (let rank = 0; rank < list.length; rank += 1) {
      const match = list[rank];
      const key = `${match.module_id}::${match.id}`;
      const contribution = 1 / (k + rank + 1);
      const existing = totals.get(key);
      if (existing) {
        existing.score += contribution;
        // keep the higher score / similarity for display
        if (match.score > existing.match.score) existing.match.score = match.score;
        if ((match.semantic_similarity ?? 0) > (existing.match.semantic_similarity ?? 0)) {
          existing.match.semantic_similarity = match.semantic_similarity;
        }
      } else {
        totals.set(key, { match: { ...match }, score: contribution });
      }
    }
  }
  return Array.from(totals.values())
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.match);
}

// ---------------------------------------------------------------------------
// Module resolution (id / name)
// ---------------------------------------------------------------------------

function resolveModuleEntries(options: SearchUserModulesOptions): UserModuleEntry[] {
  const entries = useSettingsStore.getState().userModules;
  if (entries.length === 0) return [];

  if (options.moduleIds && options.moduleIds.length > 0) {
    const wanted = new Set(options.moduleIds);
    return entries.filter((m) => wanted.has(m.id));
  }

  if (options.moduleNames && options.moduleNames.length > 0) {
    const lowerNames = options.moduleNames.map((n) => n.trim().toLowerCase()).filter(Boolean);
    return entries.filter((m) => {
      const lname = m.name.toLowerCase();
      return lowerNames.some((needle) => lname.includes(needle));
    });
  }

  return entries;
}

export function resolveModuleIdsByName(names: string[]): string[] {
  const lower = names.map((n) => n.trim().toLowerCase()).filter(Boolean);
  if (lower.length === 0) return [];
  return useSettingsStore
    .getState()
    .userModules.filter((m) => {
      const lname = m.name.toLowerCase();
      return lower.some((needle) => lname.includes(needle));
    })
    .map((m) => m.id);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

const MAX_MATCHES_PER_MODULE = 20;

export async function searchUserModules(
  query: string,
  options: SearchUserModulesOptions = {},
): Promise<UserModuleSearchResult> {
  const trimmed = query.trim();
  const limit = Math.max(1, Math.min(options.limit ?? 10, 25));
  const useVector = options.useVector !== false;

  const entries = resolveModuleEntries(options);
  const candidates = entries.filter((m) => m.status === "ready" || (m.status === "indexing" && m.apiCount > 0));
  const searchedModules: UserModuleSearchResult["searched_modules"] = [];
  const unavailableModules: UserModuleSearchResult["unavailable_modules"] = entries.filter(m => !candidates.includes(m))
    .map(m => ({ id: m.id, name: m.name, status: m.status }));
  if (!trimmed || candidates.length === 0) {
    return {
      success: true,
      query: trimmed,
      count: 0,
      matches: [],
      implementation_options: [],
      searched_modules: searchedModules,
      module_paths: [],
      unavailable_modules: unavailableModules,
    };
  }

  const tokens = tokenizeModuleQuery(trimmed);
  let queryVector: Float32Array | null = null;

  // 1) Lexical pass + 2) optional vector recall, both per-module so we can
  //    keep results scoped to the right `module_id` for downstream display.
  const lexicalRanked: UserModuleMatch[] = [];
  const vectorRanked: UserModuleMatch[] = [];

  for (const moduleEntry of candidates) {
    const stored = await fetchIndex(moduleEntry.id);
    if (!stored) {
      unavailableModules.push({ id: moduleEntry.id, name: moduleEntry.name, status: "index_unavailable" });
      continue;
    }
    searchedModules.push({ id: moduleEntry.id, name: moduleEntry.name });

    const moduleHandle = { id: moduleEntry.id, name: moduleEntry.name, storedPath: moduleEntry.storedPath };

    // Lexical
    // Internal procedures and DLL declarations remain visible in module details,
    // but cannot be called as exported .ec commands by generated projects.
    const callableApis = stored.apis.filter(api => api.isPublic);
    const apiById = new Map(callableApis.map((api) => [api.id, api] as const));
    const scored = callableApis
      .map((api) => ({ api, score: scoreApiLexical(api, trimmed, tokens) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_MATCHES_PER_MODULE);
    for (const { api, score } of scored) {
      lexicalRanked.push(toMatch(api, moduleHandle, score));
    }

    // Vector — opt-in, expensive (model load on first call)
    if (useVector && stored.vectorIndex && tokens.length > 0) {
      try {
        if (!queryVector) queryVector = await embedQuery(trimmed);
        const vectorHits = await searchModuleVectorIndex(
          stored.vectorIndex,
          queryVector,
          MAX_MATCHES_PER_MODULE,
        );
        for (const hit of vectorHits) {
          const api = apiById.get(hit.apiId);
          if (!api) continue;
          // Vector contributes its own ranked list; the score field reuses the
          // lexical score (if the API also matched lexically) or falls back to
          // the cosine sim scaled to lexical magnitude (~ * 100).
          const lexScore = scored.find((entry) => entry.api.id === hit.apiId)?.score ?? hit.similarity * 100;
          vectorRanked.push(toMatch(api, moduleHandle, lexScore, hit.similarity));
        }
      } catch (error) {
        console.warn(`vector search failed for module ${moduleEntry.id}:`, error);
      }
    }
  }

  // RRF fuse — lexical-first (so short queries match by name), but vector
  // recall ensures semantic intent is preserved.
  const sortedLexical = lexicalRanked.sort((a, b) => b.score - a.score);
  const sortedVector = vectorRanked
    .sort((a, b) => (b.semantic_similarity ?? 0) - (a.semantic_similarity ?? 0));
  const fused = rrfFuse([sortedLexical, sortedVector], 60);

  if (fused.length === 0) {
    return {
      success: true,
      query: trimmed,
      count: 0,
      matches: [],
      implementation_options: [],
      searched_modules: searchedModules,
      module_paths: [],
      unavailable_modules: unavailableModules,
    };
  }

  const matches = fused.slice(0, limit);

  // Route grouping — group fused matches into family routes.
  const routes = buildRoutes(fused, candidates);

  return {
    success: true,
    query: trimmed,
    count: fused.length,
    matches,
    implementation_options: routes,
    searched_modules: searchedModules,
    module_paths: uniqueOrdered(matches.map(m => m.module_path).filter(Boolean)),
    unavailable_modules: unavailableModules,
  };
}

function buildRoutes(
  fused: UserModuleMatch[],
  candidates: UserModuleEntry[],
): UserModuleRoute[] {
  const moduleNameById = new Map(candidates.map((m) => [m.id, m.name] as const));
  const groups = new Map<string, UserModuleMatch[]>();

  for (const match of fused.slice(0, 60)) {
    const family = familyForMatch(match);
    if (!family) continue;
    const list = groups.get(family) ?? [];
    list.push(match);
    groups.set(family, list);
  }

  const scored: UserModuleRoute[] = [];
  for (const [family, members] of groups.entries()) {
    if (members.length === 0) continue;
    const apiLikeMembers = members.map(matchToApiLike);
    const routeType = classifyRoute(family, apiLikeMembers);
    const sorted = members.sort((a, b) => b.score - a.score);
    scored.push({
      family,
      route_type: routeType,
      summary: routeSummary(family, sorted, moduleNameById),
      primary_options: sorted.slice(0, 6),
      supporting_options: sorted.slice(6, 12),
    });
  }

  scored.sort((a, b) => routeSignal(b) - routeSignal(a));
  return diversifyRoutes(scored, 4);
}

function routeSignal(route: UserModuleRoute): number {
  return route.primary_options.reduce((total, option) => total + option.score, 0);
}

function familyForMatch(match: UserModuleMatch): string {
  if (match.class_name) return match.class_name;
  const name = match.name;
  if (name.includes("_")) {
    const parts = name.split("_");
    if (parts.length >= 2) return `${parts[0]}_${parts[1]}`;
  }
  return name;
}

function matchToApiLike(match: UserModuleMatch): UserModuleApi {
  return {
    id: match.id,
    kind: match.category,
    name: match.name,
    className: match.class_name,
    returnType: match.return_type,
    description: match.description,
    line: match.line,
    params: [],
    signature: match.signature,
    isPublic: match.is_public,
  };
}

function routeSummary(
  family: string,
  members: UserModuleMatch[],
  moduleNameById: Map<string, string>,
): string {
  const headNames = members.slice(0, 3).map((m) => m.name).filter(Boolean);
  const moduleNames = uniqueOrdered(members.map((m) => moduleNameById.get(m.module_id) ?? "")).filter(Boolean);
  const callChain = headNames.length > 0 ? `调用链：${headNames.join(" → ")}` : "";
  const moduleHint = moduleNames.length > 0 ? `来源模块：${moduleNames.join("、")}` : "";
  return [family, callChain, moduleHint].filter(Boolean).join("；");
}

// Re-export: UserModuleApi/Assembly are re-exported so consumers can avoid
// importing from module-library.ts when they only need the search shape.
export type { UserModuleApi, UserModuleAssembly };
