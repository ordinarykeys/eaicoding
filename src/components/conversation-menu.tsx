import { useEffect, useRef, useState } from "react";
import { CaretDown, CopySimple, DotsThree, DownloadSimple, FolderOpen, PencilSimple } from "@phosphor-icons/react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { openPath } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { copyText } from "@/lib/clipboard";
import { useChatStore } from "@/stores/chat";
import type { ChatSession } from "@/types/llm";

export function conversationMarkdown(session: ChatSession): string {
  return `# ${session.title}\n\n` + session.messages.filter(message => message.role === "user" || message.role === "assistant")
    .map(message => `## ${message.role === "user" ? "用户" : "EAiCoding"}\n\n${message.content}`).join("\n\n");
}

export function ConversationMenu({ session, title, workspace, busy, onChooseWorkspace }: {
  session: ChatSession | null; title: string; workspace: string; busy: boolean; onChooseWorkspace: () => void;
}) {
  const [open, setOpen] = useState<"workspace" | "session" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const host = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const renameSession = useChatStore(s => s.renameSession);
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => { if (!host.current?.contains(event.target as Node)) setOpen(null); };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setOpen(null); trigger.current?.focus(); }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const buttons = Array.from(host.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
        if (!buttons.length) return;
        event.preventDefault(); const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }
    };
    const first = host.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'); first?.focus();
    window.addEventListener("pointerdown", pointer); host.current?.addEventListener("keydown", keyboard);
    return () => { window.removeEventListener("pointerdown", pointer); host.current?.removeEventListener("keydown", keyboard); };
  }, [open]);
  const run = async (action: () => Promise<unknown> | void) => {
    setOpen(null); trigger.current?.focus();
    try { await action(); } catch (error) { toast.error(String(error)); }
  };
  const toggle = (kind: "workspace" | "session", target: HTMLButtonElement) => { trigger.current = target; setOpen(current => current === kind ? null : kind); };
  const rename = () => {
    if (session && draft.trim()) renameSession(session.id, draft.trim().slice(0, 100));
    setRenaming(false);
  };
  return <div className="conversation-header-content" ref={host}>
    {renaming ? <input className="conversation-rename" aria-label="会话名称" autoFocus value={draft} onChange={event => setDraft(event.target.value)} onBlur={rename} onKeyDown={event => {
      if (event.key === "Enter") { event.preventDefault(); rename(); }
      if (event.key === "Escape") { event.preventDefault(); setRenaming(false); }
    }} /> : <h2 title={title}>{title}</h2>}
    <div className="conversation-header-menus">
      <button type="button" className="conversation-workspace-trigger" aria-label="会话工作区" title={workspace || "选择工作区文件夹"} aria-haspopup="menu" aria-expanded={open === "workspace"} onClick={event => toggle("workspace", event.currentTarget)}><FolderOpen size={16} weight="duotone" /><CaretDown size={11} /></button>
      <button type="button" className="document-icon" aria-label="会话菜单" title="会话菜单" aria-haspopup="menu" aria-expanded={open === "session"} onClick={event => toggle("session", event.currentTarget)}><DotsThree size={21} weight="bold" /></button>
      {open && <div className="conversation-popover" role="menu" aria-label={open === "workspace" ? "工作区操作" : "会话操作"}>
        {open === "workspace" ? <>
          <div className="conversation-workspace-path" title={workspace}>{workspace || "尚未选择工作区"}</div>
          <button type="button" role="menuitem" disabled={busy} onClick={() => void run(onChooseWorkspace)}><FolderOpen size={15} />选择工作区文件夹</button>
          <button type="button" role="menuitem" disabled={!workspace} onClick={() => void run(() => openPath(workspace))}><FolderOpen size={15} />在资源管理器打开</button>
          <button type="button" role="menuitem" disabled={!workspace} onClick={() => void run(async () => { await copyText(workspace); toast.success("工作区路径已复制"); })}><CopySimple size={15} />复制工作区路径</button>
        </> : <>
          <button type="button" role="menuitem" disabled={!session} onClick={() => { setOpen(null); setDraft(title); setRenaming(true); }}><PencilSimple size={15} />重命名会话</button>
          <button type="button" role="menuitem" disabled={!session?.messages.length} onClick={() => void run(async () => { await copyText(conversationMarkdown(session!)); toast.success("会话已复制"); })}><CopySimple size={15} />复制整个会话</button>
          <button type="button" role="menuitem" disabled={!session?.messages.length} onClick={() => void run(async () => {
            const path = await save({ defaultPath: `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80)}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
            if (path) { await invoke("write_text_file", { filePath: path, content: conversationMarkdown(session!), encoding: "utf-8" }); toast.success("会话已导出"); }
          })}><DownloadSimple size={15} />导出为 Markdown</button>
        </>}
      </div>}
    </div>
  </div>;
}
