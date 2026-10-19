import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowLeft, ArrowsIn, ArrowsOut, Code, Compass, File, Folder, FolderOpen, Globe, Plus, SidebarSimple, TerminalWindow, X } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { nanoid } from "nanoid";
import { toast } from "sonner";
import { documentLanguage, isTextPath, type PreviewDocument } from "./document-preview-context";
import { WorkspaceBrowser } from "./workspace-browser";
const WorkspaceTerminal = lazy(() => import("./workspace-terminal").then(module => ({ default: module.WorkspaceTerminal })));

export type WorkspaceTab = "start" | "files" | "code" | "browser" | `terminal:${string}`;
interface WorkspaceListing { root: string; directory: string; entries: { name: string; path: string; directory: boolean }[]; next_offset: number | null }

export function WorkspacePane({ root, visible, tab, onTab, onShow, onHide, onChooseRoot, onOpenFile, sidebarOpen, onToggleSidebar, focused, onFocus, width, onResize, nativeOverlay, children, hasCode }: {
  root: string; visible: boolean; tab: WorkspaceTab; onTab: (tab: WorkspaceTab) => void;
  onShow: () => void; onHide: () => void; onChooseRoot: () => void; onOpenFile: (file: PreviewDocument) => void;
  sidebarOpen: boolean; onToggleSidebar: () => void; focused: boolean; onFocus: () => void;
  width: number; onResize: (width: number) => void; nativeOverlay: boolean; children: React.ReactNode; hasCode: boolean;
}) {
  const [terminals, setTerminals] = useState<{ id: string; title: string; root: string }[]>([]);
  const [browserOpened, setBrowserOpened] = useState(false);
  const [filesOpened, setFilesOpened] = useState(false);
  const counter = useRef(0);
  const dragCleanup = useRef<(() => void) | null>(null);
  const startTerminal = () => {
    if (!root) { toast.error("请先选择工作区文件夹"); return; }
    if (terminals.length >= 6) { toast.info("请先关闭不用的终端，最多同时打开 6 个"); return; }
    const id = nanoid(10); counter.current += 1;
    setTerminals(previous => [...previous, { id, title: `终端 ${counter.current}`, root }]);
    onTab(`terminal:${id}`); onShow();
  };
  const show = (target: "files" | "browser") => {
    if (target === "browser") setBrowserOpened(true);
    if (target === "files") setFilesOpened(true);
    onTab(target); onShow();
  };
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (nativeOverlay || event.repeat || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey)) return;
      if (event.code === "KeyP") { event.preventDefault(); show("files"); }
      if (event.code === "KeyT") { event.preventDefault(); show("browser"); }
      if (event.code === "Backquote") { event.preventDefault(); startTerminal(); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [root, terminals, nativeOverlay]);
  useEffect(() => () => dragCleanup.current?.(), []);
  const startDrag = (event: React.PointerEvent) => {
    if (focused) return;
    event.preventDefault(); dragCleanup.current?.();
    const startX = event.clientX, startWidth = width;
    const move = (event: PointerEvent) => onResize(Math.max(320, Math.min(1000, startWidth + startX - event.clientX)));
    const stop = () => {
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop);
      document.body.style.cursor = ""; document.body.style.userSelect = ""; dragCleanup.current = null;
    };
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop); dragCleanup.current = stop;
  };
  const tabs: { id: WorkspaceTab; label: string; icon: React.ReactNode; close?: () => void }[] = [
    { id: "start", label: "开始", icon: <Compass size={14} /> },
    ...(filesOpened ? [{ id: "files" as const, label: "工作区文件", icon: <FolderOpen size={14} /> }] : []),
    ...(hasCode ? [{ id: "code" as const, label: "代码", icon: <Code size={14} /> }] : []),
    ...terminals.map(item => ({ id: `terminal:${item.id}` as WorkspaceTab, label: item.title, icon: <TerminalWindow size={14} />, close: () => {
      setTerminals(previous => previous.filter(terminal => terminal.id !== item.id));
      if (tab === `terminal:${item.id}`) onTab("start");
    } })),
    ...(browserOpened ? [{ id: "browser" as const, label: "浏览器", icon: <Globe size={14} />, close: () => { setBrowserOpened(false); if (tab === "browser") onTab("start"); } }] : []),
  ];
  return <aside className="workspace-pane" hidden={!visible} data-focused={focused} style={{ "--workbench-width": `${width}px` } as React.CSSProperties} aria-label="工作区面板">
    <div className="document-resize" role="separator" aria-label="调整工作区宽度" aria-orientation="vertical" tabIndex={0} onPointerDown={startDrag} onKeyDown={event => {
      if (["ArrowLeft", "ArrowRight"].includes(event.key)) { event.preventDefault(); onResize(Math.max(320, Math.min(1000, width + (event.key === "ArrowLeft" ? 24 : -24)))); }
    }} />
    <div className="workbench-header">
      <div className="workbench-tabs" role="tablist" aria-label="工作区标签" onKeyDown={event => {
        if (!(event.target instanceof HTMLElement) || event.target.getAttribute("role") !== "tab" || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const current = tabs.findIndex(item => item.id === tab);
        const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
        onTab(tabs[next].id); event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
      }}>
        {tabs.map(item => <div className="workbench-tab" key={item.id} data-active={tab === item.id}>
          <button type="button" role="tab" tabIndex={tab === item.id ? 0 : -1} aria-selected={tab === item.id} onClick={() => onTab(item.id)}>{item.icon}<span>{item.label}</span></button>
          {item.close && <button type="button" className="document-icon" aria-label={`关闭${item.label}`} onClick={item.close}><X size={12} /></button>}
        </div>)}
      </div>
      <button type="button" className="document-icon" aria-label="新标签页" title="新标签页" onClick={() => onTab("start")}><Plus size={15} /></button>
      <div className="workbench-layout">
        <button type="button" className="document-icon" aria-label="切换左侧栏" title="切换左侧栏" aria-pressed={sidebarOpen} onClick={onToggleSidebar}><SidebarSimple size={16} /></button>
        <button type="button" className="document-icon" aria-label={focused ? "恢复分栏" : "展开工作区"} title={focused ? "恢复分栏" : "展开工作区"} onClick={onFocus}>{focused ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}</button>
        <button type="button" className="document-icon" aria-label="收起工作区" title="收起工作区" onClick={onHide}><SidebarSimple size={16} className="workbench-right-icon" /></button>
      </div>
    </div>
    <div className="workbench-body">
      <div className="workbench-start" hidden={tab !== "start"}>
        <Compass className="workbench-start-mark" size={48} weight="light" />
        <div className="workbench-guide">
          <button type="button" aria-label="工作区文件" aria-keyshortcuts="Control+P" onClick={() => show("files")}><Folder size={22} weight="duotone" /><span><strong>工作区文件</strong><small>浏览会话工作区的文件</small></span><kbd>Ctrl + P</kbd></button>
          <button type="button" aria-label="新建终端" aria-keyshortcuts="Control+`" onClick={startTerminal}><TerminalWindow size={22} /><span><strong>新建终端</strong><small>在会话工作区运行命令</small></span><kbd>Ctrl + `</kbd></button>
          <button type="button" aria-label="浏览器" aria-keyshortcuts="Control+T" onClick={() => show("browser")}><Globe size={22} /><span><strong>浏览器</strong><small>浏览网页与项目文档</small></span><kbd>Ctrl + T</kbd></button>
        </div>
        <button type="button" className="workbench-root" title={root} onClick={onChooseRoot}><FolderOpen size={14} /><span>{root || "选择工作区文件夹"}</span></button>
      </div>
      <div className="workbench-files" hidden={tab !== "files"}><WorkspaceFiles root={root} onOpen={onOpenFile} onChooseRoot={onChooseRoot} visible={visible && tab === "files"} /></div>
      <div className="workbench-code" hidden={tab !== "code"}>{children}</div>
      <Suspense fallback={<div className="workbench-empty" role="status">正在加载终端…</div>}>
        {terminals.map(item => <WorkspaceTerminal key={item.id} id={item.id} root={item.root} visible={visible && tab === `terminal:${item.id}`} />)}
      </Suspense>
      {browserOpened && <WorkspaceBrowser visible={visible && tab === "browser" && !nativeOverlay} />}
    </div>
  </aside>;
}

function WorkspaceFiles({ root, onOpen, onChooseRoot, visible }: { root: string; onOpen: (file: PreviewDocument) => void; onChooseRoot: () => void; visible: boolean }) {
  const [listing, setListing] = useState<WorkspaceListing | null>(null);
  const [directory, setDirectory] = useState(root);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  useEffect(() => { epoch.current += 1; setDirectory(root); setListing(null); setFilter(""); }, [root]);
  async function load(more = false) {
    if (!root || !directory) return;
    const request = ++epoch.current; setBusy(true); setError("");
    try {
      const result = await invoke<WorkspaceListing>("list_workspace_directory", { root, directory, offset: more ? listing?.next_offset : 0 });
      if (request !== epoch.current) return;
      setListing(previous => ({ ...result, entries: more && previous ? [...previous.entries, ...result.entries] : result.entries }));
    } catch (error) { if (request === epoch.current) { setError(String(error)); if (!more) setListing(null); } }
    finally { if (request === epoch.current) setBusy(false); }
  }
  useEffect(() => { if (visible) void load(); return () => { epoch.current += 1; }; }, [root, directory, visible, revision]);
  const parent = directory.replace(/[\\/][^\\/]+[\\/]?$/, "");
  const atRoot = !listing || listing.directory.toLowerCase() === listing.root.toLowerCase();
  const entries = listing?.entries.filter(item => item.name.toLowerCase().includes(filter.toLowerCase())) ?? [];
  const openFile = async (entry: WorkspaceListing["entries"][number]) => {
    if (entry.directory) { setListing(null); setDirectory(entry.path); setFilter(""); return; }
    if (isTextPath(entry.path)) {
      onOpen({ id: `file:${entry.path}`, path: entry.path, title: entry.name, language: documentLanguage(entry.path), code: "", loadFromDisk: true });
    } else {
      try { await openPath(entry.path); } catch (error) { toast.error(`打开文件失败：${String(error)}`); }
    }
  };
  return <>
    <div className="workbench-file-toolbar">
      <button type="button" className="document-icon" aria-label="上一级目录" disabled={atRoot || busy} onClick={() => { setDirectory(parent); setListing(null); setFilter(""); }}><ArrowLeft size={15} /></button>
      <span title={directory}>{directory || "尚未选择工作区"}</span>
      <button type="button" className="document-icon" aria-label="刷新工作区文件" disabled={busy} onClick={() => setRevision(value => value + 1)}><ArrowClockwise size={15} className={busy ? "animate-spin" : ""} /></button>
      <button type="button" className="document-icon" aria-label="选择工作区文件夹" onClick={onChooseRoot}><FolderOpen size={15} /></button>
    </div>
    <input className="workbench-file-filter" aria-label="筛选当前目录" placeholder="筛选当前目录…" value={filter} onChange={event => setFilter(event.target.value)} />
    {error && <div className="document-notice document-error" role="alert">{error}<button type="button" onClick={() => setRevision(value => value + 1)}>重试</button></div>}
    <div className="workbench-file-list" aria-label="工作区文件列表">
      {entries.map(entry => <button type="button" className="workbench-file" key={entry.path} onClick={() => void openFile(entry)} title={entry.path}>{entry.directory ? <Folder size={17} weight="duotone" /> : <File size={17} />}<span>{entry.name}</span></button>)}
      {!busy && !error && !entries.length && <p className="workbench-empty">{filter ? "当前已加载文件中没有匹配项" : root ? "此文件夹为空" : "请先选择工作区文件夹"}</p>}
      {busy && <p className="workbench-empty" role="status">正在读取文件…</p>}
      {listing?.next_offset != null && <button type="button" className="workbench-load-more" disabled={busy} onClick={() => void load(true)}>加载更多文件</button>}
    </div>
  </>;
}
