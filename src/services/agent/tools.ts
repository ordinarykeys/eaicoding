import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { ToolDefinition, ToolResult } from "@/types/llm";
import type { EasyLanguageEnvScan } from "@/services/easy-language-env";
import { useSettingsStore } from "@/stores/settings";
import { JINGYI_ITEMS, type JingyiSearchItem } from "@/services/agent/knowledge/jingyi-data";
import { enrichJingyiItemsWithDocs } from "@/services/agent/knowledge/jingyi-docs";
import { semanticSearchJingyiModule } from "@/services/agent/knowledge/jingyi-vector-search";

// ---------------------------------------------------------------------------
// Backend response shapes (mirror Rust structs in src-tauri/src/*).
// Keep these aligned with ecode_parser.rs etc.
// ---------------------------------------------------------------------------

export interface ECodeProjectResult {
  success: boolean;
  stdout: string;
  stderr: string;
  source_path: string | null;
  ecode_dir: string | null;
  output_path: string | null;
  files: string[];
}

export interface ECodeBaselineBuildResult {
  success: boolean;
  source_path: string;
  ecode_dir: string | null;
  output_path: string | null;
  stage: "efile_to_ecode" | "ecode_to_efile" | "ecl_compile" | "done";
  exported: {
    success: boolean;
    ecode_dir: string | null;
    stdout: string;
    stderr: string;
  } | null;
  generated: {
    success: boolean;
    output_path: string | null;
    stdout: string;
    stderr: string;
  } | null;
  compiled: {
    success: boolean;
    output_path: string | null;
    stdout: string;
    stderr: string;
  } | null;
  module_paths_used: string[];
  stdout: string;
  stderr: string;
  note: string;
}

export interface ECodeSubprogramSummary {
  name: string;
  signature: string;
  line: number;
  line_count: number;
  locals: string[];
  calls: string[];
}

export interface ECodeSourceFileSummary {
  path: string;
  relative_path: string;
  kind: string;
  chars: number;
  lines: number;
  support_libraries: string[];
  assembly: string | null;
  assembly_variables: string[];
  subprograms: ECodeSubprogramSummary[];
}

export interface ECodeProjectMapResult {
  success: boolean;
  ecode_dir: string;
  source_file_count: number;
  skipped_module_file_count: number;
  support_libraries: string[];
  assemblies: string[];
  entrypoints: string[];
  recommended_read_order: string[];
  source_files: ECodeSourceFileSummary[];
  summary: string;
}

export interface ECodeAnalysisFinding {
  severity: "info" | "warning" | "risk";
  kind: string;
  title: string;
  path: string;
  relative_path: string;
  line: number;
  evidence: string;
  suggestion: string;
}

export interface ECodeDuplicateGroup {
  title: string;
  normalized_size: number;
  locations: Array<{
    name: string;
    path: string;
    relative_path: string;
    line: number;
    line_count: number;
  }>;
  shared_calls: string[];
  suggestion: string;
}

export interface ECodeProjectAnalysisResult {
  success: boolean;
  ecode_dir: string;
  summary: string;
  project_map: ECodeProjectMapResult;
  metrics: {
    source_file_count: number;
    analyzed_file_count: number;
    skipped_module_file_count: number;
    subprogram_count: number;
    hardcoded_url_count: number;
    insecure_http_url_count: number;
    selector_count: number;
    network_call_count: number;
    duplicate_group_count: number;
    empty_component_count: number;
    sensitive_field_count: number;
  };
  findings: ECodeAnalysisFinding[];
  duplicate_groups: ECodeDuplicateGroup[];
  recommended_next_reads: string[];
  note: string;
}

export interface ECodeContextSnippet {
  path: string;
  relative_path: string;
  start_line: number;
  end_line: number;
  reason: string;
  content: string;
}

export interface ECodeContextFile {
  path: string;
  relative_path: string;
  kind: string;
  chars: number;
  lines: number;
  support_libraries: string[];
  assembly: string | null;
  assembly_variables: string[];
  subprograms: ECodeSubprogramSummary[];
  snippets: ECodeContextSnippet[];
}

export interface ECodeContextPackResult {
  success: boolean;
  ecode_dir: string;
  summary: string;
  metrics: ECodeProjectAnalysisResult["metrics"];
  files: ECodeContextFile[];
  findings: ECodeAnalysisFinding[];
  duplicate_groups: ECodeDuplicateGroup[];
  recommended_full_reads: string[];
  note: string;
}

export interface ECodeProjectBuildResult {
  success: boolean;
  ecode_dir: string;
  stage: "ecode_to_efile" | "ecl_compile" | "done";
  source_path: string | null;
  output_path: string | null;
  generated: {
    success: boolean;
    output_path: string | null;
    stdout: string;
    stderr: string;
  };
  compiled: {
    success: boolean;
    output_path: string | null;
    stdout: string;
    stderr: string;
  } | null;
  module_paths_used: string[];
  stdout: string;
  stderr: string;
}

export interface CompileResult {
  success: boolean;
  stdout: string;
  stderr: string;
  output_path: string | null;
}

export interface ParseResult {
  success: boolean;
  output: string;
  summary: unknown | null;
  error: string | null;
}

export interface ReadFileResult {
  path: string;
  content: string;
  encoding: string;
  bytes: number;
  truncated: boolean;
}

interface EasyLanguageEnvScanResult extends EasyLanguageEnvScan {}

// ---------------------------------------------------------------------------
// Tool execution context — what an executor can use beyond raw arguments.
// ---------------------------------------------------------------------------

export interface ToolExecContext {
  /** Active session id, used by tools that read latest assistant code. */
  sessionId: string | null;
  /** The user message that originated this turn. */
  userInput: string;
  /** Whether the agent loop owns the UI (used to enable native dialogs). */
  allowDialog: boolean;
  /** Callback invoked when a tool wants to surface a transient status to the UI. */
  onStatus?: (status: string) => void;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: ToolExecContext,
) => Promise<unknown>;

export interface RegisteredTool {
  definition: ToolDefinition;
  executor: ToolExecutor;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readBoolean(args: Record<string, unknown>, key: string, fallback = false): boolean {
  const value = args[key];
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value.toLowerCase() === "true";
  return fallback;
}

function readStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,;，；]+/)
      : [];

  return rawItems
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeSearchText(text: string): string {
  return text.trim().toLowerCase();
}

function uniqueOrdered<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function splitCjkNgrams(text: string, min = 2, max = 6): string[] {
  const grams: string[] = [];
  const chars = [...text];
  for (let size = min; size <= max; size += 1) {
    if (chars.length < size) break;
    for (let index = 0; index <= chars.length - size; index += 1) {
      grams.push(chars.slice(index, index + size).join(""));
    }
  }
  return grams;
}

function segmentCjkText(text: string): string[] {
  if (!/[\u4e00-\u9fff]/.test(text)) return [];
  const segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("zh", { granularity: "word" })
    : null;
  if (!segmenter) return splitCjkNgrams(text, 2, 4);

  return [...segmenter.segment(text)]
    .filter((segment) => segment.isWordLike)
    .map((segment) => segment.segment.trim().toLowerCase())
    .filter((segment) => segment.length >= 2);
}

