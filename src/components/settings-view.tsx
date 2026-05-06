import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Books,
  CheckCircle,
  Database,
  DownloadSimple,
  Eye,
  EyeSlash,
  FileText,
  FolderOpen,
  GearSix,
  MagnifyingGlass,
  Moon,
  Sparkle,
  SidebarSimple,
  Sun,
  Trash,
  UploadSimple,
  WarningCircle,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DEFAULT_PROVIDER_PROFILE,
  useSettingsStore,
  type ProviderModel,
  type ProviderProfile,
} from "@/stores/settings";
import type { LLMProvider } from "@/types/llm";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useTranslation } from "react-i18next";
import {
  scanEasyLanguageEnv,
  type EasyLanguageEnvScan,
} from "@/services/easy-language-env";
import { JINGYI_ITEMS } from "@/services/agent/knowledge/jingyi-data";
import {
  KNOWLEDGE_TEMPLATE,
  estimateTokens,
  ingestKnowledgeDocument,
  type KnowledgeIngestionReport,
  type UserKnowledgeDocument,
} from "@/services/knowledge/user-knowledge";

interface SettingsViewProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onBack: () => void;
}

type FetchModelsResponse = {
  provider: string;
  url: string;
  models: ProviderModel[];
};

const PROVIDER_OPTIONS: { value: LLMProvider; label: string }[] = [
  { value: "openai", label: "OpenAI 兼容" },
  { value: "anthropic", label: "Claude / Anthropic" },
  { value: "gemini", label: "Gemini" },
];

const PROVIDER_DEFAULTS: Record<
  LLMProvider,
  Pick<ProviderProfile, "protocol" | "baseUrl" | "model">
> = {
  openai: {
    protocol: "openai-chat-completions",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
  },
  anthropic: {
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514",
  },
  provider: {
    protocol: "anthropic-messages",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514",
  },
  gemini: {
    protocol: "gemini-generate-content",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-pro",
  },
};

export function SettingsView({ sidebarOpen, onToggleSidebar, onBack }: SettingsViewProps) {
  const { t } = useTranslation();
  const {
    profiles,
    modelCatalogs,
    activeProfileId,
    theme,
    easyLanguageRoot,
    easyLanguageGenerateDir,
    easyLanguageCompileDir,
    userKnowledgeDocuments,
    addProfile,
    updateProfile,
    setProfileModels,
    setTheme,
    setEasyLanguageRoot,
    setEasyLanguageGenerateDir,
    setEasyLanguageCompileDir,
    addUserKnowledgeDocument,
    updateUserKnowledgeDocument,
    removeUserKnowledgeDocument,
  } = useSettingsStore();

  const activeProfile =
    profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0] ?? null;

  useEffect(() => {
    if (profiles.length === 0) {
      void addProfile({ ...DEFAULT_PROVIDER_PROFILE, apiKey: "" });
    }
  }, [addProfile, profiles.length]);

  return (
    <TooltipProvider>
      <div className="flex flex-col h-full">
        {/* Header */}
        <header className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
          {!sidebarOpen && (
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onToggleSidebar}>
              <SidebarSimple className="h-4 w-4" />
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onBack}>
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-sm font-display font-semibold">{t("settings.title")}</h2>
          <div className="flex-1" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
              >
                {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              {theme === "dark" ? t("settings.switchLight") : t("settings.switchDark")}
            </TooltipContent>
          </Tooltip>
        </header>

        <ScrollArea className="flex-1">
          <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
            <Tabs defaultValue="providers">
              <TabsList className="w-full">
                <TabsTrigger value="providers" className="flex-1">
                  {t("settings.providersTab")}
                </TabsTrigger>
                <TabsTrigger value="environment" className="flex-1">
                  易语言环境
                </TabsTrigger>
                <TabsTrigger value="knowledge" className="flex-1">
                  知识库
                </TabsTrigger>
              </TabsList>

              {/* ---- Providers ---- */}
              <TabsContent value="providers" className="space-y-4 mt-4">
                <div>
                  <h3 className="text-sm font-medium">{t("settings.apiProfiles")}</h3>
                </div>

                {activeProfile ? (
                  <ProfileCard
                    profile={activeProfile}
                    catalogModels={
                      modelCatalogs[activeProfile.id]?.length
                        ? modelCatalogs[activeProfile.id]
                        : (activeProfile.models ?? [])
                    }
                    onUpdate={(patch) => updateProfile(activeProfile.id, patch)}
                    onModelsFetched={(models) => setProfileModels(activeProfile.id, models)}
                  />
                ) : (
                  <Card className="border-0 shadow-none">
                    <CardContent className="py-8 text-center text-muted-foreground text-sm">
                      正在初始化模型配置...
                    </CardContent>
                  </Card>
                )}
              </TabsContent>
              <TabsContent value="environment" className="mt-4 space-y-4">
                <EasyLanguageEnvironmentCard
                  root={easyLanguageRoot}
                  onRootChange={setEasyLanguageRoot}
                  generateDir={easyLanguageGenerateDir}
                  compileDir={easyLanguageCompileDir}
                  onGenerateDirChange={setEasyLanguageGenerateDir}
                  onCompileDirChange={setEasyLanguageCompileDir}
                />
                <PetSettingsCard />
              </TabsContent>

              <TabsContent value="knowledge" className="mt-4 space-y-4">
                <KnowledgeBaseSettingsCard
                  documents={userKnowledgeDocuments}
                  onAdd={addUserKnowledgeDocument}
                  onUpdate={updateUserKnowledgeDocument}
                  onRemove={removeUserKnowledgeDocument}
                />
              </TabsContent>

            </Tabs>
          </div>
        </ScrollArea>
      </div>
    </TooltipProvider>
  );
}

