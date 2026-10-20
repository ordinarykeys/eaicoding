import { useDeepSeekAccount } from "@/stores/deepseek-account";
import { useChatScroll } from "@/hooks/use-chat-scroll";
import { QueueDock, type QueuedMessage } from "@/components/queue-dock";
import { ChatComposer } from "@/components/chat-composer";
import { TrajectoryView } from "@/components/trajectory-view";
import { TurnReview } from "@/components/turn-review";
import { turnChanges } from "@/lib/turn-changes";
import "@/styles/code-work.css";
import { WorkspacePane, type WorkspaceTab } from "@/components/workspace-pane";
import { ConversationMenu } from "@/components/conversation-menu";
import { copyText } from "@/lib/clipboard";
import { invoke } from "@tauri-apps/api/core";
import {
  Fragment,
  memo,
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useContext,
} from "react";
import {
  CircleNotch,
  Brain,
  FileText,
  ListChecks,
  MagnifyingGlass,
  PencilSimple,
  TerminalWindow,
  Layout,
  CaretDown,
  CaretRight,
  Check,
  Code,
  CopySimple,
  DownloadSimple,
  File,
  FolderOpen,
  GearSix,
  SidebarSimple,
  X,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MarkdownView } from "@/components/markdown-view";
import { CodeBlock } from "@/components/code-block";
import { DocumentPreview } from "@/components/document-preview";
import { DocumentPreviewContext, documentLanguage, fileName, isTextPath, type PreviewDocument } from "@/components/document-preview-context";
import { useChatStore, useActiveSession } from "@/stores/chat";
import { flushChatStorage, setChatPersistThrottling } from "@/stores/chat-storage";
import { useSettingsStore } from "@/stores/settings";
import { startAgentRun } from "@/services/agent/runner";
import { DesktopPet, emitPet } from "@/components/desktop-pet";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { copyFile } from "@tauri-apps/plugin-fs";
import { useTranslation } from "react-i18next";
import { deriveSessionTitle, getSessionDisplayTitle } from "@/lib/session-title";
import { useVirtualWindow } from "@/hooks/use-virtual-window";
import type {
  AgentStep,
  AgentTrace,
  AgentUserChoiceRequest,
  ChatMessage,
  ToolCall,
  ToolResult,
} from "@/types/llm";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Top-level component
// ---------------------------------------------------------------------------

interface ChatViewProps {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  settingsOpen?: boolean;
}

