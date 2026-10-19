import { useState, useCallback, useEffect } from "react";
import { Toaster } from "sonner";
import { createPortal } from "react-dom";
import { Sidebar } from "@/components/sidebar";
import { ChatView } from "@/components/chat-view";
import { SettingsView } from "@/components/settings-view";
import { WindowResizeHandles, WindowTitlebar } from "@/components/window-titlebar";
import { useSettingsStore } from "@/stores/settings";
import { Dialog } from "@/components/ui/dialog";
import { DeepSeekLogin } from "@/components/deepseek-login";
import { useDeepSeekAccount } from "@/stores/deepseek-account";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { PlatformOverlay } from "@/components/platform-overlay";
import { usePlatformPage } from "@/stores/platform-page";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;
const DEFAULT_SIDEBAR_WIDTH = 280;

export default function App() {
  const [settingsSection, setSettingsSection] = useState("account");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOverlayOpen, setAccountOverlayOpen] = useState(false);
  const [menuOverlayOpen, setMenuOverlayOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [configureModels, setConfigureModels] = useState(false);
  const hasApiProvider = useSettingsStore(s => s.profiles.some(p => p.authMode === "api-key"));
  const theme = useSettingsStore((s) => s.theme);
  const platformPage = usePlatformPage(s => s.page);
  const { ready, view, refresh, refreshDetails } = useDeepSeekAccount();

  useEffect(() => {
    if (!ready || view.signedIn || !hasApiProvider) return;
    const state=useSettingsStore.getState(),current=state.profiles.find(p=>p.id===state.activeProfileId);
    const fallback=state.profiles.find(p=>p.authMode==="api-key"&&p.models?.length);
    if(current?.authMode!=="api-key"&&fallback)void state.selectModel(fallback.id,fallback.model).catch(()=>{});
  },[ready,view.signedIn,hasApiProvider]);

  const workspaceMode = view.signedIn || hasApiProvider || configureModels;

  useEffect(() => { if (view.signedIn) void refreshDetails(); }, [view.signedIn, refreshDetails]);
  useEffect(() => { if (settingsOpen && view.signedIn) void refreshDetails(); }, [settingsOpen, view.signedIn, refreshDetails]);

  useEffect(() => {
    void refresh();
    const unlisten = listen("deepseek-account-changed", () => { void refresh(); });
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { void unlisten.then(stop => stop()); window.removeEventListener("focus", onFocus); };
  }, [refresh]);
  useEffect(() => {
    if (!["initializing", "waiting-browser", "exchanging"].includes(view.phase)) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(); if (!stopped) timer = setTimeout(() => void poll(), 750); };
    timer = setTimeout(() => void poll(), 250);
    return () => { stopped = true; clearTimeout(timer); };
  }, [view.phase, refresh]);
  useEffect(() => {
    if (!ready) return;
    void invoke("deepseek_account_present", { workspaceMode }).catch(() => {});
  }, [ready, workspaceMode]);

  // Sync theme on mount (one-time)
  useState(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    return null;
  });

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);
  useEffect(() => {
    const handleSettingsShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key === ",") {
        event.preventDefault();
        if (!event.repeat && workspaceMode) {
          if (!settingsOpen) setSettingsSection("account");
          setSettingsOpen(open => !open);
        }
      }
    };
    window.addEventListener("keydown", handleSettingsShortcut);
    return () => window.removeEventListener("keydown", handleSettingsShortcut);
  }, [settingsOpen, workspaceMode]);

  if (!ready) return <div className="h-screen bg-background" aria-label="正在检查登录状态" />;
  if (!workspaceMode) return <DeepSeekLogin onConfigureModels={() => { setConfigureModels(true); setSettingsSection("providers"); setSettingsOpen(true); }} />;

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <div className="app-window-frame flex h-screen w-screen overflow-hidden bg-background text-foreground">
        <WindowResizeHandles />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <WindowTitlebar sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} onMenuOverlayChange={setMenuOverlayOpen} />
          <div className="app-window-body relative min-h-0 flex-1 overflow-hidden">
            {sidebarOpen && (
              <Sidebar
                onOpenSettings={section => { setSettingsSection(section); setSettingsOpen(true); }}
                settingsOpen={settingsOpen}
                onAccountOverlayChange={setAccountOverlayOpen}
                onClose={toggleSidebar}
                width={sidebarWidth}
                onResize={setSidebarWidth}
                minWidth={MIN_SIDEBAR_WIDTH}
                maxWidth={MAX_SIDEBAR_WIDTH}
              />
            )}
            <main
              className="app-main-surface flex h-full min-w-0 flex-col"
              style={{ marginLeft: sidebarOpen ? sidebarWidth : 0 }}
            >
              <ChatView sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} settingsOpen={settingsOpen || accountOverlayOpen || menuOverlayOpen || platformPage !== null} />
            </main>
          </div>
        </div>
        {/* Escape #root's stacking context so settings cannot dim or blur notices. */}
        {createPortal(<Toaster richColors position="top-right" theme={theme} />, document.body)}
        <SettingsView section={settingsSection} onSectionChange={setSettingsSection} />
        <PlatformOverlay />
      </div>
    </Dialog>
  );
}
