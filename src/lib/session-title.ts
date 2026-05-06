import type { ChatMessage, ChatSession } from "@/types/llm";

const DEFAULT_TITLES = new Set(["新会话", "新聊天", "手机会话"]);
const UPLOAD_PREFIX = "用户上传了以下本地文件";
const SUPPLEMENT_MARKER = "用户补充说明：";
const MAX_SESSION_TITLE_CHARS = 80;

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTitleNoise(value: string): string {
  let title = value.trim();
  while (title.startsWith(SUPPLEMENT_MARKER)) {
    title = title.slice(SUPPLEMENT_MARKER.length).trim();
  }
  return title;
}

function simplifyTitle(value: string): string {
  let title = normalizeWhitespace(stripTitleNoise(value))
    .replace(/[`"'“”‘’]/g, "")
    .replace(/^[#>\-*]+\s*/, "")
    .replace(/[。.!！?？；;，,、：:]+$/g, "");

  const prefixPatterns = [
    /^(?:帮我|帮忙|麻烦你?|请你?|给我|我想|我要|能不能|可以)\s*/i,
    /^(?:写一个|写个|做一个|做个|弄一个|弄个|生成一个|生成|看一下|看看|查看一下|查看)\s*/i,
    /^(?:一个|一份|一下)\s*/i,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of prefixPatterns) {
      const next = title.replace(pattern, "").trim();
      if (next !== title) {
        title = next;
        changed = true;
      }
    }
  }

  title = title
    .replace(/(?:案例|案列|例子|示例)$/i, "")
    .replace(/[。.!！?？；;，,、：:]+$/g, "")
    .trim();

  return title;
}

function normalizeTitleCandidate(value: string, max = MAX_SESSION_TITLE_CHARS): string {
  const normalized = simplifyTitle(value);
  const chars = Array.from(normalized);
  if (chars.length <= max) return normalized;
  return chars.slice(0, max).join("");
}

function basename(path: string): string {
  return path.replace(/[）)]\s*$/, "").split(/[\\/]/).pop()?.trim() ?? path.trim();
}

function scoreFilename(name: string): number {
  const lower = name.toLowerCase();
  if (lower.endsWith(".e")) return 0;
  if (lower.endsWith(".epl")) return 1;
  if (lower.endsWith(".ecode")) return 2;
  if (lower.endsWith(".ec")) return 3;
  return 4;
}

function extractUploadedFilenames(input: string): string[] {
  const filenames: string[] = [];
  const seen = new Set<string>();

  for (const line of input.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;

    const withoutBullet = trimmed.slice(1).trim();
    const path = withoutBullet.split(/\s+（|\s+\(/)[0]?.trim();
    if (!path) continue;

    const name = basename(path);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    filenames.push(name);
  }

  return filenames.sort((a, b) => {
    const score = scoreFilename(a) - scoreFilename(b);
    return score !== 0 ? score : a.localeCompare(b, "zh-CN");
  });
}

function extractUserIntent(input: string): string | null {
  const normalized = input.replace(/\r\n/g, "\n").trim();
  if (!normalized) return null;

  const supplementIndex = normalized.indexOf(SUPPLEMENT_MARKER);
  const candidate = supplementIndex >= 0
    ? normalized.slice(supplementIndex + SUPPLEMENT_MARKER.length)
    : normalized.startsWith(UPLOAD_PREFIX)
      ? ""
      : normalized;

  for (const line of candidate.split("\n")) {
    const title = line.trim();
    if (!title || title.startsWith("-")) continue;
    if (/^[A-Za-z]:[\\/]/.test(title)) continue;
    return normalizeTitleCandidate(title);
  }

  return null;
}

function isInstructionTitle(title: string): boolean {
  const normalized = title.trim();
  return (
    !normalized ||
    DEFAULT_TITLES.has(normalized) ||
    normalized.startsWith(SUPPLEMENT_MARKER) ||
    normalized.startsWith(UPLOAD_PREFIX) ||
    normalized.startsWith("请分析以下文件") ||
    normalized.startsWith("附加文件")
  );
}

export function deriveSessionTitle(input: string, fallback = "新会话"): string {
  const intent = extractUserIntent(input);
  if (intent) return intent;

  const filenames = extractUploadedFilenames(input);
  const primarySources = filenames.filter((name) => name.toLowerCase().endsWith(".e"));
  if (primarySources.length === 1) return normalizeTitleCandidate(primarySources[0]);
  if (primarySources.length > 1) return normalizeTitleCandidate(primarySources.slice(0, 2).join("、"));
  if (filenames.length === 1) return normalizeTitleCandidate(filenames[0]);
  if (filenames.length > 1) return normalizeTitleCandidate(filenames.slice(0, 2).join("、"));

  const cleanFallback = normalizeTitleCandidate(fallback);
  return cleanFallback || "新会话";
}

export function shouldReplaceSessionTitle(title: string): boolean {
  return isInstructionTitle(title);
}

export function getSessionDisplayTitle(session: Pick<ChatSession, "title" | "messages">): string {
  if (!shouldReplaceSessionTitle(session.title)) {
    return normalizeTitleCandidate(session.title);
  }

  const firstUserMessage = session.messages.find((message: ChatMessage) => message.role === "user");
  if (firstUserMessage) {
    return deriveSessionTitle(firstUserMessage.content, session.title);
  }

  return deriveSessionTitle(session.title);
}
