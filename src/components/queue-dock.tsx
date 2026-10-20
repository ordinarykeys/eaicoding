import { useEffect, useId, useState } from "react";
import { CaretDown, CaretUp, Check, File, X } from "@phosphor-icons/react";

import { QueueIcon, QueueEditIcon, QueueTrashIcon, QueueSendIcon } from "./queue-icons";

export interface QueuedMessage {
  id: string;
  sessionId: string;
  text: string;
  files: string[];
}

// Mirrors Harness QueueDock: one inline row; multiple rows collapse to a count.
export function QueueDock({ items, running, onSend, onEdit, onRemove }: {
  items: QueuedMessage[];
  running: boolean;
  onSend: (item: QueuedMessage) => Promise<void>;
  onEdit: (id: string, text: string) => void;
  onRemove: (id: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(true);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const listId = useId();
  useEffect(() => {
    if (!items.length) setCollapsed(true);
    if (editing && !items.some(item => item.id === editing.id)) setEditing(null);
  }, [items, editing]);
  if (!items.length) return null;
  const edit = items.some(item => item.id === editing?.id) ? editing : null;
  const expanded = !collapsed || Boolean(edit || busy);
  const save = () => {
    if (!edit?.text.trim()) return;
    onEdit(edit.id, edit.text.trim());
    setEditing(null);
  };
  return <div className="composer-queue" aria-label="待发送消息" data-queue-dock>
    <div className="composer-queue-panel">
      {items.length > 1 && <button type="button" className="composer-queue-header" aria-controls={listId} aria-expanded={expanded}
        disabled={Boolean(edit || busy)} onClick={() => setCollapsed(value => !value)}>
        <QueueIcon size={14} /><span>{items.length} 条排队消息</span>{expanded ? <CaretDown size={14} /> : <CaretUp size={14} />}
      </button>}
      <ul id={listId} className="composer-queue-list" hidden={items.length > 1 && !expanded}>
        {items.map(item => <li key={item.id} className="composer-queue-row" data-queue-id={item.id}>
          {items.length === 1 && <QueueIcon size={14} className="composer-queue-lead" />}
          {edit?.id === item.id ? <textarea autoFocus className="composer-queue-editor" aria-label="编辑排队消息内容" rows={1}
            value={edit.text} onChange={event => setEditing({ id: item.id, text: event.target.value })}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Escape") { event.preventDefault(); setEditing(null); }
              if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); save(); }
            }} /> : <>
            {item.files.length > 0 && <span className="composer-queue-files">{item.files.map(path => <span key={path}><File size={14} />{path.split(/[\\/]/).pop()}</span>)}</span>}
            <span className="composer-queue-preview">{item.text}</span>
          </>}
          <div className="composer-queue-actions">
            {edit?.id === item.id ? <>
              <button type="button" aria-label="保存排队消息" disabled={!edit.text.trim()} onClick={save}><Check size={14} /></button>
              <button type="button" aria-label="取消编辑排队消息" onClick={() => setEditing(null)}><X size={14} /></button>
            </> : <>
              <button type="button" aria-label="编辑排队消息" disabled={Boolean(busy)} onClick={() => setEditing({ id: item.id, text: item.text })}><QueueEditIcon size={14} /></button>
              <button type="button" aria-label="取消排队消息" disabled={Boolean(busy)} onClick={() => onRemove(item.id)}><QueueTrashIcon size={14} /></button>
              <button type="button" aria-label={running ? "插话发送排队消息" : "发送排队消息"} disabled={Boolean(busy)} onClick={async () => {
                setBusy(item.id);
                try { await onSend(item); } finally { setBusy(null); }
              }}><QueueSendIcon /></button>
            </>}
          </div>
        </li>)}
      </ul>
    </div>
  </div>;
}
