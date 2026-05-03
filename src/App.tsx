import { useState, useCallback } from "react";
import { Toaster } from "sonner";
import { Sidebar } from "@/components/sidebar";
import { ChatView } from "@/components/chat-view";
import { SettingsView } from "@/components/settings-view";
import { WindowResizeHandles, WindowTitlebar } from "@/components/window-titlebar";
import { useSettingsStore } from "@/stores/settings";

type View = "chat" | "settings";

const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 480;
const DEFAULT_SIDEBAR_WIDTH = 280;

export default function App() {
  const [view, setView] = useState<View>("chat");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const theme = useSettingsStore((s) => s.theme);

  // Sync theme on mount (one-time)
  useState(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    return null;
  });

  const toggleSidebar = useCallback(() => setSidebarOpen((v) => !v), []);

  return (
    <div className="app-window-frame flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <WindowResizeHandles />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <WindowTitlebar />
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {sidebarOpen && (
            <Sidebar
              currentView={view}
              onNavigate={setView}
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
            {view === "chat" && (
              <ChatView sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
            )}
            {view === "settings" && (
              <SettingsView
                sidebarOpen={sidebarOpen}
                onToggleSidebar={toggleSidebar}
                onBack={() => setView("chat")}
              />
            )}
          </main>
        </div>
      </div>
      <Toaster richColors position="top-right" theme="dark" />
    </div>
  );
}