function tokenizeJingyiText(text: string): string[] {
  const normalized = normalizeSearchText(text);
  const tokens: string[] = [];

  for (const match of normalized.matchAll(/[a-z0-9]+/g)) {
    const token = match[0];
    if (token.length >= 2) tokens.push(token);
  }

  for (const match of normalized.matchAll(/[\u4e00-\u9fff]+/g)) {
    const segment = match[0];
    if (segment.length >= 2) tokens.push(segment);
    tokens.push(...segmentCjkText(segment));
  }

  for (const piece of normalized.split(/[\s,，;；/|、_()（）:："'“”<>《》[\]【】{}]+/)) {
    const token = piece.trim();
    if (token.length >= 2) tokens.push(token);
  }

  return uniqueOrdered(tokens).slice(0, 120);
}

function expandJingyiQuery(query: string): string[] {
  const normalized = normalizeSearchText(query);
  const explicit = normalized
    .split(/[\s,，;；/|、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return uniqueOrdered([...explicit, ...tokenizeJingyiText(normalized)]).slice(0, 80);
}

function jingyiItemKey(item: JingyiSearchItem): string {
  return `${item.category}:${item.class_name}:${item.name}:${item.signature}`;
}

function jingyiSearchText(item: JingyiSearchItem): string {
  return [
    item.name,
    item.category,
    item.class_name,
    item.return_type,
    item.signature,
    item.description,
    item.params
      .map((param) => [
        param.name,
        param.type,
        param.attributes,
        param.description,
      ].filter(Boolean).join(" "))
      .join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

function scoreJingyiItem(item: JingyiSearchItem, query: string, tokens: string[]): number {
  const name = normalizeSearchText(item.name);
  const description = normalizeSearchText(item.description);
  const category = normalizeSearchText(item.category);
  const signature = normalizeSearchText(item.signature);
  const className = normalizeSearchText(item.class_name);
  const returnType = normalizeSearchText(item.return_type);
  const paramText = normalizeSearchText(
    item.params
      .map((param) => `${param.name} ${param.type} ${param.attributes ?? ""} ${param.description ?? ""}`)
      .join(" "),
  );
  const haystack = `${name} ${description} ${category} ${className} ${returnType} ${signature} ${paramText}`;
  const normalizedQuery = normalizeSearchText(query);

  let score = 0;
  if (name === normalizedQuery) score += 100;
  if (name.startsWith(normalizedQuery)) score += 60;
  if (name.includes(normalizedQuery)) score += 35;
  if (className === normalizedQuery) score += 90;
  if (className.includes(normalizedQuery)) score += 28;
  if (returnType === normalizedQuery) score += 55;
  if (signature.includes(normalizedQuery)) score += 18;
  if (description.includes(normalizedQuery)) score += 12;
  if (paramText.includes(normalizedQuery)) score += 18;

  for (const token of tokens) {
    if (!token) continue;
    if (name === token) score += 35;
    else if (name.includes(token)) score += 18;
    else if (returnType === token) score += 22;
    else if (className === token) score += item.category === "类" ? 8 : 22;
    else if (className.includes(token)) score += item.category === "类" ? 4 : 10;
    else if (signature.includes(token) || paramText.includes(token)) score += 10;
    else if (haystack.includes(token)) score += 6;
  }

  return score;
}

const JINGYI_QUERY_INTENT_WORDS = new Set([
  "案例",
  "案列",
  "例子",
  "示例",
  "代码",
  "写个",
  "写一个",
  "帮我",
  "怎么",
  "如何",
  "怎样",
  "实现",
  "使用",
  "用法",
]);

function meaningfulJingyiQueryTokens(tokens: string[]): string[] {
  const meaningful = tokens.filter((token) => !JINGYI_QUERY_INTENT_WORDS.has(token));
  return meaningful.length > 0 ? meaningful : tokens;
}

function jingyiFieldHitScore(text: string, token: string): number {
  const normalized = normalizeSearchText(text);
  if (!normalized || !token) return 0;
  if (normalized === token) return 3;
  if (normalized.startsWith(token)) return 2;
  return normalized.includes(token) ? 1 : 0;
}

function scoreJingyiFunctionalCandidate(
  item: JingyiSearchItem,
  query: string,
  tokens: string[],
): {
  item: JingyiSearchItem;
  score: number;
  coverage: number;
  nameHits: number;
  detailHits: number;
} {
  const terms = meaningfulJingyiQueryTokens(tokens);
  const paramText = item.params
    .map((param) => `${param.name} ${param.type} ${param.attributes ?? ""} ${param.description ?? ""}`)
    .join(" ");
  const detailText = [
    item.description,
    item.signature,
    item.return_type,
    item.class_name,
    paramText,
  ].join(" ");

  let nameHits = 0;
  let detailHits = 0;
  let weightedHits = 0;
  const matchedTerms = new Set<string>();

  for (const token of terms) {
    const nameHit = jingyiFieldHitScore(item.name, token);
    const classHit = jingyiFieldHitScore(item.class_name, token);
    const returnHit = jingyiFieldHitScore(item.return_type, token);
    const detailHit = Math.max(
      jingyiFieldHitScore(item.description, token),
      jingyiFieldHitScore(item.signature, token),
      jingyiFieldHitScore(paramText, token),
    );

    if (nameHit > 0 || classHit > 0 || returnHit > 0 || detailHit > 0) {
      matchedTerms.add(token);
    }
    nameHits += nameHit;
    detailHits += detailHit + classHit + returnHit;
    weightedHits += nameHit * 16 + detailHit * 10 + classHit * 5 + returnHit * 4;
  }

  const coverage = matchedTerms.size;
  const coverageRatio = terms.length > 0 ? coverage / terms.length : 0;
  const exactCommandQuery = isExactJingyiCommandQuery(query);
  let score =
    weightedHits +
    coverageRatio * 36 +
    scoreJingyiItem(item, query, terms) * 0.04 +
    categoryPrior(item, exactCommandQuery);

  if (item.category === "子程序") score += 10;
  if (item.category === "全局变量" && item.return_type.startsWith("类_")) score += 6;
  if (item.category === "类" && item.class_name && nameHits === 0) score -= 8;

  const normalizedQuery = normalizeSearchText(query);
  const normalizedName = normalizeSearchText(item.name);
  const normalizedClass = normalizeSearchText(item.class_name);
  const normalizedReturn = normalizeSearchText(item.return_type);
  const normalizedDetails = normalizeSearchText(detailText);
  const executableHttpApi =
    /网页_访问/.test(item.name) ||
    /http/i.test(item.class_name) ||
    /访问方式|提交信息|提交cookies|返回cookies|返回状态代码|附加协议头|content-type|post专用/i.test(detailText);

  if (/(post|请求|http|网页|接口|访问)/i.test(normalizedQuery) && executableHttpApi) {
    score += 38;
  }
  if (/post/i.test(normalizedQuery) && /post|提交信息|字节集提交/i.test(`${normalizedName} ${normalizedDetails}`)) {
    score += 30;
  }
  if (/请求|接口|http/i.test(normalizedQuery) && /请求|http|winhttp|wininet|访问方式/i.test(`${normalizedClass} ${normalizedDetails}`)) {
    score += 18;
  }
  if (/网页/.test(normalizedQuery) && normalizedName.startsWith("网页_访问")) {
    score += 28;
  }
  if (/post|请求|http|接口|网页/.test(normalizedQuery) && /保存|查看|排序|快捷方式|浏览器句柄/.test(normalizedName + normalizedDetails)) {
    score -= 55;
  }
  if (/post|请求|http|接口/.test(normalizedQuery) && item.category === "全局变量" && normalizedReturn.startsWith("类_")) {
    score += 16;
  }

  return { item, score, coverage, nameHits, detailHits };
}

function rankJingyiFunctionalCandidates(
  items: JingyiSearchItem[],
  query: string,
  tokens: string[],
  limit: number,
): JingyiSearchItem[] {
  const terms = meaningfulJingyiQueryTokens(tokens);
  const minCoverage = Math.min(2, Math.max(1, terms.length));
  return items
    .map((item) => scoreJingyiFunctionalCandidate(item, query, tokens))
    .filter((entry) => {
      if (entry.score <= 0) return false;
      if (isExactJingyiCommandQuery(query)) return entry.coverage > 0;
      return entry.coverage >= minCoverage || (terms.length <= 1 && entry.coverage > 0);
    })
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "zh-CN"))
    .slice(0, limit)
    .map((entry) => entry.item);
}

function shouldExpandJingyiFamily(seed: JingyiSearchItem, query: string, tokens: string[]): boolean {
  if (isExactJingyiCommandQuery(query)) return true;
  const terms = meaningfulJingyiQueryTokens(tokens);
  const scored = scoreJingyiFunctionalCandidate(seed, query, tokens);
  const minCoverage = Math.min(2, Math.max(1, terms.length));

  if (scored.coverage >= minCoverage) return true;
  if (terms.length <= 1 && scored.coverage > 0) return true;
  return scored.nameHits > 0 && scored.detailHits > 0;
}

interface JingyiLexicalIndex {
  items: JingyiSearchItem[];
  docs: Array<{
    item: JingyiSearchItem;
    tokenCounts: Map<string, number>;
    length: number;
  }>;
  documentFrequency: Map<string, number>;
  averageLength: number;
}

let enrichedJingyiItemsPromise: Promise<JingyiSearchItem[]> | null = null;
let lexicalIndexPromise: Promise<JingyiLexicalIndex> | null = null;

async function getEnrichedJingyiItems(): Promise<JingyiSearchItem[]> {
  if (!enrichedJingyiItemsPromise) {
    enrichedJingyiItemsPromise = enrichJingyiItemsWithDocs(JINGYI_ITEMS);
  }
  return enrichedJingyiItemsPromise;
}

async function getJingyiLexicalIndex(): Promise<JingyiLexicalIndex> {
  if (!lexicalIndexPromise) {
    lexicalIndexPromise = (async () => {
      const items = await getEnrichedJingyiItems();
      const docs = items.map((item) => {
        const tokens = tokenizeJingyiText(jingyiSearchText(item));
        const tokenCounts = new Map<string, number>();
        for (const token of tokens) {
          tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
        }
        return {
          item,
          tokenCounts,
          length: tokens.length || 1,
        };
      });
      const documentFrequency = new Map<string, number>();
      for (const doc of docs) {
        for (const token of doc.tokenCounts.keys()) {
          documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
        }
      }
      const averageLength =
        docs.reduce((total, doc) => total + doc.length, 0) / Math.max(1, docs.length);
      return {
        items,
        docs,
        documentFrequency,
        averageLength,
      };
    })();
  }
  return lexicalIndexPromise;
}

function scoreJingyiBm25(
  doc: JingyiLexicalIndex["docs"][number],
  queryTokens: string[],
  index: JingyiLexicalIndex,
): number {
  const effectiveTokens = queryTokens;
  if (effectiveTokens.length === 0) return 0;
  const k1 = 1.4;
  const b = 0.75;
  const totalDocs = Math.max(1, index.docs.length);
  let score = 0;
  for (const token of uniqueOrdered(effectiveTokens)) {
    const tf = doc.tokenCounts.get(token) ?? 0;
    if (tf <= 0) continue;
    const df = index.documentFrequency.get(token) ?? 0;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const denominator =
      tf + k1 * (1 - b + b * (doc.length / Math.max(1, index.averageLength)));
    score += idf * ((tf * (k1 + 1)) / denominator);
  }
  return score;
}

function categoryPrior(item: JingyiSearchItem, exactCommandQuery: boolean): number {
  if (exactCommandQuery) return 0;
  if (item.category === "子程序") return 4;
  if (item.category === "全局变量" && item.return_type.startsWith("类_")) return 3;
  if (item.category === "类") return 2;
  if (item.category === "DLL命令") return -2;
  if (item.category === "常量" || item.category === "图片资源") return -4;
  if (item.category === "数据类型") return -3;
  return 0;
}

function rankJingyiLexicalMatches(
  index: JingyiLexicalIndex,
  query: string,
  tokens: string[],
  limit: number,
): Array<{
  item: JingyiSearchItem;
  score: number;
  bm25: number;
  structured: number;
}> {
  const exactCommandQuery = isExactJingyiCommandQuery(query);
  return index.docs
    .map((doc) => {
      const structured = scoreJingyiItem(doc.item, query, tokens);
      const bm25 = scoreJingyiBm25(doc, tokens, index);
      const score = structured + bm25 * 8 + categoryPrior(doc.item, exactCommandQuery);
      return {
        item: doc.item,
        score,
        bm25,
        structured,
      };
    })
    .filter((entry) => entry.score > 0 || entry.structured > 0 || entry.bm25 > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "zh-CN"))
    .slice(0, limit);
}

function addRrfVotes(
  scores: Map<string, number>,
  ranking: JingyiSearchItem[],
  weight = 1,
  k = 60,
): void {
  ranking.forEach((item, index) => {
    const key = jingyiItemKey(item);
    scores.set(key, (scores.get(key) ?? 0) + weight / (k + index + 1));
  });
}

function rerankJingyiCandidates(
  items: JingyiSearchItem[],
  query: string,
  tokens: string[],
  relatedKeys: Set<string>,
  rrfScores: Map<string, number>,
): JingyiSearchItem[] {
  const exactCommandQuery = isExactJingyiCommandQuery(query);
  return uniqueJingyiItems(items)
    .map((item) => {
      const key = jingyiItemKey(item);
      const functional = scoreJingyiFunctionalCandidate(item, query, tokens);
      const score =
        (rrfScores.get(key) ?? 0) * 1000 +
        scoreJingyiItem(item, query, tokens) * 0.03 +
        functional.score * 0.35 +
        functional.coverage * 4 +
        (relatedKeys.has(key) ? 12 : 0) +
        categoryPrior(item, exactCommandQuery);
      return { item, score };
    })
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "zh-CN"))
    .map((entry) => entry.item);
}

function uniqueJingyiItems(items: JingyiSearchItem[]): JingyiSearchItem[] {
  const seen = new Set<string>();
  const unique: JingyiSearchItem[] = [];
  for (const item of items) {
    const key = jingyiItemKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

function isExactJingyiCommandQuery(query: string): boolean {
  return /^[\u4e00-\u9fa5A-Za-z0-9]+_[\u4e00-\u9fa5A-Za-z0-9_]+$/.test(query.trim());
}

function stripAsciiVariantSuffix(text: string): string {
  return text.replace(/[A-Za-z]+$/, "");
}

function deriveJingyiFamilyRoots(name: string): string[] {
  const clean = name.trim();
  const roots = new Set<string>();
  if (!clean.includes("_")) return [];

  const parts = clean.split("_").filter(Boolean);
  if (parts.length >= 2) {
    roots.add(`${parts[0]}_${stripAsciiVariantSuffix(parts[1]) || parts[1]}`);
  }
  const withoutSuffix = stripAsciiVariantSuffix(clean);
  if (withoutSuffix && withoutSuffix !== clean) roots.add(withoutSuffix);

  return [...roots].filter((root) => root.length >= 4 && root.includes("_"));
}

function isInJingyiFamily(item: JingyiSearchItem, root: string): boolean {
  const name = item.name.trim();
  return (
    name === root ||
    name.startsWith(`${root}_`) ||
    (name.startsWith(root) && stripAsciiVariantSuffix(name) === root)
  );
}

function deriveJingyiConceptRoots(item: JingyiSearchItem, query: string, tokens: string[]): string[] {
  if (!shouldExpandJingyiFamily(item, query, tokens)) return [];

  const roots = new Set<string>();
  for (const root of deriveJingyiFamilyRoots(item.name)) {
    roots.add(root);
  }

  const name = item.name.trim();
  const parts = name.split("_").filter(Boolean);
  if (parts.length >= 2) {
    roots.add(`${parts[0]}_${parts[1]}`);
  }
  if (parts.length >= 3) {
    roots.add(`${parts[0]}_${parts[1]}_${parts[2]}`);
  }

  return [...roots].filter((root) => root.length >= 4 && root.includes("_"));
}

function buildFunctionalJingyiImplementationGroups(
  seeds: JingyiSearchItem[],
  allItems: JingyiSearchItem[],
  query: string,
  tokens: string[],
  limit: number,
): Array<{
  family: string;
  summary: string;
  items: JingyiSearchItem[];
}> {
  const groups: Array<{
    family: string;
    score: number;
    summary: string;
    items: JingyiSearchItem[];
  }> = [];
  const seenFamilies = new Set<string>();

  for (const seed of seeds) {
    for (const family of deriveJingyiConceptRoots(seed, query, tokens)) {
      if (seenFamilies.has(family)) continue;
      seenFamilies.add(family);

      const candidates = rankJingyiFunctionalCandidates(
        allItems.filter((item) => {
          if (item.category === "常量" || item.category === "图片资源" || item.category === "数据类型") {
            return false;
          }
          return isInJingyiFamily(item, family);
        }),
        query,
        tokens,
        Math.max(3, Math.min(limit, 10)),
      );

      if (candidates.length < 2) continue;

      const familyScore = candidates.reduce(
        (total, item) => total + scoreJingyiFunctionalCandidate(item, query, tokens).score,
        0,
      );
      groups.push({
        family,
        score: familyScore,
        summary:
          `发现 ${candidates.length} 个同功能实现；回答“怎么实现/写案例”时应先列可选实现，说明返回类型、请求方式/参数和适用场景，再给默认推荐。`,
        items: candidates,
      });
    }
  }

  return groups
    .sort((a, b) => b.score - a.score || a.family.localeCompare(b.family, "zh-CN"))
    .map(({ family, summary, items }) => ({ family, summary, items }));
}

function uniqueRelatedJingyiGroups(
  groups: Array<{
    family: string;
    summary: string;
    items: JingyiSearchItem[];
  }>,
): Array<{
  family: string;
  summary: string;
  items: JingyiSearchItem[];
}> {
  const byFamily = new Map<string, {
    family: string;
    summary: string;
    items: JingyiSearchItem[];
  }>();

  for (const group of groups) {
    const existing = byFamily.get(group.family);
    if (!existing) {
      byFamily.set(group.family, {
        family: group.family,
        summary: group.summary,
        items: uniqueJingyiItems(group.items),
      });
      continue;
    }
    existing.items = uniqueJingyiItems([...existing.items, ...group.items]);
  }

  return [...byFamily.values()];
}

function buildRelatedJingyiImplementationGroups(
  seeds: JingyiSearchItem[],
  allItems: JingyiSearchItem[],
  query: string,
  tokens: string[],
  limit: number,
): Array<{
  family: string;
  summary: string;
  items: JingyiSearchItem[];
}> {
  const groups: Array<{
    family: string;
    score: number;
    summary: string;
    items: JingyiSearchItem[];
  }> = [];
  const seenFamilies = new Set<string>();

  for (const seed of seeds) {
    if (!shouldExpandJingyiFamily(seed, query, tokens)) continue;

    if (seed.class_name) {
      const family = seed.class_name;
      if (!seenFamilies.has(family)) {
        seenFamilies.add(family);
        const candidates = rankJingyiFunctionalCandidates(
          allItems.filter((item) => item.class_name === seed.class_name),
          query,
          tokens,
          Math.max(2, Math.min(limit, 10)),
        );

        if (candidates.length >= 2) {
          const familyScore = candidates.reduce(
            (total, item) => total + scoreJingyiFunctionalCandidate(item, query, tokens).score,
            0,
          );
          groups.push({
            family,
            score: familyScore,
            summary:
              `发现 ${candidates.length} 个同一类对象方法；回答对象式 API 问题时应说明调用顺序、状态/响应获取和请求头设置。`,
            items: candidates,
          });
        }
      }
    }

    if (seed.return_type.startsWith("类_")) {
      const family = seed.return_type;
      if (!seenFamilies.has(family)) {
        seenFamilies.add(family);
        const className = seed.return_type;
        const candidates = rankJingyiFunctionalCandidates(
          [seed, ...allItems.filter((item) => item.class_name === className)],
          query,
          tokens,
          Math.max(2, Math.min(limit, 10)),
        );

        if (candidates.length >= 2) {
          const familyScore = candidates.reduce(
            (total, item) => total + scoreJingyiFunctionalCandidate(item, query, tokens).score,
            0,
          );
          groups.push({
            family,
            score: familyScore,
            summary:
              `发现 ${candidates.length} 个对象变量/类方法组合；回答时应把实例变量与常用方法一起给出，而不是只列单个方法。`,
            items: uniqueJingyiItems(candidates),
          });
        }
      }
    }

    for (const family of deriveJingyiFamilyRoots(seed.name)) {
      if (seenFamilies.has(family)) continue;
      seenFamilies.add(family);

      const candidates = rankJingyiFunctionalCandidates(
        allItems.filter((item) => item.category === seed.category && isInJingyiFamily(item, family)),
        query,
        tokens,
        Math.max(2, Math.min(limit, 8)),
      );

      if (candidates.length < 2) continue;

      const familyScore = candidates.reduce(
        (total, item) => total + scoreJingyiFunctionalCandidate(item, query, tokens).score,
        0,
      );
      groups.push({
        family,
        score: familyScore,
        summary:
          `发现 ${candidates.length} 个同名族实现；回答自然语言功能问题时应列举差异，并根据返回值、参数和用户场景推荐。`,
        items: candidates,
      });
    }
  }

  return groups
    .sort((a, b) => b.score - a.score || a.family.localeCompare(b.family, "zh-CN"))
    .map(({ family, summary, items }) => ({ family, summary, items }));
}

function codeLooksLikeJingyiUsage(code: string): boolean {
  return /(?:[\u4e00-\u9fa5A-Za-z0-9]+_|类_)/.test(code);
}

function shouldUseSemanticJingyiSearch(query: string, exactMatches: JingyiSearchItem[]): boolean {
  if (exactMatches.length === 0) return true;
  if (isExactJingyiCommandQuery(query)) return false;
  return query.trim().length > 0;
}

function extractJingyiModulePathsFromInput(input: string): string[] {
  return extractLocalPathsByExtension(input, "ec").filter((item) =>
    /精易|jingyi/i.test(item),
  );
}

function extractLocalPathsByExtension(input: string, extension: string): string[] {
  const normalizedExtension = extension.replace(/^\./, "").toLowerCase();
  const matcher = /[A-Za-z]:\\[^\r\n<>"]+/g;
  const matches = input.match(matcher) ?? [];
  const deduped = new Set<string>();
  for (const match of matches) {
    const path = cleanLocalPathCandidate(match, normalizedExtension);
    if (path) deduped.add(path);
  }
  return [...deduped];
}

function cleanLocalPathCandidate(candidate: string, extension: string): string | null {
  const lower = candidate.toLowerCase();
  const marker = `.${extension.toLowerCase()}`;
  const markerIndex = lower.indexOf(marker);
  if (markerIndex < 0) return null;

  let path = candidate.slice(0, markerIndex + marker.length);
  path = path
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/[)\]）】》>，,。；;：:]+$/g, "");
  return path || null;
}

function joinLocalPath(dir: string, name: string): string {
  return `${dir.replace(/[\\/]+$/, "")}\\${name}`;
}

function fileStemFromPath(path: string, fallback: string): string {
  const fileName = path.split(/[\\/]/).pop()?.trim() || fallback;
  return fileName.replace(/\.[^.]+$/, "") || fallback;
}

function sanitizeFileName(name: string, fallback = "generated"): string {
  const clean = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return clean || fallback;
}

function getConfiguredGenerateDir(): string | null {
  const dir = useSettingsStore.getState().easyLanguageGenerateDir?.trim();
  return dir || null;
}

function getConfiguredCompileDir(): string | null {
  const dir = useSettingsStore.getState().easyLanguageCompileDir?.trim();
  return dir || null;
}

function makeConfiguredECodeDir(sourcePath: string): string | null {
  const dir = getConfiguredGenerateDir();
  if (!dir) return null;
  const stem = sanitizeFileName(fileStemFromPath(sourcePath, "project"), "project");
  return joinLocalPath(dir, `${stem}-${Date.now()}`);
}

function makeConfiguredEFilePath(sourceHint: string, fallback = "generated"): string | null {
  const dir = getConfiguredGenerateDir();
  if (!dir) return null;
  const stem = sanitizeFileName(fileStemFromPath(sourceHint, fallback), fallback);
  return joinLocalPath(dir, `${stem}-${Date.now()}.e`);
}

function makeConfiguredExePath(sourcePath: string): string | null {
  const dir = getConfiguredCompileDir();
  if (!dir) return null;
  const stem = sanitizeFileName(fileStemFromPath(sourcePath, "generated"), "generated");
  return joinLocalPath(dir, `${stem}.exe`);
}

/** Quietly truncate large outputs so they fit into the next prompt without
 *  blowing up the context window. We keep both head and tail of stderr because
 *  ecl errors are usually meaningful at the bottom (after the file list). */
function trimOutput(text: string, maxChars = 4000): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.4));
  const tail = text.slice(-Math.floor(maxChars * 0.6));
  return `${head}\n... [truncated ${text.length - maxChars} chars] ...\n${tail}`;
}

