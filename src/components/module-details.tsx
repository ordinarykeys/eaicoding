import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CopySimple, FileText, MagnifyingGlass } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { loadStoredIndex, type StoredModuleIndex, type UserModuleEntry } from "@/services/knowledge/module-library";
import type { ReadFileResult } from "@/services/agent/tools";
import { moduleWorkerRequest } from "@/services/knowledge/module-worker-client";

type DetailItem = { id: string; name: string; kind: string; owner?: string; signature: string; description?: string; line?: number; params?: { name: string; type: string; description?: string; byRef?: boolean; optional?: boolean; array?: boolean }[]; public?: boolean };
export function ModuleDetails({ entry, onBack }: { entry: UserModuleEntry | null; onBack: () => void }) {
  const [index, setIndex] = useState<StoredModuleIndex | null>(null);
  const [builtin, setBuiltin] = useState<DetailItem[]>([]);
  const [tab, setTab] = useState("commands");
  const [query, setQuery] = useState("");
  const deferred = useDeferredValue(query.trim().toLowerCase());
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<DetailItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [rawPage, setRawPage] = useState<ReadFileResult | null>(null);
  const [rawStart, setRawStart] = useState(0);
  const [rawHistory, setRawHistory] = useState<number[]>([]);
  const [declarationsLoaded, setDeclarationsLoaded] = useState(false);
  const epoch = useRef(0);
  const source = entry?.storedPath.replace(/\.ec$/i, ".parse_output.txt");
  useEffect(() => {
    let live = true; setBusy(true); setError("");
    const load = entry ? loadStoredIndex(entry.id).then(value => {
      if (!live) return;
      if (!value) throw new Error("解析索引尚未生成，请等待解析完成或重建模块。");
      setIndex(value); setDeclarationsLoaded(Boolean(value.declarations));
    }) : import("@/services/agent/knowledge/jingyi-raw.json").then(({ default: data }) => {
      if (!live) return;
      setBuiltin(Object.entries(data.categories).flatMap(([kind, entries]) => entries.map((raw: { name: string; className?: string; returnType?: string; description?: string; params?: { name: string; type: string }[] }, i) => ({
        id: `${kind}:${i}`, name: raw.name, kind, owner: raw.className,
        signature: `${raw.returnType ?? ""} ${raw.name}（${raw.params?.map(p => `${p.name}: ${p.type}`).join("，") ?? ""}）`.trim(),
        description: raw.description, params: raw.params,
      }))));
    });
    void load.catch(error => { if (live) setError(String(error)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; epoch.current++; };
  }, [entry?.id, entry?.apiCount]);
  useEffect(() => {
    if (!source || tab !== "raw") return;
    const request = ++epoch.current; setBusy(true); setError("");
    void invoke<ReadFileResult>("read_text_file_for_agent", { filePath: source, maxChars: 16000, startChar: rawStart }).then(result => {
      if (request === epoch.current) setRawPage(result);
    }).catch(error => { if (request === epoch.current) setError(String(error)); }).finally(() => { if (request === epoch.current) setBusy(false); });
    return () => { epoch.current++; };
  }, [source, tab, rawStart]);
  useEffect(() => {
    if (!source || !index || declarationsLoaded || tab !== "declarations") return;
    let live = true; setBusy(true); setError("");
    // Existing imports retain their native sidecar: build the new detail view
    // from that file without running the binary parser or embedding again.
    void invoke<ReadFileResult>("read_text_file_for_agent", { filePath: source, maxChars: 8000000 }).then(async result => {
      if (result.truncated) throw new Error("解析文本超过详情整理范围，请使用完整解析文本分页查看。");
      const parsed = await moduleWorkerRequest("parse", result.content);
      if (live) { setIndex(previous => previous ? { ...previous, declarations: parsed.declarations } : previous); setDeclarationsLoaded(true); }
    }).catch(error => { if (live) setError(String(error)); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [source, tab, declarationsLoaded, index?.moduleId]);
  const all = useMemo<DetailItem[]>(() => {
    if (!entry) return builtin.filter(item => tab === "commands" ? ["子程序", "DLL命令", "类"].includes(item.kind) : tab === "classes" ? item.kind === "类" : !["子程序", "DLL命令", "类"].includes(item.kind));
    if (tab === "classes") return (index?.assemblies ?? []).map(a => ({ id: `class:${a.name}`, name: a.name, kind: "程序集", signature: `${a.name} · ${a.publicMethodCount} 个公开方法`, description: a.description, line: a.line }));
    if (tab === "declarations") return (index?.declarations ?? []).map(d => ({ ...d, id: `declaration:${d.line}` }));
    return (index?.apis ?? []).map(a => ({ id: a.id, name: a.name, kind: a.kind === "dll" ? "DLL命令" : "子程序", owner: a.className, signature: a.signature, description: a.description, line: a.line, params: a.params, public: a.isPublic }));
  }, [entry?.id, builtin, tab, index]);
  const filtered = useMemo(() => deferred ? all.filter(item => `${item.name} ${item.owner ?? ""} ${item.signature} ${item.description ?? ""}`.toLowerCase().includes(deferred)) : all, [all, deferred]);
  const pages = Math.max(1, Math.ceil(filtered.length / 40)), current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * 40, (current + 1) * 40);
  const changeTab = (value: string) => { setTab(value); setQuery(""); setPage(0); setSelected(null); setError(""); };
  return <section className="module-details" aria-label="模块详情">
    <header className="module-detail-header"><button type="button" className="module-back" onClick={onBack}><ArrowLeft size={16} />模块库</button><h2>{entry?.name ?? "内置精易知识库"}</h2><p>{entry ? `${entry.apiCount} 条命令（含内部子程序和 DLL 声明）· ${entry.classCount} 个程序集` : "6779 条文档条目 · 2026-05-01 快照"}</p></header>
    <div className="module-detail-tabs" role="tablist" aria-label="模块内容">
      {[["commands", "命令接口"], ["classes", entry ? "类与程序集" : "类方法"], ["declarations", "类型与其他声明"], ...(entry ? [["raw", "完整解析文本"]] : [])].map(([value, label]) => <button type="button" role="tab" key={value} aria-selected={tab === value} onClick={() => changeTab(value)}>{label}</button>)}
    </div>
    {error && <p role="alert" className="module-detail-error">{error}</p>}
    {busy && <p role="status" className="module-detail-loading">正在读取解析内容…</p>}
    {tab === "raw" ? <>
      <div className="module-raw-toolbar"><span>第 {rawPage?.start_line ?? 1} 行起 · {rawStart} / {rawPage?.total_chars ?? "…"} 字符</span><button type="button" disabled={!rawPage} onClick={() => void copyText(rawPage?.content ?? "").then(() => toast.success("当前页已复制"))}><CopySimple size={14} />复制当前页</button></div>
      <pre className="module-raw-source" tabIndex={0}>{rawPage?.content ?? ""}</pre>
      <footer className="module-detail-pagination"><button type="button" disabled={busy || rawHistory.length === 0} onClick={() => { setRawStart(rawHistory.at(-1) ?? 0); setRawHistory(previous => previous.slice(0, -1)); }}>上一页</button><button type="button" disabled={busy || rawPage?.next_start_char == null} onClick={() => { setRawHistory(previous => [...previous, rawStart]); setRawStart(rawPage!.next_start_char!); }}>下一页</button></footer>
    </> : <>
      <label className="module-detail-search"><MagnifyingGlass size={15} /><input aria-label="搜索模块内容" placeholder="搜索命令、类、参数或说明…" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
      <div className="module-detail-list" aria-label="解析条目">
        {visible.map(item => <button type="button" className="module-detail-item" key={item.id} onClick={() => setSelected(item)} aria-pressed={selected?.id === item.id}><span><strong>{item.owner ? `${item.owner} · ` : ""}{item.name}</strong><small>{item.kind}{item.public !== undefined ? item.public ? " · 公开" : " · 内部声明" : ""}{item.line ? ` · 第 ${item.line} 行` : ""}</small></span><ArrowRight size={14} /></button>)}
        {!busy && !visible.length && <p className="module-detail-empty">{deferred ? "没有匹配的解析条目" : "此解析输出中没有该类声明。可在完整解析文本中查看原始内容。"}</p>}
      </div>
      <footer className="module-detail-pagination"><span>{filtered.length} 项 · 第 {current + 1}/{pages} 页</span><button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>上一页</button><button type="button" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>下一页</button></footer>
      {selected && <article className="module-api-detail" aria-label="接口详情"><header><FileText size={16} /><strong>{selected.name}</strong><button type="button" onClick={() => void copyText(selected.signature).then(() => toast.success("签名已复制"))}><CopySimple size={14} />复制签名</button></header><pre>{selected.signature}</pre>{selected.description && <p>{selected.description}</p>}{Boolean(selected.params?.length) && <table><thead><tr><th>参数</th><th>类型</th><th>属性 / 说明</th></tr></thead><tbody>{selected.params!.map((param, i) => <tr key={i}><td>{param.name}</td><td>{param.type}</td><td>{[param.byRef && "传址", param.array && "数组", param.optional && "可空", param.description].filter(Boolean).join(" · ")}</td></tr>)}</tbody></table>}</article>}
    </>}
    {entry && <p className="module-count-note">显示解析器实际导出的全部文本和声明；未导出的二进制资源不计入此结果。内部子程序仅供查看，AI 检索仅使用公开接口。</p>}
    {entry?.vectorError && <p className="module-count-note">语义索引未生成，关键词检索可用。原因：{entry.vectorError}</p>}
  </section>;
}