// ---- Sub-components ----

function ProfileCard({
  profile,
  catalogModels,
  onUpdate,
  onModelsFetched,
}: {
  profile: ProviderProfile;
  catalogModels: ProviderModel[];
  onUpdate: (patch: Partial<Omit<ProviderProfile, "id" | "apiKeyEncrypted">> & { apiKey?: string }) => void;
  onModelsFetched: (models: ProviderModel[]) => void;
}) {
  const { t } = useTranslation();
  const [showKey, setShowKey] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [models, setModels] = useState<ProviderModel[]>(catalogModels);
  const [fetchingModels, setFetchingModels] = useState(false);
  const providerInfo = PROVIDER_OPTIONS.find((o) => o.value === profile.provider);

  useEffect(() => {
    setModels(catalogModels);
  }, [catalogModels]);

  const handleProviderChange = (value: string) => {
    const nextProvider = value as LLMProvider;
    const defaults = PROVIDER_DEFAULTS[nextProvider];
    setModels([]);
    onModelsFetched([]);
    onUpdate({
      provider: nextProvider,
      protocol: defaults.protocol,
      baseUrl: defaults.baseUrl,
      model: defaults.model,
      models: [],
    });
  };

  useEffect(() => {
    let cancelled = false;
    if (!profile.apiKeyEncrypted) {
      setNewKey("");
      return;
    }
    invoke<string>("decrypt_secret", { encrypted: profile.apiKeyEncrypted })
      .then((key) => {
        if (!cancelled) setNewKey(key);
      })
      .catch(() => {
        if (!cancelled) setNewKey("");
      });
    return () => {
      cancelled = true;
    };
  }, [profile.apiKeyEncrypted]);

  const handleFetchModels = async () => {
    try {
      setFetchingModels(true);
      let key = newKey.trim();
      if (!key && profile.apiKeyEncrypted) {
        key = await invoke<string>("decrypt_secret", { encrypted: profile.apiKeyEncrypted });
      }
      if (!key) {
        toast.error(t("settings.apiKeyRequiredForFetch"));
        return;
      }
      const result = await invoke<FetchModelsResponse>("fetch_llm_models", {
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        apiKey: key,
      });
      setModels(result.models);
      onModelsFetched(result.models);
      toast.success(t("settings.modelsFetched", { count: result.models.length }));
    } catch (err) {
      toast.error(t("settings.modelsFetchFailed", { message: err instanceof Error ? err.message : String(err) }));
    } finally {
      setFetchingModels(false);
    }
  };

  return (
    <Card className="border-0 shadow-none">
      <CardHeader className="pb-2 flex flex-row items-center justify-between space-y-0">
        <div>
          <CardTitle className="text-base">模型配置</CardTitle>
          <CardDescription className="text-xs">
            {providerInfo?.label || profile.provider} · {profile.model}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-3">
          <div>
            <label className="text-xs text-muted-foreground">{t("settings.providerLabel")}</label>
            <Select value={profile.provider} onValueChange={handleProviderChange}>
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={t("settings.chooseProvider")} />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Base URL</label>
            <Input
              value={profile.baseUrl}
              onChange={(e) => onUpdate({ baseUrl: e.target.value })}
              className="mt-1 text-xs"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">{t("settings.modelLabel")}</label>
            <ModelInputWithFetch
              value={profile.model}
              models={models}
              isLoading={fetchingModels}
              onChange={(model) => onUpdate({ model })}
              onFetch={handleFetchModels}
            />
          </div>
        </div>

        {/* API Key */}
        <div>
          <label className="text-xs text-muted-foreground">API Key（加密存储）</label>
          <div className="mt-1 flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                type={showKey ? "text" : "password"}
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                placeholder={profile.apiKeyEncrypted ? "••••••••（已保存）" : "输入 API Key"}
                className="pr-10 text-xs font-mono"
              />
              <button
                type="button"
                className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                onClick={() => setShowKey(!showKey)}
                aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
              >
                {showKey ? <EyeSlash className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
            <Button
              variant="secondary"
              className="h-9 shrink-0 px-3 text-xs"
              disabled={!newKey}
              onClick={() => {
                onUpdate({ apiKey: newKey });
                toast.success(t("settings.apiKeySaved"));
              }}
            >
              {t("settings.save")}
            </Button>
          </div>
        </div>

        {/* Temperature & Max Tokens */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Temperature</label>
            <Input
              type="number"
              min={0}
              max={2}
              step={0.1}
              value={profile.temperature}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (!isNaN(v) && v >= 0 && v <= 2) onUpdate({ temperature: v });
              }}
              className="mt-1 text-xs"
            />
            <p className="mt-0.5 text-[11px] text-muted-foreground">0 = 精确，2 = 创意</p>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Max Tokens</label>
            <Input
              type="number"
              min={1}
              max={1000000}
              step={1}
              value={profile.maxTokens}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!isNaN(v) && v >= 1) onUpdate({ maxTokens: v });
              }}
              className="mt-1 text-xs"
            />
            <p className="mt-0.5 text-[11px] text-muted-foreground">最大输出 token 数</p>
          </div>
        </div>

      </CardContent>
    </Card>
  );
}

