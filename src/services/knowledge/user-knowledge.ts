import { nanoid } from "nanoid";

export type KnowledgeSourceType = "builtin" | "user";
export type KnowledgeDocumentStatus = "raw" | "cleaned" | "indexed";

export interface KnowledgeChunk {
  id: string;
  title: string;
  content: string;
  tokens: number;
  metadata: Record<string, string>;
}

export interface UserKnowledgeDocument {
  id: string;
  name: string;
  sourcePath: string | null;
  sourceType: KnowledgeSourceType;
  format: string;
  status: KnowledgeDocumentStatus;
  rawText: string;
  cleanText: string;
  chunks: KnowledgeChunk[];
  metadata: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeIngestionReport {
  originalChars: number;
  cleanChars: number;
  removedChars: number;
  chunkCount: number;
  estimatedTokens: number;
  warnings: string[];
}

export const KNOWLEDGE_TEMPLATE = [
  "# 知识库名称：我的易语言知识库",
  "",
  "## 适用场景",
  "说明这份知识库适合回答哪些问题，例如：网络请求、UI 控件、多线程、数据库。",
  "",
  "## 条目：命令或能力名称",
  "",
  "### 什么时候使用",
  "描述这个命令/方案适合的场景，以及不适合的场景。",
  "",
  "### 签名",
  "```epl",
  "返回类型 命令名（参数1: 类型，参数2: 类型）",
  "```",
  "",
  "### 参数说明",
  "| 参数 | 类型 | 必填 | 说明 |",
  "| --- | --- | --- | --- |",
  "| 参数1 | 文本型 | 是 | 参数用途 |",
  "",
  "### 示例",
  "```epl",
  ".局部变量 返回结果, 文本型",
  "返回结果 ＝ 命令名 (“示例参数”)",
  "```",
  "",
  "### 常见问题",
  "- 返回为空时先检查参数和错误信息。",
  "- 涉及网络时说明编码、Cookie、协议头和超时。",
].join("\n");

export function estimateTokens(text: string): number {
  const asciiWords = text.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const cjkChars = text.match(/[\u4e00-\u9fff]/g)?.length ?? 0;
  const otherChars = Math.max(0, text.length - cjkChars);
  return Math.max(1, Math.ceil(cjkChars / 1.6 + otherChars / 4 + asciiWords * 0.3));
}

export function normalizeKnowledgeText(input: string): string {
  return input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

export function inferKnowledgeFormat(fileName: string, text: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".md") || /^#\s+/m.test(text)) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".epl") || lower.endsWith(".e.txt")) return "easy-language";
  return "text";
}

function extractHeading(line: string): string | null {
  const markdown = line.match(/^#{1,6}\s+(.+)$/);
  if (markdown?.[1]) return markdown[1].trim();
  const eSubprogram = line.match(/^\.子程序\s+([^,，]+)/);
  if (eSubprogram?.[1]) return eSubprogram[1].trim();
  const eAssembly = line.match(/^\.程序集\s+([^,，]+)/);
  if (eAssembly?.[1]) return eAssembly[1].trim();
  return null;
}

export function splitKnowledgeChunks(text: string, maxTokens = 650): KnowledgeChunk[] {
  const clean = normalizeKnowledgeText(text);
  if (!clean) return [];

  const chunks: KnowledgeChunk[] = [];
  let currentTitle = "概览";
  let buffer: string[] = [];

  const flush = () => {
    const content = buffer.join("\n").trim();
    if (!content) return;
    chunks.push({
      id: nanoid(),
      title: currentTitle,
      content,
      tokens: estimateTokens(content),
      metadata: {},
    });
    buffer = [];
  };

  const pushLine = (line: string) => {
    const heading = extractHeading(line.trim());
    if (heading && buffer.length > 0) {
      flush();
      currentTitle = heading;
    } else if (heading) {
      currentTitle = heading;
    }

    buffer.push(line);

    if (estimateTokens(buffer.join("\n")) >= maxTokens) {
      flush();
    }
  };

  for (const line of clean.split("\n")) {
    pushLine(line);
  }
  flush();

  return chunks.map((chunk, index) => ({
    ...chunk,
    metadata: {
      chunk_index: String(index + 1),
      chunk_count: String(chunks.length),
    },
  }));
}

export function ingestKnowledgeDocument(input: {
  name: string;
  sourcePath?: string | null;
  rawText: string;
  metadata?: Record<string, string>;
}): {
  document: UserKnowledgeDocument;
  report: KnowledgeIngestionReport;
} {
  const rawText = input.rawText.replace(/^\uFEFF/, "");
  const cleanText = normalizeKnowledgeText(rawText);
  const chunks = splitKnowledgeChunks(cleanText);
  const now = Date.now();
  const warnings: string[] = [];

  if (cleanText.length < 80) {
    warnings.push("文本较短，可能不足以形成稳定检索结果。");
  }
  if (chunks.some((chunk) => chunk.tokens > 900)) {
    warnings.push("存在较长分块，后续可考虑按标题或段落继续拆分。");
  }

  const document: UserKnowledgeDocument = {
    id: nanoid(),
    name: input.name,
    sourcePath: input.sourcePath ?? null,
    sourceType: "user",
    format: inferKnowledgeFormat(input.name, rawText),
    status: chunks.length > 0 ? "cleaned" : "raw",
    rawText,
    cleanText,
    chunks,
    metadata: input.metadata ?? {},
    createdAt: now,
    updatedAt: now,
  };

  return {
    document,
    report: {
      originalChars: rawText.length,
      cleanChars: cleanText.length,
      removedChars: Math.max(0, rawText.length - cleanText.length),
      chunkCount: chunks.length,
      estimatedTokens: estimateTokens(cleanText),
      warnings,
    },
  };
}
