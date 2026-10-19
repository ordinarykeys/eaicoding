import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Native clipboard works even when WebView clipboard permissions are unavailable. */
export async function copyText(text: string): Promise<void> {
  if (isTauri()) {
    try { await writeText(text); return; } catch { /* Fall through to the browser API. */ }
  }
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return; } catch { /* Older WebViews. */ }
  }
  const active = document.activeElement as HTMLElement | null;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const input = document.createElement("textarea");
  input.value = text;
  input.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.append(input);
  try {
    input.select();
    if (!document.execCommand("copy")) throw new Error("系统剪贴板不可用");
  } finally {
    input.remove(); active?.focus({ preventScroll: true });
    selection?.removeAllRanges(); ranges.forEach(range => selection?.addRange(range));
  }
}