function rankReadableECodeFiles(file: string): number {
  const normalized = file.replace(/\\/g, "/");
  if (normalized === "全局变量.e.txt" || normalized.endsWith("/全局变量.e.txt")) return 0;
  if (normalized.includes("/代码/") && normalized.endsWith(".e.txt")) return 1;
  if (normalized.endsWith(".txt") || normalized.endsWith(".json") || normalized.endsWith(".list")) {
    return 2;
  }
  return 99;
}

function isInsideExportedModule(file: string): boolean {
  return file.replace(/\\/g, "/").includes("/模块/");
}

function collectReadableECodeFiles(files: string[], limit = 20): string[] {
  return files
    .filter((file) => !isInsideExportedModule(file) && rankReadableECodeFiles(file) < 99)
    .sort((a, b) => {
      const rankDiff = rankReadableECodeFiles(a) - rankReadableECodeFiles(b);
      return rankDiff !== 0 ? rankDiff : a.localeCompare(b, "zh-CN");
    })
    .slice(0, limit);
}

function addFinding(
  findings: ECodeAnalysisFinding[],
  finding: ECodeAnalysisFinding,
  limit = 120,
): void {
  if (findings.length >= limit) return;
  findings.push({
    ...finding,
    evidence: trimOutput(finding.evidence.replace(/\s+/g, " ").trim(), 260),
  });
}

