import { useDeferredValue, useMemo, useRef, useState } from "react";
import { Books, Database, FileText, MagnifyingGlass, Sparkle, Trash, UploadSimple, X } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { useSettingsStore } from "@/stores/settings";
import { totalItems as builtinItemCount } from "@/services/agent/knowledge/jingyi-raw.json";
import { addUserModule, rebuildUserModule, removeUserModule, type UserModuleEntry } from "@/services/knowledge/module-library";
import { ModuleDetails } from "./module-details";

export default function ModuleLibraryPanel() {
  const modules = useSettingsStore(state => state.userModules);
  return <UserModuleLibraryCard modules={modules} />;
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
  const [selected, setSelected] = useState<UserModuleEntry | "builtin" | null>(null);
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
        const fileBytes = 0;
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

  if (selected) return <ModuleDetails entry={selected === "builtin" ? null : modules.find(m => m.id === selected.id) ?? selected} onBack={() => setSelected(null)} />;
  return (
    <Card className="settings-section-card module-library-card border-0 shadow-none">
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
            label="内置精易知识条目"
            value={`${builtinItemCount} 条`}
            onClick={() => setSelected("builtin")}
          />
          <KnowledgeSummaryItem
            icon={<FileText className="h-4 w-4" />}
            label="已注册用户模块"
            value={`${modules.length} 个`}
          />
          <KnowledgeSummaryItem
            icon={<Sparkle className="h-4 w-4" />}
            label="命令 / 程序集"
            value={`${totals.api} / ${totals.classes}`}
          />
        </div>

        <p className="module-count-note">内置条目包含命令、常量、类型及资源；导入命令数包含内部子程序与 DLL 声明，两者统计口径和模块版本可能不同。点击模块查看详情。</p>
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
                onOpen={() => setSelected(entry)}
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
  onOpen,
}: {
  entry: UserModuleEntry;
  busy: boolean;
  onRebuild: () => void;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const indexingPct =
    entry.status === "indexing" && entry.apiCount > 0
      ? Math.min(100, Math.round((entry.indexedCount / entry.apiCount) * 100))
      : 0;
  const statusLabel = (() => {
    switch (entry.status) {
      case "ready":
        return entry.hasVectorIndex ? "已就绪" : "关键词检索已就绪";
      case "parsing":
        return entry.phase === "structure" ? `整理接口 ${entry.phaseDone ?? 0}/${entry.phaseTotal || "…"} 行` : "正在解析文件…";
      case "indexing":
        return entry.apiCount > 0
          ? entry.phase === "model_loading" ? "接口可检索 · 正在加载语义模型…" : `接口可检索 · 语义索引 ${entry.indexedCount}/${entry.apiCount} (${indexingPct}%)`
          : "建立索引中...";
      case "error":
        return "失败";
      default:
        return entry.phase === "copying" ? "正在复制文件…" : "等待处理";
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
        <button type="button" onClick={onOpen} aria-label={`查看模块 ${entry.name}`}
          className="module-library-name block w-full truncate text-left text-sm font-medium"
        >
          {entry.name}
        </button>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className={statusTone}>{statusLabel}</span>
          <span>{entry.apiCount} 条命令</span>
          <span>{entry.classCount} 个程序集</span>
          {entry.fileBytes > 0 && <span>{formatBytes(entry.fileBytes)}</span>}
        </div>
        {["pending", "parsing", "indexing"].includes(entry.status) && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded bg-muted">
            <div
              className="h-full bg-primary transition-[width] duration-300"
              data-indeterminate={entry.phase !== "embedding"}
              style={entry.phase === "embedding" ? { width: `${indexingPct}%` } : undefined}
            />
          </div>
        )}
        {entry.lastError && (
          <pre
            className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
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
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className="settings-module-stat flex items-center gap-2 rounded-md bg-secondary px-3 py-2">
      <span className="text-muted-foreground">{icon}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="ml-auto text-sm font-medium">{value}</span>
    </button>
  );
}
