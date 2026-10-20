import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { CaretDown, Code, FilePlus, Plus, X } from "@phosphor-icons/react";
import { toast } from "sonner";
import { useSettingsStore } from "@/stores/settings";

import { ModelPicker } from "./model-picker";

export function ChatComposer({ value, onChange, onSend, onStop, running, hasQueue = false, files, onAttach, onRemove, onNewChat, focusKey }: {
  value: string; onChange: (value: string) => void; onSend: (alternate?: boolean) => void; onStop: () => void; running: boolean;
  files: string[]; onAttach: () => void; onRemove: (path: string) => void; onNewChat: () => void;
  focusKey?: string | null;
  hasQueue?: boolean;
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
      {files.length > 0 && <div className="harness-composer-files">{files.map(path => <div className="harness-file-chip" key={path}><FilePlus size={14} /><span>{path.split(/[\\/]/).pop()}</span><button type="button" aria-label={`移除附件 ${path.split(/[\\/]/).pop()}`} onClick={() => onRemove(path)}><X size={12} /></button></div>)}</div>}
      <textarea ref={editor} className="harness-composer-input" aria-label="消息输入框" value={value} rows={1}
        placeholder={hasQueue && running ? "Cmd/Ctrl+Enter 插话发送全部排队消息" : files.length ? "说明这些易语言工程或模块需要怎样修改…" : "描述易语言功能、窗口界面或需要修复的问题…"}
        onChange={event => onChange(event.target.value)} onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!empty || (hasQueue && (event.ctrlKey || event.metaKey))) onSend(event.ctrlKey || event.metaKey); }
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
          <button type="button" className="harness-composer-send" aria-label={primaryLabel} disabled={!running && empty} onMouseDown={event => event.preventDefault()} onClick={() => primaryStops ? onStop() : onSend()}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">{primaryStops ? <rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" /> : <path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" />}</svg>
          </button>
        </div>
      </div>
    </div>
  </div>;
}