function normalizeECodeBodyForDuplicate(body: string): string {
  return body
    .replace(/'[\s\S]*?(?=\r?\n|$)/g, "")
    .replace(/“[^”]*”/g, "S")
    .replace(/"[^"]*"/g, "S")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, "")
    .replace(/[，,]+/g, ",")
    .trim();
}

function extractSubprogramBody(content: string, subprogram: ECodeSubprogramSummary): string {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const start = Math.max(0, subprogram.line - 1);
  const end = Math.min(lines.length, start + Math.max(1, subprogram.line_count));
  return lines.slice(start, end).join("\n");
}

function commonCalls(items: ECodeSubprogramSummary[]): string[] {
  if (items.length === 0) return [];
  const callSets = items.map((item) => new Set(item.calls));
  const first = callSets[0];
  const rest = callSets.slice(1);
  if (!first) return [];
  return [...first]
    .filter((call) => rest.every((calls) => calls.has(call)))
    .slice(0, 12);
}

function uniquePathsFromFindings(findings: ECodeAnalysisFinding[], limit = 8): string[] {
  const paths: string[] = [];
  for (const finding of findings) {
    if (!paths.includes(finding.path)) paths.push(finding.path);
    if (paths.length >= limit) break;
  }
  return paths;
}

function tokenizeFocus(text: string): string[] {
  return [...new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .map((item) => item.trim())
      .filter((item) => [...item].length >= 2)
      .slice(0, 80),
  )];
}

function scoreECodeFileForFocus(file: ECodeSourceFileSummary, focusTokens: string[]): number {
  if (focusTokens.length === 0) return 0;
  const haystack = [
    file.relative_path,
    file.kind,
    file.assembly ?? "",
    ...file.support_libraries,
    ...file.assembly_variables,
    ...file.subprograms.flatMap((subprogram) => [
      subprogram.name,
      subprogram.signature,
      ...subprogram.locals,
      ...subprogram.calls,
    ]),
  ].join(" ").toLowerCase();

  return focusTokens.reduce((score, token) => (
    haystack.includes(token) ? score + Math.min(12, token.length) : score
  ), 0);
}

function pushUniquePath(paths: string[], value: string | null | undefined, limit = 20): void {
  if (!value || paths.includes(value) || paths.length >= limit) return;
  paths.push(value);
}

function makeSourceSnippet(
  file: ECodeSourceFileSummary,
  content: string,
  line: number,
  reason: string,
  radius = 6,
): ECodeContextSnippet {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const startLine = Math.max(1, line - radius);
  const endLine = Math.min(lines.length, line + radius);
  const snippet = lines
    .slice(startLine - 1, endLine)
    .map((item, index) => `${String(startLine + index).padStart(4, " ")} | ${item}`)
    .join("\n");
  return {
    path: file.path,
    relative_path: file.relative_path,
    start_line: startLine,
    end_line: endLine,
    reason,
    content: trimOutput(snippet, 4000),
  };
}

function lineRangesOverlap(a: ECodeContextSnippet, b: ECodeContextSnippet): boolean {
  return a.path === b.path && a.start_line <= b.end_line && b.start_line <= a.end_line;
}

async function loadECodeProjectMap(
  ecodeDir: string,
  includeModules: boolean,
  maxFiles: number | null,
): Promise<ECodeProjectMapResult> {
  return invoke<ECodeProjectMapResult>("summarize_ecode_project_for_agent", {
    ecodeDir,
    includeModules,
    maxFiles,
  });
}

