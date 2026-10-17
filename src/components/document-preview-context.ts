import { createContext } from "react";

export interface PreviewDocument {
  id: string;
  title: string;
  code: string;
  language: string;
  path?: string;
  sourceLabel?: string;
  partial?: boolean;
  startLine?: number;
  startChar?: number;
  nextStartChar?: number | null;
  hash?: string;
  /** Tool operation that produced this snapshot, including disk-only edits. */
  revision?: string;
  loadFromDisk?: boolean;
}

export const DocumentPreviewContext = createContext<((document: PreviewDocument) => void) | null>(null);

export function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function documentLanguage(path: string, code = ""): string {
  if (/\.(epl|e\.txt)$/i.test(path) || /^\s*\.版本\s/m.test(code)) return "epl";
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ({ js: "javascript", ts: "typescript", py: "python", rs: "rust", md: "markdown", yml: "yaml" } as Record<string, string>)[ext] ?? ext;
}

export function isTextPath(path: string): boolean {
  return /\.(txt|epl|json|ini|csv|log|md|xml|yaml|yml|js|ts|tsx|jsx|css|html|py|rs|toml|bat|ps1)$/i.test(path);
}
