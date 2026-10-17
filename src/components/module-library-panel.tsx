import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Books, CheckCircle, Database, FileText, MagnifyingGlass, Sparkle, Trash, UploadSimple, X } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { useSettingsStore } from "@/stores/settings";
import { totalItems as builtinItemCount } from "@/services/agent/knowledge/jingyi-raw.json";
import { addUserModule, rebuildUserModule, removeUserModule, type UserModuleEntry } from "@/services/knowledge/module-library";
import { clearAgentCheckpoints, getAgentCheckpoints, type AgentCheckpoint } from "@/services/agent/checkpoint";

export default function ModuleLibraryPanel() {
  const modules = useSettingsStore(state => state.userModules);
  return <><UserModuleLibraryCard modules={modules} /><AgentCheckpointCard /></>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Knowledge base settings
// ---------------------------------------------------------------------------

function UserModuleLibraryCard({ modules }: { modules: UserModuleEntry[] }) {
  const [isUploading, setIsUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const searchInput = useRef<HTMLInputElement>(null);
  const [page, setPage] = useState(0);
  const deferredQuery = useDeferredValue(query.trim().toLocaleLowerCase());
  const totals = useMemo(() => modules.reduce((acc, entry) => ({ api: acc.api + entry.apiCount, classes: acc.classes + entry.classCount }), { api: 0, classes: 0 }), [modules]);
  const filtered = useMemo(() => deferredQuery ? modules.filter(entry => `${entry.name} ${entry.sourcePath ?? ""}`.toLocaleLowerCase().includes(deferredQuery)) : modules, [modules, deferredQuery]);
  const pageSize = 20;
  const pages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);

  const uploadModules = async () => {
    const picked = await openDialog({
      multiple: true,
      directory: false,
      title: "选择 .ec 模块文件",
      filters: [{ name: "易语言模块", extensions: ["ec"] }],
    });
    const rawPaths = Array.isArray(picked)
      ? picked.filter((item): item is string => typeof item === "string")
      : typeof picked === "string"
        ? [picked]
        : [];
    if (rawPaths.length === 0) return;

    // Defensive: dialog filters can be bypassed (user switches to "All files").
    // The module library only accepts .ec — reject anything else with a clear toast.
    const paths = rawPaths.filter((p) => /\.ec$/i.test(p));
    const rejected = rawPaths.length - paths.length;
    if (rejected > 0) {
      toast.error(
        `已忽略 ${rejected} 个非 .ec 文件，模块库只接受易语言模块（.ec）`,
      );
    }
    if (paths.length === 0) return;

    try {
      setIsUploading(true);
      let added = 0;
      for (const path of paths) {
        const fileName = path.split(/[\\/]/).pop() ?? path;
        let fileBytes = 0;
        try {
          const stat = await invoke<{ bytes?: number }>("read_text_file_for_agent", {
            filePath: path,
            maxChars: 1,
          });
          fileBytes = typeof stat?.bytes === "number" ? stat.bytes : 0;
        } catch {
          // best-effort: missing size shouldn't block upload
        }
        await addUserModule({ sourcePath: path, fileBytes, fileName });
        added += 1;
      }
      toast.success(`已开始解析 ${added} 个模块，请稍候`);
    } catch (error) {
      toast.error(`上传失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsUploading(false);
    }
  };

  const handleRebuild = async (id: string) => {
    try {
      setBusyId(id);
      await rebuildUserModule(id);
      toast.success("已重新解析并清洗");
    } catch (error) {
      toast.error(`重建失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (id: string) => {
    try {
      setBusyId(id);
      await removeUserModule(id);
      toast.success("已移除模块");
    } catch (error) {
      toast.error(`删除失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="settings-section-card border-0 shadow-none">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="settings-section-title flex items-center gap-2">
            <Books className="h-4 w-4" />
            模块库
          </CardTitle>
          <Button size="sm" onClick={uploadModules} disabled={isUploading}>
            <UploadSimple className="h-4 w-4" />
            上传 .ec
          </Button>
        </div>
        <CardDescription>管理易语言模块，供 AI 检索接口并生成代码。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="settings-module-summary">
          <KnowledgeSummaryItem
            icon={<Database className="h-4 w-4" />}
            label="精易模块（内置）"
            value={`${builtinItemCount} 条`}
          />
          <KnowledgeSummaryItem
            icon={<FileText className="h-4 w-4" />}
            label="已注册用户模块"
            value={`${modules.length} 个`}
          />
          <KnowledgeSummaryItem
            icon={<Sparkle className="h-4 w-4" />}
            label="公开 API / 类"
            value={`${totals.api} / ${totals.classes}`}
          />
        </div>

        <div className="settings-module-search">
          <MagnifyingGlass size={16} aria-hidden="true" />
          <Input ref={searchInput} aria-label="搜索模块" placeholder="搜索模块名称或路径" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} />
          {query && <button type="button" aria-label="清除模块搜索" onClick={() => { setQuery(""); setPage(0); searchInput.current?.focus(); }}><X size={14} /></button>}
        </div>
        <div className="module-library-list space-y-2" aria-busy={query.trim().toLocaleLowerCase() !== deferredQuery}>
          {modules.length === 0 ? (
            <div className="rounded-md bg-card px-3 py-8 text-center text-sm text-muted-foreground">
              暂无用户模块。点击上方「上传 .ec」开始注册——精易、OkHttp、团队封装库等都可以加进来。
            </div>
          ) : (
            visible.map((entry) => (
              <UserModuleRow
                key={entry.id}
                entry={entry}
                busy={busyId === entry.id}
                onRebuild={() => handleRebuild(entry.id)}
                onRemove={() => handleRemove(entry.id)}
              />
            ))
          )}
        </div>
        {modules.length > 0 && <div className="module-library-pagination">
          <span role="status">共 {filtered.length} 个模块 · 第 {currentPage + 1} / {pages} 页</span>
          <div><Button variant="ghost" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</Button>
          <Button variant="ghost" size="sm" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>下一页</Button></div>
        </div>}
        {modules.length > 0 && filtered.length === 0 && <p className="text-sm text-muted-foreground">没有匹配的模块</p>}
      </CardContent>
    </Card>
  );
}

function UserModuleRow({
  entry,
  busy,
  onRebuild,
  onRemove,
}: {
  entry: UserModuleEntry;
  busy: boolean;
  onRebuild: () => void;
  onRemove: () => void;
}) {
  const indexingPct =
    entry.status === "indexing" && entry.apiCount > 0
      ? Math.min(100, Math.round((entry.indexedCount / entry.apiCount) * 100))
      : 0;
  const statusLabel = (() => {
    switch (entry.status) {
      case "ready":
        return "✓ 就绪";
      case "parsing":
        return "解析中...";
      case "indexing":
        return entry.apiCount > 0
          ? `建立索引中 ${entry.indexedCount}/${entry.apiCount} (${indexingPct}%)`
          : "建立索引中...";
      case "error":
        return "失败";
      default:
        return "等待处理";
    }
  })();
  const statusTone =
    entry.status === "ready"
      ? "text-emerald-600 dark:text-emerald-400"
      : entry.status === "error"
        ? "text-destructive"
        : "text-muted-foreground";

  return (
    <div className="module-library-row flex items-center gap-3 rounded-md bg-card px-3 py-2">
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <span
          className="block w-full truncate text-left text-sm font-medium"
          title={entry.sourcePath ?? entry.storedPath}
        >
          {entry.name}
        </span>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className={statusTone}>{statusLabel}</span>
          <span>{entry.apiCount} 条 API</span>
          <span>{entry.classCount} 个类</span>
          {entry.fileBytes > 0 && <span>{formatBytes(entry.fileBytes)}</span>}
        </div>
        {entry.status === "indexing" && entry.apiCount > 0 && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-primary transition-[width] duration-300"
              style={{ width: `${indexingPct}%` }}
            />
          </div>
        )}
        {entry.lastError && (
          <pre
            className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
            title="点击复制完整错误"
            onClick={() => {
              void navigator.clipboard?.writeText(entry.lastError ?? "").then(() => {
                toast.success("已复制错误信息");
              });
            }}
          >
            错误：{entry.lastError}
          </pre>
        )}
      </div>
      <Button
        variant="outline"
        size="sm"
        onClick={onRebuild}
        disabled={busy || entry.status === "parsing" || entry.status === "indexing"}
      >
        <Sparkle className="h-4 w-4" />
        重建
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`移除模块 ${entry.name}`}
        className="h-8 w-8"
        onClick={onRemove}
        disabled={busy}
      >
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
    <div className="settings-module-stat flex items-center gap-2 rounded-md bg-secondary px-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="ml-auto text-sm font-medium">{value}</span>
    </div>
  );
}

function AgentCheckpointCard() {
  const [checkpoints, setCheckpoints] = useState<AgentCheckpoint[]>([]);

  const refresh = () => setCheckpoints(getAgentCheckpoints());

  useEffect(() => {
    refresh();
  }, []);

  const clearAll = () => {
    clearAgentCheckpoints();
    setCheckpoints([]);
    toast.success("已清空 Agent 检查点");
  };

  return (
    <Card className="settings-section-card border-0 shadow-none">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="settings-section-title flex items-center gap-2">
            <CheckCircle className="h-4 w-4" />
            Agent 检查点
          </CardTitle>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={refresh}>
              刷新
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={clearAll}
              disabled={checkpoints.length === 0}
            >
              <Trash className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {checkpoints.length === 0 ? (
          <div className="rounded-md bg-card px-3 py-6 text-center text-sm text-muted-foreground">
            暂无检查点
          </div>
        ) : (
          checkpoints.slice(0, 6).map((checkpoint) => (
            <AgentCheckpointRow key={checkpoint.id} checkpoint={checkpoint} />
          ))
        )}
      </CardContent>
    </Card>
  );
}

function AgentCheckpointRow({ checkpoint }: { checkpoint: AgentCheckpoint }) {
  return (
    <div className="rounded-md bg-card px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium" title={checkpoint.goal}>
          {checkpoint.goal}
        </span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {new Date(checkpoint.updatedAt).toLocaleString()}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>{checkpoint.outcome}</span>
        <span>{checkpoint.stepCount} 步</span>
        <span>{checkpoint.toolCallCount} 次工具</span>
        {checkpoint.pendingChoiceQuestion && <span>等待选择</span>}
      </div>
      {checkpoint.finalAnswerPreview && (
        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
          {checkpoint.finalAnswerPreview}
        </div>
      )}
    </div>
  );
}
