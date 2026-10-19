import { Fragment, memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Check, CopySimple, DownloadSimple, SidebarSimple, TextAlignLeft, TextOutdent } from "@phosphor-icons/react";
import { DocumentPreviewContext } from "./document-preview-context";
import type { HighlighterCore, ThemedToken } from "shiki/core";
import { CodeHighlightCache } from "@/lib/code-highlight";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { EplRenderer } from "@/components/epl-renderer";
import { useSettingsStore } from "@/stores/settings";
import { copyText } from "@/lib/clipboard";

let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter() {
  // Import only the grammars we display, rather than bundling every language.
  return highlighterPromise ??= Promise.all([import("shiki/core"), import("shiki/engine/oniguruma")]).then(async ([{ createHighlighterCore }, { createOnigurumaEngine }]) => createHighlighterCore({
    themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
    langs: [import("shiki/langs/javascript.mjs"), import("shiki/langs/typescript.mjs"), import("shiki/langs/tsx.mjs"), import("shiki/langs/jsx.mjs"), import("shiki/langs/json.mjs"), import("shiki/langs/python.mjs"), import("shiki/langs/rust.mjs"), import("shiki/langs/bash.mjs"), import("shiki/langs/powershell.mjs"), import("shiki/langs/html.mjs"), import("shiki/langs/css.mjs"), import("shiki/langs/markdown.mjs"), import("shiki/langs/yaml.mjs"), import("shiki/langs/sql.mjs"), import("shiki/langs/xml.mjs"), import("shiki/langs/ini.mjs")],
    engine: createOnigurumaEngine(import("shiki/wasm")),
  }));
}

export function isEplLanguage(language: string) {
  return /^(epl|e|ec|易语言|yiyy|easy)$/i.test(language);
}

const EplLine = memo(function EplLine({ text }: { text: string }) {
  const tokens = text.split(/(“[^”]*”|"[^"\n]*"|'[^\n]*|\.[\u4e00-\u9fff]+|\b\d+(?:\.\d+)?\b|如果真结束|如果结束|如果真|如果|否则|返回|判断开始|判断结束|计次循环首|计次循环尾|真|假)/g);
  let comment = false;
  return <>{tokens.map((token, i) => {
    if (token.startsWith("'")) comment = true;
    const kind = comment ? "comment" : /^[“"]/.test(token) ? "string" : /^\./.test(token) ? "directive" : /^\d/.test(token) ? "number" : /^(如果|否则|返回|判断|计次|真$|假$)/.test(token) ? "keyword" : "text";
    return <span key={i} className={`source-${kind}`}>{token}</span>;
  })}</>;
});

const SourceLine = memo(function SourceLine({ text, epl, tokens }: { text: string; epl: boolean; tokens?: ThemedToken[] }) {
  return <span className="line">{epl ? <EplLine text={text} /> : tokens?.length
    ? tokens.map((token, index) => <span key={index} style={{ color: token.color }}>{token.content}</span>)
    : text || " "}</span>;
});

export const CodeBlock = memo(function CodeBlock({ language, code, embedded = false, startLine = 1 }: { language: string; code: string; embedded?: boolean; startLine?: number }) {
  const openPreview = useContext(DocumentPreviewContext);
  const theme = useSettingsStore(s => s.theme);
  const [highlighter, setHighlighter] = useState<HighlighterCore | null>(null);
  const highlightCache = useRef(new CodeHighlightCache());
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(true);
  const [ide, setIde] = useState(false);
  const [visible, setVisible] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const lang = language.toLowerCase();
  const epl = isEplLanguage(lang) || (!lang && /^\s*\.版本\s/m.test(code));
  const lines = code.replace(/\n$/, "").split("\n");
  const highlighted = useMemo(() => {
    if (!highlighter || epl) return undefined;
    try { return highlightCache.current.update(highlighter, code.replace(/\n$/, ""), lang, theme === "dark" ? "github-dark" : "github-light"); }
    catch { return undefined; }
  }, [highlighter, code, lang, theme, epl]);

  useEffect(() => {
    if (!root.current || typeof IntersectionObserver === "undefined") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect(); }
    }, { rootMargin: "200px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => clearTimeout(copyTimer.current), []);
  useEffect(() => {
    if (epl || !visible) return;
    let active = true;
    void getHighlighter().then(value => { if (active) setHighlighter(value); }).catch(() => {});
    return () => { active = false; };
  }, [epl, visible]);

  const copy = async () => {
    try { await copyText(code); setCopied(true); clearTimeout(copyTimer.current); copyTimer.current = setTimeout(() => setCopied(false), 1500); }
    catch { toast.error("复制失败，请重试"); }
  };
  const download = async () => {
    try {
      const ext = epl ? "epl" : ({ javascript: "js", typescript: "ts", python: "py", rust: "rs" }[lang] ?? (/^[a-z0-9]+$/.test(lang) ? lang : "txt"));
      const path = await save({ defaultPath: `代码.${ext}`, filters: [{ name: "源代码", extensions: [ext] }] });
      if (path) { await invoke("write_text_file", { filePath: path, content: code, encoding: epl ? "gbk" : "utf-8" }); toast.success("代码已保存"); }
    } catch (error) { toast.error(`保存失败：${String(error)}`); }
  };
  return <div ref={root} className="source-card" data-code-wrap={wrapped} data-embedded={embedded} style={{ "--source-gutter": `${Math.max(2, String(startLine + lines.length - 1).length)}ch`, "--source-line-start": startLine - 1 } as React.CSSProperties}>
    <div className="source-toolbar">
      <span className="source-language">{epl ? "易语言" : language || "代码"}</span>
      <span className="source-line-count">{lines.length} 行</span>
      <div className="source-actions">
        {!embedded && openPreview && <button type="button" aria-label="在右侧预览" title="在右侧预览" onClick={() => openPreview({ id: `snippet:${lang}:${code}`, title: epl ? "易语言代码.epl" : `代码.${lang || "txt"}`, code, language: epl ? "epl" : lang })}><SidebarSimple size={15} /></button>}
        {epl && <button type="button" className="source-view-toggle" onClick={() => setIde(v => !v)} aria-pressed={ide}>{ide ? "源码视图" : "易语言视图"}</button>}
        {!ide && <button type="button" aria-label="自动换行" title={wrapped ? "关闭自动换行" : "自动换行"} aria-pressed={wrapped} onClick={() => setWrapped(v => !v)}>{wrapped ? <TextOutdent size={15} /> : <TextAlignLeft size={15} />}</button>}
        <button type="button" aria-label="保存代码" title="保存代码" onClick={() => void download()}><DownloadSimple size={15} /></button>
        <button type="button" aria-label={copied ? "已复制" : "复制代码"} title={copied ? "已复制" : "复制代码"} onClick={() => void copy()}>{copied ? <Check size={15} /> : <CopySimple size={15} />}</button>
      </div>
    </div>
    {ide && epl ? <div className="source-ide"><EplRenderer code={code} theme={theme === "dark" ? 2 : 1} /></div>
      : <div className="source-body"><pre><code>{lines.map((line, index) => <Fragment key={index}>{index > 0 && "\n"}<SourceLine text={line} epl={epl} tokens={highlighted?.[index]} /></Fragment>)}</code></pre></div>}
  </div>;
});
