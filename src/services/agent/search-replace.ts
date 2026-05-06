export interface SearchReplaceEdit {
  path: string;
  search: string;
  replace: string;
}

export interface SearchReplaceResult {
  path: string;
  changed: boolean;
  replacements: number;
  bytes: number;
}

export function normalizeLineEndingsForExistingFile(
  original: string,
  replacement: string,
): string {
  if (original.includes("\r\n")) {
    return replacement.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  }
  return replacement.replace(/\r\n/g, "\n");
}

export function applySearchReplaceToText(
  original: string,
  edit: Pick<SearchReplaceEdit, "search" | "replace">,
): { content: string; replacements: number } {
  if (!edit.search) {
    throw new Error("SEARCH/REPLACE 缺少 SEARCH 内容");
  }
  const firstIndex = original.indexOf(edit.search);
  if (firstIndex < 0) {
    throw new Error("SEARCH/REPLACE 未找到匹配内容");
  }
  const secondIndex = original.indexOf(edit.search, firstIndex + edit.search.length);
  if (secondIndex >= 0) {
    throw new Error("SEARCH/REPLACE 匹配到多处内容，请扩大 SEARCH 上下文后重试");
  }

  const replace = normalizeLineEndingsForExistingFile(original, edit.replace);
  return {
    content:
      original.slice(0, firstIndex) +
      replace +
      original.slice(firstIndex + edit.search.length),
    replacements: 1,
  };
}

export function parseSearchReplaceBlock(text: string): SearchReplaceEdit {
  const pathMatch = text.match(/(?:^|\n)PATH:\s*(.+)\s*(?:\n|$)/i);
  const searchStart = text.indexOf("<<<<<<< SEARCH");
  const sep = text.indexOf("=======");
  const replaceEnd = text.indexOf(">>>>>>> REPLACE");

  if (!pathMatch?.[1]?.trim()) throw new Error("SEARCH/REPLACE 缺少 PATH 行");
  if (searchStart < 0 || sep < 0 || replaceEnd < 0 || !(searchStart < sep && sep < replaceEnd)) {
    throw new Error("SEARCH/REPLACE 格式错误，应包含 <<<<<<< SEARCH、=======、>>>>>>> REPLACE");
  }

  const search = text.slice(searchStart + "<<<<<<< SEARCH".length, sep).replace(/^\r?\n/, "");
  const replace = text.slice(sep + "=======".length, replaceEnd).replace(/^\r?\n/, "");
  return {
    path: pathMatch[1].trim(),
    search: search.replace(/\r?\n$/, ""),
    replace: replace.replace(/\r?\n$/, ""),
  };
}
