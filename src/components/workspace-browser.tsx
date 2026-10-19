import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, ArrowLeft, ArrowRight, ArrowSquareOut, Globe } from "@phosphor-icons/react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { nanoid } from "nanoid";

export function WorkspaceBrowser({ visible }: { visible: boolean }) {
  const [id] = useState(() => `browser-${nanoid(12)}`);
  const [address, setAddress] = useState("");
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const live = useRef(true);
  const opened = useRef(false);
  const lastBounds = useRef("");
  const visibleRef = useRef(visible); visibleRef.current = visible;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const schedule = (action: () => Promise<unknown>) => { queue.current = queue.current.catch(() => {}).then(action); return queue.current; };
  const layout = () => {
    const bounds = host.current?.getBoundingClientRect();
    if (!bounds || !opened.current) return;
    const key = JSON.stringify([bounds.x, bounds.y, bounds.width, bounds.height, visibleRef.current]);
    if (key === lastBounds.current) return;
    lastBounds.current = key;
    void schedule(() => invoke("browser_layout", { id, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, visible: live.current && visibleRef.current && bounds.width > 0 && bounds.height > 0 })).catch(error => { if (live.current) setError(String(error)); });
  };
  useEffect(() => {
    live.current = true;
    const observer = new ResizeObserver(layout);
    if (host.current) observer.observe(host.current);
    const unlisten = listen<{ id: string; url: string }>("workspace-browser-location", ({ payload }) => {
      if (payload.id === id && live.current) { setAddress(payload.url); setUrl(payload.url); }
    });
    return () => {
      live.current = false; observer.disconnect(); void unlisten.then(stop => stop());
      void schedule(() => invoke("browser_close", { id })).catch(() => {});
    };
  }, [id]);
  useEffect(layout, [visible]);
  useEffect(() => {
    if (!visible) return;
    // A sidebar transition can move this surface without resizing it.
    // Follow its position too, and send IPC only when bounds change.
    let frame = 0;
    const follow = () => { layout(); frame = requestAnimationFrame(follow); };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [visible]);
  async function navigate(event: React.FormEvent) {
    event.preventDefault(); setError("");
    let next: URL;
    try {
      next = new URL(/^https?:\/\//i.test(address) ? address : `https://${address}`);
      if (!/^https?:$/.test(next.protocol) || !next.hostname || next.username || next.password) throw new Error();
    } catch { setError("请输入有效的 http/https 网页地址"); return; }
    const bounds = host.current?.getBoundingClientRect();
    if (!bounds) return;
    if (!isTauri()) { setError("请在桌面应用中使用内嵌浏览器，或在系统浏览器中打开。"); setUrl(next.href); return; }
    try {
      await schedule(() => invoke("browser_open", { id, url: next.href, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }));
      opened.current = true; lastBounds.current = ""; setUrl(next.href); setAddress(next.href); layout();
    } catch (error) { setError(`网页打开失败：${String(error)}`); }
  }
  async function action(action: string) {
    try { await invoke("browser_action", { id, action }); } catch (error) { setError(String(error)); }
  }
  return <section className="workspace-browser" hidden={!visible} aria-label="工作区浏览器">
    <form className="browser-toolbar" onSubmit={event => void navigate(event)}>
      <button type="button" className="document-icon" aria-label="后退" disabled={!url} onClick={() => void action("back")}><ArrowLeft size={15} /></button>
      <button type="button" className="document-icon" aria-label="前进" disabled={!url} onClick={() => void action("forward")}><ArrowRight size={15} /></button>
      <button type="button" className="document-icon" aria-label="刷新网页" disabled={!url} onClick={() => void action("reload")}><ArrowClockwise size={15} /></button>
      <input aria-label="网页地址" placeholder="输入网址，如 https://www.deepseek.com" value={address} onChange={event => setAddress(event.target.value)} />
      <button type="submit" className="browser-go">打开</button>
      <button type="button" className="document-icon" aria-label="在系统浏览器打开" title="在系统浏览器打开" disabled={!url} onClick={() => void openUrl(url).catch(error => setError(String(error)))}><ArrowSquareOut size={15} /></button>
    </form>
    {error && <div className="document-notice document-error" role="alert">{error}</div>}
    <div ref={host} className="browser-surface">{!url && <div className="workbench-placeholder"><Globe size={36} weight="light" /><p>浏览网页和项目文档</p><small>在上方输入网址，网页会在这里打开。</small></div>}</div>
  </section>;
}