export function ChatView({ sidebarOpen, onToggleSidebar, settingsOpen = false }: ChatViewProps) {
  const { t } = useTranslation();
  const session = useActiveSession();
  // Per-field selectors: subscribing to the whole store would re-render this
  // (very large) component a second time on every streaming token.
  const createSession = useChatStore((s) => s.createSession);
  const appendMessage = useChatStore((s) => s.appendMessage);
  const updateMessage = useChatStore((s) => s.updateMessage);
  const activeSessionId = useChatStore((s) => s.activeSessionId);
  const resolveLLMConfig = useSettingsStore((s) => s.resolveLLMConfig);
  const codeWorkView = useSettingsStore(s => s.codeWorkView);
  const [conversationView, setConversationView] = useState<"chat" | "trajectory">("chat");
  const [reviewMessageId, setReviewMessageId] = useState<string | null>(null);

  // A run and its inbox belong to one conversation, including while hidden.
  const runs = useRef(new Map<string, {
    status: string | null;
    handle: ReturnType<typeof startAgentRun> | null;
    accountRequest: boolean;
    cancelled: boolean;
    cancelFrame?: () => void;
  }>());
  const [runRevision, setRunRevision] = useState(0);
  const mountedRef = useRef(false);
  const notifyRuns = useCallback(() => { if (mountedRef.current) setRunRevision(value => value + 1); }, []);
  const blockedQueues = useRef(new Set<string>());
  const [pendingMessages, setPendingMessages] = useState<QueuedMessage[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { text: string; files: string[] }>>({});
  const draftKey = activeSessionId ?? "";
  const input = drafts[draftKey]?.text ?? "";
  const attachedFiles = drafts[draftKey]?.files ?? [];
  const setInput = useCallback((text: string) => setDrafts(previous => ({ ...previous,
    [draftKey]: { text, files: previous[draftKey]?.files ?? [] },
  })), [draftKey]);
  const setAttachedFiles = useCallback((value: string[] | ((files: string[]) => string[])) => setDrafts(previous => ({ ...previous,
    [draftKey]: { text: previous[draftKey]?.text ?? "", files: typeof value === "function" ? value(previous[draftKey]?.files ?? []) : value },
  })), [draftKey]);
  const currentRun = activeSessionId ? runs.current.get(activeSessionId) : undefined;
  const isStreaming = Boolean(currentRun);
  const statusLine = currentRun?.status;
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  const [previewVisible, setPreviewVisible] = useState(false);
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>("start");
  const [workspaceFocused, setWorkspaceFocused] = useState(false);
  const [defaultWorkspace, setDefaultWorkspace] = useState("");
  const workspace = session?.workspacePath ?? defaultWorkspace;
  const [openedDocuments, setOpenedDocuments] = useState<PreviewDocument[]>([]);
  const [previewWidth, setPreviewWidth] = useState(520);
  const { rootRef: scrollRootRef, contentRef: scrollContentRef, showLatest, toLatest } = useChatScroll(activeSessionId, session?.messages);
  const accountSignedIn = useDeepSeekAccount(s => s.view.signedIn);
  useEffect(() => {
    if (accountSignedIn) return;
    for (const run of runs.current.values()) {
      if (run.accountRequest) { run.cancelled = true; run.handle?.abort(); }
    }
  }, [accountSignedIn]);
  const sessionTitle = session ? getSessionDisplayTitle(session) : "EAiCoding";
  const visibleMessages = useMemo(
    () => session?.messages.filter((m) => m.role !== "tool") ?? [],
    [session?.messages],
  );
  const virtualMessages = useVirtualWindow(visibleMessages, 140);
  const lastAssistantMessageIndex = useMemo(() => {
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      if (visibleMessages[index].role === "assistant") return index;
    }
    return -1;
  }, [visibleMessages]);
  const availableDocuments = useMemo(() => {
    const files = new Map<string, PreviewDocument>();
    for (const message of session?.messages ?? []) {
      for (const item of extractEplPreviewItems(message.agentTrace ?? null)) files.set(item.id, item);
    }
    return files;
  }, [session?.messages]);
  const latestTrace = useMemo(() => [...(session?.messages ?? [])].reverse().find(message => message.role === "assistant")?.agentTrace, [session?.messages]);
  const latestChangedFiles = useMemo(() => turnChanges(latestTrace), [latestTrace]);
  const reviewTrace = session?.messages.find(message => message.id === reviewMessageId)?.agentTrace ?? latestTrace;
  const changedFiles = useMemo(() => turnChanges(reviewTrace), [reviewTrace]);
  useEffect(() => { if (!codeWorkView) { setConversationView("chat"); if (workspaceTab === "review") setWorkspaceTab("start"); } }, [codeWorkView, workspaceTab]);
  const previewItems = useMemo(() => openedDocuments.map(item => availableDocuments.get(item.id) ?? item), [openedDocuments, availableDocuments]);
  const openPreview = useCallback((document: PreviewDocument) => {
    setOpenedDocuments(previous => previous.some(item => item.id === document.id)
      ? previous.map(item => item.id === document.id ? document : item) : [...previous, document]);
    setSelectedPreviewId(document.id);
    setPreviewVisible(true);
    setWorkspaceTab("code");
  }, []);
  const closePreviewTab = (id: string) => {
    const remaining = previewItems.filter(item => item.id !== id);
    setOpenedDocuments(remaining);
    if (selectedPreviewId === id) setSelectedPreviewId(remaining.at(-1)?.id ?? null);
    if (!remaining.length) setWorkspaceTab("start");
  };
  const activePreview = useMemo(() => {
    if (previewItems.length === 0) return null;
    return (
      previewItems.find((item) => item.id === selectedPreviewId) ??
      previewItems[0]
    );
  }, [previewItems, selectedPreviewId]);

  useEffect(() => {
    mountedRef.current = true;
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      if (state.sessions === previous.sessions) return;
      const ids = new Set(state.sessions.map(item => item.id));
      for (const [sid, run] of runs.current) {
        if (ids.has(sid)) continue;
        run.cancelled = true; run.cancelFrame?.(); run.handle?.abort();
        runs.current.delete(sid);
        blockedQueues.current.delete(sid);
      }
      if (state.sessions.length < previous.sessions.length) {
        setPendingMessages(items => items.filter(item => ids.has(item.sessionId)));
        setDrafts(items => Object.fromEntries(Object.entries(items).filter(([id]) => !id || ids.has(id))));
        notifyRuns();
      }
    });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      for (const run of runs.current.values()) {
        run.cancelled = true; run.cancelFrame?.(); run.handle?.abort();
      }
      runs.current.clear();
      setChatPersistThrottling(false);
    };
  }, [notifyRuns]);

  useEffect(() => {
    setOpenedDocuments([]); setSelectedPreviewId(null); setWorkspaceTab("start"); setWorkspaceFocused(false); setPreviewVisible(false);
    setConversationView("chat"); setReviewMessageId(null);
  }, [activeSessionId]);

  useEffect(() => { void invoke<string>("default_workspace").then(setDefaultWorkspace).catch(error => toast.error(`读取默认工作区失败：${String(error)}`)); }, []);
  const chooseWorkspace = async () => {
    if (useChatStore.getState().activeSessionId && runs.current.has(useChatStore.getState().activeSessionId!)) return;
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: "选择会话工作区", ...(workspace ? { defaultPath: workspace } : {}) });
      if (typeof selected !== "string") return;
      const store = useChatStore.getState();
      const sid = store.activeSessionId ?? store.createSession();
      store.setWorkspace(sid, selected);
    } catch (error) { toast.error(`选择工作区失败：${String(error)}`); }
  };

  const handleAttachFile = useCallback(async () => {
    if (isStreaming) return;

    try {
      const selected = await openDialog({
        multiple: true,
        title: t("chat.attachDialogTitle"),
        filters: [
          {
            name: t("chat.attachEFileFilter"),
            extensions: ["e", "ec", "epl"],
          },
          {
            name: t("chat.attachLibraryFilter"),
            extensions: ["dll", "lib"],
          },
          {
            name: t("chat.attachTextFilter"),
            extensions: ["txt", "ini", "json"],
          },
        ],
      });

      if (!selected) {
        toast.info(t("chat.attachCancelled"));
        return;
      }

      const paths = (Array.isArray(selected) ? selected : [selected]).filter(Boolean);
      if (paths.length === 0) {
        toast.info(t("chat.attachCancelled"));
        return;
      }

      setAttachedFiles((prev) => {
        const existing = new Set(prev);
        const merged = [...prev];
        for (const p of paths) {
          if (!existing.has(p)) merged.push(p);
        }
        return merged;
      });

      toast.success(t("chat.attachSuccess", { count: paths.length }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t("chat.attachFailed", { message }));
    }
  }, [isStreaming, t, setAttachedFiles]);

  // ------------------------------------------------------------------------
  // Send / agent loop
  // ------------------------------------------------------------------------

  const runAgentMessage = useCallback(async (options: {
    text: string;
    files?: string[];
    sessionId?: string;
    onAccepted?: () => void;
  }) => {
    const text = options.text.trim();
    const files = options.files ?? [];
    if (!text && files.length === 0) return;
    const store = useChatStore.getState();
    const sid = options.sessionId ?? store.activeSessionId ?? store.createSession(deriveSessionTitle(text));
    if (runs.current.has(sid) || !useChatStore.getState().sessions.some(item => item.id === sid)) return;
    // Lock before awaiting configuration: only this conversation becomes busy.
    const run = { status: "正在思考" as string | null, handle: null as ReturnType<typeof startAgentRun> | null,
      accountRequest: false, cancelled: false, cancelFrame: () => {} };
    runs.current.set(sid, run);
    blockedQueues.current.add(sid);
    notifyRuns();
    let assistantMsgId: string | undefined;
    let acceptingTokens = true;
    let streamBuffer = "";
    let reasoningBuffer = "";
    let tokenFrame: number | null = null;
    const visible = () => mountedRef.current && useChatStore.getState().activeSessionId === sid;
    const cancelTokenFrame = () => {
      if (tokenFrame !== null) { cancelAnimationFrame(tokenFrame); tokenFrame = null; }
    };
    run.cancelFrame = cancelTokenFrame;
    const publishTokens = () => {
      if (tokenFrame !== null) return;
      tokenFrame = requestAnimationFrame(() => {
        tokenFrame = null;
        if (!acceptingTokens || run.cancelled || !mountedRef.current || !assistantMsgId) return;
        updateMessage(sid, assistantMsgId, { content: streamBuffer, reasoningContent: reasoningBuffer, isStreaming: true });
      });
    };
    try {
      let config;
      try { config = await resolveLLMConfig(); }
      catch (error) { throw new Error(`读取模型配置失败：${error instanceof Error ? error.message : String(error)}`); }
      if (!mountedRef.current || run.cancelled || !useChatStore.getState().sessions.some(item => item.id === sid)) return;
      if (!config) { if (visible()) toast.error("请先登录 DeepSeek 或添加模型提供商"); return; }
      run.accountRequest = !config.profileId;
      if (run.accountRequest && !useDeepSeekAccount.getState().view.signedIn) return;
      const userContent = messageWithFiles(text, files);
      options.onAccepted?.();
      if (visible()) { toLatest(); emitPet({ state: "thinking", bubble: "Thinking..." }); }
      setChatPersistThrottling(true);
      appendMessage(sid, { role: "user", content: userContent });
      assistantMsgId = appendMessage(sid, { role: "assistant", content: "", isStreaming: true });
      const sessionSnapshot = useChatStore.getState().sessions.find(item => item.id === sid);
      const runWorkspace = sessionSnapshot?.workspacePath ?? defaultWorkspace;
      if (runWorkspace && !sessionSnapshot?.workspacePath) useChatStore.getState().setWorkspace(sid, runWorkspace);
      const history = (sessionSnapshot?.messages ?? []).filter(message => message.id !== assistantMsgId).slice(0, -1);
      const handle = startAgentRun({
        config, mode: "agent", userInput: userContent, history, sessionId: sid, workspaceRoot: runWorkspace, allowDialog: true,
        onStatus: status => {
          if (run.cancelled) return;
          run.status = status.replace(/^第 \d+\/\d+ 步：/, "").replace("模型推理中", "正在思考").replace(/^执行 ([a-z_]+)/, (_match, name: string) => toolLabel(name));
          notifyRuns();
        },
        onAssistantStart: () => {
          cancelTokenFrame(); streamBuffer = ""; reasoningBuffer = "";
          updateMessage(sid, assistantMsgId!, { content: "", reasoningContent: "", activeToolCallId: undefined });
        },
        onAssistantToken: token => { if (acceptingTokens && !run.cancelled) { streamBuffer += token; publishTokens(); } },
        onReasoningToken: token => { if (acceptingTokens && !run.cancelled) { reasoningBuffer += token; publishTokens(); } },
        onToolProgress: (_step, runningTrace, activeToolCallId) => {
          cancelTokenFrame(); streamBuffer = ""; reasoningBuffer = "";
          updateMessage(sid, assistantMsgId!, { content: "", reasoningContent: "", isStreaming: true, agentTrace: runningTrace, activeToolCallId });
        },
        onStep: (step, runningTrace) => {
          cancelTokenFrame(); streamBuffer = ""; reasoningBuffer = "";
          updateMessage(sid, assistantMsgId!, { content: renderTraceForBubble(runningTrace, false), reasoningContent: "", isStreaming: true,
            agentTrace: runningTrace, activeToolCallId: undefined });
          if (visible()) {
            if (step.finishReason === "tool_call") emitPet({ state: "building", bubble: "处理中" });
            else if (step.finishReason === "error") emitPet({ state: "error", bubble: "Error" });
          }
        },
      });
      run.handle = handle;
      notifyRuns();
      const trace = await handle.promise;
      if (trace.outcome === "answer" && !run.cancelled) blockedQueues.current.delete(sid);
      acceptingTokens = false; cancelTokenFrame();
      updateMessage(sid, assistantMsgId, {
        content: renderTraceForBubble(trace, true),
        providerMessage: trace.steps.at(-1)?.finishReason === "answer" ? trace.steps.at(-1)?.providerMessage : undefined,
        reasoningContent: trace.steps.at(-1)?.finishReason === "answer" ? trace.steps.at(-1)?.reasoningContent : reasoningBuffer,
        isStreaming: false, agentTrace: trace, activeToolCallId: undefined,
      });
      if (!visible()) return;
      if (trace.outcome === "answer") {
        if (trace.toolCallCount > 0) toast.success("处理完成");
        emitPet({ state: "happy", bubble: trace.toolCallCount > 0 ? "Done" : "Answered" });
      } else if (trace.outcome === "max_steps") {
        toast.warning("本轮已达到执行上限"); emitPet({ state: "notification", bubble: "Max steps" });
      } else if (trace.outcome === "aborted") {
        toast.info("已停止"); emitPet({ state: "idle", bubble: "Stopped" });
      } else if (trace.outcome === "needs_input") {
        toast.info("请选择一个方案继续"); emitPet({ state: "notification", bubble: "请选择" });
      } else {
        toast.error("执行失败，请查看回复中的原因"); emitPet({ state: "error", bubble: "Error" });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (assistantMsgId) updateMessage(sid, assistantMsgId, { content: `执行已中断：${message}`, reasoningContent: reasoningBuffer,
        isStreaming: false, activeToolCallId: undefined });
      if (visible()) { toast.error(message); emitPet({ state: "error", bubble: "Interrupted" }); }
    } finally {
      acceptingTokens = false; cancelTokenFrame();
      if (runs.current.get(sid) === run) runs.current.delete(sid);
      setChatPersistThrottling(runs.current.size > 0);
      void flushChatStorage();
      notifyRuns();
    }
  }, [resolveLLMConfig, toLatest, appendMessage, updateMessage, defaultWorkspace, notifyRuns]);

  const steerMessages = useCallback((items: QueuedMessage[]) => {
    if (!items.length) return false;
    const sid = items[0].sessionId;
    const run = runs.current.get(sid);
    const correction = items.map(item => messageWithFiles(item.text, item.files)).join("\n\n");
    if (run?.cancelled || !run?.handle?.steer(correction)) { toast.error("当前暂时无法插话，请稍后重试"); return false; }
    appendMessage(sid, { role: "user", content: correction });
    const ids = new Set(items.map(item => item.id));
    setPendingMessages(previous => previous.filter(item => !ids.has(item.id)));
    return true;
  }, [appendMessage]);

  const handleSend = useCallback(async (alternate = false) => {
    const text = input.trim();
    const files = attachedFiles;
    const sessionId = useChatStore.getState().activeSessionId;
    if (!text && files.length === 0) {
      if (alternate && sessionId) steerMessages(pendingMessages.filter(item => item.sessionId === sessionId));
      return;
    }
    if (sessionId && runs.current.has(sessionId)) {
      const preferred = useSettingsStore.getState().busyEnterBehavior;
      const behavior = alternate ? preferred === "queue" ? "steer" : "queue" : preferred;
      const item = { id: crypto.randomUUID(), sessionId, text, files };
      if (behavior !== "steer" || !steerMessages([item])) setPendingMessages(previous => [...previous, item]);
      setInput(""); setAttachedFiles([]);
      return;
    }
    const targetSessionId = sessionId ?? createSession(deriveSessionTitle(text));
    if (!sessionId) setDrafts(previous => ({ ...previous, "": { text: "", files: [] },
      [targetSessionId]: previous[draftKey] ?? { text: input, files },
    }));
    await runAgentMessage({ text, files, sessionId: targetSessionId, onAccepted: () => setDrafts(previous => {
      const draft = previous[targetSessionId];
      // Configuration can resolve after the user has switched tasks or typed more.
      if (!draft || draft.text.trim() !== text || draft.files !== files) return previous;
      return { ...previous, [targetSessionId]: { text: "", files: [] } };
    }) });
  }, [input, attachedFiles, runAgentMessage, steerMessages, pendingMessages, setInput, setAttachedFiles, draftKey, createSession]);

  useEffect(() => {
    const visited = new Set<string>();
    for (const next of pendingMessages) {
      if (visited.has(next.sessionId)) continue;
      visited.add(next.sessionId);
      if (runs.current.has(next.sessionId) || blockedQueues.current.has(next.sessionId)) continue;
      void runAgentMessage({ ...next, onAccepted: () => setPendingMessages(previous => previous.filter(item => item.id !== next.id)) });
    }
  }, [pendingMessages, runRevision, runAgentMessage]);

  const sendQueuedMessage = useCallback(async (item: QueuedMessage) => {
    if (runs.current.has(item.sessionId)) { steerMessages([item]); return; }
    // The dock action is busy until admission, rather than for the whole run.
    await new Promise<void>(resolve => {
      void runAgentMessage({ ...item, onAccepted: () => {
        setPendingMessages(previous => previous.filter(entry => entry.id !== item.id));
        resolve();
      } }).finally(resolve);
    });
  }, [runAgentMessage, steerMessages]);

  const handleAgentChoice = useCallback(async (choice: string, request: AgentUserChoiceRequest) => {
    const question = request.question.trim();
    const text = [`我选择：${choice}`, question ? `对应问题：${question}` : "", "请按这个选择继续完成上一轮任务。"].filter(Boolean).join("\n");
    await runAgentMessage({ text, files: [] });
  }, [runAgentMessage]);

  const handleStop = useCallback(() => {
    const sid = useChatStore.getState().activeSessionId;
    if (!sid) return;
    const run = runs.current.get(sid);
    if (!run) return;
    blockedQueues.current.add(sid);
    run.cancelled = true; run.status = "正在停止...";
    run.cancelFrame?.(); run.handle?.abort();
    notifyRuns();
    emitPet({ state: "idle", bubble: "Stopping" });
  }, [notifyRuns]);

  const handleReview = useCallback((id: string) => { setReviewMessageId(id); setWorkspaceTab("review"); setPreviewVisible(true); }, []);

  return (
    <DocumentPreviewContext.Provider value={openPreview}>

      <div className="chat-workspace relative h-full overflow-hidden bg-background" data-preview-open={previewVisible} data-workspace-focused={workspaceFocused && previewVisible}>
        <div
          className="harness-chat-column flex h-full min-w-0 flex-col transition-[padding] duration-200"
          data-empty={!session?.messages.length}
        >
          <header className="flex items-center gap-2 px-4 py-2.5 shrink-0">
            <ConversationMenu session={session} title={sessionTitle} workspace={workspace} busy={isStreaming} onChooseWorkspace={() => void chooseWorkspace()} />
            {statusLine && (
              <span className="chat-run-status text-xs text-muted-foreground hidden md:flex items-center gap-1">
                <GearSix className="h-3.5 w-3.5 animate-spin" />
                <span>{statusLine}</span>
              </span>
            )}
            {activePreview && (!previewVisible || workspaceTab !== "code") && <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" aria-label="代码预览" onClick={() => { setWorkspaceTab("code"); setPreviewVisible(true); }}><Code size={16} /></Button>}
            {!previewVisible && (

                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg text-muted-foreground"
                    aria-label="打开工作区"
                    onClick={() => setPreviewVisible(true)}
                  >
                    <SidebarSimple className="h-4 w-4 rotate-180" />
                  </Button>

            )}
          </header>

          {codeWorkView && Boolean(session?.messages.length) && <div className="conversation-view-tabs" role="tablist" aria-label="会话视图">
            <button type="button" role="tab" aria-selected={conversationView === "chat"} onClick={() => setConversationView("chat")}>对话</button>
            <button type="button" role="tab" aria-selected={conversationView === "trajectory"} onClick={() => setConversationView("trajectory")}>轨迹</button>
            <button type="button" className="conversation-changes-action" disabled={!latestChangedFiles.length} onClick={() => { setReviewMessageId(null); setWorkspaceTab("review"); setPreviewVisible(true); }}>本轮改动{latestChangedFiles.length > 0 && ` · ${latestChangedFiles.length}`}</button>
          </div>}
          {codeWorkView && conversationView === "trajectory" && <TrajectoryView key={activeSessionId} messages={session?.messages ?? []} />}

          <ScrollArea ref={scrollRootRef} className="chat-message-scroll flex-1 px-0" style={conversationView === "trajectory" && codeWorkView ? { display: "none" } : undefined}>
            <div ref={scrollContentRef} className="chat-message-content mx-auto max-w-3xl px-6 py-6 space-y-6">
              {!session?.messages.length && (
                <div className="chat-empty-welcome flex min-h-[46vh] flex-col items-center justify-center text-center text-muted-foreground">
                  <div className="max-w-2xl space-y-4">
                    <h3 className="text-3xl font-medium tracking-tight text-foreground">
                      {t("chat.welcomeTitle")}
                    </h3>
                    <p className="text-sm leading-6">
                      {t("chat.welcomeDescription")}
                    </p>
                  </div>
                </div>
              )}

              {virtualMessages.truncated && (
                <div className="mx-auto max-w-sm rounded-md border border-border/60 bg-muted/35 px-3 py-1.5 text-center text-xs text-muted-foreground">
                  已省略更早的 {virtualMessages.offset} 条消息
                </div>
              )}

              {virtualMessages.items.map((msg, index) => (
                <Fragment key={msg.id}>
                  <MessageBubble message={msg} onChoice={handleAgentChoice} onReview={handleReview} />
                  {virtualMessages.offset + index === lastAssistantMessageIndex && (
                    <div className="message-enter chat-pet-row flex justify-start">
                      <DesktopPet placement="chat" />
                    </div>
                  )}
                </Fragment>
              ))}
            </div>
          </ScrollArea>

          <div className="chat-composer-host relative shrink-0">
            <QueueDock key={activeSessionId} items={pendingMessages.filter(item => item.sessionId === activeSessionId)} running={isStreaming}
              onSend={sendQueuedMessage} onRemove={id => setPendingMessages(previous => previous.filter(item => item.id !== id))}
              onEdit={(id, text) => setPendingMessages(previous => previous.map(item => item.id === id ? { ...item, text } : item))} />
            {showLatest && <button type="button" className="chat-jump-latest" onClick={toLatest}><CaretDown size={14} />回到最新</button>}
            <ChatComposer value={input} onChange={setInput} onSend={alternate => void handleSend(alternate)} onStop={handleStop} running={isStreaming} hasQueue={pendingMessages.some(item => item.sessionId === activeSessionId)}
              files={attachedFiles} onAttach={() => void handleAttachFile()} onRemove={path => setAttachedFiles(files => files.filter(file => file !== path))}
              onNewChat={() => { createSession(); }}
              focusKey={activeSessionId} />
          </div>
        </div>
        <WorkspacePane key={activeSessionId ?? "empty"} root={workspace} visible={previewVisible} tab={workspaceTab} onTab={setWorkspaceTab}
          hasReview={codeWorkView} review={<TurnReview key={reviewMessageId ?? "latest"} files={changedFiles} onOpen={openPreview} />}
          onShow={() => setPreviewVisible(true)} onHide={() => { setPreviewVisible(false); setWorkspaceFocused(false); }}
          onChooseRoot={() => void chooseWorkspace()} onOpenFile={openPreview} sidebarOpen={sidebarOpen} onToggleSidebar={onToggleSidebar}
          focused={workspaceFocused} onFocus={() => setWorkspaceFocused(value => !value)} width={previewWidth} onResize={setPreviewWidth} nativeOverlay={settingsOpen}
          hasCode={Boolean(activePreview)}>
        {activePreview && (
          <DocumentPreview
            visible={previewVisible && workspaceTab === "code"}
            items={previewItems}
            activeId={activePreview.id}
            onSelect={setSelectedPreviewId}
            onClose={() => setWorkspaceTab("start")}
            onCloseTab={closePreviewTab}
            width={previewWidth}
            onResize={setPreviewWidth}
          />
        )}
        </WorkspacePane>
      </div>

    </DocumentPreviewContext.Provider>
  );
}

function messageWithFiles(text: string, files: string[]): string {
  if (!files.length) return text;
  const lines = files.map(path => {
    const ext = path.split(".").pop()?.toLowerCase();
    const hint = ext === "e" ? " （.e 二进制源程序）" : ext === "ec" ? " （.ec 模块文件，可用 parse_efile 读取公开接口）" : ext === "epl" ? " （.epl 文本源码）" : "";
    return `- ${path}${hint}`;
  }).join("\n");
  return `用户上传了以下本地文件，请用工具读取后再分析（.e/.ec 用 parse_efile，文本文件用 read_file）：\n${lines}${text ? `\n\n用户补充说明：${text}` : ""}`;
}

// ---------------------------------------------------------------------------
// Tool name → readable label mapping
// ---------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = {
  list_workspace_files: "浏览工作区",
  scan_easy_language_env: "扫描易语言环境",
  update_plan: "更新计划",
  search_user_modules: "查询模块库",
  search_jingyi_module: "查询精易模块",
  ask_user_choice: "等待选择",
  read_file: "读取文件",
  parse_efile: "解析源码",
  export_efile_to_ecode: "导出 ecode 工程",
  summarize_ecode_project: "生成项目地图",
  analyze_ecode_project: "分析项目质量",
  inspect_ecode_context: "整理项目上下文",
  generate_efile_from_ecode: "回编 ecode 工程",
  generate_efile_from_code: "生成 .e 文件",
  generate_gui_project: "生成窗口界面",
  apply_search_replace: "修改源码",
  compile_efile: "编译",
  build_ecode_project: "回编并编译",
  start_project_closed_loop: "启动完整闭环",
  finish_project_closed_loop: "完成闭环验证",
  restore_project_snapshot: "回滚闭环快照",
  closed_loop_build: "闭环编译",
  save_text_file: "保存文件",
  pick_file: "选择文件",
  pick_save_path: "选择保存路径",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

// ---------------------------------------------------------------------------
// Trace rendering
// ---------------------------------------------------------------------------

/** Build the markdown body that is shown in the assistant bubble while or
 *  after the agent is running. We use markdown so MarkdownView keeps code
 *  highlighting and link rendering. */
function renderTraceForBubble(trace: AgentTrace, isFinal: boolean): string {
  if (trace.finalAnswer) return trace.finalAnswer;
  if (!isFinal) {
    return "";
  }
  return trace.outcome === "aborted" ? "已停止生成。" : "本次未生成完整回复。";
}

// ---------------------------------------------------------------------------
// CodePreviewPanel: right-side EPL code preview
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MessageBubble: assistant turns get a collapsible trace panel underneath.
// ---------------------------------------------------------------------------

const MessageBubble = memo(function MessageBubble({
  message,
  onChoice,
  onReview,
}: {
  message: ChatMessage;
  onChoice: (choice: string, request: AgentUserChoiceRequest) => void;
  onReview: (id: string) => void;
}) {
  const { t } = useTranslation();
  const codeWorkView = useSettingsStore(s => s.codeWorkView);
  const changes = useMemo(() => turnChanges(message.agentTrace), [message.agentTrace]);
  const isUser = message.role === "user";
  const trace = message.agentTrace;
  const pendingChoice = !isUser ? trace?.pendingUserChoice : undefined;
  const displayContent = message.content;
  // Settled reasoning is saved both on the message (replay) and the final
  // trace step (execution history). Render that final step only once.
  const additionalReasoning = message.reasoningContent !== trace?.steps.at(-1)?.reasoningContent
    ? message.reasoningContent : undefined;
  const reasoning = [
    ...(trace?.steps.map(step => step.reasoningContent).filter(Boolean) ?? []),
    additionalReasoning,
  ].filter(Boolean).join("\n\n");

  return (
    <div
      className={cn(
        "message-enter flex gap-3",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "flex min-w-0 max-w-[85%] flex-col gap-2 text-sm leading-6",
          isUser
            ? "user-message-content items-end"
            : "assistant-message-content bg-transparent px-0 text-foreground",
        )}
      >
        {!isUser && reasoning && <ReasoningDisclosure text={reasoning} running={Boolean(message.isStreaming && !displayContent && !message.activeToolCallId)} />}
        {!isUser && trace && trace.toolCallCount > 0 && (
          <AgentTracePanel trace={trace} running={Boolean(message.isStreaming)} activeToolId={message.activeToolCallId} />
        )}
        {isUser ? (
          <p className="user-message-bubble whitespace-pre-wrap break-words px-4 py-3">{displayContent}</p>
        ) : (
          <div className="assistant-response">
            {displayContent && <MarkdownView content={displayContent} />}
            {message.isStreaming && (!trace?.toolCallCount || displayContent) && (!reasoning || displayContent) && <div className="assistant-activity" role="status" aria-label={displayContent ? "正在生成回复" : "正在思考"}><span className="assistant-activity-dot" />{!displayContent && "正在思考"}</div>}
          </div>
        )}

        {!message.isStreaming && displayContent && <ReplyActions text={displayContent} isUser={isUser} timestamp={message.timestamp} />}
        {codeWorkView && changes.length > 0 && <button type="button" className="turn-changes-summary" onClick={() => onReview(message.id)}><Code size={14} />{changes.length} 个文件已更改<span>查看本轮改动</span></button>}

        {pendingChoice && (
          <AgentChoicePrompt
            request={pendingChoice}
            disabled={Boolean(message.isStreaming)}
            onChoice={(choice) => onChoice(choice, pendingChoice)}
          />
        )}

      </div>
    </div>
  );
});

function ReasoningDisclosure({ text, running }: { text: string; running: boolean }) {
  const [open, setOpen] = useState(false);
  const summary = text.split(/\r?\n/).filter(line => line.trim()).at(-1)?.replace(/[*`#]/g, "");
  return <div className="assistant-reasoning" data-running={running} data-expanded={open}>
    <button type="button" className="assistant-reasoning-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
      <Brain size={15} /><span>{running ? "思考中" : "思考过程"}</span>
      {!open && <span className="assistant-reasoning-summary">{summary}</span>}
      <CaretRight size={12} className={open ? "is-expanded" : ""} />
    </button>
    {open && <div className="assistant-reasoning-body"><MarkdownView content={text} /></div>}
  </div>;
}

function ReplyActions({ text, isUser, timestamp }: { text: string; isUser: boolean; timestamp: number }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async () => {
    try {
      await copyText(text);
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1200);
    } catch { toast.error("复制失败，请检查系统剪贴板后重试"); }
  };
  const label = isUser ? "复制消息" : "复制回复";
  const time = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(timestamp);
  return <div className="assistant-actions" data-user={isUser}>
    {isUser && <time dateTime={new Date(timestamp).toISOString()}>{time}</time>}
    <button type="button" className="message-copy" aria-label={copied ? "已复制" : label} onClick={() => void copy()}>{copied ? <Check size={15} /> : <CopySimple size={15} />}<span>{copied ? "已复制" : "复制"}</span></button>
    {!isUser && <time dateTime={new Date(timestamp).toISOString()}>{time}</time>}
  </div>;
}

function AgentChoicePrompt({
  request,
  disabled,
  onChoice,
}: {
  request: AgentUserChoiceRequest;
  disabled: boolean;
  onChoice: (choice: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {request.options.map((option) => {
        const value = option.value ?? option.label;
        return (
          <button
            key={option.id ?? value}
            type="button"
            disabled={disabled}
            className="rounded-md border border-border/70 bg-background px-3 py-1.5 text-xs text-foreground transition hover:border-foreground/30 hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
            onClick={() => onChoice(value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentTracePanel: a compact, collapsible visualisation of all ReAct steps.
// ---------------------------------------------------------------------------

function AgentTracePanel({ trace, running, activeToolId }: { trace: AgentTrace; running: boolean; activeToolId?: string }) {
  const [disclosure, setDisclosure] = useState<{ phase: boolean; open: boolean } | null>(null);
  const open = disclosure?.phase === running ? disclosure.open : running;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  const elapsedMs = Math.max(0, (running ? now : trace.endedAt) - trace.startedAt);
  const steps = trace.steps.filter(step => step.toolCalls.length > 0);
  const currentCall = activeToolId ? steps.flatMap(step => step.toolCalls).find(call => call.id === activeToolId) : null;
  const completedItems = trace.plan?.items.filter(item => item.status === "done" || item.status === "skipped").length ?? 0;
  const summary = currentCall ? toolLabel(currentCall.name)
    : trace.plan?.items.length ? `${completedItems}/${trace.plan.items.length} 项计划已完成`
      : `${trace.toolCallCount} 次工具调用`;
  const artifacts = useMemo(() => {
    const paths = new Set<string>();
    for (const step of trace.steps) for (const result of step.toolResults) {
      const rc = extractResultContent(result.content);
      if (result.ok && rc.success !== false && rc.outputPath && /\.(e|exe|ec)$/i.test(rc.outputPath)) paths.add(rc.outputPath);
    }
    return [...paths];
  }, [trace]);
  let previousThought = "";
  return <>
    <div className="agent-trace-panel" data-running={running} data-expanded={open}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setDisclosure({ phase: running, open: !open })}
        className="agent-process-toggle"
      >
        {running ? <CircleNotch size={14} className="animate-spin" /> : <Check size={14} className={trace.outcome === "answer" ? "" : "invisible"} />}
        <span>{running ? activeToolId ? "正在执行" : "正在思考" : outcomeLabel(trace.outcome)}</span>
        <span className="agent-process-summary">{summary}</span>
        <span className="agent-process-duration">{formatMs(elapsedMs)}</span>
        {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
      </button>
      {open && (
        <div className="agent-process-body">
          {steps.map(step => {
            const thought = parseThought(step.assistantText);
            const showThought = thought && thought !== previousThought && thought !== trace.finalAnswer;
            if (thought) previousThought = thought;
            return <Fragment key={step.index}>
              {showThought && <div className="agent-preamble"><MarkdownView content={thought} /></div>}
              <AgentStepSummary step={step} running={running} activeToolId={activeToolId} />
            </Fragment>;
          })}
          {running && !activeToolId && <div className="agent-next-status" role="status"><span className="assistant-activity-dot" />正在整理下一步…</div>}
        </div>
      )}
    </div>
    {artifacts.length > 0 && <div className="agent-artifacts">{artifacts.map(path => <button type="button" key={path} onClick={() => void openPath(path).catch(error => toast.error(`打开失败：${String(error)}`))}><FileText size={14} />{fileName(path)}<span>打开</span></button>)}</div>}
  </>;
}

// ---------------------------------------------------------------------------
// AgentPlanChecklist: the visible TODO list the model maintains via update_plan.
// Pure presentational; status drives the icon/'strikethrough.
// ---------------------------------------------------------------------------

function AgentPlanChecklist({ plan }: { plan: NonNullable<AgentTrace["plan"]> }) {
  const doneCount = plan.items.filter(
    (item) => item.status === "done" || item.status === "skipped",
  ).length;
  return (
    <div className="agent-plan-checklist mb-1 rounded-md border border-border/60 bg-secondary/30 px-3 py-2">
      <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span>执行计划</span>
        <span className="ml-auto opacity-70">
          {doneCount}/{plan.items.length}
        </span>
      </div>
      <ul className="mt-1.5 space-y-1">
        {plan.items.map((item) => (
          <li key={item.id} className="flex items-start gap-2 text-xs leading-relaxed">
            <span className="mt-0.5 shrink-0">{planStatusIcon(item.status)}</span>
            <span
              className={
                item.status === "done"
                  ? "line-through opacity-55"
                  : item.status === "skipped"
                  ? "line-through opacity-40"
                  : item.status === "in_progress"
                  ? "text-foreground"
                  : "opacity-80"
              }
            >
              {item.title}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function planStatusIcon(status: string) {
  switch (status) {
    case "done":
      return <span className="text-green-500">✓</span>;
    case "in_progress":
      return <span className="text-blue-500 animate-pulse">▸</span>;
    case "skipped":
      return <span className="opacity-50">–</span>;
    default:
      return <span className="opacity-50">○</span>;
  }
}

// ---------------------------------------------------------------------------
// Parse thought from step's assistantText (it's JSON with a thought field)
// ---------------------------------------------------------------------------

function parseThought(text: string): string | null {
  if (!text) return null;
  try {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{")) return trimmed;
    const start = trimmed.indexOf("{");
    if (start < 0) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < trimmed.length; i++) {
      const c = trimmed[i];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          const json = JSON.parse(trimmed.slice(start, i + 1));
          return typeof json.thought === "string" ? json.thought : null;
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Extract key arguments for display
// ---------------------------------------------------------------------------

function formatToolArgs(name: string, args: Record<string, unknown>): string {
  if (name === "update_plan") {
    const items = Array.isArray(args.items) ? args.items as Array<{ title?: string; status?: string }> : [];
    const done = items.filter(item => item.status === "done" || item.status === "skipped").length;
    return `${done}/${items.length}` + (items.find(item => item.status === "in_progress")?.title ? ` · ${items.find(item => item.status === "in_progress")!.title}` : "");
  }
  if (name === "generate_gui_project") {
    const project = args.project as { windows?: Array<{ title?: string; controls?: unknown[] }> } | undefined;
    const windows = project?.windows ?? [];
    return `${windows.map(window => window.title || "窗口").join("、")} · ${windows.reduce((count, window) => count + (window.controls?.length ?? 0), 0)} 个控件`;
  }
  if (/search/.test(name) && name !== "apply_search_replace") return String(args.query ?? args.keyword ?? "");
  if (name === "ask_user_choice") return String(args.question ?? "");
  const path = args.file_path ?? args.path ?? args.target_path ?? args.output_path ?? args.ecode_dir ?? args.root_path;
  if (typeof path === "string" && path) return fileName(path);
  if (typeof args.code === "string") return `${args.code.split("\n").length} 行代码`;
  return "";
}

// ---------------------------------------------------------------------------
// Tool result content extraction
// ---------------------------------------------------------------------------

interface ToolResultContent {
  success?: boolean;
  readyForEdit?: boolean;
  workflowId?: string;
  ecodeDir?: string;
  snapshotPath?: string;
  workflowStatePath?: string;
  buildReportPath?: string;
  sourcePath?: string;
  stage?: string;
  outputPath?: string;
  filePath?: string;
  encoding?: string;
  bytes?: number;
  truncated?: boolean;
  startLine?: number;
  startChar?: number;
  nextStartChar?: number | null;
  hash?: string;
  error?: string;
  stderr?: string;
  stdout?: string;
  nextInstruction?: string;
  repairInstruction?: string;
  changedFiles?: Array<Record<string, unknown>>;
  fileContent?: string;
  outputExcerpt?: string;
  raw: unknown;
}

function extractResultContent(content: unknown): ToolResultContent {
  if (!content || typeof content !== "object") return { raw: content };
  const c = content as Record<string, unknown>;
  return {
    success: typeof c.success === "boolean" ? c.success : undefined,
    readyForEdit: typeof c.ready_for_edit === "boolean" ? c.ready_for_edit : undefined,
    workflowId: typeof c.workflow_id === "string" ? c.workflow_id : undefined,
    ecodeDir: typeof c.ecode_dir === "string" ? c.ecode_dir : undefined,
    snapshotPath: typeof c.snapshot_path === "string" ? c.snapshot_path : undefined,
    workflowStatePath: typeof c.workflow_state_path === "string" ? c.workflow_state_path : undefined,
    buildReportPath: typeof c.build_report_path === "string" ? c.build_report_path : undefined,
    sourcePath: typeof c.source_path === "string" ? c.source_path : undefined,
    stage: typeof c.stage === "string" ? c.stage : undefined,
    outputPath: typeof c.output_path === "string" ? c.output_path : undefined,
    filePath: typeof c.path === "string" ? c.path : undefined,
    encoding: typeof c.encoding === "string" ? c.encoding : undefined,
    bytes: typeof c.bytes === "number" ? c.bytes : undefined,
    truncated: c.is_partial === true || c.truncated === true,
    startLine: typeof c.start_line === "number" ? c.start_line : undefined,
    startChar: typeof c.start_char === "number" ? c.start_char : undefined,
    nextStartChar: typeof c.next_start_char === "number" ? c.next_start_char : null,
    hash: typeof c.code_hash === "string" ? c.code_hash : undefined,
    error: typeof c.error === "string" ? c.error : undefined,
    stderr: typeof c.stderr === "string" ? c.stderr : undefined,
    stdout: typeof c.stdout === "string" ? c.stdout : undefined,
    nextInstruction: typeof c.next_instruction === "string" ? c.next_instruction : undefined,
    repairInstruction: typeof c.repair_instruction === "string" ? c.repair_instruction : undefined,
    changedFiles: Array.isArray(c.changed_files)
      ? c.changed_files.filter((item): item is Record<string, unknown> =>
        Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : undefined,
    fileContent: typeof c.content === "string" ? c.content : undefined,
    outputExcerpt: typeof c.output_excerpt === "string" ? c.output_excerpt : undefined,
    raw: content,
  };
}

function extractToolFailureSummary(rc: ToolResultContent): string | null {
  if (rc.success !== false) return null;
  const text = [rc.error, rc.repairInstruction, rc.stderr, rc.stdout]
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .join("\n");
  if (!text.trim()) return null;

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const diagnostic = lines.find((line) =>
    /错误\(|编译失败|预检查失败|声明行包含默认值|变量指定格式错误|未生成目标|模块文件不存在|启动 .*失败|超时|异常/.test(line),
  ) ?? lines[0];

  return diagnostic.length > 260 ? `${diagnostic.slice(0, 260)}...` : diagnostic;
}

// ---------------------------------------------------------------------------
// File action buttons — open / reveal / save-as
// ---------------------------------------------------------------------------

function FileActions({ filePath }: { filePath: string }) {
  const handleOpen = async () => {
    try {
      await openPath(filePath);
    } catch (err) {
      toast.error(`打开失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleReveal = async () => {
    try {
      await revealItemInDir(filePath);
    } catch (err) {
      toast.error(`打开目录失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSaveAs = async () => {
    try {
      const ext = filePath.split(".").pop() ?? "e";
      const name = filePath.split(/[\\/]/).pop() ?? `file.${ext}`;
      const target = await saveDialog({
        defaultPath: name,
        filters: [{ name: "保存为", extensions: [ext] }],
      });
      if (!target) return;
      await copyFile(filePath, target);
      toast.success("文件已保存");
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="flex items-center gap-1 mt-1">
      <button
        type="button"
        onClick={handleOpen}
        className="agent-file-btn"
      >
        <File className="h-3 w-3" />
        打开文件
      </button>
      <button
        type="button"
        onClick={handleReveal}
        className="agent-file-btn"
      >
        <FolderOpen className="h-3 w-3" />
        打开目录
      </button>
      <button
        type="button"
        onClick={handleSaveAs}
        className="agent-file-btn"
      >
        <DownloadSimple className="h-3 w-3" />
        另存为
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentStepSummary: detailed view of a single ReAct step.
// ---------------------------------------------------------------------------

function AgentStepSummary({ step, running, activeToolId }: { step: AgentStep; running: boolean; activeToolId?: string }) {
  return <div className="agent-step">{step.toolCalls.map(call => {
    const result = step.toolResults.find(item => item.toolCallId === call.id) ?? null;
    return <ToolCallRow key={call.id} call={call} result={result} running={running} active={activeToolId === call.id} />;
  })}</div>;
}

function toolIcon(name: string) {
  if (name === "update_plan") return ListChecks;
  if (/gui/.test(name)) return Layout;
  if (/compile|build|loop/.test(name)) return TerminalWindow;
  if (/save|replace|generate/.test(name)) return PencilSimple;
  if (/search|scan|analyze|inspect|summarize/.test(name)) return MagnifyingGlass;
  return FileText;
}

function ToolCallRow({ call, result, running, active }: { call: ToolCall; result: ToolResult | null; running: boolean; active: boolean }) {
  const [open, setOpen] = useState(false);
  const openPreview = useContext(DocumentPreviewContext);
  const rc = result ? extractResultContent(result.content) : null;
  const failed = Boolean(result && (!result.ok || rc?.success === false));
  const state = result ? failed ? "failed" : "done" : running ? active ? "running" : "queued" : "stopped";
  const Icon = toolIcon(call.name);
  const preview = toolPreviewDocument(call, result);
  const summary = formatToolArgs(call.name, call.arguments);
  const error = result?.error ?? (rc && extractToolFailureSummary(rc)) ?? rc?.error;
  const path = rc?.outputPath ?? rc?.filePath ?? rc?.sourcePath;
  const items = call.name === "update_plan" && Array.isArray(call.arguments.items) ? call.arguments.items as NonNullable<AgentTrace["plan"]>["items"] : null;
  return <div className="agent-tool-row" data-state={state}>
    <div className="agent-tool-line">
      <button type="button" className="agent-tool-toggle" aria-expanded={open} aria-label={`${open ? "收起" : "展开"}${toolLabel(call.name)}详情`} onClick={() => setOpen(value => !value)}>
        <span className="agent-tool-leading">{state === "running" ? <CircleNotch size={15} className="animate-spin" /> : <Icon size={15} />}<CaretRight className="agent-tool-chevron" size={13} /></span>
        <span className="agent-tool-title">{toolLabel(call.name)}</span>
      </button>
      {summary && <><span className="agent-tool-separator">·</span>{preview && openPreview
        ? <button type="button" className="agent-tool-file" onClick={() => openPreview(preview)}>{summary}</button>
        : <button type="button" className="agent-tool-summary" onClick={() => setOpen(value => !value)}>{summary}</button>}</>}
      <span className="agent-tool-state">{state === "running" ? "执行中" : state === "queued" ? "等待执行" : state === "failed" ? "失败" : state === "stopped" ? "未完成" : ""}</span>
    </div>
    {failed && <div className="agent-tool-error" role="status">{error || "执行失败，展开查看详情。"}</div>}
    {open && <div className="agent-tool-details">
      {items && <AgentPlanChecklist plan={{ items, updatedAt: 0 }} />}
      {preview && <button type="button" className="agent-preview-link" onClick={() => openPreview?.(preview)}><FileText size={14} />{preview.title}<span>在右侧预览</span></button>}
      {rc?.fileContent && <CodeBlock code={rc.fileContent} language={documentLanguage(rc.filePath ?? "", rc.fileContent)} startLine={rc.startLine} />}
      {rc?.truncated && <p className="text-muted-foreground">当前为文件片段，可在右侧继续读取。</p>}
      {(rc?.stderr || rc?.stdout || error || rc?.repairInstruction) && <pre className="agent-tool-log">{[error, rc?.repairInstruction, rc?.stderr, rc?.stdout].filter(Boolean).join("\n")}</pre>}
      {rc?.changedFiles && <div className="agent-changed-files">{rc.changedFiles.map((file, index) => <div key={index}>{String(file.relativePath ?? file.path ?? "文件")} <span>+{Number(file.addedLines ?? 0)} / −{Number(file.removedLines ?? 0)}</span></div>)}</div>}
      {path && <div className="agent-detail-path">{shortenPath(path)}<FileActions filePath={path} /></div>}
      {[rc?.buildReportPath, rc?.snapshotPath, rc?.workflowStatePath, rc?.ecodeDir].filter((item): item is string => Boolean(item)).map(item => <div className="agent-detail-path" key={item}>{shortenPath(item)}<FileActions filePath={item} /></div>)}
      <ToolDiagnostics call={call} result={result} />
    </div>}
  </div>;
}

function ToolDiagnostics({ call, result }: { call: ToolCall; result: ToolResult | null }) {
  const [open, setOpen] = useState(false);
  return <details className="agent-tool-diagnostics" onToggle={event => setOpen(event.currentTarget.open)}><summary>调用数据</summary>{open && <pre>{JSON.stringify({ tool: call.name, arguments: call.arguments, result: result?.content, error: result?.error }, null, 2)}</pre>}</details>;
}

// ---------------------------------------------------------------------------
// Code diff: before vs after comparison
// ---------------------------------------------------------------------------

// EPL code extraction from trace — for right-side preview panel
// ---------------------------------------------------------------------------

function isLikelyEplContent(content: string, path = ""): boolean {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (normalized.length < 10) return false;
  if (/\.(epl|e\.txt)$/i.test(path) || /\.(form|class)\.e\.txt$/i.test(path)) {
    return true;
  }
  return /^\.版本|^\.支持库|^\.程序集|^\.子程序|^\.全局变量/m.test(normalized);
}

function toolPreviewDocument(call: ToolCall, result: ToolResult | null): PreviewDocument | null {
  if (!result?.ok) return null;
  const rc = extractResultContent(result.content);
  if (rc.success === false) return null;
  const data = (result.content && typeof result.content === "object" ? result.content : {}) as Record<string, unknown>;
  let path = String(rc.filePath ?? call.arguments.file_path ?? call.arguments.path ?? "");
  let code: string | undefined;
  let loadFromDisk = false;
  if (call.name === "read_file") code = rc.fileContent;
  if (call.name === "save_text_file" && typeof call.arguments.content === "string") code = call.arguments.content;
  if (call.name === "generate_efile_from_code" && typeof call.arguments.code === "string") {
    const title = fileName(String(rc.outputPath ?? "生成的代码.e")) + ".txt";
    return { id: `generated:${call.id}`, title, code: call.arguments.code, language: "epl", sourceLabel: "生成" };
  }
  if (call.name === "generate_gui_project" && typeof data.layout_path === "string") {
    path = data.layout_path; loadFromDisk = true;
  }
  if (call.name === "apply_search_replace") {
    path = String(call.arguments.file_path ?? call.arguments.path ?? rc.filePath ?? ""); loadFromDisk = true;
  }
  if (!path || !isTextPath(path) || (code === undefined && !loadFromDisk)) return null;
  return {
    id: path.replaceAll("\\", "/").toLowerCase(), title: fileName(path), path, code: code ?? "",
    language: documentLanguage(path, code), sourceLabel: call.name === "read_file" ? "读取" : "修改",
    partial: rc.truncated, startLine: rc.startLine, startChar: rc.startChar,
    nextStartChar: rc.nextStartChar, hash: rc.hash, loadFromDisk,
    revision: call.id,
  };
}

function extractEplPreviewItems(trace: AgentTrace | null): PreviewDocument[] {
  if (!trace) return [];
  const files = new Map<string, PreviewDocument>();
  for (const step of trace.steps) for (const call of step.toolCalls) {
    const document = toolPreviewDocument(call, step.toolResults.find(result => result.toolCallId === call.id) ?? null);
    if (document) files.set(document.id, document);
  }
  return [...files.values()];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function shortenPath(fullPath: string): string {
  const parts = fullPath.split(/[\\/]/);
  if (parts.length <= 3) return fullPath;
  return "…/" + parts.slice(-3).join("/");
}

function outcomeLabel(outcome: AgentTrace["outcome"]): string {
  switch (outcome) {
    case "answer":
      return "已完成";
    case "needs_input":
      return "等待选择";
    case "max_steps":
      return "已达到上限";
    case "aborted":
      return "已停止";
    case "error":
      return "失败";
    default:
      return outcome;
  }
}
