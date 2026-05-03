import { useEffect, useRef, useState } from "react";
import { createHighlighter, type Highlighter } from "shiki";
import { EplRenderer } from "@/components/epl-renderer";

let highlighterPromise: Promise<Highlighter> | null = null;

async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark", "github-light"],
      langs: [
        "javascript",
        "typescript",
        "tsx",
        "jsx",
        "json",
        "python",
        "rust",
        "bash",
        "shell",
        "powershell",
        "html",
        "css",
        "markdown",
        "yaml",
        "sql",
        "xml",
        "ini",
      ],
    });
  }
  return highlighterPromise;
}

function escapeHtml(code: string): string {
  return code
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isEplLang(lang: string): boolean {
  const normalized = lang.toLowerCase();
  return (
    normalized === "epl" ||
    normalized === "e" ||
    normalized === "ec" ||
    normalized === "易语言" ||
    normalized === "yiyy" ||
    normalized === "easy"
  );
}

export function CodeBlock({ language, code }: { language: string; code: string }) {
  const [html, setHtml] = useState<string>("");
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const langLower = (language || "").toLowerCase();
  const epl = isEplLang(langLower);

  useEffect(() => {
    if (epl) {
      // EPL is rendered via EplRenderer (table-style) — no shiki path needed.
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const highlighter = await getHighlighter();
        const supported = highlighter.getLoadedLanguages().includes(langLower as any);
        const out = highlighter.codeToHtml(code, {
          lang: supported ? (langLower as any) : "text",
          theme: "github-dark",
        });
        if (!cancelled) setHtml(out);
      } catch {
        if (!cancelled) {
          setHtml(`<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [language, code, epl, langLower]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  if (epl) {
    return (
      <div className="epl-renderer-shell" ref={ref}>
        <div className="epl-renderer-header">
          <span className="epl-renderer-tag">易语言 · IDE 视图</span>
          <span className="epl-renderer-spacer" />
          <button onClick={handleCopy}>{copied ? "已复制" : "复制"}</button>
        </div>
        <EplRenderer code={code} theme={1} />
      </div>
    );
  }

  return (
    <div className="relative group my-3" ref={ref}>
      <div className="flex items-center justify-between bg-secondary/60 px-3 py-1 rounded-t-md text-xs text-muted-foreground border-b border-border">
        <span>{language || "text"}</span>
        <button
          onClick={handleCopy}
          className="px-2 py-0.5 rounded hover:bg-accent text-xs"
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      <div
        className="rounded-b-md overflow-hidden text-sm [&>pre]:!my-0 [&>pre]:!rounded-t-none"
        dangerouslySetInnerHTML={{
          __html: html || `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`,
        }}
      />
    </div>
  );
}
