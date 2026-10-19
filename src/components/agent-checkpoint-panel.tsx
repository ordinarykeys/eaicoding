import { useEffect, useState } from "react";
import { CheckCircle, Trash } from "@phosphor-icons/react";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "./ui/card";
import { toast } from "sonner";
import { clearAgentCheckpoints, getAgentCheckpoints, type AgentCheckpoint } from "@/services/agent/checkpoint";
export default function AgentCheckpointCard() {
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
            执行记录（高级）
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
      <CardDescription>保存在本机的任务执行摘要，用于排查中断与失败。它不是项目备份，不会自动恢复任务或回滚源码。</CardDescription>
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