async function analyzeECodeProjectContent(
  ecodeDir: string,
  includeModules: boolean,
  maxFiles: number | null,
): Promise<ECodeProjectAnalysisResult> {
  const projectMap = await loadECodeProjectMap(ecodeDir, includeModules, maxFiles);
  const findings: ECodeAnalysisFinding[] = [];
  const duplicateIndex = new Map<
    string,
    Array<{
      file: ECodeSourceFileSummary;
      subprogram: ECodeSubprogramSummary;
      body: string;
    }>
  >();

  let hardcodedUrlCount = 0;
  let insecureHttpUrlCount = 0;
  let selectorCount = 0;
  let networkCallCount = 0;
  let emptyComponentCount = 0;
  let sensitiveFieldCount = 0;
  let analyzedFileCount = 0;
  const subprogramCount = projectMap.source_files.reduce(
    (total, file) => total + file.subprograms.length,
    0,
  );

  for (const file of projectMap.source_files) {
    const read = await invoke<ReadFileResult>("read_text_file_for_agent", {
      filePath: file.path,
      maxChars: 240_000,
    });
    analyzedFileCount += 1;
    const content = read.content.replace(/\r\n/g, "\n");
    const lines = content.split("\n");

    if (read.truncated) {
      addFinding(findings, {
        severity: "warning",
        kind: "truncated_source",
        title: "源码读取被截断",
        path: file.path,
        relative_path: file.relative_path,
        line: 1,
        evidence: `${read.bytes} bytes`,
        suggestion: "需要优化该文件时先单独 read_file 提高 max_chars，避免基于截断内容改代码。",
      });
    }

    if (
      (file.kind === "类模块" || file.kind === "窗口程序集") &&
      file.subprograms.length === 0
    ) {
      emptyComponentCount += 1;
      addFinding(findings, {
        severity: "info",
        kind: "empty_component",
        title: "空壳组件",
        path: file.path,
        relative_path: file.relative_path,
        line: 1,
        evidence: `${file.kind} ${file.assembly ?? ""} 没有子程序`,
        suggestion: "确认是否为预留组件；如果长期不用，可移除或补充职责，减少模型和人工理解成本。",
      });
    }

    for (const subprogram of file.subprograms) {
      const body = extractSubprogramBody(content, subprogram);
      const normalized = normalizeECodeBodyForDuplicate(body);
      if (normalized.length >= 70 && subprogram.line_count >= 3) {
        const bucket = duplicateIndex.get(normalized) ?? [];
        bucket.push({ file, subprogram, body });
        duplicateIndex.set(normalized, bucket);
      }

      if (subprogram.line_count <= 3 && subprogram.calls.length === 0 && subprogram.locals.length === 0) {
        emptyComponentCount += 1;
        addFinding(findings, {
          severity: "info",
          kind: "empty_subprogram",
          title: "空子程序",
          path: file.path,
          relative_path: file.relative_path,
          line: subprogram.line,
          evidence: subprogram.signature,
          suggestion: "确认是否为事件占位；不需要时可清理，或在注释中说明预留原因。",
        });
      }
    }

    lines.forEach((line, index) => {
      const lineNo = index + 1;
      const urls = [...line.matchAll(/https?:\/\/[^\s"'“”）)>,，]+/g)].map((match) => match[0]);
      for (const url of urls) {
        hardcodedUrlCount += 1;
        if (url.startsWith("http://")) insecureHttpUrlCount += 1;
        addFinding(findings, {
          severity: url.startsWith("http://") ? "risk" : "warning",
          kind: url.startsWith("http://") ? "insecure_hardcoded_url" : "hardcoded_url",
          title: url.startsWith("http://") ? "明文 HTTP 地址硬编码" : "URL 硬编码",
          path: file.path,
          relative_path: file.relative_path,
          line: lineNo,
          evidence: line,
          suggestion: "把远程地址集中到配置/常量，并优先使用 HTTPS；更新/日志地址建议加超时、失败提示和内容校验。",
        });
      }

      const selectors = [
        ...line.matchAll(/[“"]#[^“"\s,，）)]+[”"]?/g),
      ].map((match) => match[0]);
      if (selectors.length > 0) {
        selectorCount += selectors.length;
        addFinding(findings, {
          severity: "warning",
          kind: "hardcoded_selector",
          title: "页面选择器硬编码",
          path: file.path,
          relative_path: file.relative_path,
          line: lineNo,
          evidence: line,
          suggestion: "把选择器集中管理，并在写入元素前检查元素是否存在，避免网页结构变化后静默失败。",
        });
      }

      if (/网页_访问S|网页_访问|网络_/.test(line)) {
        networkCallCount += 1;
        addFinding(findings, {
          severity: "warning",
          kind: "network_call",
          title: "网络调用缺少显式失败处理",
          path: file.path,
          relative_path: file.relative_path,
          line: lineNo,
          evidence: line,
          suggestion: "网络调用结果应判断空值/异常内容，并给用户可见提示；更新链接应做可信校验。",
        });
      }

      if (/identitynumber|mobile|身份证|手机号|txt_name|姓名/i.test(line)) {
        sensitiveFieldCount += 1;
        addFinding(findings, {
          severity: "risk",
          kind: "sensitive_form_field",
          title: "涉及个人信息字段",
          path: file.path,
          relative_path: file.relative_path,
          line: lineNo,
          evidence: line,
          suggestion: "填写身份证、手机号、姓名前应做格式校验；日志和错误提示不要泄露完整个人信息。",
        });
      }
    });
  }

  const duplicateGroups: ECodeDuplicateGroup[] = [];
  for (const [, group] of duplicateIndex) {
    if (group.length < 2) continue;
    const summaries = group.map((item) => item.subprogram);
    duplicateGroups.push({
      title: `重复逻辑：${group.map((item) => item.subprogram.name).join(" / ")}`,
      normalized_size: normalizeECodeBodyForDuplicate(group[0].body).length,
      locations: group.map((item) => ({
        name: item.subprogram.name,
        path: item.file.path,
        relative_path: item.file.relative_path,
        line: item.subprogram.line,
        line_count: item.subprogram.line_count,
      })),
      shared_calls: commonCalls(summaries),
      suggestion: "抽成公共子程序或类方法，窗口事件只传入 URL/控件/选择器等差异参数。",
    });
  }

  duplicateGroups.sort((a, b) => b.normalized_size - a.normalized_size);
  for (const group of duplicateGroups.slice(0, 20)) {
    const first = group.locations[0];
    addFinding(findings, {
      severity: "warning",
      kind: "duplicate_logic",
      title: group.title,
      path: first.path,
      relative_path: first.relative_path,
      line: first.line,
      evidence: group.locations
        .map((item) => `${item.relative_path}:${item.line} ${item.name}`)
        .join(" | "),
      suggestion: group.suggestion,
    });
  }

  const severityRank: Record<ECodeAnalysisFinding["severity"], number> = {
    risk: 0,
    warning: 1,
    info: 2,
  };
  findings.sort((a, b) => {
    const severityDiff = severityRank[a.severity] - severityRank[b.severity];
    if (severityDiff !== 0) return severityDiff;
    const pathDiff = a.relative_path.localeCompare(b.relative_path, "zh-CN");
    return pathDiff !== 0 ? pathDiff : a.line - b.line;
  });

  const metrics = {
    source_file_count: projectMap.source_file_count,
    analyzed_file_count: analyzedFileCount,
    skipped_module_file_count: projectMap.skipped_module_file_count,
    subprogram_count: subprogramCount,
    hardcoded_url_count: hardcodedUrlCount,
    insecure_http_url_count: insecureHttpUrlCount,
    selector_count: selectorCount,
    network_call_count: networkCallCount,
    duplicate_group_count: duplicateGroups.length,
    empty_component_count: emptyComponentCount,
    sensitive_field_count: sensitiveFieldCount,
  };

  return {
    success: true,
    ecode_dir: projectMap.ecode_dir,
    summary:
      `已分析 ${metrics.analyzed_file_count}/${metrics.source_file_count} 个主工程源码文件：` +
      `发现 ${metrics.duplicate_group_count} 组重复逻辑、${metrics.hardcoded_url_count} 个硬编码 URL、` +
      `${metrics.selector_count} 个页面选择器、${metrics.network_call_count} 处网络调用、` +
      `${metrics.empty_component_count} 个空壳组件/子程序。`,
    project_map: {
      ...projectMap,
      source_files: projectMap.source_files.slice(0, 20),
    },
    metrics,
    findings: findings.slice(0, 80),
    duplicate_groups: duplicateGroups.slice(0, 20),
    recommended_next_reads: uniquePathsFromFindings(findings, 10),
    note:
      "这是基于导出文本工程的静态分析事实，用来帮助模型选择要读取和修改的文件；真正改代码前仍应 read_file 读取目标 .e.txt 的完整内容。",
  };
}

async function buildECodeContextPack(
  ecodeDir: string,
  focus: string | null,
  includeModules: boolean,
  maxFiles: number | null,
  maxSnippets: number | null,
): Promise<ECodeContextPackResult> {
  const analysis = await analyzeECodeProjectContent(ecodeDir, includeModules, maxFiles);
  const projectMap = await loadECodeProjectMap(ecodeDir, includeModules, maxFiles);
  const focusTokens = tokenizeFocus(focus ?? "");
  const fileScores = new Map<string, number>();
  for (const file of projectMap.source_files) {
    fileScores.set(file.path, scoreECodeFileForFocus(file, focusTokens));
  }

  const candidatePaths: string[] = [];
  for (const path of analysis.recommended_next_reads) {
    pushUniquePath(candidatePaths, path, 24);
  }
  for (const file of [...projectMap.source_files].sort((a, b) => {
    const scoreDiff = (fileScores.get(b.path) ?? 0) - (fileScores.get(a.path) ?? 0);
    if (scoreDiff !== 0) return scoreDiff;
    return a.relative_path.localeCompare(b.relative_path, "zh-CN");
  })) {
    if ((fileScores.get(file.path) ?? 0) > 0) pushUniquePath(candidatePaths, file.path, 24);
  }
  for (const path of projectMap.recommended_read_order) {
    pushUniquePath(candidatePaths, path, 24);
  }

  const selectedFiles = candidatePaths
    .map((path) => projectMap.source_files.find((file) => file.path === path))
    .filter((file): file is ECodeSourceFileSummary => Boolean(file))
    .slice(0, Math.max(1, Math.min(maxFiles ?? 6, 12)));
  const snippetLimit = Math.max(1, Math.min(maxSnippets ?? 24, 60));

  const files: ECodeContextFile[] = [];
  let usedSnippets = 0;
  for (const file of selectedFiles) {
    const read = await invoke<ReadFileResult>("read_text_file_for_agent", {
      filePath: file.path,
      maxChars: 120_000,
    });
    const content = read.content.replace(/\r\n/g, "\n");
    const snippets: ECodeContextSnippet[] = [];
    const fileFindings = analysis.findings.filter((finding) => finding.path === file.path);

    for (const finding of fileFindings) {
      if (usedSnippets >= snippetLimit) break;
      const snippet = makeSourceSnippet(file, content, finding.line, finding.title);
      if (!snippets.some((existing) => lineRangesOverlap(existing, snippet))) {
        snippets.push(snippet);
        usedSnippets += 1;
      }
    }

    if (snippets.length === 0 && usedSnippets < snippetLimit) {
      const firstSubprogram = file.subprograms[0];
      const anchorLine = firstSubprogram?.line ?? 1;
      snippets.push(
        makeSourceSnippet(
          file,
          content,
          anchorLine,
          firstSubprogram ? `入口子程序：${firstSubprogram.name}` : "文件开头",
          firstSubprogram ? 8 : 10,
        ),
      );
      usedSnippets += 1;
    }

    files.push({
      path: file.path,
      relative_path: file.relative_path,
      kind: file.kind,
      chars: file.chars,
      lines: file.lines,
      support_libraries: file.support_libraries,
      assembly: file.assembly,
      assembly_variables: file.assembly_variables.slice(0, 40),
      subprograms: file.subprograms.slice(0, 80),
      snippets,
    });
  }

  return {
    success: true,
    ecode_dir: analysis.ecode_dir,
    summary:
      `已生成上下文包：${files.length} 个主工程文件、${files.reduce((total, file) => total + file.snippets.length, 0)} 段源码片段。` +
      (focusTokens.length > 0 ? ` focus=${focusTokens.slice(0, 12).join(", ")}` : ""),
    metrics: analysis.metrics,
    files,
    findings: analysis.findings.slice(0, 40),
    duplicate_groups: analysis.duplicate_groups.slice(0, 10),
    recommended_full_reads: files.map((file) => file.path),
    note:
      "这是面向模型的项目上下文包，用于决定下一步读取和修改哪些文件；真正覆盖保存前仍要 read_file 读取目标文件完整内容，避免只凭片段改动。",
  };
}

export async function searchJingyiKnowledge(query: string, limit = 8) {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  const tokens = expandJingyiQuery(query);
  const allItems = await getEnrichedJingyiItems();
  const lexicalIndex = await getJingyiLexicalIndex();
  const lexicalMatches = rankJingyiLexicalMatches(lexicalIndex, query, tokens, safeLimit * 3);

  const exactMatches = JINGYI_ITEMS
    .map((item) => ({ item, score: scoreJingyiItem(item, query, tokens) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, "zh-CN"))
    .slice(0, safeLimit)
    .map((entry) => entry.item);
  const semantic = shouldUseSemanticJingyiSearch(query, exactMatches)
    ? await semanticSearchJingyiModule(query, safeLimit)
      : {
        enabled: false,
        model:
          (globalThis as typeof globalThis & {
            __EAICODING_LOCAL_EMBEDDING_MODEL_PATH__?: string;
          }).__EAICODING_LOCAL_EMBEDDING_MODEL_PATH__ ||
          "/models/Xenova/bge-small-zh-v1.5",
        indexed_count: 0,
        matches: [],
        error: "精确命令查询已命中，跳过向量检索以保持响应速度。",
      };
  const functionalMatches = rankJingyiFunctionalCandidates(
    allItems,
    query,
    tokens,
    safeLimit * 3,
  );
  const rrfScores = new Map<string, number>();
  addRrfVotes(rrfScores, exactMatches, 1.4);
  addRrfVotes(rrfScores, lexicalMatches.map((hit) => hit.item), 1.2);
  addRrfVotes(rrfScores, semantic.matches.map((hit) => hit.item), 1);
  addRrfVotes(rrfScores, functionalMatches, 2.4);
  const merged = new Map<string, JingyiSearchItem>();
  for (const item of exactMatches) {
    merged.set(jingyiItemKey(item), item);
  }
  for (const hit of lexicalMatches) {
    merged.set(jingyiItemKey(hit.item), hit.item);
    if (merged.size >= safeLimit * 3) break;
  }
  for (const hit of semantic.matches) {
    merged.set(jingyiItemKey(hit.item), hit.item);
    if (merged.size >= safeLimit * 3) break;
  }
  const seedItems = [
    ...exactMatches,
    ...lexicalMatches.map((hit) => hit.item),
    ...semantic.matches.map((hit) => hit.item),
    ...functionalMatches,
  ];
  const relatedGroups = uniqueRelatedJingyiGroups([
    ...buildFunctionalJingyiImplementationGroups(seedItems, allItems, query, tokens, safeLimit),
    ...buildRelatedJingyiImplementationGroups(seedItems, allItems, query, tokens, safeLimit),
  ]).slice(0, 5);
  const relatedKeys = new Set<string>();
  for (const item of functionalMatches) {
    merged.set(jingyiItemKey(item), item);
    if (merged.size >= safeLimit * 4) break;
  }
  for (const group of relatedGroups) {
    for (const item of group.items) {
      relatedKeys.add(jingyiItemKey(item));
      if (merged.size >= safeLimit * 4) break;
      merged.set(jingyiItemKey(item), item);
    }
  }

  const matches = rerankJingyiCandidates(
    [...merged.values()],
    query,
    tokens,
    relatedKeys,
    rrfScores,
  ).slice(0, safeLimit);
  const enrichedMatches = await enrichJingyiItemsWithDocs(matches);
  const relatedImplementations = await Promise.all(
    relatedGroups.map(async (group) => ({
      family: group.family,
      summary: group.summary,
      count: group.items.length,
      items: await enrichJingyiItemsWithDocs(group.items),
    })),
  );
  const implementationOptions = relatedImplementations.map((group) => ({
    family: group.family,
    summary: group.summary,
    options: group.items.map((item) => ({
      name: item.name,
      category: item.category,
      class_name: item.class_name,
      return_type: item.return_type,
      signature: item.signature,
      description: item.description,
      key_params: item.params
        .filter((param) => {
          const text = `${param.name} ${param.description ?? ""}`;
          return /网址|访问方式|提交|cookie|协议头|状态|超时|数据|内容|编码|代理|请求|响应|返回/i.test(text);
        })
        .slice(0, 10),
    })),
  }));
  const semanticItems = await enrichJingyiItemsWithDocs(
    semantic.matches.map((hit) => hit.item),
  );

  return {
    module: "精易模块",
    query,
    expanded_terms: tokens,
    count: enrichedMatches.length,
    matches: enrichedMatches,
    related_implementations: relatedImplementations,
    implementation_options: implementationOptions,
    exact_count: exactMatches.length,
    lexical_search: {
      enabled: true,
      indexed_count: lexicalIndex.items.length,
      method: "BM25 + structured field scoring; fused with exact and semantic retrieval by RRF",
      matches: lexicalMatches.slice(0, safeLimit).map((hit) => ({
        score: Number(hit.score.toFixed(4)),
        bm25: Number(hit.bm25.toFixed(4)),
        structured: Number(hit.structured.toFixed(4)),
        item: hit.item,
      })),
    },
    semantic_search: {
      enabled: semantic.enabled,
      model: semantic.model,
      indexed_count: semantic.indexed_count,
      error: semantic.error,
    },
    semantic_matches: semantic.matches.map((hit, index) => ({
      similarity: Number(hit.similarity.toFixed(4)),
      ...semanticItems[index],
    })),
    note:
      "matches 已合并精确检索、BM25/结构化字段检索、本地向量检索、功能候选重排和通用 API 关系展开。回答自然语言功能问题时，如果 implementation_options 或 related_implementations 非空，应先列多个可用实现，比较返回值、关键参数、对象调用链和适用场景，再给默认推荐与代码；不要只因为第一条能用就只写一种。生成代码时以实际签名为准。如果用到这些命令，生成 .e 时需要通过 module_paths 引用精易模块，compile_efile 也会自动使用用户消息中的 .ec 路径。",
  };
}

/** Extract the most relevant code block from an assistant message. Prefers
 *  explicit ```epl/```易语言/```e blocks, falls back to any block, finally
 *  returns the message as-is. */
export function extractPreferredCodeBlock(content: string): string {
  const candidates = [...content.matchAll(/```(\w+)?\n([\s\S]*?)```/g)];
  if (candidates.length === 0) return content;

  const ranked = ["epl", "易语言", "e", "ecode", "easy"];
  for (const lang of ranked) {
    const found = candidates.find((m) => (m[1] || "").toLowerCase() === lang);
    if (found) return found[2].trim();
  }
  return candidates[0][2].trim();
}

export interface WriteTextResult {
  path: string;
  bytes: number;
}

/** Read any local file and return its content as text (UTF-8 or GBK auto-detected). */
const readFile: RegisteredTool = {
  definition: {
    name: "read_file",
    description:
      "读取本地文件内容，自动识别 UTF-8 / GBK 编码（易语言文件通常为 GBK）。" +
      "适用于 .epl .txt .ini .json .csv .log .md 以及导出的 .e.txt 等文本文件。" +
      "当用户提到文本文件路径时，先用此工具读取内容再分析；对于 .e / .ec 二进制工程文件，应改用 parse_efile。",
    parameters: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "本地文件绝对路径，必须真实存在。",
        },
        max_chars: {
          type: "integer",
          description: "最多读取的字符数，默认 12000。超长文件会被截断并提示。",
          nullable: true,
        },
      },
      required: ["file_path"],
    },
  },
  executor: async (args) => {
    const filePath = readString(args, "file_path");
    if (!filePath) throw new Error("缺少必填参数 file_path");
    const maxChars = typeof args.max_chars === "number" ? args.max_chars : null;
    const result = await invoke<ReadFileResult>("read_text_file_for_agent", {
      filePath,
      maxChars,
    });
    return {
      path: result.path,
      encoding: result.encoding,
      bytes: result.bytes,
      truncated: result.truncated,
      content: result.content,
    };
  },
};

const scanEasyLanguageEnv: RegisteredTool = {
  definition: {
    name: "scan_easy_language_env",
    description:
      "扫描本机易语言安装目录，只返回环境与依赖清单（支持库 .fne、模块 .ec、编译相关工具），不建立帮助文档知识库。" +
      "在分析/优化/编译项目时可先调用它确认本机有哪些支持库和模块，避免推荐不存在的依赖。",
    parameters: {
      type: "object",
      properties: {
        root_path: {
          type: "string",
          description: "可选易语言安装目录，例如 D:\\e。留空时自动探测常见路径。",
          nullable: true,
        },
      },
    },
  },
  executor: async (args) => {
    const rootPath = readString(args, "root_path");
    const result = await invoke<EasyLanguageEnvScanResult>("scan_easy_language_env", {
      rootPath: rootPath ?? null,
    });
    return {
      root: result.root,
      exists: result.exists,
      is_compile_ready: result.is_compile_ready,
      counts: result.counts,
      tools: result.tools,
      support_libraries: result.support_libraries.slice(0, 120),
      modules: result.modules,
      warnings: result.warnings,
      note:
        "这是本机环境/依赖清单，不是知识库。需要源码内容时仍要 parse_efile / export_efile_to_ecode / read_file。",
    };
  },
};

const searchJingyiModule: RegisteredTool = {
  definition: {
    name: "search_jingyi_module",
    description:
      "查询内置精易模块知识库，返回匹配命令/类/全局变量的签名和参数。" +
      "当用户要实现任意易语言/精易模块相关功能时，先调用本工具查精易模块，再生成易语言代码。" +
      "本工具是唯一可作为知识库使用的 API 查询入口，不读取易语言 IDE help 或其他支持库文档。",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要查询的精易模块命令名或自然语言功能描述。",
        },
        limit: {
          type: "integer",
          description: "最多返回多少条，默认 8，最大 20。",
          nullable: true,
        },
      },
      required: ["query"],
    },
  },
  executor: async (args) => {
    const query = readString(args, "query");
    if (!query) throw new Error("缺少必填参数 query");
    const limit = Math.max(1, Math.min(typeof args.limit === "number" ? args.limit : 8, 20));
    return searchJingyiKnowledge(query, limit);
  },
};

