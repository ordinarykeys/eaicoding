import {
  GearSix,
  Books,
  FolderOpen,
  FolderPlus,
  MagnifyingGlass,
  CaretDown,
  Plus,
  SidebarSimple,
  Trash,
} from "@phosphor-icons/react";
import { useCallback, useRef, useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { DialogTrigger } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useChatStore } from "@/stores/chat";
import { getSessionDisplayTitle } from "@/lib/session-title";
import { cn } from "@/lib/utils";

import { open } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";

interface SidebarProps {
  onOpenSettings: (section: string) => void;
  settingsOpen: boolean;
  onClose: () => void;
  width: number;
  onResize: (width: number) => void;
  minWidth: number;
  maxWidth: number;
}

export function Sidebar({ onOpenSettings, settingsOpen, onClose, width, onResize, minWidth, maxWidth }: SidebarProps) {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const createSession = useChatStore((s) => s.createSession);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const dragging = useRef(false);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const grouped = new Map<string, typeof sessions>();
    const needle = query.trim().toLowerCase();
    for (const session of sessions) {
      if (needle && !`${getSessionDisplayTitle(session)} ${session.workspacePath ?? ""}`.toLowerCase().includes(needle)) continue;
      const key = session.workspacePath || "默认工作区";
      grouped.set(key, [...(grouped.get(key) ?? []), session]);
    }
    return [...grouped];
  }, [sessions, query]);
  const chooseWorkspace = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择新任务的工作区" });
      if (typeof selected !== "string") return;
      const id = createSession();
      useChatStore.getState().setWorkspace(id, selected);
    } catch (error) { toast.error(String(error)); }
  };

  const handleNew = () => {
    const id = createSession();
    setActiveSession(id);
  };

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startWidth = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const newWidth = Math.min(maxWidth, Math.max(minWidth, startWidth + ev.clientX - startX));
      onResize(newWidth);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width, onResize, minWidth, maxWidth]);

  return (
    <TooltipProvider>
      <aside className="claude-sidebar text-sidebar-foreground" style={{ width }}>
        <div className="flex items-center gap-2 px-3 py-2.5">
          <Button
            variant="ghost"
            className="h-9 flex-1 justify-start gap-2 rounded-lg bg-transparent px-3 text-sm font-medium text-foreground hover:bg-sidebar-accent"
            onClick={handleNew}
          >
            <Plus className="h-4 w-4" weight="bold" />
            新建任务
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-lg text-muted-foreground hover:bg-sidebar-accent"
                aria-label="收起侧栏"
                onClick={onClose}
              >
                <SidebarSimple className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>收起侧栏</TooltipContent>
          </Tooltip>
        </div>

        <div className="sidebar-quick-actions"><button type="button" onClick={() => onOpenSettings("knowledge")}><Books size={16} />模块库</button></div>
        <div className="sidebar-workspace-heading"><span>工作区</span><button type="button" aria-label="选择工作区新建任务" title="选择工作区新建任务" onClick={() => void chooseWorkspace()}><FolderPlus size={15} /></button></div>
        <label className="sidebar-task-search"><MagnifyingGlass size={14} /><input aria-label="搜索任务" placeholder="搜索任务或工作区…" value={query} onChange={event => setQuery(event.target.value)} /></label>

        <ScrollArea className="flex-1 px-2 py-1">
          {sessions.length === 0 && (
            <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">
              暂无编程任务
            </p>
          )}
          <div className="space-y-0.5">
            {groups.map(([workspace, grouped]) => <section key={workspace} className="sidebar-workspace-group">
              <button type="button" className="sidebar-group-toggle" aria-expanded={!collapsed.has(workspace)} title={workspace} onClick={() => setCollapsed(previous => { const next = new Set(previous); if (next.has(workspace)) next.delete(workspace); else next.add(workspace); return next; })}><CaretDown size={11} style={{ transform: collapsed.has(workspace) ? "rotate(-90deg)" : undefined }} /><FolderOpen size={14} /><span>{workspace.split(/[\\/]/).pop() || workspace}</span><small>{grouped.length}</small></button>
              {!collapsed.has(workspace) && grouped.map((session) => {
              const displayTitle = getSessionDisplayTitle(session);
              return (
              <div
                key={session.id}
                className={cn(
                  "group grid min-w-0 cursor-pointer grid-cols-[minmax(0,1fr)_24px] items-center gap-2 rounded-md px-3 py-1.5 text-[13px] transition-colors hover:bg-sidebar-accent",
                  activeSessionId === session.id
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80",
                )}
                onClick={() => {
                  setActiveSession(session.id);
                }}
                title={displayTitle}
              >
                <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {displayTitle}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 rounded-md text-muted-foreground opacity-55 hover:bg-transparent hover:text-destructive group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteSession(session.id);
                  }}
                >
                  <Trash className="h-3 w-3" />
                </Button>
              </div>
              );
            })}</section>)}
            {sessions.length > 0 && !groups.length && <p className="sidebar-empty">没有匹配的任务</p>}
          </div>
        </ScrollArea>

        <div className="px-2 py-2">
          <DialogTrigger asChild>
            <Button
              variant="ghost"
              aria-label="设置"
              aria-keyshortcuts="Control+, Meta+,"
              className={cn(
                "h-9 w-full justify-start gap-2 rounded-md bg-transparent px-3 text-sm text-muted-foreground hover:bg-sidebar-accent",
                settingsOpen && "text-foreground",
              )}
            >
              <GearSix className="h-4 w-4" />
              设置
              <kbd className="settings-shortcut" aria-hidden="true">Ctrl+,</kbd>
            </Button>
          </DialogTrigger>
        </div>
        <div
          className="sidebar-resize-handle"
          onMouseDown={handleDragStart}
        />
      </aside>
    </TooltipProvider>
  );
}
