import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowClockwise, CircleNotch, Code, FileText, FolderOpen, X } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { CodeBlock } from "@/components/code-block";
import type { ReadFileResult } from "@/services/agent/tools";
import type { PreviewDocument } from "./document-preview-context";

export function DocumentPreview({ items, activeId, onSelect, onClose, onCloseTab, width, onResize, visible }: {
  items: PreviewDocument[]; activeId: string; onSelect: (id: string) => void;
  onClose: () => void; onCloseTab: (id: string) => void;
  width: number; onResize: (width: number) => void;
  visible: boolean;
}) {
  const active = items.find(item => item.id === activeId) ?? items[0];
  const [loaded, setLoaded] = useState<Record<string, { source: string; document: PreviewDocument }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, { source: string; message: string }>>({});
  const body = useRef<HTMLDivElement>(null);
  const scroll = useRef(new Map<string, { top: number; left: number }>());
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const dragCleanup = useRef<(() => void) | null>(null);
  const tabs = useRef<HTMLDivElement>(null);
  const version = (item: PreviewDocument) => `${item.revision ?? ""}\0${item.code}\0${item.hash ?? ""}\0${item.nextStartChar ?? ""}`;
  const cached = active && loaded[active.id];
  const document = active && cached?.source === version(active) ? cached.document : active;
  const source = active ? version(active) : "";
  const error = active && errors[active.id]?.source === source ? errors[active.id].message : "";
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; dragCleanup.current?.(); }; }, []);
  useLayoutEffect(() => {
    if (!body.current || !active || !visible) return;
    const position = scroll.current.get(active.id);
    body.current.scrollTop = position?.top ?? 0;
    body.current.scrollLeft = position?.left ?? 0;
  }, [active?.id, visible]);
  useEffect(() => {
    if (visible) tabs.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active?.id, visible]);

  async function read(more = false) {
    if (!active?.path || !document || inFlight.current) return;
    const snapshot = document;
    const source = version(active);
    inFlight.current = true; setBusyId(active.id);
    setErrors(previous => ({ ...previous, [active.id]: { source, message: "" } }));
    try {
      const result = await invoke<ReadFileResult>("read_text_file_for_agent", {
        filePath: active.path, maxChars: 24000,
        startChar: more ? document.nextStartChar : 0, startLine: null, maxLines: null,
      });
      if (!mounted.current) return;
      if (more && snapshot.hash && result.code_hash && snapshot.hash !== result.code_hash) {
        throw new Error("文件已更新，请刷新后继续读取。");
      }
      const next: PreviewDocument = {
        ...active, code: more ? snapshot.code + result.content : result.content,
        hash: result.code_hash, startLine: more ? snapshot.startLine : result.start_line ?? 1,
        startChar: more ? snapshot.startChar : result.start_char ?? 0,
        nextStartChar: result.next_start_char, partial: result.truncated,
        loadFromDisk: false,
      };
      setLoaded(previous => ({ ...previous, [active.id]: { source, document: next } }));
    } catch (error) {
      if (mounted.current) setErrors(previous => ({ ...previous, [active.id]: { source, message: error instanceof Error ? error.message : String(error) } }));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusyId(null);
    }
  }
  useEffect(() => {
    if (visible && active?.loadFromDisk && cached?.source !== source && !inFlight.current && !error) void read();
  }, [active?.id, active?.loadFromDisk, source, cached, busyId, visible, error]);

  if (!active || !document) return null;
  const busy = busyId === active.id;
  const startDrag = (event: React.PointerEvent) => {
    event.preventDefault();
    dragCleanup.current?.();
    const startX = event.clientX, startWidth = width;
    const move = (e: PointerEvent) => onResize(Math.max(300, Math.min(900, startWidth + startX - e.clientX)));
    const stop = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      window.document.body.style.cursor = ""; window.document.body.style.userSelect = "";
      dragCleanup.current = null;
    };
    window.document.body.style.cursor = "col-resize"; window.document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop);
    dragCleanup.current = stop;
  };
  const open = async (reveal = false) => {
    if (!active.path) return;
    try { await (reveal ? revealItemInDir(active.path) : openPath(active.path)); }
    catch (error) { toast.error(`打开失败：${String(error)}`); }
  };
  return <aside className="document-preview" hidden={!visible} style={{ "--preview-width": `${width}px` } as React.CSSProperties} aria-label="文件预览">
    <div className="document-resize" role="separator" aria-orientation="vertical" aria-label="调整预览宽度" tabIndex={0}
      onPointerDown={startDrag} onKeyDown={event => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); onResize(Math.max(300, Math.min(900, width + (event.key === "ArrowLeft" ? 24 : -24)))); } }} />
    <div className="document-tab-strip">
      <div className="document-tabs" ref={tabs} role="tablist" aria-label="预览文件" onKeyDown={event => {
        if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab") return;
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = items.findIndex(item => item.id === active.id);
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
        onSelect(items[next].id);
        tabs.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
        {items.map(item => <div className="document-tab" key={item.id} data-active={item.id === active.id}>
          <button type="button" role="tab" tabIndex={item.id === active.id ? 0 : -1} aria-selected={item.id === active.id} onClick={() => onSelect(item.id)}><Code size={14} /><span>{item.title}</span></button>
          <button type="button" aria-label={`关闭 ${item.title}`} onClick={() => onCloseTab(item.id)}><X size={12} /></button>
        </div>)}
      </div>
      <button type="button" className="document-icon" aria-label="关闭预览" onClick={onClose}><X size={15} /></button>
    </div>
    <div className="document-path-row">
      <span>{active.path ?? active.title}</span>
      {active.path && <>
        <button type="button" className="document-icon" aria-label="刷新文件" disabled={busy} onClick={() => void read()}>{busy ? <CircleNotch size={15} className="animate-spin" /> : <ArrowClockwise size={15} />}</button>
        <button type="button" className="document-icon" aria-label="在系统中打开" onClick={() => void open()}><FileText size={15} /></button>
        <button type="button" className="document-icon" aria-label="打开文件所在目录" onClick={() => void open(true)}><FolderOpen size={15} /></button>
      </>}
    </div>
    {error && <div className="document-notice document-error" role="alert">{error}<button type="button" disabled={busy} onClick={() => void read()}>重试</button></div>}
    {document.partial && <div className="document-notice">{(document.startChar ?? 0) > 0 ? `文件片段 · 从第 ${document.startLine ?? 1} 行开始` : "已加载部分文件"}
      <button type="button" disabled={busy} onClick={() => void read((document.startChar ?? 0) === 0 && document.nextStartChar != null)}>{busy ? "读取中…" : (document.startChar ?? 0) > 0 ? "从头加载" : "加载更多"}</button></div>}
    <div className="document-body" ref={body} onScroll={event => { if (visible) scroll.current.set(active.id, { top: event.currentTarget.scrollTop, left: event.currentTarget.scrollLeft }); }}>
      {document.loadFromDisk && !document.code ? <div className="document-loading" role="status">{busy ? "正在读取文件…" : "尚未加载文件"}</div>
        : <CodeBlock key={active.id} code={document.code} language={document.language} startLine={document.startLine} embedded />}
    </div>
  </aside>;
}