function ModelInputWithFetch({
  value,
  models,
  isLoading,
  onChange,
  onFetch,
}: {
  value: string;
  models: ProviderModel[];
  isLoading: boolean;
  onChange: (value: string) => void;
  onFetch: () => void;
}) {
  const { t } = useTranslation();
  const visibleModels = models.slice(0, 60);
  const selectedModel = models.find((model) => model.id === value);
  const selectValue = selectedModel ? value : value ? "__custom__" : undefined;

  return (
    <div className="mt-1 space-y-2">
      <div className="flex items-center gap-2">
        {visibleModels.length > 0 ? (
          <Select
            value={selectValue}
            onValueChange={(nextValue) => {
              if (nextValue !== "__custom__") onChange(nextValue);
            }}
          >
            <SelectTrigger className="h-9 min-w-0 flex-1 text-xs font-mono">
              <SelectValue placeholder={t("settings.chooseModel")} />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              {!selectedModel && value && (
                <SelectItem value="__custom__" className="text-xs">
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-mono">{value}</span>
                    <span className="shrink-0 text-muted-foreground">custom</span>
                  </span>
                </SelectItem>
              )}
              {visibleModels.map((model) => (
                <SelectItem key={model.id} value={model.id} className="text-xs">
                  <span className="flex w-full items-center justify-between gap-3">
                    <span className="min-w-0 truncate font-mono">{model.id}</span>
                    {model.ownedBy && (
                      <span className="shrink-0 text-muted-foreground">{model.ownedBy}</span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="text-xs font-mono"
            placeholder={t("settings.fetchModelsFirst")}
          />
        )}
        <Button
          type="button"
          variant="outline"
          className="h-9 shrink-0 px-3 text-xs"
          onClick={onFetch}
          disabled={isLoading}
        >
          {isLoading ? "..." : t("settings.fetch")}
        </Button>
      </div>
      <p className="text-[11px] text-muted-foreground">
        {t("settings.modelHelp")}
      </p>
    </div>
  );
}

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

  useEffect(() => {
    let cancelled = false;
    scanEasyLanguageEnv(root)
      .then((result) => {
        if (!cancelled) setScan(result);
      })
      .catch(() => {
        if (!cancelled) setScan(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    try {
      setIsScanning(true);
      const result = await scanEasyLanguageEnv(root);
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
      toast.error(`扫描失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setIsScanning(false);
    }
  };

  const topLibraries = scan?.support_libraries.slice(0, 16) ?? [];
  const topModules = scan?.modules.slice(0, 10) ?? [];

  return (
    <Card className="border-0 shadow-none">
      <CardHeader>
        <CardTitle>本机易语言环境</CardTitle>
        <CardDescription>
          只检测安装目录、支持库、模块和编译链，不建立新的帮助文档知识库。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <label className="text-xs text-muted-foreground">安装目录</label>
            <Input
              value={root}
              onChange={(event) => onRootChange(event.target.value)}
              className="mt-1 text-xs font-mono"
              placeholder="D:\e"
            />
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="icon" className="h-9 w-9" onClick={handleBrowse}>
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
            扫描
          </Button>
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <DirectorySettingField
            label="源码生成目录"
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
  label,
  value,
  placeholder,
  onChange,
  onBrowse,
  onClear,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (path: string) => void;
  onBrowse: () => void;
  onClear: () => void;
}) {
  return (
    <div className="min-w-0">
      <label className="text-xs text-muted-foreground">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 text-xs font-mono"
          placeholder={placeholder}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Knowledge base settings
// ---------------------------------------------------------------------------

function KnowledgeBaseSettingsCard({
  documents,
  onAdd,
  onUpdate,
  onRemove,
}: {
  documents: UserKnowledgeDocument[];
  onAdd: (document: UserKnowledgeDocument) => void;
  onUpdate: (id: string, patch: Partial<UserKnowledgeDocument>) => void;
  onRemove: (id: string) => void;
}) {
  const [lastReport, setLastReport] = useState<KnowledgeIngestionReport | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const builtinStats = getBuiltinKnowledgeStats();
  const userChunkCount = documents.reduce((total, document) => total + document.chunks.length, 0);

  const importKnowledge = async () => {
    const picked = await openDialog({
      multiple: true,
      directory: false,
      title: "选择知识库文档",
      filters: [
        {
          name: "知识库文档",
          extensions: ["md", "txt", "json", "csv", "epl", "e"],
        },
      ],
    });
    const paths = Array.isArray(picked)
      ? picked.filter((item): item is string => typeof item === "string")
      : typeof picked === "string"
        ? [picked]
        : [];
    if (paths.length === 0) return;

    try {
      setIsImporting(true);
      let imported = 0;
      let latestReport: KnowledgeIngestionReport | null = null;
      for (const path of paths) {
        const rawText = await readTextFile(path);
        const name = path.split(/[\\/]/).pop() || "未命名知识库";
        const { document, report } = ingestKnowledgeDocument({
          name,
          sourcePath: path,
          rawText,
        });
        onAdd(document);
        latestReport = report;
        imported += 1;
      }
      setLastReport(latestReport);
      toast.success(`已导入 ${imported} 个知识库文档`);
    } catch (error) {
      toast.error(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsImporting(false);
    }
  };

  const exportTemplate = async () => {
    const target = await saveDialog({
      title: "保存知识库模板",
      defaultPath: "eaicoding-knowledge-template.md",
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (!target) return;
    await writeTextFile(target, KNOWLEDGE_TEMPLATE);
    toast.success("知识库模板已生成");
  };

  const reprocessDocument = (document: UserKnowledgeDocument) => {
    const result = ingestKnowledgeDocument({
      name: document.name,
      sourcePath: document.sourcePath,
      rawText: document.rawText,
      metadata: document.metadata,
    });
    onUpdate(document.id, {
      cleanText: result.document.cleanText,
      chunks: result.document.chunks,
      status: result.document.status,
      format: result.document.format,
    });
    setLastReport(result.report);
    toast.success("已重新清洗并分块");
  };

  return (
    <Card className="border-0 shadow-none">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Books className="h-4 w-4" />
            知识库
          </CardTitle>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={exportTemplate}>
              <DownloadSimple className="h-4 w-4" />
              模板
            </Button>
            <Button size="sm" onClick={importKnowledge} disabled={isImporting}>
              <UploadSimple className="h-4 w-4" />
              上传
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 md:grid-cols-3">
          <KnowledgeSummaryItem
            icon={<Database className="h-4 w-4" />}
            label="精易模块"
            value={`${builtinStats.items} 条`}
          />
          <KnowledgeSummaryItem
            icon={<FileText className="h-4 w-4" />}
            label="用户文档"
            value={`${documents.length} 个`}
          />
          <KnowledgeSummaryItem
            icon={<Sparkle className="h-4 w-4" />}
            label="分块"
            value={`${userChunkCount} 个`}
          />
        </div>

        {lastReport && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-card px-3 py-2 text-xs text-muted-foreground">
            <span>清洗 {lastReport.cleanChars} 字</span>
            <span>{lastReport.chunkCount} 分块</span>
            <span>约 {lastReport.estimatedTokens} tokens</span>
          </div>
        )}

        <div className="space-y-2">
          {documents.length === 0 ? (
            <div className="rounded-md bg-card px-3 py-8 text-center text-sm text-muted-foreground">
              暂无用户知识库
            </div>
          ) : (
            documents.map((document) => (
              <KnowledgeDocumentRow
                key={document.id}
                document={document}
                onReprocess={() => reprocessDocument(document)}
                onRemove={() => onRemove(document.id)}
              />
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function KnowledgeDocumentRow({
  document,
  onReprocess,
  onRemove,
}: {
  document: UserKnowledgeDocument;
  onReprocess: () => void;
  onRemove: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-card px-3 py-2">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium" title={document.name}>
          {document.name}
        </div>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span>{document.format}</span>
          <span>{document.status}</span>
          <span>{document.chunks.length} 分块</span>
          <span>约 {estimateTokens(document.cleanText)} tokens</span>
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onReprocess}>
        <Sparkle className="h-4 w-4" />
        清洗
      </Button>
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onRemove}>
        <Trash className="h-4 w-4" />
      </Button>
    </div>
  );
}

function KnowledgeSummaryItem({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-card px-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="ml-auto text-sm font-medium">{value}</span>
    </div>
  );
}

function getBuiltinKnowledgeStats(): { items: number; categories: number } {
  return {
    items: JINGYI_ITEMS.length,
    categories: new Set(JINGYI_ITEMS.map((item) => item.category)).size,
  };
}
// ---------------------------------------------------------------------------
// Desktop pet settings card
// ---------------------------------------------------------------------------

function PetSettingsCard() {
  const { t } = useTranslation();
  const enabled = useSettingsStore((s) => s.petEnabled);
  const sound = useSettingsStore((s) => s.petSoundEnabled);
  const setEnabled = useSettingsStore((s) => s.setPetEnabled);
  const setSound = useSettingsStore((s) => s.setPetSoundEnabled);
  const setPos = useSettingsStore((s) => s.setPetPosition);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settings.desktopPetTitle")}</CardTitle>
        <CardDescription>
          {t("settings.desktopPetDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center justify-between text-sm">
          <span>{t("settings.showPet")}</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            className="h-4 w-4"
          />
        </label>
        <label className="flex items-center justify-between text-sm">
          <span>{t("settings.enableSound")}</span>
          <input
            type="checkbox"
            checked={sound}
            onChange={(event) => setSound(event.target.checked)}
            className="h-4 w-4"
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setPos(null);
            toast.success(t("settings.petPositionReset"));
          }}
        >
          {t("settings.resetPetPosition")}
        </Button>
      </CardContent>
    </Card>
  );
}
