// Adapted from Harness AccountMenu and SignOutDialog (MIT); see THIRD_PARTY_NOTICES.md.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import * as Dialog from "@radix-ui/react-dialog";
import { GearSix, SignOut, User, X } from "@phosphor-icons/react";
import { AccountNoticeStack } from "@/components/account-notice";
import { useDeepSeekAccount } from "@/stores/deepseek-account";
import { useChatStore } from "@/stores/chat";
import "@/styles/account.css";

export function AccountAvatar({ large = false }: { large?: boolean }) {
  return <span className="account-avatar" data-large={large} aria-hidden="true"><User size={16} /></span>;
}

export function AccountMenu({ onSettings, settingsOpen, onOverlayChange }: {
  onSettings: () => void; settingsOpen: boolean; onOverlayChange: (open: boolean) => void;
}) {
  const view = useDeepSeekAccount(state => state.view);
  const notices = useDeepSeekAccount(state => state.notices);
  const noticeShown = useDeepSeekAccount(state => state.noticeShown);
  const dismissNotice = useDeepSeekAccount(state => state.dismissNotice);
  const busy = useDeepSeekAccount(state => state.busy);
  const start = useDeepSeekAccount(state => state.start);
  const logout = useDeepSeekAccount(state => state.logout);
  const running = useChatStore(state => state.sessions.some(session => session.messages.some(message => message.isStreaming)));
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, bottom: 0, width: 200 });
  const label = view.name || view.contact || (view.signedIn ? "已登录 DeepSeek" : "未登录 DeepSeek");
  const dismiss = () => { setOpen(false); trigger.current?.focus(); };
  useEffect(() => { if (settingsOpen) setOpen(false); }, [settingsOpen]);
  useEffect(() => { onOverlayChange(open || confirm); }, [open, confirm, onOverlayChange]);
  useEffect(() => () => onOverlayChange(false), [onOverlayChange]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const box = trigger.current?.getBoundingClientRect();
      if (!box) return;
      const width = Math.min(280, Math.max(200, box.width), window.innerWidth - 16);
      setPosition({ left: Math.max(8, Math.min(box.left, window.innerWidth - width - 8)), bottom: window.innerHeight - box.top + 6, width });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", outside);
    return () => window.removeEventListener("pointerdown", outside);
  }, [open]);
  return <div className="account-launcher">
    <AccountNoticeStack notices={notices} anchor={trigger} title="账号通知" closeLabel="关闭账号通知" onShown={noticeShown} onDismiss={dismissNotice} />
    <button ref={trigger} type="button" className="account-trigger" aria-label="账号菜单" title={label}
      aria-haspopup="menu" aria-expanded={open} aria-controls={open ? "account-menu" : undefined}
      onClick={() => setOpen(previous => !previous)} onKeyDown={event => {
        if (event.key === "ArrowUp" || event.key === "ArrowDown") { event.preventDefault(); setOpen(true); }
      }}><AccountAvatar /><span>{label}</span></button>
    {open && createPortal(<div ref={menu} id="account-menu" className="account-popover" role="menu" aria-label="账号操作" style={position}
      onKeyDown={event => {
        const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
        else if (event.key === "Tab") { setOpen(false); trigger.current?.focus(); }
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          items[event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
        }
      }}>
      <button type="button" role="menuitem" aria-label="设置" aria-keyshortcuts="Control+," onClick={() => { dismiss(); onSettings(); }}><GearSix size={16} /><span>设置</span><kbd>Ctrl+,</kbd></button>
      <button type="button" role="menuitem" disabled={busy} onClick={() => { setOpen(false); if (view.signedIn) setConfirm(true); else void start(); }}><SignOut size={16} /><span>{view.signedIn ? "退出登录" : "登录 DeepSeek"}</span></button>
    </div>, document.body)}
    <Dialog.Root open={confirm} onOpenChange={value => { if (!busy) setConfirm(value); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="account-signout-overlay" />
        <Dialog.Content className="account-signout-dialog" onCloseAutoFocus={event => { event.preventDefault(); trigger.current?.focus(); }}
          onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onInteractOutside={event => { if (busy) event.preventDefault(); }}>
          <header><Dialog.Title>退出登录</Dialog.Title><Dialog.Close aria-label="关闭退出登录" disabled={busy}><X size={14} /></Dialog.Close></header>
          <Dialog.Description>{running ? "当前有任务正在执行，退出登录将中断任务，是否退出登录？" : "退出登录不会丢失任何数据，你仍可以登录此账号。"}</Dialog.Description>
          <footer><Dialog.Close disabled={busy}>取消</Dialog.Close><button type="button" className="account-primary" disabled={busy} onClick={() => void logout()}>{busy ? "正在退出…" : "退出登录"}</button></footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
