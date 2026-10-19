import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CircleNotch, Minus, X } from "@phosphor-icons/react";
import { useDeepSeekAccount } from "@/stores/deepseek-account";
import "@/styles/login.css";

export function DeepSeekLogin() {
  const { view, busy, start, cancel, logout } = useDeepSeekAccount();
  const [feedback, setFeedback] = useState("");
  const waiting = view.phase === "waiting-browser";
  const running = ["initializing", "waiting-browser", "exchanging"].includes(view.phase);
  const browser = async (copy: boolean) => {
    try { await invoke("deepseek_account_browser", { attemptId: view.attemptId, copy }); setFeedback(copy ? "登录链接已复制" : "已重新打开系统浏览器"); }
    catch (error) { setFeedback(String(error)); }
  };
  return <div className="login-window" data-testid="deepseek-login">
    <header className="login-titlebar" data-tauri-drag-region>
      <div className="login-window-controls">
        <button aria-label="最小化" onClick={() => void getCurrentWindow().minimize()}><Minus size={16} /></button>
        <button aria-label="隐藏到系统托盘" onClick={() => void getCurrentWindow().close()}><X size={16} /></button>
      </div>
    </header>
    <main className="login-welcome" aria-labelledby="login-heading">
      <div className="login-brand" aria-label="EAiCoding"><img src="/icon.ico" alt="" draggable={false} />EAiCoding</div>
      <section className="login-message" aria-live="polite">
        {running ? <>
          <h1 id="login-heading">{waiting ? "请在浏览器中完成登录" : view.phase === "exchanging" ? "正在完成授权…" : "正在准备登录…"}</h1>
          <p>{waiting ? "登录完成后，将自动返回应用" : "请稍候"}</p>
          {waiting && <button className="login-text-button" onClick={() => void browser(true)}>复制登录链接</button>}
        </> : view.phase === "failed" ? <><h1 id="login-heading">登录未完成</h1><p>请重新发起 DeepSeek 官方授权</p></> : <>
          <h1 id="login-heading">让 <em>EAiCoding</em> 为你编程</h1>
          <p>从想法到易语言应用</p>
        </>}
        {(view.error || feedback) && <p className="login-error" role="alert">{view.error || feedback}</p>}
      </section>
      <div className="login-actions">
        {running ? <>
          <button className="login-primary" disabled><CircleNotch size={18} className="animate-spin" /><span className="sr-only">等待授权完成</span></button>
          {waiting && <button className="login-secondary" onClick={() => void browser(false)}>重新打开浏览器</button>}
          <button className="login-back" disabled={busy || !view.attemptId} onClick={() => { setFeedback(""); void cancel(); }}>取消登录</button>
        </> : <>
          <button className="login-primary" disabled={busy} onClick={() => { setFeedback(""); void start(); }}>{view.phase === "failed" ? "重新登录 DeepSeek" : "登录 DeepSeek"}</button>
          <p className="login-caption">使用 DeepSeek 账号在官方浏览器页面授权</p>
          {view.error && <button className="login-back" disabled={busy} onClick={() => { setFeedback(""); void logout(); }}>清除登录状态后重试</button>}
        </>}
      </div>
    </main>
  </div>;
}
