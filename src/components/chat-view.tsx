import {
  Fragment,
  memo,
  useRef,
  useEffect,
  useState,
  useCallback,
  useMemo,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ArrowElbowDownLeft,
  CaretDown,
  CaretRight,
  Check,
  Code,
  CopySimple,
  DeviceMobile,
  DownloadSimple,
  File,
  FolderOpen,
  GearSix,
  LinkSimple,
  Plus,
  Power,
  SidebarSimple,
  Square,
  X,
} from "@phosphor-icons/react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MarkdownView } from "@/components/markdown-view";
import { CodeBlock } from "@/components/code-block";
import { EplRenderer, renderEplToHtml } from "@/components/epl-renderer";
import { useChatStore, useActiveSession } from "@/stores/chat";
import { useSettingsStore } from "@/stores/settings";
import { startAgentRun } from "@/services/agent/runner";
import {
  getMobileBridgeState,
  pollMobileActions,
  publishMobileSnapshot,
  startMobileBridge,
  stopMobileBridge,
  type MobileAction,
  type MobileBridgeInfo,
  type MobileSnapshot,
} from "@/services/mobile-bridge";
import { DesktopPet, emitPet } from "@/components/desktop-pet";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { copyFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { useTranslation } from "react-i18next";
import { deriveSessionTitle, getSessionDisplayTitle } from "@/lib/session-title";
import type {
  AgentStep,
  AgentTrace,
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
}

export function ChatView({ sidebarOpen, onToggleSidebar }: ChatViewProps) {
  const { t } = useTranslation();
  const session = useActiveSession();
  const {
    sessions,
    createSession,
    setActiveSession,
    appendMessage,
    updateMessage,
    activeSessionId,
  } = useChatStore();
  const resolveLLMConfig = useSettingsStore((s) => s.resolveLLMConfig);
  const profiles = useSettingsStore((s) => s.profiles);
  const modelCatalogs = useSettingsStore((s) => s.modelCatalogs);
  const activeProfileId = useSettingsStore((s) => s.activeProfileId);
  const updateProfile = useSettingsStore((s) => s.updateProfile);

  const [input, setInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusLine, setStatusLine] = useState<string | null>(null);
  const [selectedPreviewId, setSelectedPreviewId] = useState<string | null>(null);
  const [previewVisible, setPreviewVisible] = useState(true);
  const [previewWidth, setPreviewWidth] = useState(520);
  const [mobileBridge, setMobileBridge] = useState<MobileBridgeInfo | null>(null);
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);
  const [mobileQrDataUrl, setMobileQrDataUrl] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const streamBufRef = useRef("");
  const previewSignatureRef = useRef("");
  const sendingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const activeSessionIdRef = useRef(activeSessionId);
  const isStreamingRef = useRef(isStreaming);
  const pendingMobileActionsRef = useRef<MobileAction[]>([]);
  const processingMobileActionRef = useRef(false);
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  const sessionTitle = session ? getSessionDisplayTitle(session) : "EAiCoding";
  const composerModels = useMemo(() => {
    if (!activeProfile) return [];
    const seen = new Set<string>();
    const fetchedModels = modelCatalogs[activeProfile.id]?.length
      ? modelCatalogs[activeProfile.id]
      : (activeProfile.models ?? []);
    return fetchedModels.filter((model) => {
      if (!model.id || seen.has(model.id)) return false;
      seen.add(model.id);
      return true;
    });
  }, [activeProfile, modelCatalogs]);
  const visibleMessages = useMemo(
    () => session?.messages.filter((m) => m.role !== "tool") ?? [],
    [session?.messages],
  );
  const lastAssistantMessageIndex = useMemo(() => {
    for (let index = visibleMessages.length - 1; index >= 0; index -= 1) {
      if (visibleMessages[index].role === "assistant") return index;
    }
    return -1;
  }, [visibleMessages]);
  const latestAssistantTrace = useMemo(() => {
    const messages = session?.messages ?? [];
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message.role === "assistant" && message.agentTrace) {
        return message.agentTrace;
      }
    }
    return null;
  }, [session?.messages]);
  const previewItems = useMemo(
    () => extractEplPreviewItems(latestAssistantTrace),
    [latestAssistantTrace],
  );
  const activePreview = useMemo(() => {
    if (previewItems.length === 0) return null;
    return (
      previewItems.find((item) => item.id === selectedPreviewId) ??
      previewItems[0]
    );
  }, [previewItems, selectedPreviewId]);
  const mobileSnapshot = useMemo<MobileSnapshot>(() => {
    const activeMobileSession = activeSessionId
      ? sessions.find((item) => item.id === activeSessionId) ?? null
      : null;
    const messages = (activeMobileSession?.messages ?? [])
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-80)
      .map((message) => {
        const content = limitMobileText(
          message.role === "assistant"
            ? sanitizeProtocolText(message.content)
            : message.content,
          8000,
        );
        return {
          id: message.id,
          role: message.role,
          content,
          html: message.role === "assistant" ? renderMobileMessageHtml(content) : undefined,
          timestamp: message.timestamp,
          isStreaming: message.isStreaming,
        };
      });
    const steps = (latestAssistantTrace?.steps ?? []).map((step) => ({
      index: step.index,
      label: mobileStepLabel(step),
      detail: mobileStepDetail(step),
    }));

    return {
      activeSessionId,
      sessions: sessions.slice(0, 40).map((item) => ({
        id: item.id,
        title: getSessionDisplayTitle(item),
        updatedAt: item.updatedAt,
        lastMessagePreview: limitMobileText(
          item.messages
            .filter((message) => message.role === "user" || message.role === "assistant")
            .at(-1)?.content ?? "",
          140,
        ),
      })),
      messages,
      previewItems: previewItems.slice(0, 8).map((item) => ({
        id: item.id,
        title: item.title,
        code: limitMobileText(item.code, 120_000),
        html: renderEplToHtml(item.code, {
          theme: 1,
          showLineNumbers: false,
          className: "mobile-epl-renderer",
        }),
        sourceLabel: item.sourceLabel,
        stepIndex: item.stepIndex,
      })),
      steps,
      statusLine,
      isStreaming,
      updatedAt: Date.now(),
    };
  }, [activeSessionId, isStreaming, latestAssistantTrace?.steps, previewItems, sessions, statusLine]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Scroll to bottom on session switch / initial mount (instant)
  useEffect(() => {
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    });
  }, [activeSessionId]);

  // Scroll to bottom on new messages / streaming updates
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [session?.messages, session?.messages?.length]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [activeSessionId]);

  useEffect(() => {
    if (previewItems.length === 0) {
      setSelectedPreviewId(null);
      previewSignatureRef.current = "";
      return;
    }

    if (!selectedPreviewId || !previewItems.some((item) => item.id === selectedPreviewId)) {
      setSelectedPreviewId(previewItems[0].id);
    }

    const signature = previewItems
      .map((item) => `${item.id}:${item.stepIndex}`)
      .join("|");
    if (signature && signature !== previewSignatureRef.current) {
      previewSignatureRef.current = signature;
      setPreviewVisible(true);
    }
  }, [previewItems, selectedPreviewId]);

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

      requestAnimationFrame(() => textareaRef.current?.focus());
      toast.success(t("chat.attachSuccess", { count: paths.length }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      toast.error(t("chat.attachFailed", { message }));
    }
  }, [isStreaming, t]);

  // ------------------------------------------------------------------------
  // Send / agent loop
  // ------------------------------------------------------------------------

  const runAgentMessage = useCallback(async (options: {
    text: string;
    files?: string[];
    source?: "desktop" | "mobile";
  }) => {
    const text = options.text.trim();
    const files = options.files ?? [];
    if (!text && files.length === 0) return;
    if (isStreamingRef.current || sendingRef.current) {
      if (options.source === "mobile") toast.info("桌面端正在处理上一条消息");
      return;
    }
    sendingRef.current = true;

    let config;
    try {
      config = await resolveLLMConfig();
    } catch (err) {
      sendingRef.current = false;
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`读取模型配置失败：${message}`);
      return;
    }
    if (!config || !config.apiKey) {
      sendingRef.current = false;
      toast.error(t("chat.apiKeyMissing"));
      return;
    }

    let userContent = text;

    if (files.length > 0) {
      const fileLines = files.map((fp) => {
        const ext = fp.split(".").pop()?.toLowerCase() ?? "";
        if (ext === "e") return `- ${fp} （.e 二进制源程序）`;
        if (ext === "ec") return `- ${fp} （.ec 模块，被主程序引用的依赖库）`;
        if (ext === "epl") return `- ${fp} （.epl 文本源码）`;
        return `- ${fp}`;
      }).join("\n");
      const fileBlock = `用户上传了以下本地文件，请用工具读取后再分析（.e/.ec 用 parse_efile，文本文件用 read_file）：\n${fileLines}`;
      userContent = text ? `${fileBlock}\n\n用户补充说明：${text}` : fileBlock;
    }

    let sid = activeSessionIdRef.current;
    if (!sid) {
      sid = createSession(deriveSessionTitle(userContent));
      activeSessionIdRef.current = sid;
    }

    setIsStreaming(true);
    setStatusLine("Thinking...");
    emitPet({ state: "thinking", bubble: "Thinking..." });

    appendMessage(sid, { role: "user", content: userContent });
    const assistantMsgId = appendMessage(sid, {
      role: "assistant",
      content: "",
      isStreaming: true,
    });

    const sessionSnapshot = useChatStore
      .getState()
      .sessions.find((sx) => sx.id === sid);
    const history = (sessionSnapshot?.messages ?? []).filter(
      (m) => m.id !== assistantMsgId,
    );
    const historyWithoutTrigger = history.slice(0, -1);

    streamBufRef.current = "";

    const handle = startAgentRun({
      config,
      userInput: userContent,
      history: historyWithoutTrigger,
      sessionId: sid,
      allowDialog: true,
      onStatus: (status) => setStatusLine(status),
      onAssistantToken: (token, stepIndex) => {
        streamBufRef.current += token;
        if (rafRef.current === null) {
          rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            const extracted = extractStreamingContent(streamBufRef.current);
            if (extracted) {
              updateMessage(sid!, assistantMsgId, {
                content: sanitizeProtocolText(extracted),
                isStreaming: true,
              });
            } else {
              updateMessage(sid!, assistantMsgId, {
                content: `*第 ${stepIndex} 步：推理中...*`,
                isStreaming: true,
              });
            }
          });
        }
        emitPet({ state: "typing", bubble: `Generating · Step ${stepIndex}` });
      },
      onStep: (step, runningTrace) => {
        streamBufRef.current = "";
        updateMessage(sid!, assistantMsgId, {
          content: renderTraceForBubble(runningTrace, /*isFinal*/ false),
          isStreaming: true,
          agentTrace: runningTrace,
        });
        if (step.finishReason === "tool_call") {
          emitPet({
            state: "building",
            bubble: "处理中",
          });
        } else if (step.finishReason === "error") {
          emitPet({ state: "error", bubble: "Error" });
        }
      },
    });
    abortRef.current = handle.abort;

    try {
      const trace = await handle.promise;
      const finalContent = renderTraceForBubble(trace, /*isFinal*/ true);
      updateMessage(sid, assistantMsgId, {
        content: finalContent,
        isStreaming: false,
        agentTrace: trace,
      });

      if (trace.outcome === "answer") {
        if (trace.toolCallCount > 0) {
          toast.success("处理完成");
          emitPet({ state: "happy", bubble: "Done" });
        } else {
          emitPet({ state: "happy", bubble: "Answered" });
        }
      } else if (trace.outcome === "max_steps") {
        toast.warning("Reached max steps");
        emitPet({ state: "notification", bubble: "Max steps" });
      } else if (trace.outcome === "aborted") {
        toast.info("Stopped");
        emitPet({ state: "idle", bubble: "Stopped" });
      } else {
        toast.error("Run failed");
        emitPet({ state: "error", bubble: "Error" });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateMessage(sid, assistantMsgId, {
        content: `Run interrupted: ${message}`,
        isStreaming: false,
      });
      toast.error(`Run interrupted: ${message}`);
      emitPet({ state: "error", bubble: "Interrupted" });
    } finally {
      abortRef.current = null;
      sendingRef.current = false;
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setIsStreaming(false);
      setStatusLine(null);
    }
  }, [
    resolveLLMConfig,
    createSession,
    appendMessage,
    updateMessage,
    t,
  ]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const files = attachedFiles;
    if (!text && files.length === 0) return;
    setInput("");
    setAttachedFiles([]);
    await runAgentMessage({ text, files, source: "desktop" });
  }, [input, attachedFiles, runAgentMessage]);

  const handleStartMobileBridge = useCallback(async () => {
    try {
      const info = await startMobileBridge();
      setMobileBridge(info);
      setMobilePanelOpen(true);
      toast.success("手机模式已开启");
    } catch (err) {
      toast.error(`开启手机模式失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const handleStopMobileBridge = useCallback(async () => {
    try {
      const info = await stopMobileBridge();
      setMobileBridge(info);
      setMobileQrDataUrl(null);
      setMobilePanelOpen(false);
      toast.info("手机模式已关闭");
    } catch (err) {
      toast.error(`关闭手机模式失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  const handleToggleMobileBridge = useCallback(async () => {
    if (mobileBridge?.running) {
      setMobilePanelOpen((open) => !open);
      return;
    }
    await handleStartMobileBridge();
  }, [handleStartMobileBridge, mobileBridge?.running]);

  const handleCopyMobileLink = useCallback(async () => {
    const url = mobileBridge?.url || mobileBridge?.localUrl;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success("手机链接已复制");
    } catch (err) {
      toast.error(`复制失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [mobileBridge?.localUrl, mobileBridge?.url]);

  const processMobileAction = useCallback(async (action: MobileAction) => {
    if (action.type === "set_active_session") {
      if (action.sessionId) {
        setActiveSession(action.sessionId);
        activeSessionIdRef.current = action.sessionId;
      }
      return;
    }

    if (action.type === "new_session") {
      const id = createSession();
      activeSessionIdRef.current = id;
      return;
    }

    if (action.type === "send_message" || action.type === "quick_action") {
      const text = (action.content ?? action.prompt ?? "").trim();
      if (!text) return;
      await runAgentMessage({ text, source: "mobile" });
    }
  }, [createSession, runAgentMessage, setActiveSession]);

  const drainMobileActions = useCallback(async () => {
    if (processingMobileActionRef.current || isStreamingRef.current) return;
    const action = pendingMobileActionsRef.current.shift();
    if (!action) return;

    processingMobileActionRef.current = true;
    try {
      await processMobileAction(action);
    } finally {
      processingMobileActionRef.current = false;
      if (pendingMobileActionsRef.current.length > 0) {
        window.setTimeout(() => {
          void drainMobileActions();
        }, 200);
      }
    }
  }, [processMobileAction]);

  useEffect(() => {
    let alive = true;
    getMobileBridgeState()
      .then((info) => {
        if (alive) setMobileBridge(info);
      })
      .catch(() => {
        if (alive) setMobileBridge(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const url = mobileBridge?.url || mobileBridge?.localUrl;
    if (!mobileBridge?.running || !url) {
      setMobileQrDataUrl(null);
      return;
    }

    let alive = true;
    QRCode.toDataURL(url, {
      margin: 1,
      width: 192,
      color: {
        dark: "#0f172a",
        light: "#ffffff",
      },
    })
      .then((dataUrl) => {
        if (alive) setMobileQrDataUrl(dataUrl);
      })
      .catch((err) => {
        if (alive) {
          setMobileQrDataUrl(null);
          toast.error(`二维码生成失败：${err instanceof Error ? err.message : String(err)}`);
        }
      });

    return () => {
      alive = false;
    };
  }, [mobileBridge?.localUrl, mobileBridge?.running, mobileBridge?.url]);

  useEffect(() => {
    if (!mobileBridge?.running) return;
    const timeout = window.setTimeout(() => {
      publishMobileSnapshot(mobileSnapshot).catch(() => {
        // 手机页会在下一轮轮询恢复，不打扰桌面端主流程。
      });
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [mobileBridge?.running, mobileSnapshot]);

  useEffect(() => {
    if (!mobileBridge?.running) return;

    let alive = true;
    const tick = async () => {
      try {
        const actions = await pollMobileActions();
        if (!alive || actions.length === 0) return;
        pendingMobileActionsRef.current.push(...actions);
        void drainMobileActions();
      } catch {
        // 手机端临时断开时不影响桌面 agent。
      }
    };

    void tick();
    const interval = window.setInterval(tick, 900);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [drainMobileActions, mobileBridge?.running]);

  const handleStop = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
    setStatusLine("正在停止...");
    emitPet({ state: "idle", bubble: "Stopping" });
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <TooltipProvider>
      <div className="relative h-full overflow-hidden bg-background">
        <div
          className="flex h-full min-w-0 flex-col transition-[padding] duration-200"
          style={{
            paddingRight: activePreview && previewVisible ? previewWidth + 16 : 0,
          }}
        >
          <header className="flex items-center gap-2 px-4 py-2.5 shrink-0">
            {!sidebarOpen && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg text-muted-foreground"
                    onClick={onToggleSidebar}
                  >
                    <SidebarSimple className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>打开侧栏</TooltipContent>
              </Tooltip>
            )}
            <h2 className="text-sm font-medium truncate flex-1 text-muted-foreground">
              {sessionTitle}
            </h2>
            {statusLine && (
              <span className="text-xs text-muted-foreground hidden md:flex items-center gap-1">
                <GearSix className="h-3.5 w-3.5 animate-spin" />
                {statusLine}
              </span>
            )}
            {activePreview && !previewVisible && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 rounded-lg text-muted-foreground"
                    onClick={() => setPreviewVisible(true)}
                  >
                    <Code className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {previewItems.length > 1
                    ? `代码预览 (${previewItems.length})`
                    : "代码预览"}
                </TooltipContent>
              </Tooltip>
            )}
          </header>

          <ScrollArea className="flex-1 px-0">
            <div className="mx-auto max-w-3xl px-6 py-6 space-y-6">
              {!session?.messages.length && (
                <div className="flex min-h-[46vh] flex-col items-center justify-center text-center text-muted-foreground">
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

              {visibleMessages.map((msg, index) => (
                <Fragment key={msg.id}>
                  <MessageBubble message={msg} />
                  {index === lastAssistantMessageIndex && (
                    <div className="message-enter chat-pet-row flex justify-start">
                      <DesktopPet placement="chat" />
                    </div>
                  )}
                </Fragment>
              ))}
              <div ref={bottomRef} />
            </div>
          </ScrollArea>

          <div className="px-5 pb-5 pt-2 shrink-0">
            <div className="code-composer-shell mx-auto flex max-w-3xl flex-col">
              {attachedFiles.length > 0 && (
                <div className="composer-file-chips">
                  {attachedFiles.map((fp) => (
                    <span key={fp} className="claude-chip composer-file-chip">
                      <File className="h-3 w-3 shrink-0" />
                      <span className="truncate max-w-[200px]">
                        {fp.split(/[\\/]/).pop()}
                      </span>
                      <button
                        type="button"
                        className="composer-file-chip-close"
                        onClick={() =>
                          setAttachedFiles((prev) => prev.filter((p) => p !== fp))
                        }
                        aria-label="Remove"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="code-composer-input-wrap">
                <div className="code-composer-input-mirror" aria-hidden="true">
                  {input || " "}
                </div>
                <Textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder={attachedFiles.length > 0 ? "补充你的目标" : "输入你的需求"}
                  className="code-composer-input"
                  rows={1}
                />
                {isStreaming ? (
                  <button
                    type="button"
                    className="code-composer-send is-active"
                    onClick={handleStop}
                    aria-label="Stop"
                  >
                    <Square className="h-3.5 w-3.5" weight="fill" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="code-composer-send"
                    onClick={handleSend}
                    disabled={!input.trim() && attachedFiles.length === 0}
                    aria-label="Send"
                  >
                    <ArrowElbowDownLeft className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
              <div className="code-composer-toolbar">
                <div className="flex items-center gap-2">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="code-composer-plus"
                        onClick={handleAttachFile}
                        disabled={isStreaming}
                        aria-label={t("chat.attachFile")}
                      >
                        <Plus className="h-4 w-4" weight="bold" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("chat.attachFile")}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          "code-composer-plus",
                          mobileBridge?.running && "is-mobile-running",
                        )}
                        onClick={handleToggleMobileBridge}
                        aria-label="手机模式"
                      >
                        <DeviceMobile className="h-4 w-4" weight="regular" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {mobileBridge?.running ? "显示手机二维码" : "开启手机模式"}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <div className="flex items-center gap-2">
                  {activeProfile && composerModels.length > 0 ? (
                    <Select
                      value={activeProfile.model}
                      onValueChange={(model) => updateProfile(activeProfile.id, { model })}
                    >
                      <SelectTrigger className="code-composer-model">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent align="end">
                        {composerModels.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            <span className="flex min-w-0 items-center gap-3">
                              <span className="min-w-0 truncate font-mono">{model.id}</span>
                              {model.ownedBy && (
                                <span className="shrink-0 text-muted-foreground">
                                  {model.ownedBy}
                                </span>
                              )}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="code-composer-model-empty">
                      {activeProfile ? "未获取模型" : "未配置模型"}
                    </span>
                  )}
                  <span className="code-composer-status-dot" />
                </div>
                </div>
              <Dialog
                open={Boolean(mobileBridge?.running && mobilePanelOpen)}
                onOpenChange={(open) => {
                  if (!open) setMobilePanelOpen(false);
                  else if (mobileBridge?.running) setMobilePanelOpen(true);
                }}
              >
                <DialogContent className="mobile-bridge-dialog">
                  <DialogHeader>
                    <DialogTitle>手机扫码继续写代码</DialogTitle>
                  </DialogHeader>
                  <div className="mobile-bridge-panel">
                    <div className="mobile-bridge-qr-wrap">
                      {mobileQrDataUrl ? (
                        <img
                          className="mobile-bridge-qr"
                          src={mobileQrDataUrl}
                          alt="手机模式二维码"
                        />
                      ) : (
                        <div className="mobile-bridge-qr-placeholder">
                          <GearSix className="h-4 w-4 animate-spin" />
                        </div>
                      )}
                    </div>
                    <div className="mobile-bridge-copy">
                      <button
                        type="button"
                        className="mobile-bridge-link"
                        onClick={handleCopyMobileLink}
                      >
                        <LinkSimple className="h-3.5 w-3.5" />
                        <span>{mobileBridge?.url || mobileBridge?.localUrl}</span>
                      </button>
                    </div>
                    <div className="mobile-bridge-actions">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            className="mobile-bridge-icon-btn"
                            onClick={handleStopMobileBridge}
                            aria-label="关闭手机模式"
                          >
                            <Power className="h-4 w-4" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent>关闭手机模式</TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            </div>
          </div>
        </div>
        {activePreview && previewVisible && (
          <CodePreviewPanel
            items={previewItems}
            activeId={activePreview.id}
            onSelect={setSelectedPreviewId}
            onClose={() => setPreviewVisible(false)}
            width={previewWidth}
            onResize={setPreviewWidth}
          />
        )}
      </div>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Tool name → readable label mapping
// ---------------------------------------------------------------------------

const TOOL_LABELS: Record<string, string> = {
  scan_easy_language_env: "扫描易语言环境",
  search_jingyi_module: "查询精易模块",
  read_file: "读取文件",
  parse_efile: "解析源码",
  export_efile_to_ecode: "导出 ecode 工程",
  summarize_ecode_project: "生成项目地图",
  analyze_ecode_project: "分析项目质量",
  inspect_ecode_context: "整理项目上下文",
  generate_efile_from_ecode: "回编 ecode 工程",
  generate_efile_from_code: "生成 .e 文件",
  compile_efile: "编译",
  build_ecode_project: "回编并编译",
  closed_loop_build: "闭环编译",
  save_text_file: "保存文件",
  pick_file: "选择文件",
  pick_save_path: "选择保存路径",
};

function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

function limitMobileText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.72));
  const tail = text.slice(-Math.floor(maxChars * 0.18));
  return `${head}\n\n... 已省略 ${text.length - maxChars} 字 ...\n\n${tail}`;
}

function mobileStepLabel(step: AgentStep): string {
  if (step.toolCalls.length > 0) {
    return step.toolCalls.map((call) => toolLabel(call.name)).join("、");
  }
  if (step.finishReason === "answer") return "生成回复";
  if (step.finishReason === "error") return "错误";
  if (step.finishReason === "format_retry") return "继续推理";
  return "模型推理";
}

function mobileStepDetail(step: AgentStep): string {
  const toolDetails = step.toolCalls
    .map((call, index) => {
      const result = step.toolResults[index];
      const status = result ? (result.ok ? "成功" : "失败") : "执行中";
      const detail = result?.error
        ? `：${result.error}`
        : result
          ? ` · ${formatMs(result.durationMs)}`
          : "";
      return `${toolLabel(call.name)} ${status}${detail}`;
    })
    .join("\n");
  if (toolDetails) return toolDetails;
  const thought = parseThought(step.assistantText);
  if (thought) return thought;
  return sanitizeProtocolText(step.assistantText).slice(0, 320);
}

// ---------------------------------------------------------------------------
// Trace rendering
// ---------------------------------------------------------------------------

/** Strip leaked ReAct protocol artifacts (raw JSON / XML tool-call blocks)
 *  from text that is shown to the user in the assistant bubble. */
function sanitizeProtocolText(text: string): string {
  let cleaned = text;

  // Remove XML-style tool call blocks: <tool_call>...</tool_call>
  cleaned = cleaned.replace(/<tool_call>\s*[\s\S]*?<\/tool_call>/gi, "").trim();

  // Remove standalone XML fragments: <function=...>...</function>
  cleaned = cleaned.replace(/<function=[^>]*>[\s\S]*?<\/function>/gi, "").trim();

  // Remove <parameter=...>...</parameter> fragments
  cleaned = cleaned.replace(/<parameter=[^>]*>[\s\S]*?<\/parameter>/gi, "").trim();

  const protocolJson = extractProtocolJson(cleaned);
  if (protocolJson) {
    const parsed = parseProtocolJson(protocolJson.json);
    if (parsed) {
      if (typeof parsed.final_answer === "string") {
        cleaned = `${cleaned.slice(0, protocolJson.start)}${parsed.final_answer}${cleaned.slice(protocolJson.end)}`.trim();
      } else if (typeof parsed.answer === "string") {
        cleaned = `${cleaned.slice(0, protocolJson.start)}${parsed.answer}${cleaned.slice(protocolJson.end)}`.trim();
      } else if ("tool_calls" in parsed || "thought" in parsed) {
        cleaned = `${cleaned.slice(0, protocolJson.start)}${cleaned.slice(protocolJson.end)}`.trim();
      }
    }
  }

  // Remove leaked raw JSON protocol objects containing tool_calls or thought.
  // Uses bracket matching to handle nested objects correctly.
  cleaned = cleaned.replace(/\{[\s\S]{0,20}"(?:thought|tool_calls)"[\s\S]*$/gm, (match) => {
    return stripProtocolJson(match);
  });

  // Also handle JSON at start of text
  if (cleaned.startsWith("{")) {
    cleaned = stripProtocolJson(cleaned);
  }

  return cleaned.trim() || text.trim();
}

function extractProtocolJson(text: string): { json: string; start: number; end: number } | null {
  const firstBrace = text.indexOf("{");
  if (firstBrace < 0) return null;
  if (!/"(?:thought|tool_calls|final_answer|answer)"/.test(text.slice(firstBrace, firstBrace + 120))) {
    return null;
  }

  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = firstBrace; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        return { json: text.slice(firstBrace, i + 1), start: firstBrace, end: i + 1 };
      }
    }
  }
  return null;
}

function parseProtocolJson(jsonStr: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(jsonStr);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stripProtocolJson(text: string): string {
  const start = text.indexOf("{");
  if (start < 0) return text;

  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }

  if (end < 0) return "";

  const jsonStr = text.slice(start, end + 1);
  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed === "object" && parsed !== null) {
      if (typeof parsed.final_answer === "string") return parsed.final_answer + text.slice(end + 1);
      if (typeof parsed.answer === "string") return parsed.answer + text.slice(end + 1);
      if ("tool_calls" in parsed || "thought" in parsed) {
        const remainder = text.slice(end + 1).trim();
        return remainder;
      }
    }
  } catch { /* not valid JSON */ }

  return text;
}

/** Build the markdown body that is shown in the assistant bubble while or
 *  after the agent is running. We use markdown so MarkdownView keeps code
 *  highlighting and link rendering. */
function renderTraceForBubble(trace: AgentTrace, isFinal: boolean): string {
  const lines: string[] = [];
  if (!isFinal) {
    const lastStep = trace.steps[trace.steps.length - 1];
    if (lastStep) {
      if (lastStep.finishReason === "format_retry" && trace.steps.length > 1) {
        lines.push(`*第 ${trace.steps.length} 步：继续处理中...*`);
      } else {
        const toolNames = lastStep.toolCalls
          .map((tc) => toolLabel(tc.name))
          .join("、");
        if (toolNames) {
          lines.push(`*第 ${trace.steps.length} 步：${toolNames}...*`);
        } else {
          lines.push(`*第 ${trace.steps.length} 步：推理中...*`);
        }
      }
    } else {
      lines.push("*推理中...*");
    }
    lines.push("");
  }
  if (trace.finalAnswer) {
    lines.push(sanitizeProtocolText(trace.finalAnswer));
    lines.push("");
  } else if (isFinal) {
    lines.push("_(No final answer)_");
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CodePreviewPanel: right-side EPL code preview
// ---------------------------------------------------------------------------

function CodePreviewPanel({
  items,
  activeId,
  onSelect,
  onClose,
  width,
  onResize,
}: {
  items: EplPreviewData[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  width: number;
  onResize: (w: number) => void;
}) {
  const [copied, setCopied] = useState(false);
  const dragging = useRef(false);
  const activePreview = items.find((item) => item.id === activeId) ?? items[0];

  const handleOpen = async () => {
    if (!activePreview?.path) return;
    try {
      await openPath(activePreview.path);
    } catch (err) {
      toast.error(`打开失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleReveal = async () => {
    if (!activePreview?.path) return;
    try {
      await revealItemInDir(activePreview.path);
    } catch (err) {
      toast.error(`打开目录失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleSaveAs = async () => {
    if (!activePreview) return;
    try {
      const ext = "txt";
      const originalName = activePreview.path?.split(/[\\/]/).pop()
        ?? activePreview.title.replace(/[\\/:*?"<>|]/g, "_");
      const name = /\.(epl|txt)$/i.test(originalName)
        ? originalName
        : `${originalName}.txt`;
      const target = await saveDialog({
        defaultPath: name,
        filters: [{ name: "易语言代码", extensions: [ext, "epl"] }],
      });
      if (!target) return;
      await writeTextFile(target, activePreview.code);
      toast.success("代码已保存");
    } catch (err) {
      toast.error(`保存失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleCopy = async () => {
    if (!activePreview) return;
    try {
      await navigator.clipboard.writeText(activePreview.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* ignore */ }
  };

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startWidth = width;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const newWidth = Math.min(800, Math.max(280, startWidth - (ev.clientX - startX)));
      onResize(newWidth);
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width, onResize]);

  if (!activePreview) return null;

  return (
    <div className="code-preview-panel" style={{ width }}>
      <div
        className="code-preview-resize-handle"
        onMouseDown={handleDragStart}
      />
      <div className="code-preview-header">
        <div className="code-preview-heading">
          <span className="code-preview-title">易语言代码</span>
          <span className="code-preview-count">{items.length} 个片段</span>
        </div>
        <span className="code-preview-spacer" />
        <div className="flex items-center gap-0.5">
          {activePreview.path && (
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="code-preview-icon-button"
                    onClick={handleOpen}
                    aria-label="打开文件"
                  >
                    <File className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>打开文件</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="code-preview-icon-button"
                    onClick={handleReveal}
                    aria-label="打开目录"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>打开目录</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="code-preview-icon-button"
                    onClick={handleSaveAs}
                    aria-label="另存为"
                  >
                    <DownloadSimple className="h-3.5 w-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent>另存为</TooltipContent>
              </Tooltip>
            </>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="code-preview-icon-button"
                onClick={handleCopy}
                aria-label="复制代码"
              >
                {copied ? <Check className="h-3.5 w-3.5" /> : <CopySimple className="h-3.5 w-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent>{copied ? "已复制" : "复制代码"}</TooltipContent>
          </Tooltip>
          <button
            type="button"
            className="code-preview-close"
            onClick={onClose}
            aria-label="关闭预览"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="code-preview-content">
        <section className="code-preview-main">
          <div className="code-preview-meta">
            {items.length > 1 ? (
              <Select value={activePreview.id} onValueChange={onSelect}>
                <SelectTrigger className="code-preview-select">
                  <SelectValue placeholder="选择易语言文件" />
                </SelectTrigger>
                <SelectContent>
                  {items.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="code-preview-current-row">
                <span className="code-preview-current-title" title={activePreview.title}>
                  {activePreview.title}
                </span>
                <span className="code-preview-current-badge">
                  {activePreview.sourceLabel}
                </span>
              </div>
            )}
            {activePreview.path && (
              <div className="code-preview-current-path" title={activePreview.path}>
                {shortenPath(activePreview.path)}
              </div>
            )}
          </div>
          <div className="code-preview-body">
            <EplRenderer code={activePreview.code} theme={1} showLineNumbers={false} />
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageBubble: assistant turns get a collapsible trace panel underneath.
// ---------------------------------------------------------------------------

const MessageBubble = memo(function MessageBubble({ message }: { message: ChatMessage }) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  const trace = message.agentTrace;
  const displayContent = isUser
    ? message.content
    : sanitizeProtocolText(message.content || t("chat.emptyAssistantMessage"));

  return (
    <div
      className={cn(
        "message-enter flex gap-3",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "flex max-w-[85%] flex-col gap-2 rounded-2xl px-4 py-3 text-sm leading-6",
          isUser
            ? "user-message-bubble"
            : "bg-transparent px-0 text-foreground",
          message.isStreaming && "streaming-cursor",
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap break-words">{displayContent}</p>
        ) : (
          <MarkdownView content={displayContent} />
        )}

        {!isUser && trace && trace.steps.length > 0 && (
          <AgentTracePanel trace={trace} />
        )}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// AgentTracePanel: a compact, collapsible visualisation of all ReAct steps.
// ---------------------------------------------------------------------------

function AgentTracePanel({ trace }: { trace: AgentTrace }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const stepCount = trace.steps.length;
  const elapsedMs = Math.max(0, trace.endedAt - trace.startedAt);

  const summary = useMemo(() => {
    return t("chat.traceSummary", {
      stepCount,
      elapsed: formatMs(elapsedMs),
      outcome: outcomeLabel(trace.outcome),
    });
  }, [stepCount, elapsedMs, trace.outcome, t]);

  const codeDiff = useMemo(() => extractCodeDiff(trace), [trace]);

  return (
    <div className="agent-trace-panel overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-0 py-1.5 text-xs text-muted-foreground hover:text-foreground transition"
      >
        {open ? (
          <CaretDown className="h-3.5 w-3.5" />
        ) : (
          <CaretRight className="h-3.5 w-3.5" />
        )}
        <span className="opacity-80">处理过程</span>
        <span className="ml-auto opacity-60">{summary}</span>
      </button>
      {open && (
        <div className="pl-5 pr-0 py-1 space-y-2 text-xs">
          {trace.steps.map((step) => (
            <AgentStepSummary key={step.index} step={step} />
          ))}
          {codeDiff && <CodeDiffPanel diff={codeDiff} />}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Parse thought from step's assistantText (it's JSON with a thought field)
// ---------------------------------------------------------------------------

function parseThought(text: string): string | null {
  if (!text) return null;
  try {
    const trimmed = text.trim();
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
  switch (name) {
    case "read_file":
      return String(args.file_path ?? "");
    case "parse_efile":
    case "export_efile_to_ecode":
    case "compile_efile":
      return String(args.target_path ?? "");
    case "summarize_ecode_project":
    case "analyze_ecode_project":
    case "inspect_ecode_context":
    case "build_ecode_project":
      return String(args.ecode_dir ?? "");
    case "generate_efile_from_ecode":
      return String(args.ecode_dir ?? args.output_path ?? "");
    case "generate_efile_from_code": {
      const code = String(args.code ?? "");
      return code.length > 60 ? code.slice(0, 60) + "..." : code;
    }
    case "save_text_file":
      return String(args.path ?? "");
    default: {
      const raw = JSON.stringify(args);
      return raw.length > 80 ? raw.slice(0, 80) + "..." : raw;
    }
  }
}

// ---------------------------------------------------------------------------
// Tool result content extraction
// ---------------------------------------------------------------------------

interface ToolResultContent {
  success?: boolean;
  outputPath?: string;
  filePath?: string;
  encoding?: string;
  bytes?: number;
  truncated?: boolean;
  error?: string;
  stderr?: string;
  stdout?: string;
  fileContent?: string;
  outputExcerpt?: string;
  raw: unknown;
}

function extractResultContent(content: unknown): ToolResultContent {
  if (!content || typeof content !== "object") return { raw: content };
  const c = content as Record<string, unknown>;
  return {
    success: typeof c.success === "boolean" ? c.success : undefined,
    outputPath: typeof c.output_path === "string" ? c.output_path : undefined,
    filePath: typeof c.path === "string" ? c.path : undefined,
    encoding: typeof c.encoding === "string" ? c.encoding : undefined,
    bytes: typeof c.bytes === "number" ? c.bytes : undefined,
    truncated: typeof c.truncated === "boolean" ? c.truncated : undefined,
    error: typeof c.error === "string" ? c.error : undefined,
    stderr: typeof c.stderr === "string" ? c.stderr : undefined,
    stdout: typeof c.stdout === "string" ? c.stdout : undefined,
    fileContent: typeof c.content === "string" ? c.content : undefined,
    outputExcerpt: typeof c.output_excerpt === "string" ? c.output_excerpt : undefined,
    raw: content,
  };
}

function extractToolFailureSummary(rc: ToolResultContent): string | null {
  if (rc.success !== false) return null;
  const text = [rc.error, rc.stderr, rc.stdout]
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

function AgentStepSummary({ step }: { step: AgentStep }) {
  const [expanded, setExpanded] = useState(false);
  const thought = useMemo(() => parseThought(step.assistantText), [step.assistantText]);
  const elapsed = formatMs(Math.max(0, step.endedAt - step.startedAt));

  const toolSummary = step.toolCalls.length > 0
    ? step.toolCalls.map((tc) => toolLabel(tc.name)).join("、")
    : step.finishReason === "answer"
      ? "生成回复"
      : step.finishReason === "error"
        ? "错误"
        : "推理";

  const hasDetails = step.toolCalls.length > 0 || thought;

  return (
    <div className="agent-step rounded-md overflow-hidden">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        className={cn(
          "w-full flex items-center gap-2 px-2 py-1.5 text-left",
          hasDetails && "hover:bg-background/40 cursor-pointer",
          !hasDetails && "cursor-default",
        )}
      >
        {hasDetails ? (
          expanded ? <CaretDown className="h-3 w-3 shrink-0" /> : <CaretRight className="h-3 w-3 shrink-0" />
        ) : (
          <span className="w-3 shrink-0" />
        )}
        <span className="font-medium opacity-80">第 {step.index} 步</span>
        <span className="opacity-60 truncate flex-1">{toolSummary}</span>
        <span className="opacity-50 shrink-0">{elapsed}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-2 pt-1 space-y-2">
          {thought && (
            <p className="italic text-muted-foreground">{thought}</p>
          )}
          {step.toolCalls.map((tc, i) => {
            const result = step.toolResults[i];
            const rc = result ? extractResultContent(result.content) : null;
            return (
              <ToolCallCard
                key={tc.id}
                call={tc}
                result={result ?? null}
                rc={rc}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ToolCallCard: single tool call + its result
// ---------------------------------------------------------------------------

function ToolCallCard({
  call,
  result,
  rc,
}: {
  call: ToolCall;
  result: ToolResult | null;
  rc: ToolResultContent | null;
}) {
  const [showResult, setShowResult] = useState(false);
  const ok = result?.ok ?? true;
  const argPreview = formatToolArgs(call.name, call.arguments);
  const failureSummary = rc ? extractToolFailureSummary(rc) : null;

  return (
    <div className="agent-tool-card">
      <div className="flex items-center gap-2">
        <span className={cn(
          "agent-tool-badge",
          ok ? "agent-tool-badge-ok" : "agent-tool-badge-err",
        )}>
          {ok ? <Check className="h-2.5 w-2.5" /> : <X className="h-2.5 w-2.5" />}
        </span>
        <span className="font-medium">{toolLabel(call.name)}</span>
        {result && (
          <span className="opacity-50 ml-auto">{formatMs(result.durationMs)}</span>
        )}
      </div>

      {argPreview && (
        <p className="text-muted-foreground truncate mt-0.5 pl-5 font-mono text-[10px]">
          {argPreview}
        </p>
      )}

      {rc && (
        <div className="mt-1 pl-5 space-y-1">
          {rc.filePath && rc.encoding && (
            <p className="text-muted-foreground">
              {rc.filePath} · {rc.encoding} · {rc.bytes != null ? `${rc.bytes} 字节` : ""}
              {rc.truncated && " · 已截断"}
            </p>
          )}
          {rc.success !== undefined && (
            <p className={rc.success ? "text-green-600 dark:text-green-400" : "text-red-500"}>
              {rc.success ? "成功" : "失败"}
              {rc.outputPath && ` → ${rc.outputPath.split(/[\\/]/).pop()}`}
            </p>
          )}
          {failureSummary && (
            <p className="text-red-500 break-all">
              {failureSummary}
            </p>
          )}
          {rc.error && !rc.stderr && (
            <p className="text-red-500 break-all">{rc.error}</p>
          )}
          {rc.outputPath && rc.success && (
            <FileActions filePath={rc.outputPath} />
          )}

          {(rc.stderr || rc.stdout || rc.fileContent) && (
            <button
              type="button"
              onClick={() => setShowResult((v) => !v)}
              className="text-muted-foreground hover:text-foreground transition text-[10px] underline underline-offset-2"
            >
              {showResult ? "收起详情" : "查看详情"}
            </button>
          )}
          {showResult && (
            <div className="agent-result-block">
              {rc.stderr && (
                <pre className="text-red-400 whitespace-pre-wrap break-all">
                  {rc.stderr.slice(0, 2000)}
                </pre>
              )}
              {rc.stdout && (
                <pre className="whitespace-pre-wrap break-all">
                  {rc.stdout.slice(0, 1000)}
                </pre>
              )}
              {rc.fileContent && (
                <pre className="whitespace-pre-wrap break-all">
                  {rc.fileContent.slice(0, 2000)}
                  {(rc.fileContent.length > 2000) && "\n... (已截断)"}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Code diff: before vs after comparison
// ---------------------------------------------------------------------------

interface CodeDiffData {
  originalCode: string;
  optimizedCode: string;
  originalPath: string;
}

function extractCodeDiff(trace: AgentTrace): CodeDiffData | null {
  const originals = new Map<string, string>();
  let fallbackOriginalCode: string | null = null;
  let fallbackOriginalPath = "";
  let diffCandidate: CodeDiffData | null = null;

  for (const step of trace.steps) {
    for (let i = 0; i < step.toolCalls.length; i++) {
      const call = step.toolCalls[i];
      const result = step.toolResults[i];
      if (!result?.ok) continue;

      if (call.name === "read_file") {
        const rc = extractResultContent(result.content);
        const path = rc.filePath ?? String(call.arguments.file_path ?? "");
        if (rc.fileContent && isLikelyEplContent(rc.fileContent, path)) {
          if (path) {
            originals.set(path, rc.fileContent);
          }
          if (!fallbackOriginalCode) {
            fallbackOriginalCode = rc.fileContent;
            fallbackOriginalPath = path;
          }
        }
      }

      if (call.name === "save_text_file") {
        const path = String(call.arguments.path ?? "");
        const content = typeof call.arguments.content === "string"
          ? call.arguments.content
          : null;
        if (!content || !isLikelyEplContent(content, path)) continue;

        const original = originals.get(path) ?? fallbackOriginalCode;
        if (original && original !== content) {
          diffCandidate = {
            originalCode: original,
            optimizedCode: content,
            originalPath: path || fallbackOriginalPath,
          };
        }
      }

      if (call.name === "generate_efile_from_code") {
        const code = typeof call.arguments.code === "string"
          ? call.arguments.code
          : null;
        if (code && fallbackOriginalCode && fallbackOriginalCode !== code) {
          diffCandidate = {
            originalCode: fallbackOriginalCode,
            optimizedCode: code,
            originalPath: fallbackOriginalPath,
          };
        }
      }
    }
  }

  return diffCandidate;
}

function CodeDiffPanel({ diff }: { diff: CodeDiffData }) {
  const [tab, setTab] = useState<"original" | "optimized">("optimized");
  return (
    <div className="rounded-md overflow-hidden bg-background/30">
      <div className="flex items-center gap-0 bg-background/40">
        <button
          type="button"
          onClick={() => setTab("original")}
          className={cn(
            "px-3 py-1.5 text-xs transition",
            tab === "original" ? "bg-background text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
          )}
        >
          原始代码
        </button>
        <button
          type="button"
          onClick={() => setTab("optimized")}
          className={cn(
            "px-3 py-1.5 text-xs transition",
            tab === "optimized" ? "bg-background text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
          )}
        >
          优化后代码
        </button>
        <span className="ml-auto px-2 text-[10px] text-muted-foreground truncate">
          {diff.originalPath.split(/[\\/]/).pop()}
        </span>
      </div>
      <div className="max-h-[400px] overflow-auto">
        <CodeBlock
          language="epl"
          code={tab === "original" ? diff.originalCode : diff.optimizedCode}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EPL code extraction from trace — for right-side preview panel
// ---------------------------------------------------------------------------

interface EplPreviewData {
  id: string;
  code: string;
  title: string;
  path?: string;
  sourceLabel: string;
  stepIndex: number;
}

function isLikelyEplContent(content: string, path = ""): boolean {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (normalized.length < 10) return false;
  if (/\.(epl|e\.txt)$/i.test(path) || /\.(form|class)\.e\.txt$/i.test(path)) {
    return true;
  }
  return /^\.版本|^\.支持库|^\.程序集|^\.子程序|^\.全局变量/m.test(normalized);
}

function renderMobileMessageHtml(content: string): string {
  const html = renderToStaticMarkup(
    <div className="mobile-markdown">
      <MarkdownView content={content} />
    </div>,
  );
  return html;
}

function extractEplPreviewItems(trace: AgentTrace | null): EplPreviewData[] {
  if (!trace) return [];

  const previewMap = new Map<string, EplPreviewData>();

  const upsertPreview = (preview: {
    code: string;
    title: string;
    path?: string;
    sourceLabel: string;
    stepIndex: number;
  }) => {
    if (!isLikelyEplContent(preview.code, preview.path ?? "")) return;
    const id = preview.path
      ? preview.path.toLowerCase()
      : `${preview.sourceLabel}:${preview.title}`;
    previewMap.set(id, {
      id,
      code: preview.code.replace(/\r\n/g, "\n"),
      title: preview.title,
      path: preview.path,
      sourceLabel: preview.sourceLabel,
      stepIndex: preview.stepIndex,
    });
  };

  for (const step of trace.steps) {
    for (let index = 0; index < step.toolCalls.length; index += 1) {
      const call = step.toolCalls[index];
      const result = step.toolResults[index];
      if (!result?.ok) continue;

      if (call.name === "read_file") {
        const rc = extractResultContent(result.content);
        const path = rc.filePath ?? String(call.arguments.file_path ?? "");
        if (rc.fileContent) {
          upsertPreview({
            code: rc.fileContent,
            title: path.split(/[\\/]/).pop() ?? "源码",
            path,
            sourceLabel: "提取",
            stepIndex: step.index,
          });
        }
      }

      if (call.name === "save_text_file") {
        const path = String(call.arguments.path ?? "");
        const content = typeof call.arguments.content === "string"
          ? call.arguments.content
          : null;
        if (content) {
          upsertPreview({
            code: content,
            title: path.split(/[\\/]/).pop() ?? "优化后源码",
            path,
            sourceLabel: "修改",
            stepIndex: step.index,
          });
        }
      }

      if (call.name === "generate_efile_from_code") {
        const code = typeof call.arguments.code === "string"
          ? call.arguments.code
          : null;
        if (code) {
          upsertPreview({
            code,
            title: "生成的代码",
            sourceLabel: "生成",
            stepIndex: step.index,
          });
        }
      }
    }
  }

  return [...previewMap.values()].sort((a, b) => {
    if (b.stepIndex !== a.stepIndex) return b.stepIndex - a.stepIndex;
    return a.title.localeCompare(b.title, "zh-CN");
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract partial `final_answer` or `thought` from an incomplete JSON stream.
 *  The model outputs `{"thought":"...","final_answer":"...markdown..."}`.
 *  While streaming, the JSON is incomplete — we grab the value after the last
 *  `"final_answer":"` (or `"thought":"` as fallback) by scanning for the key
 *  and collecting everything after it, stripping the trailing incomplete quote. */
function extractStreamingContent(buf: string): string | null {
  // Try final_answer first, then thought
  for (const key of ['"final_answer"', '"answer"', '"thought"']) {
    const idx = buf.lastIndexOf(key);
    if (idx < 0) continue;
    // Find the colon after the key, then the opening quote of the value
    const afterKey = buf.indexOf(":", idx + key.length);
    if (afterKey < 0) continue;
    const quoteStart = buf.indexOf('"', afterKey + 1);
    if (quoteStart < 0) continue;
    // Collect chars after the opening quote, handling escaped chars
    let value = "";
    let escape = false;
    for (let i = quoteStart + 1; i < buf.length; i++) {
      const c = buf[i];
      if (escape) {
        if (c === "n") value += "\n";
        else if (c === "t") value += "\t";
        else if (c === "\\") value += "\\";
        else if (c === '"') value += '"';
        else if (c === "/") value += "/";
        else value += c;
        escape = false;
        continue;
      }
      if (c === "\\") { escape = true; continue; }
      if (c === '"') break; // end of value
      value += c;
    }
    if (value.length > 0) return value;
  }
  return null;
}

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
