import { DeepSeekProfileCard } from "@/components/deepseek-profile-card";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  Books,
  CheckCircle,
  Code,
  FolderOpen,
  GearSix,
  Key,
  MagnifyingGlass,
  Moon,
  Sun,
  WarningCircle,
  X,
  User,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DEFAULT_PROVIDER_PROFILE,
  useSettingsStore,
} from "@/stores/settings";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useTranslation } from "react-i18next";
import {
  scanEasyLanguageEnv,
  type EasyLanguageEnvScan,
} from "@/services/easy-language-env";
const AgentCheckpointPanel = lazy(() => import("./agent-checkpoint-panel"));
const ModuleLibraryPanel = lazy(() => import("@/components/module-library-panel"));
const AccountCenter = lazy(() => import("@/components/account-center"));

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SettingsView({ section, onSectionChange }: { section: string; onSectionChange: (value: string) => void }) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="settings-overlay" />
      <DialogPrimitive.Content className="settings-dialog" aria-modal="true"
        onOpenAutoFocus={() => { returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
        onCloseAutoFocus={event => {
          if (returnFocus.current?.isConnected) { event.preventDefault(); returnFocus.current.focus(); }
        }}>
        <DialogPrimitive.Description className="sr-only">
          管理 DeepSeek 官方授权账号、模型、易语言环境、模块库和界面外观。
        </DialogPrimitive.Description>
        <SettingsPanel section={section} onSectionChange={onSectionChange} />
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function SettingsPanel({ section, onSectionChange }: { section: string; onSectionChange: (value: string) => void }) {
  const { t } = useTranslation();
  // Mount a section on its first visit; keep its draft and scroll until the modal closes.
  const [visited, setVisited] = useState(() => new Set([section]));
  const selectSection = (value: string) => {
    setVisited(previous => previous.has(value) ? previous : new Set([...previous, value]));
    onSectionChange(value);
  };
  const {
    profiles,
    activeProfileId,
    easyLanguageRoot,
    easyLanguageGenerateDir,
    easyLanguageCompileDir,
    addProfile,
    updateProfile,
    setEasyLanguageRoot,
    setEasyLanguageGenerateDir,
    setEasyLanguageCompileDir,
  } = useSettingsStore(useShallow(state => ({
    profiles: state.profiles, activeProfileId: state.activeProfileId,
    easyLanguageRoot: state.easyLanguageRoot,
    easyLanguageGenerateDir: state.easyLanguageGenerateDir, easyLanguageCompileDir: state.easyLanguageCompileDir,
    addProfile: state.addProfile, updateProfile: state.updateProfile,
    setEasyLanguageRoot: state.setEasyLanguageRoot, setEasyLanguageGenerateDir: state.setEasyLanguageGenerateDir,
    setEasyLanguageCompileDir: state.setEasyLanguageCompileDir,
  })));

  const activeProfile =
    profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? null;

  useEffect(() => {
    if (profiles.length === 0) {
      void addProfile({ ...DEFAULT_PROVIDER_PROFILE, apiKey: "" });
    }
  }, [addProfile, profiles.length]);

  return (
    <TooltipProvider>
      <Tabs value={section} onValueChange={selectSection} orientation="vertical" className="settings-layout">
        <nav className="settings-nav" aria-label="设置分类">
          <DialogPrimitive.Title className="settings-title">{t("settings.title")}</DialogPrimitive.Title>
          <TabsList className="settings-navigation" aria-label="设置分类">
            <TabsTrigger value="account"><User size={16} />个人中心</TabsTrigger>
            <TabsTrigger value="appearance"><GearSix size={16} />通用</TabsTrigger>
            <TabsTrigger value="providers"><Key size={16} />模型</TabsTrigger>
            <TabsTrigger value="environment"><Code size={16} />易语言环境</TabsTrigger>
            <TabsTrigger value="knowledge"><Books size={16} />模块库</TabsTrigger>
          </TabsList>
        </nav>
        <div className="settings-main">
          <header className="settings-header">
            <DialogPrimitive.Close className="settings-close" aria-label="关闭设置">
              <X size={16} />
            </DialogPrimitive.Close>
          </header>
          <div className="settings-options">
            {visited.has("account") && <TabsContent forceMount value="account" className="settings-pane">
              <Suspense fallback={<p role="status">正在打开个人中心…</p>}><AccountCenter /></Suspense>
            </TabsContent>}
            {visited.has("providers") && <TabsContent forceMount value="providers" className="settings-pane">
              {activeProfile ? (
                <DeepSeekProfileCard
                  key={activeProfile.id}
                  active={section === "providers"}
                  profile={activeProfile}
                  onUpdate={(patch) => updateProfile(activeProfile.id, patch)}
                />
              ) : (
                <Card className="settings-section-card border-0 shadow-none">
                  <CardContent className="py-8 text-center text-muted-foreground text-sm">
                    正在初始化模型配置...
                  </CardContent>
                </Card>
              )}
            </TabsContent>}
            {visited.has("environment") && <TabsContent forceMount value="environment" className="settings-pane">
              <EasyLanguageEnvironmentCard
                root={easyLanguageRoot}
                onRootChange={setEasyLanguageRoot}
                generateDir={easyLanguageGenerateDir}
                compileDir={easyLanguageCompileDir}
                onGenerateDirChange={setEasyLanguageGenerateDir}
                onCompileDirChange={setEasyLanguageCompileDir}
              />
            </TabsContent>}
            {visited.has("knowledge") && <TabsContent forceMount value="knowledge" className="settings-pane">
              <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">正在打开模块库…</p>}><ModuleLibraryPanel /></Suspense>
            </TabsContent>}
            {visited.has("appearance") && <TabsContent forceMount value="appearance" className="settings-pane">
              <AppearanceSettings />
              <CodingPreferences />
              <PetSettingsCard />
              <details className="settings-diagnostics"><summary>执行诊断</summary><Suspense fallback={null}><AgentCheckpointPanel /></Suspense></details>
            </TabsContent>}
          </div>
        </div>
      </Tabs>
    </TooltipProvider>
  );
}

function AppearanceSettings() {
  const theme = useSettingsStore(state => state.theme);
  const setTheme = useSettingsStore(state => state.setTheme);
  return (
    <section className="settings-general-group">
      <fieldset className="settings-theme-picker">
        <legend>外观</legend>
        {(["light", "dark"] as const).map(value => (
          <label key={value} className="settings-theme-option" data-selected={theme === value}>
            <input type="radio" name="theme" value={value} checked={theme === value} onChange={() => setTheme(value)} />
            {value === "light" ? <Sun size={22} aria-hidden="true" /> : <Moon size={22} aria-hidden="true" />}
            <span>{value === "light" ? "浅色" : "深色"}</span>
          </label>
        ))}
      </fieldset>
    </section>
  );
}

function CodingPreferences() {
  const behavior = useSettingsStore(s => s.busyEnterBehavior);
  const setBehavior = useSettingsStore(s => s.setBusyEnterBehavior);
  const codeWorkView = useSettingsStore(s => s.codeWorkView);
  const setCodeWorkView = useSettingsStore(s => s.setCodeWorkView);
  return <section className="settings-coding-preferences">
    <div className="settings-coding-row"><div><div>繁忙时的发送行为</div><p>智能体运行时 Enter 键和发送按钮的行为；Ctrl+Enter 使用另一行为</p></div>
      <Select value={behavior} onValueChange={value => setBehavior(value as "queue" | "steer")}><SelectTrigger className="settings-busy-selector" aria-label="繁忙时的发送行为"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="queue">排队发送</SelectItem><SelectItem value="steer">插话发送</SelectItem></SelectContent></Select>
    </div>
    <label className="settings-coding-row"><div><div>显示代码工作视图</div><p>开启后，显示轨迹、本轮代码差异</p></div><input type="checkbox" role="switch" aria-label="显示代码工作视图" className="settings-switch" checked={codeWorkView} onChange={event => setCodeWorkView(event.target.checked)} /></label>
  </section>;
}

// ---- Sub-components ----

// ---------------------------------------------------------------------------
// Easy Language environment card
// ---------------------------------------------------------------------------

function EasyLanguageEnvironmentCard({
  root,
  onRootChange,
  generateDir,
  compileDir,
  onGenerateDirChange,
  onCompileDirChange,
}: {
  root: string;
  onRootChange: (path: string) => void;
  generateDir: string;
  compileDir: string;
  onGenerateDirChange: (path: string) => void;
  onCompileDirChange: (path: string) => void;
}) {
  const [scan, setScan] = useState<EasyLanguageEnvScan | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const scanBusy = useRef(false);
  const scanRequest = useRef(0);

  useEffect(() => {
    // Opening settings must not start a recursive disk scan. Invalidate results
    // when the configured root changes or the modal closes.
    setScan(null);
    scanRequest.current += 1;
    return () => { scanRequest.current += 1; };
  }, [root]);

  const handleBrowse = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: "选择易语言安装目录",
    });
    if (typeof picked === "string") {
      onRootChange(picked);
    }
  };

  const handleBrowseOutputDir = async (
    title: string,
    onChange: (path: string) => void,
  ) => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title,
    });
    if (typeof picked === "string") {
      onChange(picked);
    }
  };

  const handleScan = async () => {
    if (scanBusy.current) return;
    scanBusy.current = true;
    const request = ++scanRequest.current;
    try {
      setIsScanning(true);
      setScan(null);
      const result = await scanEasyLanguageEnv(root);
      if (request !== scanRequest.current) return;
      setScan(result);
      if (result.exists) {
        toast.success(
          result.is_compile_ready
            ? "易语言环境可用"
            : "已扫描易语言环境，但编译链不完整",
        );
      } else {
        toast.error("未找到易语言安装目录");
      }
    } catch (err) {
      if (request === scanRequest.current) {
        toast.error(`扫描失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } finally {
      scanBusy.current = false;
      setIsScanning(false);
    }
  };

  const topLibraries = scan?.support_libraries.slice(0, 16) ?? [];
  const topModules = scan?.modules.slice(0, 10) ?? [];

  return (
    <Card className="settings-section-card border-0 shadow-none">
      <CardHeader>
        <CardTitle className="settings-section-title">本机易语言环境</CardTitle>
        <CardDescription>
          配置本机易语言安装位置、源码生成和编译输出目录。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="settings-installation-field flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor="easy-language-root" className="settings-input-label">安装目录</label>
            <Input
              id="easy-language-root"
              value={root}
              onChange={(event) => onRootChange(event.target.value)}
              className="mt-1 text-xs font-mono"
              placeholder="D:\e"
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" aria-label="选择易语言安装目录" className="h-9 w-9 shrink-0" onClick={handleBrowse}>
                <FolderOpen className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>选择目录</TooltipContent>
          </Tooltip>
          <Button
            type="button"
            variant="outline"
            className="h-9 gap-2 px-3 text-xs"
            onClick={handleScan}
            disabled={isScanning}
          >
            {isScanning ? (
              <GearSix className="h-4 w-4 animate-spin" />
            ) : (
              <MagnifyingGlass className="h-4 w-4" />
            )}
            {isScanning ? "扫描中…" : "扫描环境"}
          </Button>
        </div>

        <p role="status" className="settings-hint" aria-live="polite">
          {isScanning
            ? "正在后台检查工具链、支持库和例程，可以继续切换设置或关闭弹窗。"
            : !scan ? "点击“扫描环境”检查工具链与文件统计，打开本页不会自动扫描磁盘。" : scan.counts_complete === false ? "部分目录未完成统计，当前数量仅包含已扫描文件，请查看下方提示。" : "环境扫描完成。"}
        </p>

        <div className="settings-directory-grid">
          <DirectorySettingField
            label="源码生成目录"
            id="easy-language-generate-dir"
            value={generateDir}
            placeholder="默认：应用数据目录\\ecode 和 auto-runs"
            onChange={onGenerateDirChange}
            onBrowse={() =>
              handleBrowseOutputDir("选择易语言源码生成目录", onGenerateDirChange)
            }
            onClear={() => onGenerateDirChange("")}
          />
          <DirectorySettingField
            label="编译输出目录"
            id="easy-language-compile-dir"
            value={compileDir}
            placeholder="默认：.e 文件同目录"
            onChange={onCompileDirChange}
            onBrowse={() =>
              handleBrowseOutputDir("选择易语言编译输出目录", onCompileDirChange)
            }
            onClear={() => onCompileDirChange("")}
          />
        </div>

        {scan && (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <EnvMetric label="支持库" value={scan.counts.support_library_files} />
              <EnvMetric label="模块" value={scan.counts.module_files} />
              <EnvMetric label="例程" value={scan.counts.sample_e_files} />
              <EnvMetric label="帮助页" value={scan.counts.help_html_files} />
            </div>

            <div className="rounded-md bg-card p-3 text-xs">
              <div className="mb-2 flex items-center gap-2">
                {scan.is_compile_ready ? (
                  <CheckCircle className="h-4 w-4 text-green-600" weight="fill" />
                ) : (
                  <WarningCircle className="h-4 w-4 text-amber-600" weight="fill" />
                )}
                <span className="font-medium">
                  {scan.is_compile_ready ? "编译链状态正常" : "编译链需要检查"}
                </span>
              </div>
              <div className="grid gap-1 text-muted-foreground md:grid-cols-2">
                {scan.tools.map((tool) => (
                  <div key={tool.name} className="flex min-w-0 items-center gap-2">
                    <span
                      className={tool.exists ? "text-green-600" : "text-amber-600"}
                    >
                      {tool.exists ? "可用" : "缺失"}
                    </span>
                    <span className="min-w-0 truncate font-mono" title={tool.path}>
                      {tool.name}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {scan.warnings.length > 0 && (
              <div className="rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                {scan.warnings.join("；")}
              </div>
            )}

            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">
                  已安装支持库
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {topLibraries.map((library) => (
                    <span
                      key={library.name}
                      className="rounded-md bg-card px-2 py-1 text-[11px]"
                      title={library.fne_path}
                    >
                      {library.name}
                    </span>
                  ))}
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">
                  本机模块库
                </div>
                <div className="space-y-1">
                  {topModules.map((module) => (
                    <div
                      key={module.path}
                      className="flex min-w-0 items-center gap-2 rounded-md bg-card px-2 py-1 text-[11px]"
                      title={module.path}
                    >
                      <span className="min-w-0 flex-1 truncate">{module.name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {formatBytes(module.bytes)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DirectorySettingField({
  id,
  label,
  value,
  placeholder,
  onChange,
  onBrowse,
  onClear,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (path: string) => void;
  onBrowse: () => void;
  onClear: () => void;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="settings-input-label">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 text-xs font-mono"
          placeholder={placeholder}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              aria-label={`选择${label}`}
              variant="outline"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={onBrowse}
            >
              <FolderOpen className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>选择目录</TooltipContent>
        </Tooltip>
        {value && (
          <Button
            type="button"
            variant="ghost"
            className="h-9 shrink-0 px-2 text-xs"
            onClick={onClear}
          >
            默认
          </Button>
        )}
      </div>
    </div>
  );
}

function EnvMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-card px-3 py-2">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-base font-medium">{value}</div>
    </div>
  );
}

function PetSettingsCard() {
  const { t } = useTranslation();
  const enabled = useSettingsStore((s) => s.petEnabled);
  const sound = useSettingsStore((s) => s.petSoundEnabled);
  const setEnabled = useSettingsStore((s) => s.setPetEnabled);
  const setSound = useSettingsStore((s) => s.setPetSoundEnabled);
  const setPos = useSettingsStore((s) => s.setPetPosition);

  return (
    <section className="settings-general-group settings-pet-card">
      <div className="settings-general-heading">{t("settings.desktopPetTitle")}</div>
      <p className="settings-hint">{t("settings.desktopPetDescription")}</p>
      <div className="settings-preferences">
        <label className="settings-preference-row">
          <span>{t("settings.showPet")}</span>
          <input
            type="checkbox"
            role="switch"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="settings-switch"
          />
        </label>
        <label className="settings-preference-row">
          <span>{t("settings.enableSound")}</span>
          <input
            type="checkbox"
            role="switch"
            checked={sound}
            onChange={(event) => setSound(event.target.checked)}
            className="settings-switch"
          />
        </label>
        <div className="settings-preference-row"><span>桌面位置</span><Button
          size="sm"
          variant="outline"
          onClick={() => {
            setPos(null);
            toast.success(t("settings.petPositionReset"));
          }}
        >
          {t("settings.resetPetPosition")}
        </Button></div>
      </div>
    </section>
  );
}
