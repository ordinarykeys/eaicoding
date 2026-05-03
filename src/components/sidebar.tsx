import {
  GearSix,
  Plus,
  SidebarSimple,
  Trash,
} from "@phosphor-icons/react";
import { useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
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

interface SidebarProps {
  currentView: "chat" | "settings";
  onNavigate: (view: "chat" | "settings") => void;
  onClose: () => void;
  width: number;
  onResize: (width: number) => void;
  minWidth: number;
  maxWidth: number;
}

export function Sidebar({ currentView, onNavigate, onClose, width, onResize, minWidth, maxWidth }: SidebarProps) {
  const sessions = useChatStore((s) => s.sessions);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const createSession = useChatStore((s) => s.createSession);
  const setActiveSession = useChatStore((s) => s.setActiveSession);
  const deleteSession = useChatStore((s) => s.deleteSession);
  const dragging = useRef(false);

  const handleNew = () => {
    const id = createSession();
    onNavigate("chat");
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
            新聊天
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 rounded-lg text-muted-foreground hover:bg-sidebar-accent"
                onClick={onClose}
              >
                <SidebarSimple className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>收起侧栏</TooltipContent>
          </Tooltip>
        </div>

        <div className="px-4 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/75">
          最近
        </div>

        <ScrollArea className="flex-1 px-2 py-1">
          {sessions.length === 0 && (
            <p className="px-3 py-3 text-xs leading-5 text-muted-foreground">
              暂无聊天
            </p>
          )}
          <div className="space-y-0.5">
            {sessions.map((session) => {
              const displayTitle = getSessionDisplayTitle(session);
              return (
              <div
                key={session.id}
                className={cn(
                  "group flex min-w-0 cursor-pointer items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-[13px] transition-colors hover:bg-sidebar-accent",
                  activeSessionId === session.id && currentView === "chat"
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/80",
                )}
                onClick={() => {
                  setActiveSession(session.id);
                  onNavigate("chat");
                }}
                title={displayTitle}
              >
                <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                  {displayTitle}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 shrink-0 rounded-md text-muted-foreground opacity-0 hover:bg-transparent hover:text-destructive group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteSession(session.id);
                  }}
                >
                  <Trash className="h-3 w-3" />
                </Button>
              </div>
              );
            })}
          </div>
        </ScrollArea>

        <div className="px-2 py-2">
          <Button
            variant="ghost"
            className={cn(
              "h-9 w-full justify-start gap-2 rounded-md bg-transparent px-3 text-sm text-muted-foreground hover:bg-sidebar-accent",
              currentView === "settings" && "text-foreground",
            )}
            onClick={() => onNavigate("settings")}
          >
            <GearSix className="h-4 w-4" />
            设置
          </Button>
        </div>
        <div
          className="sidebar-resize-handle"
          onMouseDown={handleDragStart}
        />
      </aside>
    </TooltipProvider>
  );
}
