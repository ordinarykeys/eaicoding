export interface EplSyntaxDiagnostic {
  blockIndex: number;
  line: number;
  severity: "error" | "warning";
  kind: "control_structure" | "repeated_executable";
  message: string;
  source: string;
}

interface EplCodeBlock {
  code: string;
  language: string;
}

interface ControlFrame {
  startKeyword: string;
  expectedEnd: string;
  line: number;
}

const START_TO_END: Record<string, string> = {
  "如果": "如果结束",
  "如果真": "如果真结束",
  "判断开始": "判断结束",
  "判断循环首": "判断循环尾",
  "计次循环首": "计次循环尾",
  "变量循环首": "变量循环尾",
  "循环判断首": "循环判断尾",
};

const END_TO_START = Object.fromEntries(
  Object.entries(START_TO_END).map(([start, end]) => [end, start]),
) as Record<string, string>;

const EPL_LANGUAGE_ALIASES = new Set(["epl", "e", "ec", "易语言", "easy", "yiyy"]);
const REPEATED_EXECUTABLE_THRESHOLD = 3;

function looksLikeEplCode(code: string, language: string): boolean {
  const normalizedLanguage = language.trim().toLowerCase();
  if (EPL_LANGUAGE_ALIASES.has(normalizedLanguage)) return true;

  return (
    /^\s*\.(版本|程序集|子程序|局部变量|程序集变量|全局变量|参数)\b/m.test(code) ||
    /^\s*(类名|子程序名|变量名)\s+(基\s*类|返回值类型|类\s*型)\b/m.test(code) ||
    /(计次循环首|变量循环首|循环判断首|判断循环首|如果真|如果结束)\s*[（(]/.test(code)
  );
}

function extractEplCodeBlocks(markdown: string): EplCodeBlock[] {
  const blocks: EplCodeBlock[] = [];
  const fencedPattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fencedPattern.exec(markdown)) !== null) {
    const language = (match[1] ?? "").trim();
    const code = match[2] ?? "";
    if (looksLikeEplCode(code, language)) {
      blocks.push({ code, language });
    }
  }

  if (blocks.length === 0 && looksLikeEplCode(markdown, "")) {
    blocks.push({ code: markdown, language: "" });
  }

  return blocks;
}

export function answerContainsEplCode(answer: string): boolean {
  return extractEplCodeBlocks(answer).length > 0;
}

function firstKeyword(line: string): string | null {
  const trimmed = line.trim().replace(/^\./, "");
  if (!trimmed || trimmed.startsWith("'") || trimmed.startsWith("//")) return null;

  const match = trimmed.match(/^[^\s(（,，=＝]+/);
  return match?.[0] ?? null;
}

function isCompleteExample(code: string): boolean {
  return /^\s*\.(版本|程序集|子程序|DLL命令)\b/m.test(code);
}

function stripInlineComment(line: string): string {
  let inAsciiString = false;
  let inChineseString = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && !inChineseString) {
      inAsciiString = !inAsciiString;
      continue;
    }
    if (char === "“" && !inAsciiString) {
      inChineseString = true;
      continue;
    }
    if (char === "”" && !inAsciiString) {
      inChineseString = false;
      continue;
    }
    if (char === "'" && !inAsciiString && !inChineseString) {
      return line.slice(0, index);
    }
  }

  return line;
}

function normalizeExecutableLine(line: string): string | null {
  const trimmed = stripInlineComment(line).trim();
  if (!trimmed || trimmed.startsWith("'") || trimmed.startsWith("//")) return null;
  if (trimmed.startsWith(".")) return null;
  if (/^(类名|基\s*类|子程序名|返回值类型|变量名|类\s*型|公开|易包|备注|静态|数组)\b/.test(trimmed)) {
    return null;
  }

  const keyword = firstKeyword(trimmed);
  if (keyword && (keyword in START_TO_END || keyword in END_TO_START)) return null;

  const normalized = trimmed
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/[，]/g, ",")
    .replace(/[＝]/g, "=")
    .replace(/\s+/g, "");

  if (normalized.length < 8) return null;
  if (!/[()=]/.test(normalized)) return null;
  return normalized;
}

