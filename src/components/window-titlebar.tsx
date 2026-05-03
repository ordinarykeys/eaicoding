import { type PointerEvent, useCallback, useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CopySimple, Minus, Square, X } from "@phosphor-icons/react";

type WindowResizeDirection =
  | "East"
  | "North"
  | "NorthEast"
  | "NorthWest"
  | "South"
  | "SouthEast"
  | "SouthWest"
  | "West";

const RESIZE_HANDLES: Array<{
  direction: WindowResizeDirection;
  className: string;
  label: string;
}> = [
  { direction: "North", className: "window-resize-n", label: "Resize top edge" },
  { direction: "East", className: "window-resize-e", label: "Resize right edge" },
  { direction: "South", className: "window-resize-s", label: "Resize bottom edge" },
  { direction: "West", className: "window-resize-w", label: "Resize left edge" },
  {
    direction: "NorthEast",
    className: "window-resize-ne",
    label: "Resize top right corner",
  },
  {
    direction: "NorthWest",
    className: "window-resize-nw",
    label: "Resize top left corner",
  },
  {
    direction: "SouthEast",
    className: "window-resize-se",
    label: "Resize bottom right corner",
  },
  {
    direction: "SouthWest",
    className: "window-resize-sw",
    label: "Resize bottom left corner",
  },
];

function useCurrentTauriWindow() {
  return useMemo(() => {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  }, []);
}

function useMaximizedState() {
  const appWindow = useCurrentTauriWindow();
  const [isMaximized, setIsMaximized] = useState(false);

  const refreshMaximized = useCallback(() => {
    if (!appWindow) return;
    void appWindow.isMaximized().then(setIsMaximized).catch(() => {});
  }, [appWindow]);

  useEffect(() => {
    if (!appWindow) return;
    refreshMaximized();
    const unlisten = appWindow.onResized(refreshMaximized);
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [appWindow, refreshMaximized]);

  return { appWindow, isMaximized, refreshMaximized };
}

export function WindowResizeHandles() {
  const { appWindow, isMaximized } = useMaximizedState();

  const startResize = (direction: WindowResizeDirection) => (
    event: PointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0 || !appWindow || isMaximized) return;
    event.preventDefault();
    event.stopPropagation();
    void appWindow.startResizeDragging(direction);
  };

  return (
    <div className="window-resize-handles" aria-hidden={isMaximized}>
      {RESIZE_HANDLES.map((handle) => (
        <div
          key={handle.direction}
          aria-label={handle.label}
          className={`window-resize-handle ${handle.className}`}
          role="presentation"
          onPointerDown={startResize(handle.direction)}
        />
      ))}
    </div>
  );
}

export function WindowTitlebar() {
  const { appWindow, isMaximized, refreshMaximized } = useMaximizedState();

  const minimize = () => {
    if (!appWindow) return;
    void appWindow.minimize();
  };

  const toggleMaximize = () => {
    if (!appWindow) return;
    void appWindow.toggleMaximize().then(refreshMaximized);
  };

  const close = () => {
    if (!appWindow) return;
    void appWindow.close();
  };

  return (
    <header
      data-tauri-drag-region
      onDoubleClick={toggleMaximize}
      className="window-titlebar flex h-10 shrink-0 select-none items-center justify-between bg-background text-foreground"
    >
      <div
        data-tauri-drag-region
        className="flex min-w-0 flex-1 items-center gap-2.5 px-3"
      >
        <img
          data-tauri-drag-region
          src="/icon.ico"
          alt=""
          className="h-4.5 w-4.5 shrink-0 rounded-[3px] object-contain opacity-90"
          draggable={false}
        />
        <div data-tauri-drag-region className="min-w-0">
          <div
            data-tauri-drag-region
            className="truncate text-xs font-medium leading-none text-muted-foreground"
          >
            EAiCoding
          </div>
        </div>
      </div>

      <div className="no-window-drag flex h-full items-center">
        <button
          type="button"
          aria-label="Minimize"
          className="window-control"
          onClick={minimize}
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={isMaximized ? "Restore" : "Maximize"}
          className="window-control"
          onClick={toggleMaximize}
        >
          {isMaximized ? (
            <CopySimple className="h-3.5 w-3.5" />
          ) : (
            <Square className="h-3 w-3" />
          )}
        </button>
        <button
          type="button"
          aria-label="Close"
          className="window-control window-control-close"
          onClick={close}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </header>
  );
}
