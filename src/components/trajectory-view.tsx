import { useMemo, useState } from "react";
import { CopySimple, X, MagnifyingGlass } from "@phosphor-icons/react";
import { copyText } from "@/lib/clipboard";
import { toast } from "sonner";
import type { ChatMessage } from "@/types/llm";

interface RecordRow { id: string; turn: number; kind: string; label: string; content: string; details: unknown; duration?: number; failed?: boolean; running?: boolean }
export function TrajectoryView({ messages }: { messages: ChatMessage[] }) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [wrap, setWrap] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const rows = useMemo(() => {
    const rows: RecordRow[] = [];
    let turn = 0;
    for (const message of messages) {
      if (message.role === "user") { turn++; rows.push({ id: message.id, turn, kind: "用户", label: "用户", content: message.content, details: { content: message.content } }); }
      if (message.role !== "assistant") continue;
      const trace = message.agentTrace;
      for (const step of trace?.steps ?? []) {
        rows.push({ id: `${message.id}:${step.index}`, turn, kind: "模型", label: `Step ${step.index}`, content: step.assistantText || step.reasoningContent || "工具调用", details: { answer: step.assistantText, reasoning: step.reasoningContent }, duration: step.endedAt - step.startedAt });
        for (const call of step.toolCalls) {
          const result = step.toolResults.find(result => result.toolCallId === call.id);
          rows.push({ id: `${message.id}:${step.index}:${call.id}`, turn, kind: "工具", label: call.name, content: JSON.stringify(call.arguments), details: { tool: call.name, arguments: call.arguments, result: result?.content, error: result?.error }, duration: result?.durationMs, failed: result && !result.ok, running: !result && message.isStreaming });
        }
      }
      if (!trace?.steps.length || message.isStreaming || (trace.finalAnswer && trace.steps.at(-1)?.assistantText !== message.content)) rows.push({ id: message.id, turn, kind: "模型", label: message.isStreaming ? "生成中" : "最终答复", content: message.content || message.reasoningContent || "正在思考…", details: { answer: message.content, reasoning: message.reasoningContent }, running: message.isStreaming });
    }
    return rows;
  }, [messages]);
  const filtered = useMemo(() => rows.filter(row => (!collapsed || row.kind === "用户") && `${row.kind} ${row.label} ${row.content}`.toLowerCase().includes(query.toLowerCase())), [rows, query, collapsed]);
  const pages = Math.max(1, Math.ceil(filtered.length / 200));
  const current = Math.min(page, pages - 1);
  const selected = rows.find(row => row.id === selectedId);
  return <section className="trajectory-view" aria-label="轨迹视图">
    <header className="trajectory-toolbar"><button type="button" aria-pressed={collapsed} onClick={() => setCollapsed(value => !value)}>轮次</button><span>{rows.length} 条记录</span><label><MagnifyingGlass size={14} /><input aria-label="搜索轨迹" placeholder="搜索轨迹" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label></header>
    <div className="trajectory-split"><div className="trajectory-table-pane"><table className="trajectory-table"><colgroup><col className="trajectory-event-column" /><col /><col className="trajectory-duration-column" /></colgroup><thead><tr><th>事件</th><th>内容</th><th>耗时</th></tr></thead><tbody>{filtered.slice(current * 200, (current + 1) * 200).map((row, index, group) => <tr key={row.id} data-turn-start={!index || group[index - 1].turn !== row.turn} data-selected={row.id === selectedId} data-failed={row.failed}><td><span className="trajectory-turn">{row.turn}</span>{row.kind}</td><td><button type="button" aria-label={`检查 ${row.label}`} onClick={() => setSelectedId(row.id)}><strong>{row.label}</strong><span>{row.content.slice(0, 500)}</span>{row.running && <i className="assistant-activity-dot" />}</button></td><td>{row.duration === undefined ? "—" : `${(row.duration / 1000).toFixed(1)}s`}</td></tr>)}</tbody></table>{!filtered.length && <p className="code-work-empty">{query ? "没有匹配的记录" : "执行记录将在这里显示。"}</p>}</div>
      {selected && <aside className="trajectory-inspector" aria-label="轨迹详情"><header><strong>{selected.label}</strong><button type="button" aria-label="轨迹详情自动换行" aria-pressed={wrap} onClick={() => setWrap(value => !value)}>换行</button><button type="button" aria-label="复制轨迹详情" onClick={() => void copyText(JSON.stringify(selected.details, null, 2)).then(() => toast.success("详情已复制")).catch(() => toast.error("复制失败"))}><CopySimple size={14} /></button><button type="button" aria-label="关闭轨迹详情" onClick={() => setSelectedId(null)}><X size={14} /></button></header><pre data-wrap={wrap}>{JSON.stringify(selected.details, null, 2)}</pre></aside>}
    </div>
    {pages > 1 && <footer className="review-pagination"><button type="button" disabled={!current} onClick={() => setPage(current - 1)}>上一页</button><span>{current + 1} / {pages}</span><button type="button" disabled={current === pages - 1} onClick={() => setPage(current + 1)}>下一页</button></footer>}
  </section>;
}
