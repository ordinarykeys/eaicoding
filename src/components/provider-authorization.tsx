import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { X } from '@phosphor-icons/react';
import css from './ModelsSection.module.css';
import type { ProviderModel } from '@/stores/settings';

interface Prompt { type: 'text' | 'secret' | 'manual_code' | 'select'; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] }
interface Notice { type: string; message?: string; instructions?: string; url?: string; verificationUri?: string; userCode?: string; links?: { url: string; label?: string }[] }
interface Event { type: string; promptId?: string; prompt?: Prompt; notice?: Notice }

/** The same notice/select/secret/text interaction vocabulary as Harness login.ts. */
export function ProviderAuthorization({ profileId, name, method, onClose, onSuccess }: {
  profileId: string; name: string; method: string; onClose: () => void; onSuccess: (models: ProviderModel[]) => Promise<void>;
}) {
  const [prompt, setPrompt] = useState<{ id: string; value: Prompt } | null>(null);
  const [value, setValue] = useState(''), [notices, setNotices] = useState<Notice[]>([]), [error, setError] = useState(''), [submitting, setSubmitting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const request = useRef('');
  const success = useRef(onSuccess); success.current = onSuccess;
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    const requestId = crypto.randomUUID(); request.current = requestId;
    let active = true, completed = false, stop: (() => void) | undefined;
    void (async () => {
      stop = await listen<{ requestId: string; event: Event }>('model-runtime-event', ({ payload }) => {
        if (!active || payload.requestId !== requestId) return;
        const event = payload.event;
        if (event.type === 'notice' && event.notice) setNotices(rows => [...rows.slice(-19), event.notice!]);
        if (event.type === 'prompt' && event.prompt && event.promptId) { setPrompt({ id: event.promptId, value: event.prompt }); setValue(event.prompt.options?.[0]?.id ?? ''); setSubmitting(false); }
        if (event.type === 'prompt_cancel') setPrompt(current => current?.id === event.promptId ? null : current);
      });
      if (!active) { stop(); return; }
      const result = await invoke<{ configured: boolean; models: ProviderModel[] }>('model_runtime_run', { requestId, profileId, input: { operation: 'login', method } });
      completed = true;
      if (!active) return;
      setPrompt(null); setValue('');
      if (!result.configured) { setError('凭据已保存，但配置尚不完整。请补齐提供商要求的环境配置后重试。'); return; }
      await success.current(result.models ?? []);
      if (active) close.current();
    })().catch(e => { if (active) { setError(String(e)); setPrompt(null); setValue(''); } });
    return () => { active = false; stop?.(); if (!completed) void invoke('cancel_agent_task', { requestId }).catch(() => {}); };
  }, [profileId, method]);
  useEffect(() => { input.current?.focus(); }, [prompt]);
  const submit = async () => {
    if (!prompt || submitting) return;
    setSubmitting(true); setError('');
    const response = value; setValue('');
    try { await invoke('model_runtime_reply', { requestId: request.current, promptId: prompt.id, value: response }); setPrompt(current => current?.id === prompt.id ? null : current); }
    catch (e) { setSubmitting(false); setError(String(e)); }
  };
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}><Dialog.Portal>
    <Dialog.Overlay className="account-signout-overlay" />
    <Dialog.Content className={`provider-discovery-dialog ${css.authDialog}`} aria-describedby="provider-auth-description">
      <header><Dialog.Title>连接 {name}</Dialog.Title><Dialog.Close aria-label="关闭认证"><X size={16} /></Dialog.Close></header>
      <Dialog.Description id="provider-auth-description">按提供商的提示完成认证，凭据由桌面后台加密保存。</Dialog.Description>
      <div className={css.authNotices} role="log">{notices.map((notice, index) => {
        const links = [...(notice.links ?? []), ...(notice.url || notice.verificationUri ? [{ url: notice.url ?? notice.verificationUri!, label: '打开授权页面' }] : [])];
        return <div key={index}><p>{notice.message ?? notice.instructions ?? (notice.userCode ? '请在授权页面输入此验证码：' : '正在等待授权…')}</p>
          {notice.userCode && <div className={css.deviceCode}><code>{notice.userCode}</code><button className={css.secondaryButton} type="button" onClick={() => void navigator.clipboard.writeText(notice.userCode!).catch(e => setError(String(e)))}>复制</button></div>}
          {links.filter(link => /^https?:\/\//.test(link.url)).map((link, i) => <button key={i} className={css.secondaryButton} onClick={() => void openUrl(link.url).catch(e => setError(String(e)))}>{link.label ?? '打开页面'}</button>)}
        </div>;
      })}</div>
      {prompt && <form className={css.field} onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label className={css.fieldLabel} htmlFor="provider-auth-input">{prompt.value.message}</label>
        {prompt.value.type === 'select' ? <select id="provider-auth-input" className={css.input} value={value} onChange={e => setValue(e.target.value)} disabled={submitting}>{prompt.value.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select>
          : <input ref={input} id="provider-auth-input" className={css.input} type={prompt.value.type === 'secret' ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={prompt.value.placeholder} value={value} onChange={e => setValue(e.target.value)} disabled={submitting} />}
        <button type="submit" className={css.primaryButton} disabled={submitting}>{submitting ? '提交中…' : '继续'}</button>
      </form>}
      {!prompt && !error && <p role="status">正在等待提供商响应…</p>}
      {error && <p className={css.error} role="alert">{error}</p>}
      <footer><Dialog.Close className={css.secondaryButton}>关闭</Dialog.Close></footer>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