const parseEFile: RegisteredTool = {
  definition: {
    name: "parse_efile",
    description:
      "解析本地 .e 或 .ec 文件，返回反编译源码摘要（子程序列表、参数、局部变量、代码逻辑）、引用的支持库和模块列表。" +
      "对于 .e 主程序：输出包含完整的子程序结构和代码，以及引用了哪些支持库和 .ec 模块。" +
      "对于 .ec 模块：输出模块中所有公开子程序的接口信息。注意：模块通常非常大，主程序只使用其中一小部分命令。",
    parameters: {
      type: "object",
      properties: {
        target_path: {
          type: "string",
          description: "本地 .e 或 .ec 文件的绝对路径，必须真实存在。",
        },
      },
      required: ["target_path"],
    },
  },
  executor: async (args) => {
    const targetPath = readString(args, "target_path");
    if (!targetPath) throw new Error("缺少必填参数 target_path");
    const result = await invoke<ParseResult>("parse_efile", { filePath: targetPath });
    return {
      success: result.success,
      summary: result.summary,
      output_excerpt: trimOutput(result.output ?? "", 8000),
      error: result.error,
    };
  },
};

/** Convert an .e file to e2txt-style folder source. */
const exportECode: RegisteredTool = {
  definition: {
    name: "export_efile_to_ecode",
    description:
      "把 .e 文件导出为 e2txt 文本工程目录，方便逐行查看子程序源码。",
    parameters: {
      type: "object",
      properties: {
        target_path: {
          type: "string",
          description: "本地 .e 文件路径。",
        },
        output_path: {
          type: "string",
          description: "可选输出目录，留空时使用默认 AppLocalData/ecode/<name>。",
          nullable: true,
        },
      },
      required: ["target_path"],
    },
  },
  executor: async (args) => {
    const targetPath = readString(args, "target_path");
    if (!targetPath) throw new Error("缺少必填参数 target_path");
    const outputPath =
      readString(args, "output_path") ??
      readString(args, "output_dir") ??
      makeConfiguredECodeDir(targetPath);
    const result = await invoke<ECodeProjectResult>("export_efile_to_ecode", {
      sourcePath: targetPath,
      outputDir: outputPath ?? null,
    });
    const readableFiles = collectReadableECodeFiles(result.files);
    return {
      success: result.success,
      ecode_dir: result.ecode_dir,
      output_path: result.output_path ?? result.ecode_dir,
      files: result.files.slice(0, 50),
      readable_files: readableFiles,
      recommended_read_order: readableFiles.slice(0, 8),
      note:
        "下一步优先调用 summarize_ecode_project 生成项目地图；如果要优化/重构，再调用 analyze_ecode_project 找重复逻辑、硬编码和风险点，然后按 recommended_next_reads / recommended_read_order 读取关键 .e.txt 文本源码。导出目录根部的 代码.e 通常仍是二进制工程文件，不适合直接 read_file。",
      file_count: result.files.length,
      stderr: trimOutput(result.stderr, 1500),
    };
  },
};

const summarizeECodeProject: RegisteredTool = {
  definition: {
    name: "summarize_ecode_project",
    description:
      "为 export_efile_to_ecode 导出的易语言文本工程生成项目地图。" +
      "返回主工程源码文件、窗口/类程序集、子程序入口、支持库、建议读取顺序；默认跳过 模块/ 下的精易模块等大型依赖源码，避免把依赖库当成主项目。",
    parameters: {
      type: "object",
      properties: {
        ecode_dir: {
          type: "string",
          description: "export_efile_to_ecode 返回的文本工程目录。",
        },
        include_modules: {
          type: "boolean",
          description: "是否包含 模块/ 下的依赖源码。默认 false；分析主程序时不要开启。",
          nullable: true,
        },
        max_files: {
          type: "integer",
          description: "最多摘要多少个源码文件，默认 40。",
          nullable: true,
        },
      },
      required: ["ecode_dir"],
    },
  },
  executor: async (args) => {
    const ecodeDir = readString(args, "ecode_dir");
    if (!ecodeDir) throw new Error("缺少必填参数 ecode_dir");
    const includeModules = readBoolean(args, "include_modules", false);
    const maxFiles = typeof args.max_files === "number" ? args.max_files : null;
    const result = await invoke<ECodeProjectMapResult>("summarize_ecode_project_for_agent", {
      ecodeDir,
      includeModules,
      maxFiles,
    });
    return result;
  },
};

const analyzeECodeProject: RegisteredTool = {
  definition: {
    name: "analyze_ecode_project",
    description:
      "对 export_efile_to_ecode 导出的易语言文本工程做静态质量分析。" +
      "它会读取主工程 .e.txt，返回重复子程序、硬编码 URL/选择器、网络调用、空壳组件、个人信息字段等结构化事实；默认跳过 模块/ 依赖源码。",
    parameters: {
      type: "object",
      properties: {
        ecode_dir: {
          type: "string",
          description: "export_efile_to_ecode 返回的文本工程目录。",
        },
        include_modules: {
          type: "boolean",
          description: "是否分析 模块/ 下的依赖源码。默认 false；优化主程序时不要开启。",
          nullable: true,
        },
        max_files: {
          type: "integer",
          description: "最多分析多少个源码文件，默认 40。",
          nullable: true,
        },
      },
      required: ["ecode_dir"],
    },
  },
  executor: async (args) => {
    const ecodeDir = readString(args, "ecode_dir");
    if (!ecodeDir) throw new Error("缺少必填参数 ecode_dir");
    const includeModules = readBoolean(args, "include_modules", false);
    const maxFiles = typeof args.max_files === "number" ? args.max_files : null;
    return analyzeECodeProjectContent(ecodeDir, includeModules, maxFiles);
  },
};

const inspectECodeContext: RegisteredTool = {
  definition: {
    name: "inspect_ecode_context",
    description:
      "为导出的易语言文本工程生成面向模型的上下文包，类似 AI coding agent 的 repo/context map。" +
      "它会结合项目地图、静态质量分析、用户关注点，返回关键文件轮廓、风险片段、重复逻辑和 recommended_full_reads；用于减少盲目 read_file 和中途停顿。",
    parameters: {
      type: "object",
      properties: {
        ecode_dir: {
          type: "string",
          description: "export_efile_to_ecode 返回的文本工程目录。",
        },
        focus: {
          type: "string",
          description: "当前任务关注点，可直接传用户原话或模型当前要优化的目标；用于通用语义排序，不做关键词路由。",
          nullable: true,
        },
        include_modules: {
          type: "boolean",
          description: "是否包含 模块/ 下依赖源码。默认 false；优化主工程时不要开启。",
          nullable: true,
        },
        max_files: {
          type: "integer",
          description: "最多返回多少个主工程文件上下文，默认 6，最大 12。",
          nullable: true,
        },
        max_snippets: {
          type: "integer",
          description: "最多返回多少段源码片段，默认 24，最大 60。",
          nullable: true,
        },
      },
      required: ["ecode_dir"],
    },
  },
  executor: async (args, ctx) => {
    const ecodeDir = readString(args, "ecode_dir");
    if (!ecodeDir) throw new Error("缺少必填参数 ecode_dir");
    const focus = readString(args, "focus") ?? ctx.userInput;
    const includeModules = readBoolean(args, "include_modules", false);
    const maxFiles = typeof args.max_files === "number" ? args.max_files : null;
    const maxSnippets = typeof args.max_snippets === "number" ? args.max_snippets : null;
    return buildECodeContextPack(ecodeDir, focus, includeModules, maxFiles, maxSnippets);
  },
};