function validateRepeatedExecutableLines(
  lines: string[],
  blockIndex: number,
): EplSyntaxDiagnostic[] {
  const diagnostics: EplSyntaxDiagnostic[] = [];
  let current: {
    normalized: string;
    startLine: number;
    source: string;
    count: number;
  } | null = null;

  const flush = () => {
    if (!current || current.count < REPEATED_EXECUTABLE_THRESHOLD) return;
    diagnostics.push({
      blockIndex,
      line: current.startLine,
      severity: "warning",
      kind: "repeated_executable",
      source: current.source,
      message:
        `连续出现 ${current.count} 次相同可执行语句，可能是机械复制而不是有意设计。` +
        "请结合用户目标判断是否应改成循环、参数化任务或保留为明确展开。",
    });
  };

  lines.forEach((line, index) => {
    const normalized = normalizeExecutableLine(line);
    if (!normalized) {
      flush();
      current = null;
      return;
    }

    if (current?.normalized === normalized) {
      current.count += 1;
      return;
    }

    flush();
    current = {
      normalized,
      startLine: index + 1,
      source: line.trim(),
      count: 1,
    };
  });

  flush();
  return diagnostics;
}

function validateEplCodeBlock(code: string, blockIndex: number): EplSyntaxDiagnostic[] {
  const diagnostics: EplSyntaxDiagnostic[] = [];
  const stack: ControlFrame[] = [];
  const completeExample = isCompleteExample(code);
  const lines = code.replace(/\r\n?/g, "\n").split("\n");

  lines.forEach((line, index) => {
    const keyword = firstKeyword(line);
    if (!keyword) return;

    if (/(?:首|开始)结束$/.test(keyword) && !(keyword in END_TO_START)) {
      diagnostics.push({
        blockIndex,
        line: index + 1,
        severity: "error",
        kind: "control_structure",
        source: line.trim(),
        message: `无效的控制结构结束语句“${keyword}”。易语言循环块应使用对应的“尾”，例如“计次循环首”对应“计次循环尾”。`,
      });
      return;
    }

    const expectedEnd = START_TO_END[keyword];
    if (expectedEnd) {
      stack.push({
        startKeyword: keyword,
        expectedEnd,
        line: index + 1,
      });
      return;
    }

    const expectedStart = END_TO_START[keyword];
    if (!expectedStart) return;

    const top = stack[stack.length - 1];
    if (!top) {
      diagnostics.push({
        blockIndex,
        line: index + 1,
        severity: "error",
        kind: "control_structure",
        source: line.trim(),
        message: `多余的结束语句“${keyword}”，前面没有匹配的“${expectedStart}”。`,
      });
      return;
    }

    if (top.expectedEnd !== keyword) {
      diagnostics.push({
        blockIndex,
        line: index + 1,
        severity: "error",
        kind: "control_structure",
        source: line.trim(),
        message: `控制结构不匹配：第 ${top.line} 行“${top.startKeyword}”应以“${top.expectedEnd}”结束，当前却遇到“${keyword}”。`,
      });
      return;
    }

    stack.pop();
  });

  if (completeExample) {
    for (const frame of stack) {
      diagnostics.push({
        blockIndex,
        line: frame.line,
        severity: "error",
        kind: "control_structure",
        source: frame.startKeyword,
        message: `控制结构未闭合：“${frame.startKeyword}”缺少对应的“${frame.expectedEnd}”。`,
      });
    }
  }

  diagnostics.push(...validateRepeatedExecutableLines(lines, blockIndex));

  return diagnostics;
}

export function findEplAnswerDiagnostics(answer: string): EplSyntaxDiagnostic[] {
  return extractEplCodeBlocks(answer).flatMap((block, index) =>
    validateEplCodeBlock(block.code, index + 1),
  );
}

export function formatEplDiagnostics(diagnostics: EplSyntaxDiagnostic[]): string {
  return diagnostics
    .slice(0, 8)
    .map((item) => {
      const level = item.severity === "warning" ? "质量信号" : "确定错误";
      const source = item.source ? `：${item.source}` : "";
      return `- ${level}，代码块 ${item.blockIndex} 第 ${item.line} 行${source}\n  ${item.message}`;
    })
    .join("\n");
}
