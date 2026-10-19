import { diffLines } from "diff";
import type { AgentTrace, ToolResult } from "@/types/llm";

export type SourceChange = NonNullable<ToolResult["sourceChange"]>;
export function turnChanges(trace: AgentTrace | undefined): SourceChange[] {
  const files = new Map<string, SourceChange>();
  for (const step of trace?.steps ?? []) for (const result of step.toolResults) {
    const change = result.ok && result.sourceChange;
    if (!change) continue;
    const key = change.path.replaceAll("\\", "/").toLowerCase();
    const first = files.get(key);
    files.set(key, { ...change, before: first ? first.before : change.before });
  }
  return [...files.values()].filter(file => (file.before ?? "") !== file.after);
}
export interface DiffRow { oldLine?: number; newLine?: number; before?: string; after?: string; kind: "context" | "change" }
/** Unified view keeps each deletion run before its additions, as Harness does. */
export function unifiedRows(rows: DiffRow[]): DiffRow[] {
  const result: DiffRow[] = [];
  let changes: DiffRow[] = [];
  const flush = () => {
    for (const row of changes) if (row.before !== undefined) result.push({ kind: "change", oldLine: row.oldLine, before: row.before });
    for (const row of changes) if (row.after !== undefined) result.push({ kind: "change", newLine: row.newLine, after: row.after });
    changes = [];
  };
  for (const row of rows) {
    if (row.kind === "change") changes.push(row);
    else { flush(); result.push(row); }
  }
  flush();
  return result;
}
export function comparisonRows(change: SourceChange): DiffRow[] | null {
  const chunks = diffLines(change.before ?? "", change.after, { timeout: 150 });
  if (!chunks) return null;
  const rows: DiffRow[] = [];
  let oldLine = 1, newLine = 1;
  let removed: string[] = [], added: string[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index++) rows.push({ kind: "change",
      ...(index < removed.length ? { oldLine: oldLine++, before: removed[index] } : {}),
      ...(index < added.length ? { newLine: newLine++, after: added[index] } : {}),
    });
    removed = []; added = [];
  };
  for (const chunk of chunks) {
    const lines = chunk.value.replace(/\n$/, "").split("\n");
    if (chunk.removed) removed.push(...lines);
    else if (chunk.added) added.push(...lines);
    else { flush(); for (const line of lines) rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, before: line, after: line }); }
  }
  flush();
  return rows;
}