/** Rebuild a real .e project from an exported e2txt folder. */
const generateEFileFromECode: RegisteredTool = {
  definition: {
    name: "generate_efile_from_ecode",
    description:
      "把已经导出的 e2txt 文本工程目录重新打包为 .e 文件。" +
      "适用于保留原有窗口、模块、资源结构的项目优化场景；当你已经通过 export_efile_to_ecode 拿到 ecode_dir 并修改了其中的 .e.txt 文件后，应优先使用本工具。",
    parameters: {
      type: "object",
      properties: {
        ecode_dir: {
          type: "string",
          description: "export_efile_to_ecode 返回的文本工程目录路径。",
        },
        output_path: {
          type: "string",
          description: "可选 .e 输出路径，留空时使用默认临时目录。",
          nullable: true,
        },
      },
      required: ["ecode_dir"],
    },
  },
  executor: async (args) => {
    const ecodeDir = readString(args, "ecode_dir");
    if (!ecodeDir) throw new Error("缺少必填参数 ecode_dir");
    const outputPath =
      readString(args, "output_path") ??
      makeConfiguredEFilePath(ecodeDir);
    const result = await invoke<ECodeProjectResult>("generate_efile_from_ecode", {
      ecodeDir,
      outputPath: outputPath ?? "",
    });
    return {
      success: result.success,
      ecode_dir: result.ecode_dir,
      output_path: result.output_path,
      stderr: trimOutput(result.stderr, 2500),
      stdout: trimOutput(result.stdout, 1500),
      stage: "ecode_to_efile",
      file_count: result.files.length,
    };
  },
};

/** Convert raw EPL text into a real .e file via the bundled e2txt + ebuild chain. */
const generateEFileFromCode: RegisteredTool = {
  definition: {
    name: "generate_efile_from_code",
    description:
      "把单个易语言源码字符串落盘成默认 console 模板文本工程并打包为 .e 文件。" +
      "仅适用于从零生成新程序，或用户明确只提供了单文件源码字符串。" +
      "如果任务是优化已有 .e 项目且已经导出了 ecode_dir，应优先修改导出的 .e.txt 文件并调用 build_ecode_project 或 generate_efile_from_ecode，以保留原窗口/模块结构。",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "完整的易语言源码（推荐含 .版本/.程序集/.子程序），UTF-8。",
        },
        output_path: {
          type: "string",
          description: "可选 .e 输出路径，留空时使用默认临时目录。",
          nullable: true,
        },
        module_paths: {
          type: "array",
          description:
            "可选，生成工程需要引用的 .ec 模块绝对路径列表。使用精易模块命令时应传入精易模块路径；若用户消息中已给出精易模块 .ec，本工具会自动提取。",
          items: { type: "string" },
          nullable: true,
        },
      },
      required: ["code"],
    },
  },
  executor: async (args, ctx) => {
    const code = typeof args.code === "string" ? args.code : null;
    if (!code) throw new Error("缺少必填参数 code");
    const outputPath =
      readString(args, "output_path") ??
      makeConfiguredEFilePath("generated.e", "generated");
    const modulePaths = [
      ...readStringArray(args, "module_paths"),
      ...extractJingyiModulePathsFromInput(ctx.userInput),
      ...(!readString(args, "module_paths") && codeLooksLikeJingyiUsage(code)
        ? extractJingyiModulePathsFromInput(ctx.userInput)
        : []),
    ].filter((item, index, list) => list.indexOf(item) === index);
    const result = await invoke<ECodeProjectResult>("generate_efile_from_code", {
      code,
      outputPath: outputPath ?? "",
      modulePaths: modulePaths.length > 0 ? modulePaths : null,
    });
    return {
      success: result.success,
      output_path: result.output_path,
      stderr: trimOutput(result.stderr, 2500),
      stdout: trimOutput(result.stdout, 1500),
      stage: "e2txt_to_efile",
      module_paths_used: modulePaths,
    };
  },
};

/** Compile an .e file with ecl. */
const compileEFile: RegisteredTool = {
  definition: {
    name: "compile_efile",
    description:
      "调用 ecl.exe 对 .e 文件进行编译检查。成功返回 output_path；失败返回 stderr/stdout 供修复。" +
      "如项目依赖 .ec 模块，可通过 module_paths 传入；若用户消息里已给出 .ec 绝对路径，本工具也会自动提取并先放入易语言 ecom 目录再编译。",
    parameters: {
      type: "object",
      properties: {
        target_path: {
          type: "string",
          description: "已存在的 .e 文件路径。",
        },
        output_path: {
          type: "string",
          description: "可选 .exe 输出路径，留空时使用默认。",
          nullable: true,
        },
        static_link: {
          type: "boolean",
          description: "是否静态链接，默认 true。",
          default: true,
        },
        module_paths: {
          type: "array",
          description: "可选，编译所需的 .ec 模块绝对路径列表。",
          items: { type: "string" },
          nullable: true,
        },
      },
      required: ["target_path"],
    },
  },
  executor: async (args, ctx) => {
    const targetPath = readString(args, "target_path");
    if (!targetPath) throw new Error("缺少必填参数 target_path");
    const outputPath =
      readString(args, "output_path") ??
      makeConfiguredExePath(targetPath);
    const staticLink = readBoolean(args, "static_link", true);
    const modulePaths = [
      ...readStringArray(args, "module_paths"),
      ...extractLocalPathsByExtension(ctx.userInput, "ec"),
    ].filter((item, index, list) => list.indexOf(item) === index);
    const easyLanguageRoot = useSettingsStore.getState().easyLanguageRoot || null;
    const result = await invoke<CompileResult>("compile_efile", {
      sourcePath: targetPath,
      outputPath: outputPath ?? null,
      staticLink,
      modulePaths: modulePaths.length > 0 ? modulePaths : null,
      easyLanguageRoot,
    });
    return {
      success: result.success,
      output_path: result.output_path,
      stderr: trimOutput(result.stderr, 3500),
      stdout: trimOutput(result.stdout, 1500),
      stage: "ecl_compile",
      module_paths_used: modulePaths,
    };
  },
};

const buildECodeProject: RegisteredTool = {
  definition: {
    name: "build_ecode_project",
    description:
      "把已导出的 e2txt 文本工程重新打包为 .e 并立即调用 ecl 编译验证。" +
      "这是项目级 build 工具，适合 save_text_file 修改 .e.txt 后一步完成 generate_efile_from_ecode + compile_efile，保留原窗口/模块结构并返回两阶段日志。",
    parameters: {
      type: "object",
      properties: {
        ecode_dir: {
          type: "string",
          description: "export_efile_to_ecode 返回的文本工程目录。",
        },
        source_output_path: {
          type: "string",
          description: "可选 .e 输出路径；留空时使用默认临时目录。",
          nullable: true,
        },
        exe_output_path: {
          type: "string",
          description: "可选 .exe 输出路径；留空时使用 .e 同名 exe。",
          nullable: true,
        },
        static_link: {
          type: "boolean",
          description: "是否静态链接，默认 true。",
          default: true,
        },
        module_paths: {
          type: "array",
          description: "可选，编译所需 .ec 模块路径；用户消息里的 .ec 路径也会自动加入。",
          items: { type: "string" },
          nullable: true,
        },
      },
      required: ["ecode_dir"],
    },
  },
  executor: async (args, ctx): Promise<ECodeProjectBuildResult> => {
    const ecodeDir = readString(args, "ecode_dir");
    if (!ecodeDir) throw new Error("缺少必填参数 ecode_dir");
    const sourceOutputPath =
      readString(args, "source_output_path") ??
      makeConfiguredEFilePath(ecodeDir);
    const exeOutputPath = readString(args, "exe_output_path");
    const staticLink = readBoolean(args, "static_link", true);
    const modulePaths = [
      ...readStringArray(args, "module_paths"),
      ...extractLocalPathsByExtension(ctx.userInput, "ec"),
    ].filter((item, index, list) => list.indexOf(item) === index);

    const generated = await invoke<ECodeProjectResult>("generate_efile_from_ecode", {
      ecodeDir,
      outputPath: sourceOutputPath ?? "",
    });

    if (!generated.success || !generated.output_path) {
      return {
        success: false,
        ecode_dir: ecodeDir,
        stage: "ecode_to_efile",
        source_path: generated.output_path,
        output_path: null,
        generated: {
          success: generated.success,
          output_path: generated.output_path,
          stdout: trimOutput(generated.stdout, 2000),
          stderr: trimOutput(generated.stderr, 3000),
        },
        compiled: null,
        module_paths_used: modulePaths,
        stdout: trimOutput(generated.stdout, 2000),
        stderr: trimOutput(generated.stderr, 3000),
      };
    }

    const compiled = await invoke<CompileResult>("compile_efile", {
      sourcePath: generated.output_path,
      outputPath: exeOutputPath ?? makeConfiguredExePath(generated.output_path),
      staticLink,
      modulePaths: modulePaths.length > 0 ? modulePaths : null,
      easyLanguageRoot: useSettingsStore.getState().easyLanguageRoot || null,
    });

    return {
      success: compiled.success,
      ecode_dir: ecodeDir,
      stage: compiled.success ? "done" : "ecl_compile",
      source_path: generated.output_path,
      output_path: compiled.output_path,
      generated: {
        success: generated.success,
        output_path: generated.output_path,
        stdout: trimOutput(generated.stdout, 1500),
        stderr: trimOutput(generated.stderr, 1500),
      },
      compiled: {
        success: compiled.success,
        output_path: compiled.output_path,
        stdout: trimOutput(compiled.stdout, 2000),
        stderr: trimOutput(compiled.stderr, 3500),
      },
      module_paths_used: modulePaths,
      stdout: trimOutput([generated.stdout, compiled.stdout].filter(Boolean).join("\n\n"), 2500),
      stderr: trimOutput([generated.stderr, compiled.stderr].filter(Boolean).join("\n\n"), 4500),
    };
  },
};

