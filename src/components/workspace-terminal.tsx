import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { copyText } from "@/lib/clipboard";
import { useSettingsStore } from "@/stores/settings";
import "@xterm/xterm/css/xterm.css";
import { nanoid } from "nanoid";

export function WorkspaceTerminal({ id, root, visible }: { id: string; root: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const fitRef = useRef<() => void>(() => {});
  const [error, setError] = useState("");
  const [exited, setExited] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const theme = useSettingsStore(s => s.theme);
  const terminalRef = useRef<Terminal | null>(null);
  useEffect(() => {
    if (!host.current) return;
    const processId = `${id}-${nanoid(8)}`;
    let disposed = false, opened = false;
    const terminal = new Terminal({ fontSize: 12, fontFamily: 'Consolas, "Microsoft YaHei", monospace', cursorBlink: true, scrollback: 3000, allowProposedApi: false });
    terminalRef.current = terminal;
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current);
    setError(""); setExited(false);
    const resize = () => {
      if (!host.current?.offsetWidth || !host.current.offsetHeight || disposed) return;
      fit.fit();
      if (opened) void invoke("terminal_resize", { id: processId, cols: terminal.cols, rows: terminal.rows }).catch(() => {});
    };
    fitRef.current = resize;
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    const input = terminal.onData(data => { if (opened && !disposed) void invoke("terminal_write", { id: processId, data }).catch(error => { if (!disposed) setError(String(error)); }); });
    terminal.attachCustomKeyEventHandler(event => {
      if (event.type === "keydown" && event.ctrlKey && event.shiftKey && event.code === "KeyC" && terminal.hasSelection()) {
        void copyText(terminal.getSelection()).catch(error => setError(String(error))); return false;
      }
      return !(event.ctrlKey && ["KeyP", "KeyT", "Backquote"].includes(event.code));
    });
    let stop: (() => void) | undefined;
    const start = async () => {
      stop = await listen<{ id: string; data: number[]; exited: boolean }>("workspace-terminal-output", ({ payload }) => {
        if (disposed || payload.id !== processId) return;
        if (payload.data.length) terminal.write(new Uint8Array(payload.data));
        if (payload.exited) { opened = false; setExited(true); }
      });
      if (disposed) { stop(); return; }
      resize();
      await invoke("terminal_open", { id: processId, root, cols: terminal.cols, rows: terminal.rows });
      if (disposed) { await invoke("terminal_close", { id: processId }); return; }
      opened = true; resize();
    };
    void start().catch(error => { if (!disposed) setError(String(error)); });
    return () => {
      disposed = true; opened = false; observer.disconnect(); stop?.(); input.dispose(); terminal.dispose(); terminalRef.current = null;
      // start() closes a process whose allocation completes after disposal.
      void invoke("terminal_close", { id: processId }).catch(() => {});
    };
  }, [id, root, attempt]);
  useEffect(() => {
    if (!terminalRef.current) return;
    const style = getComputedStyle(document.body);
    const background = style.backgroundColor, foreground = style.color;
    terminalRef.current.options.theme = { background, foreground, cursor: foreground, cursorAccent: background,
      selectionBackground: foreground, selectionForeground: background, selectionInactiveBackground: foreground };
  }, [theme, attempt]);
  useEffect(() => { if (visible) { fitRef.current(); terminalRef.current?.focus(); } }, [visible]);
  return <section className="workspace-terminal" hidden={!visible} aria-label="工作区终端">
    <div className="workbench-path">PowerShell · {root}</div>
    {(error || exited) && <div className="document-notice" role={error ? "alert" : "status"}>{error || "终端已退出"}<button type="button" onClick={() => setAttempt(value => value + 1)}>重新打开</button></div>}
    <div className="terminal-screen" ref={host} />
  </section>;
}
