// Full-window Platform surface adapted from Harness's PlatformOverlay (MIT).
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { CaretLeft, CircleNotch } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { usePlatformPage } from "@/stores/platform-page";
import { useDeepSeekAccount } from "@/stores/deepseek-account";
import { WindowTitlebar } from "@/components/window-titlebar";

let nativeOperations: Promise<unknown> = Promise.resolve();
const scheduleNative = (action: () => Promise<unknown>) => {
  const result = nativeOperations.catch(() => {}).then(action);
  nativeOperations = result;
  return result;
};

export function PlatformOverlay() {
  const returnFocus = useRef<HTMLElement | null>(null);
  const page = usePlatformPage(s => s.page);
  const close = usePlatformPage(s => s.close);
  const signedIn = useDeepSeekAccount(s => s.view.signedIn);
  useEffect(() => { if (!signedIn) close(); }, [signedIn, close]);
  return <Dialog.Root open={page !== null && signedIn} onOpenChange={open => { if (!open) close(); }}>
    <Dialog.Portal><Dialog.Content className="platform-overlay" aria-describedby={undefined}
      onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onCloseAutoFocus={event => {
        if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); }
      }}>
      <Dialog.Title className="sr-only">{page === "usage" ? "查询用量" : "充值"}</Dialog.Title>
      <WindowTitlebar />
      <header className="platform-header"><Dialog.Close className="platform-back"><CaretLeft size={16} />返回个人中心</Dialog.Close></header>
      {page && <PlatformViewport key={page} page={page} />}
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}

function PlatformViewport({ page }: { page: "usage" | "top-up" }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"loading" | "loaded" | "failed">("loading");
  useEffect(() => {
    const id = `account-platform-${crypto.randomUUID()}`;
    const element = viewport.current!;
    let disposed = false;
    let failed = false;
    let opened = false;
    let timer: ReturnType<typeof setTimeout>;
    const bounds = () => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) }; };
    const fail = () => { if (!disposed && !failed) { failed = true; clearTimeout(timer); setStatus("failed"); void scheduleNative(() => invoke("deepseek_platform_close", { id })).catch(() => {}); } };
    setStatus("loading");
    const unlisten = listen<{ id: string }>("deepseek-platform-loaded", event => { if (!disposed && !failed && event.payload.id === id) { clearTimeout(timer); setStatus("loaded"); } });
    void unlisten.then(async () => {
      if (disposed) return;
      timer = setTimeout(fail, 30_000);
      await scheduleNative(async () => {
        if (disposed || failed) return;
        await invoke("deepseek_platform_open", { id, page, bounds: bounds() });
        opened = true;
        if (disposed) await invoke("deepseek_platform_close", { id });
      });
    }).catch(fail);
    const observer = new ResizeObserver(() => { if (opened && !disposed && !failed) void invoke("deepseek_platform_layout", { id, bounds: bounds() }).catch(fail); });
    observer.observe(element);
    return () => {
      disposed = true; clearTimeout(timer); observer.disconnect(); void unlisten.then(stop => stop()).catch(() => {});
      void scheduleNative(() => invoke("deepseek_platform_close", { id })).catch(() => {});
      void useDeepSeekAccount.getState().refreshDetails();
    };
  }, [page, attempt]);
  return <div className="platform-viewport" ref={viewport}>
    {status !== "loaded" && <div className="platform-status" role="status">{status === "failed" ? <><span>操作未完成，请重试</span><button type="button" onClick={() => setAttempt(value => value + 1)}>重试</button></> : <><CircleNotch size={24} className="animate-spin" /><span className="sr-only">正在加载官方页面…</span></>}</div>}
  </div>;
}
