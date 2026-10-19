import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Check, Code, FilePlus, Plus, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { useSettingsStore } from "@/stores/settings";

import { DEEPSEEK_MODELS, deepSeekModelLabel as modelLabel, normalizeDeepSeekModel } from "@/lib/deepseek-models";

function ModelPicker({ disabled }: { disabled: boolean }) {
  const profiles = useSettingsStore(s => s.profiles);
  const activeId = useSettingsStore(s => s.activeProfileId);
  const update = useSettingsStore(s => s.updateProfile);
  const profile = profiles.find(p => p.id === activeId) ?? profiles[0];
  const models = DEEPSEEK_MODELS;
  const currentModel = normalizeDeepSeekModel(profile?.model ?? "");
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ visibility: "hidden", left: 0, top: 0 });
  const root = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    menu.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open, models.length]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const popup = menu.current;
      if (!anchor || !popup) return;
      const left = Math.max(12, Math.min(anchor.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 12));
      const top = Math.max(12, Math.min(anchor.top - popup.offsetHeight - 8, window.innerHeight - popup.offsetHeight - 12));
      setPosition({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  const choose = async (id: string) => {
    if (!profile || saving) return;
    if (profile.model === id) { setOpen(false); trigger.current?.focus(); return; }
    setSaving(true);
    try { await update(profile.id, { model: id }); setOpen(false); trigger.current?.focus(); }
    catch (error) { toast.error(`切换模型失败：${String(error)}`); }
    finally { setSaving(false); }
  };
  return <div className="harness-model-picker" ref={root}>
    <button ref={trigger} type="button" className="harness-model-trigger" aria-label="选择模型" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? menuId : undefined} aria-busy={saving} disabled={disabled || saving || !profile}
      title={profile ? modelLabel(profile.model) : "选择 DeepSeek 模型"}
      onClick={() => { setOpen(!open); }}><span className="harness-model-name">{profile ? modelLabel(profile.model) : "选择模型"}</span><CaretDown size={12} /></button>
    {open && createPortal(<div id={menuId} className="harness-model-menu" style={position} role="dialog" aria-label="选择 DeepSeek 模型" ref={menu} onKeyDown={event => {
      if (event.key === "Tab") { event.preventDefault(); setOpen(false); trigger.current?.focus(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
      const index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : event.key === "ArrowDown" ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
      items[next]?.focus();
    }}>
      <div role="listbox" aria-label="可用模型" className="harness-model-options">{models.map(({ id }) => <button type="button" key={id} role="option" aria-selected={currentModel === id} disabled={saving} onClick={() => void choose(id)}>
        <span>{modelLabel(id)}</span><span className="harness-model-check">{currentModel === id && <Check size={14} />}</span>
      </button>)}</div>
    </div>, document.body)}
  </div>;
}

export function ChatComposer({ value, onChange, onSend, onStop, running, files, onAttach, onRemove, onNewChat, focusKey }: {
  value: string; onChange: (value: string) => void; onSend: (alternate?: boolean) => void; onStop: () => void; running: boolean;
  files: string[]; onAttach: () => void; onRemove: (path: string) => void; onNewChat: () => void;
  focusKey?: string | null;
}) {
  const editor = useRef<HTMLTextAreaElement>(null);
  const menuRoot = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const busyEnter = useSettingsStore(s => s.busyEnterBehavior);
  const empty = !value.trim() && !files.length;
  const primaryStops = running && empty;
  const primaryLabel = primaryStops ? "停止生成" : running ? busyEnter === "queue" ? "排队发送" : "插话发送" : "发送消息";
  useLayoutEffect(() => {
    const field = editor.current;
    if (!field) return;
    const resize = () => {
      // Empty fields never measure the placeholder. It can wrap while the
      // window or sidebar is sizing, leaving an unnecessarily tall editor.
      field.style.height = "36px";
      if (value) field.style.height = `${Math.min(168, Math.max(36, field.scrollHeight))}px`;
    };
    resize();
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === width) return;
      width = field.clientWidth;
      resize();
    });
    observer.observe(field);
    return () => observer.disconnect();
  }, [value]);
  useEffect(() => { editor.current?.focus(); }, [focusKey, files.length]);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: MouseEvent) => { if (!menuRoot.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    document.addEventListener("mousedown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);
  return <div className="harness-composer-dock">
    <div className="harness-composer" data-composer-card>
      {files.length > 0 && <div className="harness-composer-files">{files.map(path => <div className="harness-file-chip" key={path} title={path}><FilePlus size={14} /><span>{path.split(/[\\/]/).pop()}</span><button type="button" aria-label={`移除附件 ${path.split(/[\\/]/).pop()}`} onClick={() => onRemove(path)}><X size={12} /></button></div>)}</div>}
      <textarea ref={editor} className="harness-composer-input" aria-label="消息输入框" value={value} rows={1}
        placeholder={files.length ? "说明这些易语言工程或模块需要怎样修改…" : "描述易语言功能、窗口界面或需要修复的问题…"}
        onChange={event => onChange(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!empty) onSend(event.ctrlKey || event.metaKey); }
        }} />
      <div className="harness-composer-row">
        <div className="harness-composer-tools">
          <div className="harness-command-root" ref={menuRoot}>
            <button type="button" className="harness-composer-add" aria-label="添加与快捷操作" aria-haspopup="menu" aria-expanded={menuOpen} disabled={running} onClick={() => setMenuOpen(!menuOpen)}><Plus size={16} /></button>
            {menuOpen && <div className="harness-command-menu" role="menu" aria-label="快捷操作">
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onAttach(); }}><FilePlus size={16} /><span>添加文件<small>易语言工程、模块与文本</small></span></button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onChange(value + (value ? "\n" : "") + "```epl\n\n```"); editor.current?.focus(); }}><Code size={16} /><span>插入代码块</span></button>
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onNewChat(); }}><Plus size={16} /><span>新建编程任务</span></button>
            </div>}
          </div>
        </div>
        <div className="harness-composer-trailing"><ModelPicker disabled={running} />
          {running && !empty && <button type="button" className="harness-composer-send" aria-label="停止生成" onMouseDown={event => event.preventDefault()} onClick={onStop}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" /></svg></button>}
          <button type="button" className="harness-composer-send" aria-label={primaryLabel} title={primaryLabel} disabled={!running && empty} onMouseDown={event => event.preventDefault()} onClick={() => primaryStops ? onStop() : onSend()}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">{primaryStops ? <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" /> : <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />}</svg>
          </button>
        </div>
      </div>
    </div>
    <p className="harness-composer-hint">Enter 发送 · Shift + Enter 换行</p>
  </div>;
}
