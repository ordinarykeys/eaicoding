// Caption labels and editor selection restoration adapted from Harness preload-menu.ts (MIT).
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { useChatStore } from "@/stores/chat";
import { version } from "../../package.json";
import "@/styles/account.css";

export function WindowMenu({ onOverlayChange }: { onOverlayChange: (open: boolean) => void }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [tab, setTab] = useState(0);
  const [dialog, setDialog] = useState<"about" | "updates" | "exit" | null>(null);
  const [update, setUpdate] = useState<{ version: string; url: string } | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const restoreEditor = useRef(() => {});
  const running = useChatStore(s => s.sessions.some(session => session.messages.some(message => message.isStreaming)));

  useEffect(() => {
    const remember = (event: FocusEvent) => {
      const target = event.composedPath()[0];
      if (!(target instanceof HTMLElement) || !target.matches('input, textarea, [contenteditable="true"]')) return;
      const input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : null;
      const start = input?.selectionStart, end = input?.selectionEnd, direction = input?.selectionDirection;
      const selection = document.getSelection();
      const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
      restoreEditor.current = () => {
        if (!target.isConnected) return;
        target.focus({ preventScroll: true });
        if (input && start != null && end != null) input.setSelectionRange(start, end, direction ?? undefined);
        else if (selection && ranges.length) { selection.removeAllRanges(); ranges.forEach(range => selection.addRange(range)); }
      };
    };
    document.addEventListener("focusout", remember, true);
    return () => document.removeEventListener("focusout", remember, true);
  }, []);
  useEffect(() => {
    const stop = listen<"about" | "updates" | "exit">("caption-menu-action", ({ payload }) => {
      setUpdate(null); setError(""); setDialog(payload);
    });
    return () => { void stop.then(fn => fn()); };
  }, []);
  useEffect(() => { onOverlayChange(dialog !== null); }, [dialog, onOverlayChange]);
  useEffect(() => () => onOverlayChange(false), [onOverlayChange]);
  useEffect(() => {
    if (dialog !== "updates") return;
    let active = true;
    setChecking(true);
    void invoke<{ version: string; url: string }>("check_application_update")
      .then(value => { if (active) setUpdate(value); })
      .catch(reason => { if (active) setError(String(reason)); })
      .finally(() => { if (active) setChecking(false); });
    return () => { active = false; };
  }, [dialog]);

  const open = async (index: number) => {
    if (expanded !== null) return;
    const button = buttons.current[index];
    if (!button) return;
    if (buttons.current.includes(document.activeElement as HTMLButtonElement)) restoreEditor.current();
    const rect = button.getBoundingClientRect();
    const name = index === 0 ? "application" : "edit";
    setExpanded(name);
    try { await invoke("show_caption_menu", { name, x: rect.left, y: rect.bottom }); }
    catch (reason) { toast.error(String(reason)); }
    finally { setExpanded(null); }
  };

  return <>
    <div className="window-caption-menu no-window-drag" role="menubar" aria-label="应用菜单" onDoubleClick={event => event.stopPropagation()}>
      {["应用", "编辑"].map((label, index) => <button key={label} ref={element => { buttons.current[index] = element; }} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={expanded === (index === 0 ? "application" : "edit")} tabIndex={tab === index ? 0 : -1}
        onPointerDown={event => event.preventDefault()} onMouseDown={event => event.preventDefault()} onClick={() => void open(index)}
        onKeyDown={event => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const next = 1 - index; setTab(next); buttons.current[next]?.focus(); }
          else if (event.key === "ArrowDown") { event.preventDefault(); void open(index); }
        }}>{label}</button>)}
    </div>
    <Dialog.Root open={dialog !== null} onOpenChange={value => { if (!value) setDialog(null); }}>
      <Dialog.Portal><Dialog.Overlay className="account-signout-overlay" /><Dialog.Content className="account-signout-dialog window-application-dialog">
        <header><Dialog.Title>{dialog === "about" ? "关于 EAiCoding" : dialog === "updates" ? "检查更新" : "退出 EAiCoding？"}</Dialog.Title><Dialog.Close aria-label="关闭应用对话框"><X size={14} /></Dialog.Close></header>
        <Dialog.Description>{dialog === "about" ? `EAiCoding · 版本 V${version}` : dialog === "exit" ? (running ? "当前正在运行的任务将会中断。" : "是否退出应用？") : `当前版本 V${version}`}</Dialog.Description>
        {dialog === "about" && <img className="window-about-icon" src="/icon.ico" alt="EAiCoding" />}
        {dialog === "updates" && <p className="window-update-status" role="status">{checking ? "正在检查更新…" : error || (update ? `最新发布版本 ${update.version}` : "")}</p>}
        <footer><Dialog.Close>{dialog === "exit" ? "取消" : "关闭"}</Dialog.Close>
          {dialog === "updates" && update && <button type="button" className="account-primary" onClick={() => void openUrl(update.url).catch(reason => toast.error(String(reason)))}>查看发布版本</button>}
          {dialog === "exit" && <button type="button" className="account-primary" onClick={() => void invoke("exit_application").catch(reason => toast.error(String(reason)))}>退出</button>}
        </footer>
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </>;
}