const buildOriginalEFileBaseline: RegisteredTool = {
  definition: {
    name: "build_original_efile_baseline",
    description:
      "对用户提供的原始 .e 工程做未修改基线构建：导出到临时文本工程、回编为 .e、再调用 ecl 编译验证。" +
      "适合优化已有项目前先确认本机工具链和依赖模块是否能编译原工程；它不会修改用户原文件或桌面同名 .ecode 目录。",
    parameters: {
      type: "object",
      properties: {
        target_path: {
          type: "string",
          description: "用户提供的原始 .e 文件路径。",
        },
        static_link: {
          type: "boolean",
          description: "是否静态链接，默认 true。",
          default: true,
        },
        module_paths: {
          type: "array",
          description: "可选，编译所需 .ec 模块路径；用户消息里的 .ec 路径也会自动加入。",
          items: { type: "string" },
          nullable: true,
        },
      },
      required: ["target_path"],
    },
  },
  executor: async (args, ctx): Promise<ECodeBaselineBuildResult> => {
    const targetPath = readString(args, "target_path");
    if (!targetPath) throw new Error("缺少必填参数 target_path");
    const staticLink = readBoolean(args, "static_link", true);
    const modulePaths = [
      ...readStringArray(args, "module_paths"),
      ...extractLocalPathsByExtension(ctx.userInput, "ec"),
    ].filter((item, index, list) => list.indexOf(item) === index);

    const exported = await invoke<ECodeProjectResult>("export_efile_to_ecode", {
      sourcePath: targetPath,
      outputDir: makeConfiguredECodeDir(targetPath),
    });

    if (!exported.success || !exported.ecode_dir) {
      return {
        success: false,
        source_path: targetPath,
        ecode_dir: exported.ecode_dir,
        output_path: null,
        stage: "efile_to_ecode",
        exported: {
          success: exported.success,
          ecode_dir: exported.ecode_dir,
          stdout: trimOutput(exported.stdout, 1500),
          stderr: trimOutput(exported.stderr, 2500),
        },
        generated: null,
        compiled: null,
        module_paths_used: modulePaths,
        stdout: trimOutput(exported.stdout, 1500),
        stderr: trimOutput(exported.stderr, 2500),
        note: "原工程导出失败；先修复导出/解析工具链，不应继续修改源码。",
      };
    }

    const generated = await invoke<ECodeProjectResult>("generate_efile_from_ecode", {
      ecodeDir: exported.ecode_dir,
      outputPath: makeConfiguredEFilePath(exported.ecode_dir) ?? "",
    });

    if (!generated.success || !generated.output_path) {
      return {
        success: false,
        source_path: targetPath,
        ecode_dir: exported.ecode_dir,
        output_path: null,
        stage: "ecode_to_efile",
        exported: {
          success: exported.success,
          ecode_dir: exported.ecode_dir,
          stdout: trimOutput(exported.stdout, 1000),
          stderr: trimOutput(exported.stderr, 1000),
        },
        generated: {
          success: generated.success,
          output_path: generated.output_path,
          stdout: trimOutput(generated.stdout, 1500),
          stderr: trimOutput(generated.stderr, 2500),
        },
        compiled: null,
        module_paths_used: modulePaths,
        stdout: trimOutput([exported.stdout, generated.stdout].filter(Boolean).join("\n\n"), 2000),
        stderr: trimOutput([exported.stderr, generated.stderr].filter(Boolean).join("\n\n"), 3000),
        note: "原工程回编失败；先修复 e2txt 回编问题，不应继续修改源码。",
      };
    }

    const compiled = await invoke<CompileResult>("compile_efile", {
      sourcePath: generated.output_path,
      outputPath: makeConfiguredExePath(generated.output_path),
      staticLink,
      modulePaths: modulePaths.length > 0 ? modulePaths : null,
      easyLanguageRoot: useSettingsStore.getState().easyLanguageRoot || null,
    });

    return {
      success: compiled.success,
      source_path: targetPath,
      ecode_dir: exported.ecode_dir,
      output_path: compiled.output_path,
      stage: compiled.success ? "done" : "ecl_compile",
      exported: {
        success: exported.success,
        ecode_dir: exported.ecode_dir,
        stdout: trimOutput(exported.stdout, 1000),
        stderr: trimOutput(exported.stderr, 1000),
      },
      generated: {
        success: generated.success,
        output_path: generated.output_path,
        stdout: trimOutput(generated.stdout, 1000),
        stderr: trimOutput(generated.stderr, 1000),
      },
      compiled: {
        success: compiled.success,
        output_path: compiled.output_path,
        stdout: trimOutput(compiled.stdout, 2000),
        stderr: trimOutput(compiled.stderr, 3500),
      },
      module_paths_used: modulePaths,
      stdout: trimOutput([exported.stdout, generated.stdout, compiled.stdout].filter(Boolean).join("\n\n"), 3000),
      stderr: trimOutput([exported.stderr, generated.stderr, compiled.stderr].filter(Boolean).join("\n\n"), 4500),
      note: compiled.success
        ? "原工程未修改基线可以编译，后续优化失败更可能是源码改动导致。"
        : "原工程未修改基线编译失败；应优先报告/修复编译环境或依赖问题，不要把失败归因到优化代码。",
    };
  },
};

/** Closed-loop generate → e2txt → ecl → repair → ecl … until success or
 *  max_attempts. The model can call this when it wants the runtime to drive
 *  the entire repair cycle without further LLM round-trips. */
const closedLoopBuild: RegisteredTool = {
  definition: {
    name: "closed_loop_build",
    description:
      "对已有的易语言源码字符串执行『生成 .e → 编译 → 失败时由本工具自身重试 e2txt』的最小闭环。" +
      "本工具不会再调用 LLM，只做工具链层的重试。模型负责给出新代码，复杂修复请用 generate_efile_from_code+compile_efile 两步组合。",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string", description: "完整易语言源码。" },
        max_attempts: {
          type: "integer",
          description: "工具链层最大重试次数（仅做 e2txt+ecl 层重试，不修改源码）。默认 1。",
          default: 1,
        },
      },
      required: ["code"],
    },
  },
  executor: async (args) => {
    const code = typeof args.code === "string" ? args.code : null;
    if (!code) throw new Error("缺少必填参数 code");
    const maxAttempts = Math.max(
      1,
      Math.min(
        typeof args.max_attempts === "number" ? args.max_attempts : 1,
        3,
      ),
    );

    let lastGenerated: ECodeProjectResult | null = null;
    let lastCompiled: CompileResult | null = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      lastGenerated = await invoke<ECodeProjectResult>("generate_efile_from_code", {
        code,
        outputPath: makeConfiguredEFilePath("generated.e", "generated") ?? "",
      });
      if (!lastGenerated.success || !lastGenerated.output_path) continue;
      lastCompiled = await invoke<CompileResult>("compile_efile", {
        sourcePath: lastGenerated.output_path,
        outputPath: makeConfiguredExePath(lastGenerated.output_path),
        staticLink: true,
        easyLanguageRoot: useSettingsStore.getState().easyLanguageRoot || null,
      });
      if (lastCompiled.success) {
        return {
          success: true,
          attempts: attempt,
          source_path: lastGenerated.output_path,
          output_path: lastCompiled.output_path,
        };
      }
    }
    return {
      success: false,
      attempts: maxAttempts,
      generate_stderr: trimOutput(lastGenerated?.stderr ?? "", 1500),
      compile_stderr: trimOutput(lastCompiled?.stderr ?? "", 2500),
      stage: lastCompiled ? "ecl_compile" : "e2txt_to_efile",
    };
  },
};

/** Save plain text via the Rust write_text_file command (auto GBK for .epl). */
const saveTextFile: RegisteredTool = {
  definition: {
    name: "save_text_file",
    description:
      "把指定文本写入本地文件。常用于把 AI 生成的源码保存为 .epl/.txt，编码可选。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "目标文件路径。" },
        content: { type: "string", description: "要写入的文本。" },
        encoding: {
          type: "string",
          description: "可选，'gbk' 或 'utf-8'，默认按扩展名推断。",
          enum: ["gbk", "utf-8"],
          nullable: true,
        },
      },
      required: ["path", "content"],
    },
  },
  executor: async (args) => {
    const path = readString(args, "path");
    const content = typeof args.content === "string" ? args.content : null;
    if (!path) throw new Error("缺少必填参数 path");
    if (content === null) throw new Error("缺少必填参数 content");
    const encoding = readString(args, "encoding");
    const result = await invoke<WriteTextResult>("write_text_file", {
      filePath: path,
      content,
      encoding,
    });
    return {
      path: result.path,
      bytes: result.bytes,
    };
  },
};

/** Native file picker — model can request a path from the user. */
const pickFile: RegisteredTool = {
  definition: {
    name: "pick_file",
    description:
      "弹出系统原生文件选择对话框让用户挑选一个文件。模型在缺路径时使用，避免瞎猜路径。",
    parameters: {
      type: "object",
      properties: {
        purpose: {
          type: "string",
          description: "向用户展示的用途说明，例如 '选择要解析的 .e 文件'。",
        },
        extensions: {
          type: "array",
          description: "可选扩展过滤，如 ['e','ec']。",
          items: { type: "string" },
          nullable: true,
        },
      },
      required: ["purpose"],
    },
  },
  executor: async (args, ctx) => {
    if (!ctx.allowDialog) {
      throw new Error("当前模式不允许弹出文件选择框");
    }
    const exts = Array.isArray(args.extensions)
      ? (args.extensions as unknown[]).filter((x): x is string => typeof x === "string")
      : ["e", "ec"];
    const result = await openDialog({
      multiple: false,
      filters: [{ name: "易语言文件", extensions: exts }],
    });
    if (!result) return { picked: null, cancelled: true };
    const path = typeof result === "string" ? result : (result as { path: string }).path;
    return { picked: path, cancelled: false };
  },
};

/** Native save dialog. */
const pickSavePath: RegisteredTool = {
  definition: {
    name: "pick_save_path",
    description: "弹出系统原生『保存为』对话框，返回用户选定的目标路径。",
    parameters: {
      type: "object",
      properties: {
        default_name: {
          type: "string",
          description: "默认文件名，例如 'generated.e'。",
          nullable: true,
        },
        extensions: {
          type: "array",
          items: { type: "string" },
          nullable: true,
        },
      },
    },
  },
  executor: async (args, ctx) => {
    if (!ctx.allowDialog) throw new Error("当前模式不允许弹出对话框");
    const defaultName = readString(args, "default_name") ?? "generated.e";
    const exts = Array.isArray(args.extensions)
      ? (args.extensions as unknown[]).filter((x): x is string => typeof x === "string")
      : ["e", "ec", "epl", "txt"];
    const target = await saveDialog({
      defaultPath: defaultName,
      filters: [{ name: "保存为", extensions: exts }],
    });
    if (!target) return { picked: null, cancelled: true };
    return { picked: target, cancelled: false };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOL_REGISTRY: Record<string, RegisteredTool> = {
  [scanEasyLanguageEnv.definition.name]: scanEasyLanguageEnv,
  [searchJingyiModule.definition.name]: searchJingyiModule,
  [readFile.definition.name]: readFile,
  [parseEFile.definition.name]: parseEFile,
  [exportECode.definition.name]: exportECode,
  [summarizeECodeProject.definition.name]: summarizeECodeProject,
  [analyzeECodeProject.definition.name]: analyzeECodeProject,
  [inspectECodeContext.definition.name]: inspectECodeContext,
  [generateEFileFromECode.definition.name]: generateEFileFromECode,
  [generateEFileFromCode.definition.name]: generateEFileFromCode,
  [compileEFile.definition.name]: compileEFile,
  [buildECodeProject.definition.name]: buildECodeProject,
  [buildOriginalEFileBaseline.definition.name]: buildOriginalEFileBaseline,
  [closedLoopBuild.definition.name]: closedLoopBuild,
  [saveTextFile.definition.name]: saveTextFile,
  [pickFile.definition.name]: pickFile,
  [pickSavePath.definition.name]: pickSavePath,
};

export const TOOL_DEFINITIONS: ToolDefinition[] = Object.values(TOOL_REGISTRY).map(
  (entry) => entry.definition,
);

/** Public entrypoint used by the agent runner. Always returns a ToolResult,
 *  even for invalid tool names — this lets the model see the failure on the
 *  next turn and recover (instead of crashing the whole run). */
const TOOL_EXEC_TIMEOUT_MS = 120_000;

export async function executeTool(
  toolName: string,
  toolCallId: string,
  args: Record<string, unknown>,
  ctx: ToolExecContext,
): Promise<ToolResult> {
  const startedAt = Date.now();
  const entry = TOOL_REGISTRY[toolName];
  if (!entry) {
    return {
      toolCallId,
      toolName,
      ok: false,
      content: { error: `unknown tool: ${toolName}` },
      error: `unknown tool: ${toolName}`,
      durationMs: Date.now() - startedAt,
    };
  }
  try {
    const content = await Promise.race([
      entry.executor(args, ctx),
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`工具 ${toolName} 执行超时（${TOOL_EXEC_TIMEOUT_MS / 1000}s）`)),
          TOOL_EXEC_TIMEOUT_MS,
        );
      }),
    ]);
    return {
      toolCallId,
      toolName,
      ok: true,
      content,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      toolCallId,
      toolName,
      ok: false,
      content: { error: message },
      error: message,
      durationMs: Date.now() - startedAt,
    };
  }
}
