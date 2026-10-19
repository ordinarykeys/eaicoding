import { useState, useCallback, useEffect } from "react";
import { Toaster } from "sonner";
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

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;
const DEFAULT_SIDEBAR_WIDTH = 280;

export default function App() {
  const [settingsSection, setSettingsSection] = useState("account");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOverlayOpen, setAccountOverlayOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const theme = useSettingsStore((s) => s.theme);
  const { ready, view, refresh, refreshDetails } = useDeepSeekAccount();

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
    setSettingsOpen(false);
    void invoke("deepseek_account_present").catch(() => {});
  }, [ready, view.signedIn]);

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
        if (!event.repeat && useDeepSeekAccount.getState().view.signedIn) {
          if (!settingsOpen) setSettingsSection("account");
          setSettingsOpen(open => !open);
        }
      }
    };
    window.addEventListener("keydown", handleSettingsShortcut);
    return () => window.removeEventListener("keydown", handleSettingsShortcut);
  }, [settingsOpen]);

  if (!ready) return <div className="h-screen bg-background" aria-label="正在检查登录状态" />;
  if (!view.signedIn) return <DeepSeekLogin />;

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <div className="app-window-frame flex h-screen w-screen overflow-hidden bg-background text-foreground">
        <WindowResizeHandles />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <WindowTitlebar />
          <div className="relative min-h-0 flex-1 overflow-hidden">
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
              className="flex h-full min-w-0 flex-col transition-[padding] duration-200"
              style={{ paddingLeft: sidebarOpen ? sidebarWidth + 16 : 0 }}
            >
              <ChatView sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} settingsOpen={settingsOpen || accountOverlayOpen} />
            </main>
          </div>
        </div>
        <Toaster richColors position="top-right" theme={theme} />
        <SettingsView section={settingsSection} onSectionChange={setSettingsSection} />
      </div>
    </Dialog>
  );
}
