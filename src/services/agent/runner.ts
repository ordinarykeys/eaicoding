import { nanoid } from "nanoid";
import { abortable, abortableDelay, throwIfAborted } from "@/services/tauri-task";
import type {
  AgentStep,
  AgentTrace,
  AgentChoiceOption,
  AgentPlan,
  AgentPlanItem,
  AgentPlanItemStatus,
  AgentUserChoiceRequest,
  AgentApprovalRequest,
  AgentApprovalDecision,
  ChatMessage,
  LLMConfig,
  ToolCall,
  ToolResult,
} from "@/types/llm";
import { createLLMProvider, type BaseLLMProvider, LLMError, LLMOutputLimitError } from "@/services/llm";
import { DEEPSEEK_DEFAULT_MAX_TOKENS } from "@/lib/deepseek-models";
import {
  TOOL_DEFINITIONS,
  TOOL_REGISTRY,
  executeTool,
  isReadOnlyTool,
  type ToolExecContext,
} from "@/services/agent/tools";
import {
  summarizeTraceForHistory,
} from "@/services/agent/memory";
import { saveAgentCheckpoint } from "@/services/agent/checkpoint";
import {
  selectAgentToolTransport,
  type AgentToolTransport,
} from "@/services/agent/runner-transport";
import {
  extractJsonObject,
  parseAgentTurn,
  tryParseJsonWithRepair,
  type ParsedAgentTurn,
} from "@/services/agent/runner-parser";
import {
  answerContainsEplCode,
  extractEplCodeBlocks,
  findEplAnswerDiagnostics,
  findEplSourceDiagnostics,
  formatEplDiagnostics,
  isCompleteExample,
} from "@/services/agent/epl-syntax";
import { JINGYI_MODULE_SUMMARY } from "@/services/agent/knowledge/jingyi-module";
import {
  buildCompileFollowupText,
  checkAnswerCompiles,
  type AnswerCompileCheckResult,
} from "@/services/agent/answer-compile-check";
import { extractLocalPathsByExtension } from "@/services/agent/tools";
import { useSettingsStore } from "@/stores/settings";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentRunOptions {
  mode?: "agent" | "plan" | "read-only";
  /** Active LLM config (decrypted). */
  config: LLMConfig;
  /** The originating user message text. */
  userInput: string;
  /** Prior conversation messages (system messages will be injected by the runner;
   *  do NOT include the user message that triggered this run, or the new
   *  assistant placeholder — those are added internally). */
  history: ChatMessage[];
  /** Active session id (used by some tools). May be null. */
  sessionId: string | null;
  /** Optional explicit turn limit for integrations/tests. The desktop agent
   *  runs until completion, cancellation, or a concrete failure by default. */
  maxSteps?: number;
  /** Status callback for transient UI updates. */
  onStatus?: (status: string) => void;
  /** Streaming token callback for the *current* step's assistant text. */
  onAssistantToken?: (token: string, stepIndex: number) => void;
  onReasoningToken?: (token: string, stepIndex: number) => void;
  /** Reset the visible draft when a model round starts or retries. */
  onAssistantStart?: (stepIndex: number) => void;
  /** Live tool rows before and after execution; completed steps use onStep. */
  onToolProgress?: (step: AgentStep, runningTrace: AgentTrace, activeToolId?: string) => void;
  /** Called whenever a step finishes — useful for live trace rendering. */
  onStep?: (step: AgentStep, runningTrace: AgentTrace) => void;
  /** Allow the runner to pop native dialogs (only true for foreground turns). */
  allowDialog?: boolean;
  /** Optional abort signal carrying the cancellation source. */
  signal?: AbortSignal;
  /** When provided, the runner pauses before every source-mutating tool call
   *  (save_text_file / apply_search_replace) and awaits the returned decision.
   *  Leaving it undefined keeps the fully-autonomous behavior unchanged. */
  onApprovalRequest?: (request: AgentApprovalRequest) => Promise<AgentApprovalDecision>;
}

export interface AgentRunHandle {
  /** Resolves with the final trace once the loop terminates. */
  promise: Promise<AgentTrace>;
  /** Aborts the underlying provider stream and stops the loop ASAP. */
  abort: () => void;
  /** Pause the loop at the next safe boundary (between steps / before a tool). */
  pause: () => void;
  /** Resume a paused loop. No-op if not paused. */
  resume: () => void;
  /** True while the loop is parked waiting for resume(). */
  isPaused: () => boolean;
  /** Reference to the underlying provider — exposed so the UI can hook into
   *  its native abort if desired. */
  providerRef: { current: BaseLLMProvider | null };
}

const LLM_STEP_TIMEOUT_MS = 180_000;
const TOOL_TEXT_PROMPT_LIMIT = 6_000;
const LLM_MAX_RETRIES = 2;
const LLM_OUTPUT_RECOVERY_ATTEMPTS = 2;
const LLM_RETRY_BASE_MS = 1_000;
const ANSWER_SELF_CHECK_TIMEOUT_MS = 90_000;
const ANSWER_SELF_CHECK_MAX_REVISIONS = 2;
const CHOICE_EVIDENCE_SEARCH_LIMIT = 12;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const AGENT_SYSTEM_PROMPT = `你是 易语言 AI Coding Agent 的多轮推理内核（ReAct）。
你的工作是编写、修改、调试易语言代码和原生窗口工程。根据桌面工具结果推进任务，直到交付代码、工程或有证据的分析结论。

【可用工具】
工具通过 DeepSeek 原生 tools 接口提供，每个工具的 description 已经写明了使用规则、优先级关系和常见错误处理。如果 system prompt 跟工具 description 看起来冲突，以工具 description 为准。

【工具调用协议】
需要工具时使用原生 function/tool_calls，参数须符合工具 schema；可附一句简短进度说明。不要把工具调用写进正文 JSON。
工具结果以 tool 消息返回后，继续使用同一套工具分析和实现。完成任务后直接输出 Markdown 与易语言代码块，不需要 final_answer JSON 包装。
同一轮允许多个工具调用，有读写依赖时按先读取、后修改、再编译的顺序分轮执行。
大型工程按文件、子程序拆分修改；小改优先 apply_search_replace，避免一次输出整套工程。工具参数必须是完整 JSON，不要在正文重复工具参数中的源码。每轮完成一个可验证的小操作，再根据工具结果继续，最后回编编译。
若工具失败，继续推理并尝试更小的步骤；不要重复完全相同的失败调用。
所有路径必须由用户提供或上一步工具返回，禁止编造路径。
提到易语言源码时优先使用 \`\`\`epl 代码块。

【易语言语法硬约束】
- 控制结构必须使用真实易语言配对：如果/如果结束，如果真/如果真结束，判断开始/判断结束，判断循环首/判断循环尾，计次循环首/计次循环尾，变量循环首/变量循环尾，循环判断首/循环判断尾。
- 不允许把控制结构的开始语句自行拼接成结束语句；结束语句必须来自真实配对表。
- 不要连续复制同一条可执行语句来表示“多次执行”。需要执行固定次数时使用计次循环首/计次循环尾；需要并发多个任务时为每个线程准备不同参数或任务队列。
- 易语言变量声明行不能写默认值/初始化值。例如不要写 \`.全局变量 URL_主站, 文本型, , , "http://..."\`；应写 \`.全局变量 URL_主站, 文本型\`，再在启动子程序或窗口创建完毕事件里赋值。
- 示例代码中的模块命令名、参数和返回值必须有工具证据：用户上传的 .ec 以 search_user_modules 或 parse_efile 结果为准；精易模块 API 以 search_jingyi_module 返回结果为准；没有证据时不要凭记忆编造对象名或参数个数。

【知识库优先（核心原则）】
"如果有知识库优先使用知识库"。两个一等公民知识库：
1. 用户模块库（设置 → 模块库 上传的 .ec，如鱼刺类、OkHttp 封装等）→ search_user_modules
2. 内置精易模块库（1500+ 子程序）→ search_jingyi_module
用户上传的 .e/.ec/.epl 文件不是"外部知识库"而是"项目事实"。用户点名"用上传模块"时不要用精易模块替代；需求同时含上传模块和辅助能力（例如"用多线程模块写 POST 案例"），就两个 KB 都查再组合。
不要读取/解析易语言 IDE help 或其他支持库文档作为知识库。

【文件类型 → 工具速查】
- .e 二进制源程序 → parse_efile（绝不 read_file，乱码会推理失败）
- .ec 模块 → 优先 search_user_modules；搜不到或要看完整结构时才 parse_efile（绝不 read_file）
- .epl / .txt / .ini / .json / .csv 文本 → read_file
- .dll → read_file 或配合 parse_efile 看对应 .ec

【完整闭环优先级（优化/修复已有 .e 项目时必须遵守）】
优先使用统一工具，而不是手动拼散步骤：
1. start_project_closed_loop：一次性完成 .e 导出/接管 ecode_dir、项目地图、原始基线回编编译、静态分析、上下文包、回滚快照、状态文件。
2. 如果 start_project_closed_loop 返回 ready_for_edit=false 或 success=false：停止改源码，先根据 baseline/stderr 让用户补齐 .ec 模块或修复 ecl/易语言环境。
3. ready_for_edit=true 后，只读取 recommended_reads / recommended_full_reads 指向的 .e.txt，按需用 apply_search_replace 或 save_text_file 修改；禁止修改未读过的文件。
4. 每次修改后必须调用 finish_project_closed_loop；它会计算 diff、回编 .e、ecl 编译、写 build report。
5. finish_project_closed_loop 失败时，按 repair_instruction 和 stderr 继续读取/修复/重试；不能只给文字建议。
6. 如果发现修改方向错误或需要撤销，调用 restore_project_snapshot 回滚，再重新修改和 finish_project_closed_loop。
7. 最终回答必须包含：改了哪些文件、验证结果、生成的 .e 路径、.exe 路径（若成功）、build_report_path、snapshot_path/回滚方式。

【优化/分析 .e 项目的标准编排】
1. parse_efile 主程序 → 子程序、支持库、模块依赖一览
2. export_efile_to_ecode → 文本工程目录 + 文件清单
3. summarize_ecode_project → 项目地图、入口、recommended_read_order
4. 用户要"优化/完善/找问题"时调 analyze_ecode_project → findings、重复逻辑、硬编码
5. build_original_efile_baseline → 原始基线编译；基线就失败时先报告环境/依赖问题，不要乱改源码
6. inspect_ecode_context → 关键文件轮廓 + recommended_full_reads
7. read_file 推荐的 <ecode_dir>/代码/*.e.txt（绝不读根目录的 代码.e，那是二进制）
8. 修改用 save_text_file 覆盖 .e.txt（小改用 apply_search_replace），保留原项目结构，不要把多窗口 GUI 改成单文件 console
9. build_ecode_project 一步回编+编译验证（或 generate_efile_from_ecode + compile_efile 两步）
10. 编译失败按 stderr 修复重试；成功后输出 final_answer 附优化说明
不要看完摘要就给文字建议——用户期望可用代码。export_efile_to_ecode 成功后必须继续 summarize/analyze/inspect/read_file。

【执行计划（多步任务时使用 update_plan）】
- 当任务需要 3 步以上（典型：优化/修复已有 .e 项目的完整闭环），先调用一次 update_plan 列出你要走的步骤清单，让用户看到进度。步骤建议对齐易语言闭环阶段：解析 → 导出 ecode → 项目地图 → 静态分析 → 原始基线 → 读取源码 → 修改 → 回编编译 → 验证。
- 每完成一步，调用 update_plan 把该步 status 更新为 done，并把下一步置为 in_progress。同一时刻只应有一个 in_progress。
- 确实不需要做的步骤用 skipped，不要留在 pending 造成误导。
- 单功能问答、片段示例等简单任务不必使用 update_plan，避免噪音。

【生成 + 编译入口】
- 已有 ecode_dir：先 save_text_file 改 .e.txt，再 build_ecode_project（必要时拆 generate_efile_from_ecode + compile_efile）
- 窗口/UI/登录框：generate_gui_project（真实窗口、控件位置、events 事件体）→ compile_efile。必须交付 .e 和 .exe；只输出按钮事件代码不能算完成界面。
- 大文件：read_file 用 start_char/start_line 分页，保留 code_hash；修改片段用 apply_search_replace 的 expected_hash。
- 只有控制台单文件源码：generate_efile_from_code → compile_efile
- 失败按 stderr 定位原因并修复，再验证最新源码；不要用旧构建结果代替最新修改的验证。任务未完成时继续调用工具，完成后直接回复。重复相同操作且没有新进展时停止并说明具体原因。

【意图匹配 + 事实驱动】
- 普通知识问答 / 参数解释 / 单功能片段示例：调一次必要的知识工具 → 直接 final_answer。不要因为带代码就强行生成 .e、编译、反复自检。
- 用户明确要"生成/编译/测试/运行/跑通"或在优化已有 .e：进入生成/编译闭环。
- 【重要】final_answer 阶段你回答里完整的 EPL 代码块会被**静默编译验证**；编译失败你会收到 stderr 让你重写——这是 KB-first 之外的事实层质量保证。写代码时按真实工具证据来；编译反馈会兜底，但不要把它当借口偷懒。

【杂项】
- 不允许在没有读取文件内容的情况下对文件内容做任何推断或假设。
- 每次 tool_calls 返回结果后根据结果继续推理或调用下一步工具，不要急于给出 final_answer。
- 任务完成或无法继续时输出 final_answer。

【精易模块功能域索引】（详细使用规则见 search_jingyi_module 工具 description）
${JINGYI_MODULE_SUMMARY}
`;

// ---------------------------------------------------------------------------
// Message-list construction for the LLM
// ---------------------------------------------------------------------------

function makeSystemMessage(extraSystem: string | undefined, maxSteps: number): ChatMessage {
  const parts = [AGENT_SYSTEM_PROMPT,
    "【自主选择与效率】知识库的多个 API 是供你分析的证据，不是需要用户做的选择题。遵从用户指定的库；否则按需求匹配、已有依赖、参数完整性和实现复杂度选择最合适的入口，简短说明理由并直接实现。仅在缺少用户才能提供的目标、账号或业务约束时追问；不要因存在多个可行技术方案暂停。不要重复读取、搜索或构建相同且未变化的内容。普通问题不需要项目全流程，完整工程修改才走闭环。"
  ];
  if (Number.isFinite(maxSteps)) parts.push(`【调用方执行限制】本次调用最多 ${maxSteps} 轮；达到限制时如实说明未完成内容，不得声称已验证。`);
  if (extraSystem && extraSystem.trim()) {
    parts.push("\n【用户偏好的全局指令】\n" + extraSystem.trim());
  }
  return {
    id: "__sys__",
    role: "system",
    content: parts.join("\n"),
    timestamp: 0,
  };
}

/** Map a ToolResult into a `tool` role message that the LLM can read. */
function limitTextForPrompt(text: string, maxChars = TOOL_TEXT_PROMPT_LIMIT): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.55));
  const tail = text.slice(-Math.floor(maxChars * 0.35));
  return `${head}\n\n... [content trimmed for the next model turn: ${text.length - maxChars} chars omitted] ...\n\n${tail}`;
}

function compactToolContentForPrompt(content: unknown): unknown {
  if (!content || typeof content !== "object" || Array.isArray(content)) return content;
  const obj = content as Record<string, unknown>;
  const compacted: Record<string, unknown> = { ...obj };

  if (typeof compacted.content === "string") {
    // Source pages are already bounded by read_file. Keep every character and offset.
    if (typeof obj.code_hash !== "string") compacted.content = limitTextForPrompt(compacted.content);
  }
  if (typeof compacted.output_excerpt === "string") {
    compacted.output_excerpt = limitTextForPrompt(compacted.output_excerpt);
  }
  if (typeof compacted.stdout === "string") {
    compacted.stdout = limitTextForPrompt(compacted.stdout, 2_000);
  }
  if (typeof compacted.stderr === "string") {
    compacted.stderr = limitTextForPrompt(compacted.stderr, 3_000);
  }

  // 精易检索结果里同一批条目最多重复 5 份（matches / related_implementations /
  // implementation_options / lexical / semantic）。只保留 matches 和
  // implementation_options 一份进入对话；原始 ToolResult（UI、trace）不受影响。
  if (Array.isArray(compacted.matches) && Array.isArray(compacted.implementation_options)) {
    delete compacted.related_implementations;
    delete compacted.evidence_terms;
    delete compacted.lexical_search;
    delete compacted.semantic_matches;
    delete compacted.semantic_search;
    delete compacted.reranker;
    compacted.implementation_options = (compacted.implementation_options as unknown[]).map(
      (route) => {
        if (!route || typeof route !== "object") return route;
        const routeObj = { ...(route as Record<string, unknown>) };
        // `options` 是 primary_options + supporting_options 的全量重复。
        if (Array.isArray(routeObj.primary_options)) delete routeObj.options;
        return routeObj;
      },
    );
  }

  return compacted;
}

function toolResultToMessage(result: ToolResult): ChatMessage {
  const payload = {
    tool: result.toolName,
    tool_call_id: result.toolCallId,
    ok: result.ok,
    duration_ms: result.durationMs,
    content: compactToolContentForPrompt(result.content),
    error: result.error,
  };
  return {
    id: `tr_${nanoid(8)}`,
    role: "tool",
    // Compact JSON: pretty-printed indentation on multi-KB tool payloads is
    // pure token overhead re-sent on every subsequent step.
    content: JSON.stringify(payload),
    timestamp: Date.now(),
    toolCallId: result.toolCallId,
    toolName: result.toolName,
  };
}

/** Strip a non-textual / non-tool history field out so we can re-send messages
 *  to the LLM. We keep role + content for normal messages, and add structured
 *  envelopes for tool messages (so e.g. OpenAI/Anthropic adapters can map
 *  them however they like). */
function shapeHistoryForLLM(history: ChatMessage[]): ChatMessage[] {
  const shaped: ChatMessage[] = [];
  const recent = new Set(history.filter(m => m.role === "assistant").slice(-2).map(m => m.id));
  for (const message of history.slice(-24)) {
    if (message.role === "system") continue; // reset; we inject our own system
    shaped.push({
      id: message.id,
      role: message.role,
      content:
        message.role === "assistant" && message.agentTrace
          ? recent.has(message.id) ? message.content : summarizeTraceForHistory(message)
          : message.content,
      timestamp: message.timestamp,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      toolCalls: message.toolCalls,
    });
  }
  return shaped;
}

function toolResultSucceeded(result: ToolResult | undefined): boolean {
  if (!result?.ok) return false;
  if (result.content && typeof result.content === "object") {
    const success = (result.content as Record<string, unknown>).success;
    if (success === false) return false;
  }
  return true;
}

function hasJingyiKnowledgeEvidence(trace: AgentTrace): boolean {
  return trace.steps.some((step) =>
    step.toolCalls.some((call, index) => {
      if (call.name !== "search_jingyi_module") return false;
      const result = step.toolResults[index];
      if (!toolResultSucceeded(result)) return false;
      const content = resultContentObject(result);
      const count = typeof content?.count === "number" ? content.count : 0;
      return count > 0;
    }),
  );
}

/** Only standalone social turns bypass the coding workflow. A greeting followed
 * by a request (and continuation commands such as “好的继续”) remains an agent task. */
function isSocialTurn(input: string): boolean {
  const text = input.trim().replace(/[\s，,。.!！?？~～、]+/g, "");
  return /^(?:你好(?:啊|呀|哇|哦|哈|呢)?|您好|嗨|哈喽|hello|hi|早上好|下午好|晚上好|早安|晚安|谢谢(?:你|啦|了)?|多谢|辛苦了|再见|拜拜|你是谁|你是干什么的|你(?:能|可以|会)(?:做|干|帮我做)什么|介绍一下你自己)$/i.test(text);
}

function shouldRequireJingyiEvidence(userInput: string, answer: string, trace: AgentTrace): boolean {
  if (isSocialTurn(userInput) || hasJingyiKnowledgeEvidence(trace)) return false;
  if (hasUploadedEcModuleEvidence(userInput, trace)) return false;
  const isEasyLanguageTask = /精易模块|易语言|```epl|```易语言|\.e\b|\.ec\b/i.test(`${userInput}\n${answer}`);
  // Capability descriptions and window event names are not claims about module APIs.
  const calls = /(?:^|[^\w\u4e00-\u9fff_.])([A-Za-z\u4e00-\u9fff][\w\u4e00-\u9fff]*_[\w\u4e00-\u9fff]+)\s*[（(]/gm;
  return isEasyLanguageTask && calls.test(answer);
}

function collectJingyiImplementationOptionNames(trace: AgentTrace): string[] {
  const names: string[] = [];
  for (const step of trace.steps) {
    step.toolCalls.forEach((call, index) => {
      if (call.name !== "search_jingyi_module") return;
      const result = step.toolResults[index];
      if (!toolResultSucceeded(result)) return;
      const content = resultContentObject(result);
      const groups = Array.isArray(content?.implementation_options)
        ? content.implementation_options
        : Array.isArray(content?.related_implementations)
          ? content.related_implementations
          : [];
      for (const rawGroup of groups) {
        if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) continue;
        const group = rawGroup as Record<string, unknown>;
        const options = Array.isArray(group.options)
          ? group.options
          : Array.isArray(group.items)
            ? group.items
            : [];
        for (const rawOption of options) {
          if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) continue;
          const option = rawOption as Record<string, unknown>;
          const name = typeof option.name === "string" ? option.name.trim() : "";
          if (name && !names.includes(name)) names.push(name);
          if (names.length >= 12) return;
        }
      }
    });
  }
  return names;
}

interface JingyiImplementationRouteEvidence {
  family: string;
  routeType: string;
  primaryNames: string[];
  supportingNames: string[];
}

function extractJingyiOptionName(rawOption: unknown): string {
  if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) return "";
  const option = rawOption as Record<string, unknown>;
  return typeof option.name === "string" ? option.name.trim() : "";
}

function collectJingyiImplementationRoutes(trace: AgentTrace): JingyiImplementationRouteEvidence[] {
  const routes: JingyiImplementationRouteEvidence[] = [];
  const seen = new Set<string>();

  for (const step of trace.steps) {
    step.toolCalls.forEach((call, index) => {
      if (call.name !== "search_jingyi_module") return;
      const result = step.toolResults[index];
      if (!toolResultSucceeded(result)) return;
      const content = resultContentObject(result);
      const groups = Array.isArray(content?.implementation_options)
        ? content.implementation_options
        : Array.isArray(content?.related_implementations)
          ? content.related_implementations
          : [];

      for (const rawGroup of groups) {
        if (!rawGroup || typeof rawGroup !== "object" || Array.isArray(rawGroup)) continue;
        const group = rawGroup as Record<string, unknown>;
        const family = typeof group.family === "string" ? group.family.trim() : "";
        if (!family) continue;
        const routeType =
          typeof group.route_type === "string"
            ? group.route_type.trim()
            : family.startsWith("类_")
              ? "object_workflow"
              : "unknown";
        const primaryOptions = Array.isArray(group.primary_options)
          ? group.primary_options
          : Array.isArray(group.primary_items)
            ? group.primary_items
            : Array.isArray(group.options)
              ? group.options.slice(0, 3)
              : Array.isArray(group.items)
                ? group.items.slice(0, 3)
                : [];
        const supportingOptions = Array.isArray(group.supporting_options)
          ? group.supporting_options
          : Array.isArray(group.supporting_items)
            ? group.supporting_items
            : [];
        const primaryNames = primaryOptions
          .map(extractJingyiOptionName)
          .filter(Boolean)
          .slice(0, 6);
        const supportingNames = supportingOptions
          .map(extractJingyiOptionName)
          .filter(Boolean)
          .slice(0, 8);
        if (primaryNames.length === 0) continue;

        const key = `${family}:${routeType}:${primaryNames.join("|")}`;
        if (seen.has(key)) continue;
        seen.add(key);
        routes.push({
          family,
          routeType,
          primaryNames,
          supportingNames,
        });
      }
    });
  }

  return routes.slice(0, 8);
}

export function shouldRequireImplementationComparison(answer: string, trace: AgentTrace): string[] {
  const routes = collectJingyiImplementationRoutes(trace)
    .filter((route) =>
      route.routeType === "function_family" ||
      route.routeType === "object_workflow" ||
      route.primaryNames.length >= 2,
    );
  if (routes.length === 0) return [];

  const mentionedRoutes = routes.filter((route) =>
    route.primaryNames.some((name) => answer.includes(name)) ||
    route.supportingNames.some((name) => answer.includes(name)) ||
    answer.includes(route.family),
  );
  const mentionedPrimaryNames = new Set<string>();
  for (const route of mentionedRoutes) {
    for (const name of route.primaryNames) {
      if (answer.includes(name)) mentionedPrimaryNames.add(name);
    }
  }

  if (mentionedRoutes.length >= 2 || mentionedPrimaryNames.size >= 2) return [];

  const compactRoutes = routes.slice(0, 5).map((route) =>
    `${route.family}(${route.routeType}): ${route.primaryNames.slice(0, 4).join(" / ")}`,
  );
  if (compactRoutes.length >= 2) return compactRoutes;

  const optionNames = collectJingyiImplementationOptionNames(trace);
  const mentioned = optionNames.filter((name) => answer.includes(name));
  return mentioned.length >= 2 ? [] : optionNames.slice(0, 6);
}

export function getLatestPendingUserChoice(history: ChatMessage[]): AgentUserChoiceRequest | null {
  return getLatestPendingUserChoiceContext(history)?.request ?? null;
}

function getLatestPendingUserChoiceContext(
  history: ChatMessage[],
): { request: AgentUserChoiceRequest; trace: AgentTrace } | null {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role !== "assistant") continue;
    const trace = message.agentTrace;
    const pending = trace?.pendingUserChoice;
    if (trace && pending) return { request: pending, trace };
    if (trace && trace.outcome !== "needs_input") return null;
  }

  return null;
}

function findSelectedChoice(
  userInput: string,
  pending: AgentUserChoiceRequest,
): AgentChoiceOption | null {
  const normalizedInput = userInput.trim();
  const selected = pending.options
    .map((option) => {
      const label = option.label.trim();
      const value = (option.value || option.label).trim();
      const candidates = [value, label].filter(Boolean);
      let exact = false;
      let matchLength = 0;
      for (const candidate of candidates) {
        if (normalizedInput === candidate) exact = true;
        if (normalizedInput.includes(candidate)) {
          matchLength = Math.max(matchLength, candidate.length);
        }
      }
      if (!exact && matchLength === 0) return null;
      return {
        option,
        score: (exact ? 10_000 : 0) + matchLength,
        specificity: Math.max(label.length, value.length),
      };
    })
    .filter((item): item is { option: AgentChoiceOption; score: number; specificity: number } => Boolean(item))
    .sort((a, b) =>
      b.score - a.score ||
      b.specificity - a.specificity ||
      a.option.label.localeCompare(b.option.label, "zh-CN"),
    )[0];

  return selected?.option ?? null;
}

export function describeSelectedImplementationFromChoice(
  userInput: string,
  history: ChatMessage[],
): string {
  const pending = getLatestPendingUserChoice(history);
  if (!pending) return "";
  const selected = findSelectedChoice(userInput, pending);
  if (!selected) return "";
  const label = selected.label.trim();
  const value = (selected.value || selected.label).trim();
  return value === label ? label : `${label}（${value}）`;
}

export function buildSelectedImplementationEvidenceQuery(
  userInput: string,
  history: ChatMessage[],
): string {
  const context = getLatestPendingUserChoiceContext(history);
  if (!context) return "";
  const selected = findSelectedChoice(userInput, context.request);
  if (!selected) return "";

  const parts = [
    context.trace.goal ? `原问题：${context.trace.goal}` : "",
    `用户选择：${selected.label}`,
    selected.value && selected.value !== selected.label ? `实现入口：${selected.value}` : "",
    selected.description ? `选择说明：${selected.description}` : "",
    userInput ? `当前补充：${userInput}` : "",
  ].filter((part) => part.trim());

  return parts.join("\n");
}

function makeSelectedImplementationReminder(selectedImplementation: string): ChatMessage {
  return {
    id: `selected_impl_${nanoid(8)}`,
    role: "user",
    content:
      `【用户已选择实现方式】${selectedImplementation}\n` +
      "请基于刚刚查询到的精易模块工具证据继续回答用户原问题。不要再次要求用户选择；如果只是普通案例问答，直接输出完整 final_answer。",
    timestamp: Date.now(),
  };
}

function userInputLooksLikeLocalFileTask(userInput: string): boolean {
  return (
    /(?:^|\s)[A-Za-z]:[\\/]/.test(userInput) ||
    /\\\\[^\s]+/.test(userInput) ||
    /\.(?:e|ec|epl|txt|ini|json|csv|log|md)\b/i.test(userInput)
  );
}

const LOCAL_FILE_PATH_RE =
  /[A-Za-z]:[\\/][^\r\n<>|"]+?\.(e|ec|epl|txt|ini|json|csv|log|md)(?=$|[\s,，;；(（)）\]])/gi;

export function extractLocalFilePathsByExtension(
  userInput: string,
  extensions: string[],
): string[] {
  const wanted = new Set(
    extensions.map((ext) => ext.replace(/^\./, "").toLowerCase()).filter(Boolean),
  );
  const paths: string[] = [];
  for (const match of userInput.matchAll(LOCAL_FILE_PATH_RE)) {
    const path = match[0]?.trim();
    const ext = match[1]?.toLowerCase();
    if (!path || !ext || !wanted.has(ext)) continue;
    if (paths.some((item) => normalizeToolPath(item) === normalizeToolPath(path))) continue;
    paths.push(path);
  }
  return paths;
}

function userExplicitlyRequestsUploadedModule(userInput: string): boolean {
  const compact = userInput.replace(/\s+/g, " ").trim();
  if (!compact) return false;
  return (
    /(用|使用|基于|调用|利用|按|按照)[^。！？!?]{0,40}(上传的|这个|该|本地|自定义|模块|\.ec)/i.test(compact) ||
    /(上传的|这个|该|本地|自定义)[^。！？!?]{0,24}(模块|\.ec)[^。！？!?]{0,40}(写|实现|生成|调用|使用|做)/i.test(compact) ||
    /(模块|\.ec)[^。！？!?]{0,30}(写|实现|生成|做)[^。！？!?]{0,30}(案例|案列|代码|功能)/i.test(compact)
  );
}

export function getUploadedEcModuleParseTargets(userInput: string): string[] {
  const ecPaths = extractLocalFilePathsByExtension(userInput, ["ec"]);
  if (ecPaths.length === 0) return [];
  const mainEPaths = extractLocalFilePathsByExtension(userInput, ["e"]);
  const onlyUploadedEcModules = mainEPaths.length === 0;
  if (!onlyUploadedEcModules && !userExplicitlyRequestsUploadedModule(userInput)) return [];
  return ecPaths.slice(0, 4);
}

function getRecentUploadedEcModuleParseTargets(userInput: string, history: ChatMessage[]): string[] {
  const currentTargets = getUploadedEcModuleParseTargets(userInput);
  if (currentTargets.length > 0) return currentTargets;
  if (!userExplicitlyRequestsUploadedModule(userInput)) return [];

  const targets: string[] = [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role !== "user") continue;
    const ecPaths = extractLocalFilePathsByExtension(message.content, ["ec"]);
    const mainEPaths = extractLocalFilePathsByExtension(message.content, ["e"]);
    if (ecPaths.length === 0 || mainEPaths.length > 0) continue;
    for (const path of ecPaths) {
      if (targets.some((item) => normalizeToolPath(item) === normalizeToolPath(path))) continue;
      targets.push(path);
      if (targets.length >= 4) return targets;
    }
  }
  return targets;
}

function shouldPrimeJingyiKnowledge(userInput: string, history: ChatMessage[]): boolean {
  const text = userInput.trim();
  if (text.length < 2) return false;
  if (getLatestPendingUserChoiceContext(history)) return false;
  if (getRecentUploadedEcModuleParseTargets(text, history).length > 0) return false;
  if (userInputLooksLikeLocalFileTask(text)) return false;
  if (/JavaScript|TypeScript|Python|React|Rust|Java\b|C\+\+/i.test(text) && !/易语言|精易/.test(text)) return false;
  return /易语言|精易|多线程|网页_访问|POST|HTTP|JSON|编码转换|正则|字节集|子程序|模块命令/i.test(text);
}

function makeJingyiSearchToolCall(query: string, limit = CHOICE_EVIDENCE_SEARCH_LIMIT): ToolCall {
  const args = { query, limit };
  return {
    id: `auto_jingyi_${nanoid(8)}`,
    name: "search_jingyi_module",
    arguments: args,
    rawArguments: JSON.stringify(args),
  };
}

function makeParseEFileToolCall(targetPath: string): ToolCall {
  const args = { target_path: targetPath };
  return {
    id: `auto_parse_${nanoid(8)}`,
    name: "parse_efile",
    arguments: args,
    rawArguments: JSON.stringify(args),
  };
}

function answerMentionsSelectedImplementation(answer: string, selectedImplementation: string): boolean {
  const candidates = selectedImplementation
    .split(/[（）()、,，\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
  if (candidates.length === 0) return true;
  return candidates.some((candidate) => answer.includes(candidate));
}

function extractUserChoiceRequest(result: ToolResult | undefined): AgentUserChoiceRequest | null {
  if (!toolResultSucceeded(result)) return null;
  const content = result?.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const payload = content as Record<string, unknown>;
  if (payload.needs_user_choice !== true) return null;
  const question = typeof payload.question === "string" && payload.question.trim()
    ? payload.question.trim()
    : "请选择一个方案";
  const rawOptions = Array.isArray(payload.options) ? payload.options : [];
  const options: AgentUserChoiceRequest["options"] = rawOptions
    .map((item, index): AgentUserChoiceRequest["options"][number] | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const option = item as Record<string, unknown>;
      const label = typeof option.label === "string" && option.label.trim()
        ? option.label.trim()
        : typeof option.value === "string" && option.value.trim()
          ? option.value.trim()
          : "";
      if (!label) return null;
      return {
        id: typeof option.id === "string" && option.id.trim()
          ? option.id.trim()
          : `choice_${index + 1}`,
        label,
        value: typeof option.value === "string" && option.value.trim()
          ? option.value.trim()
          : label,
        description: typeof option.description === "string" && option.description.trim()
          ? option.description.trim()
          : undefined,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
  if (options.length === 0) return null;

  return {
    question,
    options,
    allowCustom: payload.allow_custom !== false,
    context: typeof payload.context === "string" && payload.context.trim()
      ? payload.context.trim()
      : undefined,
  };
}

function findPendingUserChoice(results: ToolResult[]): AgentUserChoiceRequest | null {
  for (const result of results) {
    const request = extractUserChoiceRequest(result);
    if (request) return request;
  }
  return null;
}

function findPendingUserChoiceFromToolResults(
  results: ToolResult[],
  userInput: string,
): AgentUserChoiceRequest | null {
  // Multiple valid APIs are evidence for the model to compare, not a reason
  // to interrupt the task. Only explicit requests for essential information pause.
  return findPendingUserChoice(results);
}

function findPendingUserChoiceFromTrace(
  trace: AgentTrace,
  userInput: string,
): AgentUserChoiceRequest | null {
  for (let index = trace.steps.length - 1; index >= 0; index -= 1) {
    const request = findPendingUserChoiceFromToolResults(
      trace.steps[index].toolResults,
      userInput,
    );
    if (request) return request;
  }
  return null;
}

function finishWithPendingUserChoice(
  trace: AgentTrace,
  step: AgentStep,
  request: AgentUserChoiceRequest,
  onStatus?: (status: string) => void,
  onStep?: (step: AgentStep, trace: AgentTrace) => void,
): void {
  step.finishReason = "needs_input";
  trace.pendingUserChoice = request;
  trace.outcome = "needs_input";
  trace.finalAnswer = formatPendingUserChoice(request);
  onStatus?.("等待用户选择");
  onStep?.(step, trace);
  saveAgentCheckpoint(trace);
}

function hasSuccessfulToolCall(trace: AgentTrace, toolName: string): boolean {
  return trace.steps.some((step) =>
    step.toolCalls.some(
      (call, index) => call.name === toolName && toolResultSucceeded(step.toolResults[index]),
    ),
  );
}

function hasToolCallAfter(trace: AgentTrace, toolName: string, afterToolName: string): boolean {
  let sawAfterTool = false;
  let satisfied = false;
  for (const step of trace.steps) {
    for (let index = 0; index < step.toolCalls.length; index += 1) {
      const call = step.toolCalls[index];
      const result = step.toolResults[index];
      if (call.name === afterToolName && toolResultSucceeded(result)) {
        sawAfterTool = true;
        satisfied = false;
      } else if (sawAfterTool && call.name === toolName && toolResultSucceeded(result)) {
        satisfied = true;
      }
    }
  }
  return satisfied;
}

function hasAnyToolCall(trace: AgentTrace, toolName: string): boolean {
  return trace.steps.some((step) => step.toolCalls.some((call) => call.name === toolName));
}

function hasSuccessfulParseOfExtension(trace: AgentTrace, extension: string): boolean {
  const normalizedExtension = extension.startsWith(".")
    ? extension.toLowerCase()
    : `.${extension.toLowerCase()}`;
  return trace.steps.some((step) =>
    step.toolCalls.some((call, index) => {
      if (call.name !== "parse_efile" || !toolResultSucceeded(step.toolResults[index])) {
        return false;
      }
      const targetPath = typeof call.arguments.target_path === "string"
        ? call.arguments.target_path
        : "";
      return targetPath.trim().toLowerCase().endsWith(normalizedExtension);
    }),
  );
}

function hasSuccessfulParseOfPath(trace: AgentTrace, targetPath: string): boolean {
  const normalizedTarget = normalizeToolPath(targetPath);
  return trace.steps.some((step) =>
    step.toolCalls.some((call, index) => {
      if (call.name !== "parse_efile" || !toolResultSucceeded(step.toolResults[index])) {
        return false;
      }
      const callPath = typeof call.arguments.target_path === "string"
        ? call.arguments.target_path
        : "";
      return normalizeToolPath(callPath) === normalizedTarget;
    }),
  );
}

function hasSuccessfulSearchUserModules(trace: AgentTrace): boolean {
  return trace.steps.some((step) =>
    step.toolCalls.some((call, index) => {
      if (call.name !== "search_user_modules") return false;
      const result = step.toolResults[index];
      if (!toolResultSucceeded(result)) return false;
      const content = resultContentObject(result);
      if (!content) return false;
      // Counts as evidence if at least one user module was actually searched
      // (user has a populated module library) — whether or not this query hit.
      // count===0 with searched_modules>0 still proves the agent consulted the
      // KB before falling back to parse_efile or precomputed knowledge.
      const searched = Array.isArray(content.searched_modules)
        ? (content.searched_modules as unknown[]).length
        : 0;
      const count = typeof content.count === "number" ? content.count : 0;
      return searched > 0 || count > 0;
    }),
  );
}

function hasUploadedEcModuleEvidence(userInput: string, trace: AgentTrace): boolean {
  // search_user_modules counts as evidence — it consults the same .ec library,
  // and per the new system prompt agents are told to prefer it over parse_efile.
  if (hasSuccessfulSearchUserModules(trace)) return true;

  const targets = getUploadedEcModuleParseTargets(userInput);
  if (targets.length > 0) {
    return targets.some((targetPath) => hasSuccessfulParseOfPath(trace, targetPath));
  }
  return userExplicitlyRequestsUploadedModule(userInput) && trace.steps.some((step) =>
    step.toolCalls.some((call, index) => {
      if (call.name !== "parse_efile" || !toolResultSucceeded(step.toolResults[index])) {
        return false;
      }
      const targetPath = typeof call.arguments.target_path === "string"
        ? call.arguments.target_path
        : "";
      return targetPath.trim().toLowerCase().endsWith(".ec");
    }),
  );
}

function findLastSuccessfulParsedEFilePath(trace: AgentTrace): string | null {
  for (let stepIndex = trace.steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
    const step = trace.steps[stepIndex];
    for (let callIndex = step.toolCalls.length - 1; callIndex >= 0; callIndex -= 1) {
      const call = step.toolCalls[callIndex];
      if (call.name !== "parse_efile" || !toolResultSucceeded(step.toolResults[callIndex])) {
        continue;
      }
      const targetPath = typeof call.arguments.target_path === "string"
        ? call.arguments.target_path.trim()
        : "";
      if (targetPath.toLowerCase().endsWith(".e")) return targetPath;
    }
  }
  return null;
}

function countToolCalls(trace: AgentTrace, toolName: string): number {
  return trace.steps.reduce((total, step) => {
    return total + step.toolCalls.filter((call) => call.name === toolName).length;
  }, 0);
}

function findLastToolResult(trace: AgentTrace, toolName: string): ToolResult | null {
  for (let stepIndex = trace.steps.length - 1; stepIndex >= 0; stepIndex -= 1) {
    const step = trace.steps[stepIndex];
    for (let callIndex = step.toolCalls.length - 1; callIndex >= 0; callIndex -= 1) {
      if (step.toolCalls[callIndex].name === toolName) {
        return step.toolResults[callIndex] ?? null;
      }
    }
  }
  return null;
}

function isCompileEnvironmentFailure(result: ToolResult | null): boolean {
  if (!result) return false;
  const content = result.content && typeof result.content === "object"
    ? result.content as Record<string, unknown>
    : {};
  const text = [
    result.error,
    typeof content.error === "string" ? content.error : "",
    typeof content.stderr === "string" ? content.stderr : "",
    typeof content.stdout === "string" ? content.stdout : "",
  ].join("\n");

  return /ecl\.exe 缺失|内置易语言运行环境缺失|启动 ecl\.exe 失败|ecl 编译超时|当前内置 ecl 在本机可能不可执行|link\.exe|VC98 link|静态库目录/.test(text);
}

function isECodeSourceWrite(call: ToolCall): boolean {
  if (!["save_text_file", "apply_search_replace"].includes(call.name)) return false;
  const path = typeof call.arguments.path === "string"
    ? call.arguments.path.replace(/\//g, "\\").toLowerCase()
    : "";
  return path.endsWith(".e.txt") || path.endsWith(".form.json");
}

function shouldRunBaselineBeforeTool(trace: AgentTrace, call: ToolCall): boolean {
  if (!hasSuccessfulToolCall(trace, "analyze_ecode_project")) return false;
  if (hasAnyToolCall(trace, "build_original_efile_baseline")) return false;
  if (!findLastSuccessfulParsedEFilePath(trace)) return false;

  return (
    isECodeSourceWrite(call) ||
    call.name === "build_ecode_project" ||
    call.name === "generate_efile_from_ecode"
  );
}

function makeBaselineToolCall(trace: AgentTrace): ToolCall | null {
  const targetPath = findLastSuccessfulParsedEFilePath(trace);
  if (!targetPath) return null;
  const args = { target_path: targetPath };
  return {
    id: `auto_baseline_${nanoid(8)}`,
    name: "build_original_efile_baseline",
    arguments: args,
    rawArguments: JSON.stringify(args),
  };
}

function countTrailingBlankRetries(trace: AgentTrace): number {
  let count = 0;
  for (let index = trace.steps.length - 1; index >= 0; index -= 1) {
    const step = trace.steps[index];
    if (step.finishReason === "format_retry" && !step.assistantText.trim()) {
      count += 1;
      continue;
    }
    break;
  }
  return count;
}

interface ContinueDecision {
  shouldContinue: boolean;
  reminder: string;
}

interface AgentWorkflowState {
  closedLoopStarted: boolean;
  closedLoopReady: boolean;
  closedLoopFinishAttempted: boolean;
  closedLoopBuilt: boolean;
  parsedEFile: boolean;
  exported: boolean;
  mappedAfterExport: boolean;
  readAfterExport: boolean;
  readAfterMap: boolean;
  analyzedAfterMap: boolean;
  contextAfterAnalysis: boolean;
  readAfterAnalysis: boolean;
  baselineAttempted: boolean;
  baselineBuilt: boolean;
  savedText: boolean;
  generated: boolean;
  buildAttempted: boolean;
  builtProject: boolean;
  compileAttempted: boolean;
  compiled: boolean;
  projectEditRequired: boolean;
  unreadRecommendedSourcePaths: string[];
}

function resultContentObject(result: ToolResult | undefined | null): Record<string, unknown> | null {
  if (!result?.content || typeof result.content !== "object" || Array.isArray(result.content)) {
    return null;
  }
  return result.content as Record<string, unknown>;
}

function collectSuccessfulToolResults(trace: AgentTrace, toolName: string): ToolResult[] {
  const results: ToolResult[] = [];
  for (const step of trace.steps) {
    for (let index = 0; index < step.toolCalls.length; index += 1) {
      const call = step.toolCalls[index];
      const result = step.toolResults[index];
      if (call.name === toolName && toolResultSucceeded(result) && result) {
        results.push(result);
      }
    }
  }
  return results;
}

function normalizeToolPath(path: string): string {
  return path.trim().replace(/\//g, "\\").replace(/\\+/g, "\\").toLowerCase();
}

function pushUniqueToolPath(paths: string[], value: unknown, limit = 40): void {
  if (typeof value !== "string") return;
  const clean = value.trim();
  if (!clean || paths.length >= limit) return;
  const normalized = normalizeToolPath(clean);
  if (paths.some((item) => normalizeToolPath(item) === normalized)) return;
  paths.push(clean);
}

function pushPathArray(paths: string[], value: unknown, limit = 40): void {
  if (!Array.isArray(value)) return;
  for (const item of value) pushUniqueToolPath(paths, item, limit);
}

function isMainECodeTextSourcePath(path: string): boolean {
  const normalized = normalizeToolPath(path);
  return normalized.endsWith(".e.txt") && !normalized.includes("\\模块\\");
}

function collectToolResultPathsFromObjects(
  paths: string[],
  value: unknown,
  key: string,
  limit = 40,
): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    pushUniqueToolPath(paths, (item as Record<string, unknown>)[key], limit);
  }
}

function collectRecommendedSourceReadPaths(trace: AgentTrace): string[] {
  const paths: string[] = [];
  const appendFromResult = (result: ToolResult, keys: string[]) => {
    const content = resultContentObject(result);
    if (!content) return;
    for (const key of keys) pushPathArray(paths, content[key]);
    collectToolResultPathsFromObjects(paths, content.source_files, "path");
    collectToolResultPathsFromObjects(paths, content.files, "path");
    const projectMap = content.project_map;
    if (projectMap && typeof projectMap === "object" && !Array.isArray(projectMap)) {
      const map = projectMap as Record<string, unknown>;
      pushPathArray(paths, map.recommended_read_order);
      collectToolResultPathsFromObjects(paths, map.source_files, "path");
    }
  };

  for (const result of collectSuccessfulToolResults(trace, "inspect_ecode_context")) {
    appendFromResult(result, ["recommended_full_reads"]);
  }
  for (const result of collectSuccessfulToolResults(trace, "analyze_ecode_project")) {
    appendFromResult(result, ["recommended_next_reads"]);
  }
  for (const result of collectSuccessfulToolResults(trace, "summarize_ecode_project")) {
    appendFromResult(result, ["recommended_read_order"]);
  }
  for (const result of collectSuccessfulToolResults(trace, "start_project_closed_loop")) {
    appendFromResult(result, ["recommended_reads"]);
    const content = resultContentObject(result);
    if (!content) continue;
    const projectMap = content.project_map;
    if (projectMap && typeof projectMap === "object" && !Array.isArray(projectMap)) {
      appendFromResult({ ...result, content: projectMap }, ["recommended_read_order"]);
    }
    const analysis = content.analysis;
    if (analysis && typeof analysis === "object" && !Array.isArray(analysis)) {
      appendFromResult({ ...result, content: analysis }, ["recommended_next_reads"]);
    }
    const contextPack = content.context_pack;
    if (contextPack && typeof contextPack === "object" && !Array.isArray(contextPack)) {
      appendFromResult({ ...result, content: contextPack }, ["recommended_full_reads"]);
    }
  }
  for (const result of collectSuccessfulToolResults(trace, "export_efile_to_ecode")) {
    appendFromResult(result, ["recommended_read_order", "readable_files"]);
  }

  return paths.filter(isMainECodeTextSourcePath).slice(0, 12);
}

function collectSuccessfulReadFilePaths(trace: AgentTrace): Set<string> {
  const paths = new Set<string>();
  const coverage = new Map<string, { hash: string; total: number; ranges: [number, number][] }>();
  for (const step of trace.steps) for (let i = 0; i < step.toolCalls.length; i++) {
    const call = step.toolCalls[i], result = step.toolResults[i];
    if (call.name !== "read_file" || !toolResultSucceeded(result)) continue;
    const content = resultContentObject(result);
    if (!content) continue;
    const path = normalizeToolPath(String(content.path ?? call.arguments.file_path ?? ""));
    if (!path) continue;
    if (typeof content.code_hash !== "string" || typeof content.start_char !== "number" || typeof content.returned_chars !== "number" || typeof content.total_chars !== "number") {
      if (content.truncated !== true && content.is_partial !== true) paths.add(path);
      continue;
    }
    let entry = coverage.get(path);
    if (!entry || entry.hash !== content.code_hash) {
      paths.delete(path);
      entry = { hash: content.code_hash, total: content.total_chars, ranges: [] }; coverage.set(path, entry);
    }
    entry.ranges.push([content.start_char, content.start_char + content.returned_chars]);
    entry.ranges.sort((x, y) => x[0] - y[0]);
    let end = 0;
    for (const range of entry.ranges) { if (range[0] > end) break; end = Math.max(end, range[1]); }
    if (end >= entry.total) paths.add(path);
  }
  return paths;
}

function collectUnreadRecommendedSourcePaths(trace: AgentTrace): string[] {
  const readPaths = collectSuccessfulReadFilePaths(trace);
  return collectRecommendedSourceReadPaths(trace).filter((path) => !readPaths.has(normalizeToolPath(path)));
}

function makeAgentWorkflowState(
  trace: AgentTrace,
  answer: string | undefined,
): AgentWorkflowState {
  const closedLoopStarted = hasAnyToolCall(trace, "start_project_closed_loop");
  const closedLoopReady = hasSuccessfulToolCall(trace, "start_project_closed_loop");
  const closedLoopFinishAttempted = hasAnyToolCall(trace, "finish_project_closed_loop");
  const closedLoopBuilt = toolResultSucceeded(findLastToolResult(trace, "finish_project_closed_loop") ?? undefined);
  const generatedFromCode = hasSuccessfulToolCall(trace, "generate_efile_from_code") || hasSuccessfulToolCall(trace, "generate_gui_project");
  const generatedFromProject = hasSuccessfulToolCall(trace, "generate_efile_from_ecode");
  const exported = hasSuccessfulToolCall(trace, "export_efile_to_ecode");
  const mappedAfterExport = hasToolCallAfter(
    trace,
    "summarize_ecode_project",
    "export_efile_to_ecode",
  );
  const analyzedAfterMap = hasToolCallAfter(
    trace,
    "analyze_ecode_project",
    "summarize_ecode_project",
  );

  return {
    closedLoopStarted,
    closedLoopReady,
    closedLoopFinishAttempted,
    closedLoopBuilt,
    parsedEFile: hasSuccessfulParseOfExtension(trace, ".e"),
    exported,
    mappedAfterExport,
    readAfterExport: hasToolCallAfter(trace, "read_file", "export_efile_to_ecode"),
    readAfterMap: hasToolCallAfter(trace, "read_file", "summarize_ecode_project"),
    analyzedAfterMap,
    contextAfterAnalysis: hasToolCallAfter(
      trace,
      "inspect_ecode_context",
      "analyze_ecode_project",
    ),
    readAfterAnalysis: hasToolCallAfter(trace, "read_file", "analyze_ecode_project"),
    baselineAttempted: closedLoopStarted || hasAnyToolCall(trace, "build_original_efile_baseline"),
    baselineBuilt: closedLoopReady || hasSuccessfulToolCall(trace, "build_original_efile_baseline"),
    savedText: hasSuccessfulToolCall(trace, "save_text_file") || hasSuccessfulToolCall(trace, "apply_search_replace"),
    generated: closedLoopBuilt || generatedFromProject || generatedFromCode,
    buildAttempted: closedLoopFinishAttempted || hasAnyToolCall(trace, "build_ecode_project"),
    builtProject: closedLoopBuilt || toolResultSucceeded(findLastToolResult(trace, "build_ecode_project") ?? undefined),
    compileAttempted: closedLoopFinishAttempted || hasAnyToolCall(trace, "compile_efile"),
    compiled: closedLoopBuilt || toolResultSucceeded(findLastToolResult(trace, "compile_efile") ?? undefined),
    projectEditRequired: answer ? shouldRequireProjectEditBeforeAnswer(trace, answer) : false,
    unreadRecommendedSourcePaths: collectUnreadRecommendedSourcePaths(trace),
  };
}

function makeUnreadSourceHint(paths: string[]): string {
  const preview = paths.slice(0, 4).map((path) => `\n- ${path}`).join("");
  const suffix = paths.length > 4 ? `\n- 另有 ${paths.length - 4} 个推荐源码文件未读取` : "";
  return preview + suffix;
}

const PLAN_ITEM_STATUSES: ReadonlySet<AgentPlanItemStatus> = new Set([
  "pending",
  "in_progress",
  "done",
  "skipped",
]);

/** Fold an update_plan tool result into trace.plan. Tolerates loose model
 *  output: coerces status, drops empty titles, renumbers ids 1..n. Returns the
 *  new plan or null when the payload carried no usable items. */
function reducePlanFromToolResult(result: ToolResult | undefined): AgentPlan | null {
  if (!result || !result.ok) return null;
  const content = result.content;
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const rawItems = (content as Record<string, unknown>).plan_items;
  if (!Array.isArray(rawItems)) return null;

  const items: AgentPlanItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as Record<string, unknown>;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (!title) continue;
    const statusRaw = typeof record.status === "string" ? record.status.trim() : "pending";
    const status = PLAN_ITEM_STATUSES.has(statusRaw as AgentPlanItemStatus)
      ? (statusRaw as AgentPlanItemStatus)
      : "pending";
    items.push({ id: items.length + 1, title, status });
  }

  if (items.length === 0) return null;
  return { items, updatedAt: Date.now() };
}

/** Intercept update_plan results and fold them into trace.plan in place. Other
 *  tools pass through untouched. Keeps the visible checklist on the trace so
 *  the UI and completion checks read the same source of truth. */
function applyPlanUpdateFromToolResult(
  trace: AgentTrace,
  call: ToolCall,
  result: ToolResult,
): void {
  if (call.name !== "update_plan") return;
  const plan = reducePlanFromToolResult(result);
  if (plan) trace.plan = plan;
}

function evaluateContinueAfterFinalAnswer(
  trace: AgentTrace,
  answer: string | undefined,
): ContinueDecision {
  const state = makeAgentWorkflowState(trace, answer);
  // A build only verifies mutations that precede it. An old successful build
  // cannot validate a later edit or a newly generated window project.
  let source = -1, generated = -1, verified = -1, compileAttempt = -1;
  let buildAttempt = -1, buildTool = "";
  let position = 0;
  for (const step of trace.steps) for (let i = 0; i < step.toolCalls.length; i++, position++) {
    const name = step.toolCalls[i].name;
    const ok = toolResultSucceeded(step.toolResults[i]);
    if (ok && ["save_text_file", "apply_search_replace", "restore_project_snapshot"].includes(name)) source = position;
    if (["generate_gui_project", "generate_efile_from_code", "generate_efile_from_ecode"].includes(name)) {
      if (ok) generated = position;
    }
    if (["compile_efile", "build_ecode_project", "finish_project_closed_loop"].includes(name)) {
      compileAttempt = position;
      if (name !== "compile_efile") { buildAttempt = position; buildTool = name; }
      if (name !== "compile_efile" && ok) generated = position;
      verified = ok && (name !== "compile_efile" || generated >= source) ? position : -1;
    }
  }
  const buildExhausted = buildAttempt >= source && buildTool &&
    (countToolCalls(trace, buildTool) >= 3 || isCompileEnvironmentFailure(findLastToolResult(trace, buildTool)));
  if (source > Math.max(verified, generated) && !buildExhausted) {
    return { shouldContinue: true, reminder: state.closedLoopStarted
      ? "最新源码修改尚未验证，请调用 finish_project_closed_loop。"
      : "最新源码修改尚未验证，请调用 build_ecode_project 回编并编译。" };
  }
  if (generated > verified && compileAttempt < generated) {
    return { shouldContinue: true, reminder: "最新生成的 .e（包括窗口工程）尚未编译，请调用 compile_efile。" };
  }

  if (state.closedLoopStarted && !state.closedLoopReady && !state.savedText) {
    return { shouldContinue: false, reminder: "" };
  }

  if (
    state.parsedEFile &&
    !state.exported &&
    !state.readAfterExport &&
    /(?:^|\s)[A-Za-z]:[\\/][^\r\n<>|"]+?\.e(?=$|[\s,，;；)）\]])/i.test(trace.goal)
  ) {
    return {
      shouldContinue: true,
      reminder: "你已经解析了 .e 文件，请继续调用 export_efile_to_ecode 导出文本工程。",
    };
  }

  if (state.exported && !state.mappedAfterExport && !state.readAfterExport) {
    return {
      shouldContinue: true,
      reminder: "你已经导出了文本工程，请继续调用 summarize_ecode_project 生成项目地图。",
    };
  }

  if (state.mappedAfterExport && !state.analyzedAfterMap && !state.readAfterMap) {
    return {
      shouldContinue: true,
      reminder: "你已经生成了项目地图；请根据项目地图继续做结构化分析，或按 recommended_read_order 读取主工程源码后再回答。",
    };
  }

  if (state.analyzedAfterMap && !state.baselineAttempted) {
    return {
      shouldContinue: true,
      reminder: "你已经完成项目质量分析；在形成修改交付物前，请先调用 build_original_efile_baseline 对原始 .e 做未修改基线构建，确认工具链和依赖状态。",
    };
  }

  if (
    state.analyzedAfterMap &&
    state.baselineBuilt &&
    !state.contextAfterAnalysis &&
    !state.savedText &&
    !state.buildAttempted &&
    !state.generated &&
    !state.compileAttempted
  ) {
    return {
      shouldContinue: true,
      reminder: "原工程基线构建已通过，请继续调用 inspect_ecode_context 生成上下文包，或根据 recommended_read_order 读取目标源码。",
    };
  }

  if (
    state.analyzedAfterMap &&
    state.baselineBuilt &&
    state.unreadRecommendedSourcePaths.length > 0 &&
    !state.savedText &&
    !state.buildAttempted &&
    !state.generated &&
    !state.compileAttempted
  ) {
    return {
      shouldContinue: true,
      reminder:
        "原工程基线构建已通过，但推荐读取的主工程源码还没有覆盖完整。请先读取这些文件，再决定修改或给出有证据的无修改结论：" +
        makeUnreadSourceHint(state.unreadRecommendedSourcePaths),
    };
  }

  if (
    state.projectEditRequired &&
    !state.savedText &&
    !state.buildAttempted &&
    !state.generated &&
    !state.compileAttempted
  ) {
    return {
      shouldContinue: true,
      reminder: "你已经给出源码级修改方案，但还没有写入真实项目文件。请先调用 save_text_file 写入对应 .e.txt，再进行回编或编译验证。",
    };
  }

  if (
    state.generated &&
    !state.compileAttempted &&
    !state.buildAttempted &&
    !hasToolCallAfter(trace, "compile_efile", "generate_efile_from_ecode") &&
    !hasToolCallAfter(trace, "compile_efile", "generate_efile_from_code")
  ) {
    return {
      shouldContinue: true,
      reminder: "你已经生成了 .e 文件，请继续调用 compile_efile 编译验证。",
    };
  }

  if (
    state.closedLoopFinishAttempted &&
    !state.closedLoopBuilt &&
    countToolCalls(trace, "finish_project_closed_loop") < 3 &&
    !isCompileEnvironmentFailure(findLastToolResult(trace, "finish_project_closed_loop"))
  ) {
    return {
      shouldContinue: true,
      reminder: "finish_project_closed_loop 还未成功。请根据 repair_instruction/stdout/stderr 定位错误，读取并修复对应 .e.txt 后再次调用 finish_project_closed_loop。",
    };
  }

  if (
    !state.closedLoopFinishAttempted &&
    state.buildAttempted &&
    !state.builtProject &&
    countToolCalls(trace, "build_ecode_project") < 3 &&
    !isCompileEnvironmentFailure(findLastToolResult(trace, "build_ecode_project"))
  ) {
    return {
      shouldContinue: true,
      reminder: "项目回编或编译仍未成功。请根据 build_ecode_project 的 stdout/stderr 定位错误，读取并修复对应源码后再次构建。",
    };
  }

  if (
    !state.closedLoopFinishAttempted &&
    state.compileAttempted &&
    !state.compiled &&
    countToolCalls(trace, "compile_efile") < 3 &&
    !isCompileEnvironmentFailure(findLastToolResult(trace, "compile_efile"))
  ) {
    return {
      shouldContinue: true,
      reminder: "编译仍未成功。请根据 compile_efile 的 stdout/stderr 定位错误，读取并修复对应源码后重新生成或编译。",
    };
  }

  if (!state.compileAttempted && !state.buildAttempted && state.savedText) {
    return {
      shouldContinue: true,
      reminder: "你已经保存了源码修改，但还没有进行项目级构建或编译验证；请继续完成验证闭环。",
    };
  }

  return { shouldContinue: false, reminder: "" };
}

function shouldContinueAfterFinalAnswer(
  trace: AgentTrace,
  answer: string | undefined,
): boolean {
  return evaluateContinueAfterFinalAnswer(trace, answer).shouldContinue;
}

function traceHasProjectWorkflow(trace: AgentTrace): boolean {
  const projectTools = new Set([
    "export_efile_to_ecode",
    "summarize_ecode_project",
    "analyze_ecode_project",
    "inspect_ecode_context",
    "build_original_efile_baseline",
    "start_project_closed_loop",
    "finish_project_closed_loop",
    "restore_project_snapshot",
    "save_text_file",
    "generate_efile_from_ecode",
    "generate_efile_from_code",
    "build_ecode_project",
    "compile_efile",
  ]);
  return trace.steps.some((step) =>
    step.toolCalls.some((call) => projectTools.has(call.name)),
  );
}

function shouldUseHeavyAnswerSelfCheck(trace: AgentTrace): boolean {
  return traceHasProjectWorkflow(trace) || hasSuccessfulParseOfExtension(trace, ".ec");
}

function shouldUseReviewerAnswerSelfCheck(trace: AgentTrace, _answer: string): boolean {
  return shouldUseHeavyAnswerSelfCheck(trace);
}

function shouldRequireProjectEditBeforeAnswer(
  trace: AgentTrace,
  answer: string,
): boolean {
  const parsedEFile = hasSuccessfulParseOfExtension(trace, ".e");
  const exported = hasSuccessfulToolCall(trace, "export_efile_to_ecode");
  const analyzed = hasSuccessfulToolCall(trace, "analyze_ecode_project");
  const readSourceAfterAnalysis = hasToolCallAfter(
    trace,
    "read_file",
    "analyze_ecode_project",
  );
  if (!parsedEFile || !exported || !analyzed || !readSourceAfterAnalysis) {
    return false;
  }

  // Use the EL syntax engine instead of a fragile fence regex: any extracted
  // block that is a complete example (has a .版本/.程序集/.子程序 header) is
  // deliverable EL source that must be written into the project and compiled,
  // not just pasted into the answer. This recognizes EL source regardless of
  // how the model fenced it (```epl, ```e, or no language tag at all).
  const answerContainsUnappliedCode = extractEplCodeBlocks(answer).some((block) =>
    isCompleteExample(block.code),
  );

  return answerContainsUnappliedCode;
}

function makeContinueReminder(
  trace: AgentTrace,
  answer: string | undefined,
): ChatMessage {
  const decision = evaluateContinueAfterFinalAnswer(trace, answer);
  const hint = decision.reminder || "请继续执行下一步工具调用，完成任务后再输出 final_answer。";

  return {
    id: `guard_${nanoid(8)}`,
    role: "user",
    content:
      "【继续执行提醒】上一轮回答不是最终结果。" + hint +
      (answer ? "\n\n上一轮未完成的回答就在你上一条消息中，直接在其基础上继续，不要重复粘贴。" : ""),
    timestamp: Date.now(),
  };
}

function makeBlankResponseReminder(): string {
  return "【空响应重试】你上一轮返回了空内容。请继续当前易语言任务：需要工具时调用原生工具，完成时直接输出代码和结果说明。";
}

export function answerLooksLikeClarificationOnly(answer: string): boolean {
  const compact = answer.replace(/\s+/g, " ").trim();
  if (!compact || compact.length > 1600) return false;
  if (/```[\s\S]*?```/.test(answer) || answerContainsEplCode(answer)) return false;

  const asksQuestion = /[?？]/.test(compact);
  const asksToChoose =
    /(请选择|选择|选一个|选定|你要哪|需要哪|哪种|哪一种|回复数字|直接回复|告诉我|确认后|我再)/.test(compact);
  const hasOptionList =
    /(?:^|\s)(?:\d+[.、)]|[-*•])\s*\S+/.test(answer) ||
    /(1[.、)]|2[.、)]|3[.、)]|4[.、)])/.test(compact);

  return (asksQuestion && asksToChoose) || (asksToChoose && hasOptionList);
}

function shouldRejectClarificationOnlyAnswer(answer: string, trace: AgentTrace): boolean {
  if (!hasJingyiKnowledgeEvidence(trace)) return false;
  if (trace.pendingUserChoice) return false;
  return answerLooksLikeClarificationOnly(answer);
}

export function answerDeflectsAfterUploadedModuleParse(
  userInput: string,
  answer: string,
  trace: AgentTrace,
): boolean {
  if (!hasUploadedEcModuleEvidence(userInput, trace)) return false;
  const missingEvidence =
    /(缺少|没有|无法|不能|不敢|需要).*?(接口|命令名|签名|参数|证据)/.test(answer);
  const asksUserToContinue =
    /(先让用户|让用户|请选择|选定实现路线|不能硬编造|你接下来有.*选择|如果你希望我继续|我下一步可以|再上传.*模块)/.test(answer);
  const leavesPlaceholderImplementation =
    /(占位|模拟返回|当前先做演示|先做演示|你项目里实际可用|请替换成.*?(方法|函数|命令|模块|接口|实现)|替换成.*?(方法|函数|命令|模块|接口|实现)|下一步.*?补全)/.test(answer);
  if (leavesPlaceholderImplementation) return true;
  if (answerContainsEplCode(answer) && !missingEvidence && !asksUserToContinue) return false;
  return missingEvidence || asksUserToContinue;
}

function makeAnswerSelfCheckRetryStep(
  stepIndex: number,
  assistantText: string,
  stepStart: number,
): AgentStep {
  return {
    index: stepIndex,
    assistantText,
    toolCalls: [],
    toolResults: [],
    finishReason: "format_retry",
    startedAt: stepStart,
    endedAt: Date.now(),
  };
}

interface AnswerSelfCheckDecision {
  pass: boolean;
  confidence: number;
  issues: string[];
  followup: string;
}

function limitForSelfCheck(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.58));
  const tail = text.slice(-Math.floor(maxChars * 0.28));
  return `${head}\n\n... [自检上下文已截断，省略 ${text.length - maxChars} 字符] ...\n\n${tail}`;
}

function summarizeTraceForSelfCheck(trace: AgentTrace): string {
  const lines: string[] = [
    `目标：${trace.goal}`,
    `当前步骤数：${trace.steps.length}`,
    `工具调用次数：${trace.toolCallCount}`,
  ];

  for (const step of trace.steps.slice(-10)) {
    if (step.toolCalls.length === 0) {
      lines.push(`- 第 ${step.index} 步：${step.finishReason}`);
      continue;
    }
    step.toolCalls.forEach((call, index) => {
      const result = step.toolResults[index];
      lines.push(
        `- 第 ${step.index}.${index + 1} 步 ${call.name}: ${summarizeToolResultForSelfCheck(result)}`,
      );
    });
  }

  return limitForSelfCheck(lines.join("\n"), 7_000);
}

function summarizeToolResultForSelfCheck(result: ToolResult | undefined): string {
  if (!result) return "无结果";
  const parts = [toolResultSucceeded(result) ? "成功" : "失败"];
  if (result.error) parts.push(`错误=${result.error}`);
  if (result.content && typeof result.content === "object" && !Array.isArray(result.content)) {
    const payload = result.content as Record<string, unknown>;
    const importantKeys = [
      "success",
      "summary",
      "public_api_index",
      "matches",
      "implementation_options",
      "related_implementations",
      "findings",
      "stderr",
      "stdout",
      "error",
      "output_path",
      "ecode_dir",
    ];
    for (const key of importantKeys) {
      const value = payload[key];
      if (value === undefined || value === null) continue;
      parts.push(`${key}=${limitForSelfCheck(JSON.stringify(value), 900)}`);
    }
  } else if (typeof result.content === "string") {
    parts.push(limitForSelfCheck(result.content, 900));
  }
  return limitForSelfCheck(parts.join("；"), 1_800);
}

function parseAnswerSelfCheckDecision(text: string): AnswerSelfCheckDecision | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  const parsed = tryParseJsonWithRepair(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const pass = obj.pass === true;
  const confidence =
    typeof obj.confidence === "number"
      ? obj.confidence
      : typeof obj.score === "number"
        ? obj.score
        : pass
          ? 1
          : 0;
  const issues = Array.isArray(obj.issues)
    ? obj.issues.filter((item): item is string => typeof item === "string")
    : typeof obj.issue === "string"
      ? [obj.issue]
      : [];
  const followup =
    typeof obj.followup === "string"
      ? obj.followup
      : typeof obj.revision_prompt === "string"
        ? obj.revision_prompt
        : issues.join("\n");

  return {
    pass,
    confidence,
    issues,
    followup,
  };
}

function makeAnswerSelfCheckMessages(
  userInput: string,
  trace: AgentTrace,
  answer: string,
  eplDiagnosticsText: string,
  selectedImplementation: string,
): ChatMessage[] {
  const diagnosticSection = eplDiagnosticsText
    ? `\n\n【本地 EPL 代码信号】\n${eplDiagnosticsText}`
    : "";
  const selectedImplementationSection = selectedImplementation
    ? `\n\n【用户上一轮已选择的实现方式】\n${selectedImplementation}`
    : "";
  const prompt = `请作为 EAiCoding 的独立 Reviewer 自检候选最终答案。

你的任务不是重写答案，而是判断它是否可以展示给用户。重点检查：
1. 是否真正回答了用户当前问题，而不是答偏或只给空泛建议。
2. 易语言示例是否有工具证据支撑；如果用户上传并要求使用 .ec 模块，应确认答案基于 parse_efile 的模块接口；如果涉及精易模块 API，应确认答案使用了已查询到的签名/实现，不要凭记忆编造。
3. 代码是否存在明显不可用结构、伪语法、缺少必要声明、控制结构不闭合、机械复制、参数没有变化等问题。
4. 如果用户要求生成、编译、测试、修复，应确认工具闭环已经完成或失败原因已被真实说明。
5. 如果只是普通案例问答，不要求强行生成 .e，但应保证示例自洽、语法可信、实现路线符合用户选择。
6. 如果本地代码信号只是 warning，不要机械否决；请结合用户目标判断它是否确实会导致答案质量问题。

只输出一个 JSON 对象：
{
  "pass": true 或 false,
  "confidence": 0 到 1,
  "issues": ["不通过时列出具体问题"],
  "followup": "不通过时写给主 Agent 的下一步指令：需要继续查工具、重写答案或修正哪段代码"
}

【用户问题】
${userInput}

【已执行轨迹和工具证据】
${summarizeTraceForSelfCheck(trace)}${selectedImplementationSection}${diagnosticSection}

【候选最终答案】
${limitForSelfCheck(answer, 10_000)}`;

  return [
    {
      id: "__self_check_sys__",
      role: "system",
      content: "你是严谨的 AI Coding Reviewer。只做事实核查和可交付性判断，输出严格 JSON。",
      timestamp: 0,
    },
    {
      id: `self_check_${nanoid(8)}`,
      role: "user",
      content: prompt,
      timestamp: Date.now(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Silent compile-validation gate.
//
// Runs after all rule-based and reviewer self-checks pass. The point is to
// catch the failure mode prompts can't reach: "looks correct but ecl rejects
// it." When a candidate answer contains a complete-looking EPL example, we
// generate a .e in a temp dir, run ecl, and feed stderr back if it fails so
// the model can self-correct — the way a human would after a compile error.
//
// Module paths gathered from:
// 1. user input (.ec absolute paths the user pasted, e.g. precompiled jingyi)
// 2. all ready-state user modules in the library (their stored .ec copies)
// The compile backend de-dups; passing extras is cheap (mod files are copied
// to ecom/ but only ones actually referenced by the source affect compilation).
// ---------------------------------------------------------------------------

function collectCompileModulePaths(userInput: string): string[] {
  const fromInput = extractLocalPathsByExtension(userInput, "ec");
  const fromLibrary = useSettingsStore
    .getState()
    .userModules.filter((entry) => entry.status === "ready" && entry.storedPath)
    .map((entry) => entry.storedPath);
  return Array.from(new Set([...fromInput, ...fromLibrary]));
}

async function applyCompileGate(
  userInput: string,
  answer: string,
  base: AnswerSelfCheckDecision,
  signal?: AbortSignal,
): Promise<AnswerSelfCheckDecision> {
  if (!base.pass) return base;
  const modulePaths = collectCompileModulePaths(userInput);
  let result: AnswerCompileCheckResult;
  try {
    result = await checkAnswerCompiles(answer, modulePaths, signal);
  } catch (err) {
    throwIfAborted(signal);
    // Never fail the answer because the *checker* crashed — that would be
    // worse than letting a possibly-broken answer through. Log and skip.
    console.warn("[answer-compile-check] checker crashed:", err);
    return base;
  }
  if (!result.attempted || result.ok) return base;

  return {
    pass: false,
    confidence: 0,
    issues: [
      result.stage === "generate_failed"
        ? "候选答案中的 EPL 代码块无法落盘成 .e 工程。"
        : "候选答案中的 EPL 代码块通过 ecl 编译验证失败。",
    ],
    followup: buildCompileFollowupText(result),
  };
}

async function runAnswerSelfCheck(
  config: LLMConfig,
  userInput: string,
  history: ChatMessage[],
  trace: AgentTrace,
  answer: string,
  signal?: AbortSignal,
): Promise<AnswerSelfCheckDecision> {
  throwIfAborted(signal);
  const eplDiagnostics = findEplAnswerDiagnostics(answer);
  const eplDiagnosticsText = eplDiagnostics.length > 0
    ? formatEplDiagnostics(eplDiagnostics)
    : "";
  const eplErrorsText = eplDiagnostics.some((item) => item.severity === "error")
    ? formatEplDiagnostics(eplDiagnostics.filter((item) => item.severity === "error"))
    : "";
  const blockingEplDiagnostics = eplDiagnostics.filter(
    (item) => item.severity === "error" || item.kind === "repeated_executable",
  );
  const blockingEplDiagnosticsText = blockingEplDiagnostics.length > 0
    ? formatEplDiagnostics(blockingEplDiagnostics)
    : "";
  const selectedImplementation = describeSelectedImplementationFromChoice(userInput, history);

  if (shouldRequireJingyiEvidence(userInput, answer, trace)) {
    return {
      pass: false,
      confidence: 0.1,
      issues: ["答案涉及易语言/精易模块 API，但本轮没有查询任何知识库作为依据。"],
        followup:
        "按 KB-first 原则先查知识库：用户上传过 .ec 时优先 search_user_modules（鱼刺类等团队模块），需要精易模块 API 时调 search_jingyi_module。根据工具返回的签名、参数和 implementation_options 重写答案，不要凭记忆。",
    };
  }

  if (shouldRejectClarificationOnlyAnswer(answer, trace)) {
    return {
      pass: false,
      confidence: 0.15,
      issues: ["候选答案只是让用户在正文里继续选择，没有交付代码或明确结论。"],
      followup:
        "本轮已经有精易模块工具证据；如果确实需要用户选择，必须通过 ask_user_choice/结构化 pendingUserChoice，而不是在正文里追问。当前没有 pendingUserChoice 时，请根据工具证据选一个默认推荐实现并直接给完整 final_answer。",
    };
  }

  if (answerDeflectsAfterUploadedModuleParse(userInput, answer, trace)) {
    return {
      pass: false,
      confidence: 0.12,
      issues: ["已成功解析用户上传的 .ec 模块，但候选答案仍把缺少接口证据作为最终结论。"],
      followup:
        "请读取 parse_efile 工具结果中的 public_api_index，基于其中的公开接口签名继续写完整示例；不要再要求用户选择或声称缺少模块接口证据。只有 public_api_index 为空时，才说明无法确认接口。",
    };
  }

  if (selectedImplementation) {
    if (!answerMentionsSelectedImplementation(answer, selectedImplementation)) {
      return {
        pass: false,
        confidence: 0.2,
        issues: ["用户已经选择了实现方式，但候选答案没有按该选择展开。"],
        followup:
          `用户已选择 ${selectedImplementation}。请基于该实现方式和已查询到的精易模块签名重写最终答案，不要再要求用户重新选择。`,
      };
    }
  } else {
    const missingComparisonOptions = /(比较|对比|区别|有哪些方式|有哪些实现)/.test(userInput) ? shouldRequireImplementationComparison(answer, trace) : [];
    if (missingComparisonOptions.length > 0) {
      return {
        pass: false,
        confidence: 0.2,
        issues: [
          "精易模块知识库返回了多个实现候选，但候选答案没有基于这些证据做比较或选择说明。",
        ],
        followup:
          "请根据 search_jingyi_module 返回的 implementation_options/related_implementations 重写答案，至少比较这些候选中的多个实现，并说明默认推荐或需要用户选择的点：" +
          missingComparisonOptions.join("、"),
      };
    }
  }

  if (blockingEplDiagnosticsText) {
    return {
      pass: false,
      confidence: 0,
      issues: ["候选答案存在 EPL 结构错误或机械重复代码。"],
      followup: `请修正以下 EPL 代码问题后重写最终答案：\n${blockingEplDiagnosticsText}`,
    };
  }

  const heavySelfCheck = shouldUseHeavyAnswerSelfCheck(trace);
  const useReviewerSelfCheck = shouldUseReviewerAnswerSelfCheck(trace, answer);

  if (!useReviewerSelfCheck) {
    if (eplErrorsText) {
      return {
        pass: false,
        confidence: 0,
        issues: ["候选答案存在确定的 EPL 结构错误。"],
        followup: `请修正以下 EPL 结构问题后重写最终答案：\n${eplErrorsText}`,
      };
    }
    return await applyCompileGate(userInput, answer, {
      pass: true,
      confidence: 0.86,
      issues: [],
      followup: "",
    }, signal);
  }

  let checkerText = "";

  const runCheckerOnce = async (): Promise<Error | null> => {
    checkerText = "";
    let attemptError: Error | null = null;
    const provider = createLLMProvider({ ...config, maxTokens: Math.min(config.maxTokens ?? 8192, 8192), systemPrompt: undefined });
    let timeoutId: number | undefined;
    try {
      await Promise.race([
        abortable(provider.stream(
          makeAnswerSelfCheckMessages(userInput, trace, answer, eplDiagnosticsText, selectedImplementation),
          {
            onToken: (token) => {
              checkerText += token;
            },
            onComplete: (full) => {
              checkerText = full || checkerText;
            },
            onError: (error) => {
              attemptError = error;
            },
          },
          { nativeTools: false },
        ), signal, () => provider.abort()),
        new Promise<never>((_, reject) => {
          timeoutId = window.setTimeout(() => {
            provider.abort();
            reject(new Error(`Answer self-check timed out after ${Math.round(ANSWER_SELF_CHECK_TIMEOUT_MS / 1000)}s`));
          }, ANSWER_SELF_CHECK_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      attemptError = error instanceof Error ? error : new Error(String(error));
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
    return attemptError;
  };

  // One retry on transport failure: a transient network error here would
  // otherwise report pass:false and burn several answer-rewrite steps.
  let checkerError = await runCheckerOnce();
  if (checkerError) {
    await abortableDelay(1500, signal);
    checkerError = await runCheckerOnce();
  }

  throwIfAborted(signal);
  const parsed = checkerError ? null : parseAnswerSelfCheckDecision(checkerText);
  if (parsed) {
    if (eplErrorsText && parsed.pass) {
      return {
        pass: false,
        confidence: Math.min(parsed.confidence, 0.2),
        issues: [
          "本地 EPL 结构检查发现候选答案存在确定的控制结构错误。",
          ...parsed.issues,
        ],
        followup:
          `请根据本地 EPL 结构检查修正代码后重写最终答案：\n${eplErrorsText}`,
      };
    }
    return parsed.pass ? await applyCompileGate(userInput, answer, parsed, signal) : parsed;
  }

  if (eplErrorsText) {
    return {
      pass: false,
      confidence: 0,
      issues: ["候选答案存在确定的 EPL 结构错误。"],
      followup: `请修正以下 EPL 结构问题后重写最终答案：\n${eplErrorsText}`,
    };
  }

  return {
    pass: false,
    confidence: checkerError ? 0 : 0.5,
    issues: checkerError ? [`自检模型调用失败：${checkerError.message}`] : ["自检模型未返回可解析 JSON。"],
    followup: "请重新执行答案自检；如果仍失败，不要把候选答案作为已验证结果展示给用户。",
  };
}

function makeAnswerSelfCheckReminder(
  decision: AnswerSelfCheckDecision,
  iteration: number,
): ChatMessage {
  const issues = decision.issues.length > 0
    ? decision.issues.map((issue) => `- ${issue}`).join("\n")
    : "- 自检未通过，但未给出细节。";
  const followup = decision.followup.trim()
    ? decision.followup.trim()
    : "请重新审查用户问题和工具结果，必要时继续调用工具，然后重写最终答案。";

  return {
    id: `self_check_retry_${nanoid(8)}`,
    role: "user",
    content:
      `【自检未通过 ${iteration}/${ANSWER_SELF_CHECK_MAX_REVISIONS}】候选最终答案暂不展示给用户。\n` +
      `置信度：${decision.confidence}\n` +
      `问题：\n${issues}\n\n` +
      `下一步：${followup}\n\n` +
      `要求：如果缺少精易模块证据，先调用 search_jingyi_module；如果缺少文件事实，先调用对应读取/解析工具；如果只是答案表达或代码错误，则重写 final_answer。不要把自检过程暴露给用户。\n\n` +
      `候选答案就是你上一条消息中的 final_answer，请直接在其基础上修正，不要重复粘贴原文。`,
    timestamp: Date.now(),
  };
}

function formatPendingUserChoice(request: AgentUserChoiceRequest): string {
  const lines = [request.question.trim()];
  if (request.context?.trim()) {
    lines.push("", request.context.trim());
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Approval gate (P4). Only source-mutating tools are gated; everything else
// (reads, searches, analysis, compile) runs freely. The request is built from
// the model's own tool arguments — no disk read — so the runner stays free of
// Tauri invoke and remains unit-testable.
// ---------------------------------------------------------------------------

const SOURCE_MUTATING_TOOLS = new Set([
  "save_text_file",
  "apply_search_replace",
]);

function isSourceMutatingCall(call: ToolCall): boolean {
  return SOURCE_MUTATING_TOOLS.has(call.name);
}

/** Pull the pending new source text from a mutating call's arguments, so we can
 *  run the EL pre-flight and show a preview before it touches disk. For
 *  save_text_file this is the whole `content`; for apply_search_replace it is
 *  the `replace` side of the patch. Returns "" when nothing is derivable. */
function pendingSourceFromCall(call: ToolCall): string {
  const args = call.arguments ?? {};
  if (call.name === "save_text_file") {
    return typeof args.content === "string" ? args.content : "";
  }
  if (call.name === "apply_search_replace") {
    if (typeof args.replace === "string") return args.replace;
    // Whole-patch form: extract the REPLACE side from the block text.
    if (typeof args.patch === "string") {
      const sep = args.patch.indexOf("=======");
      const end = args.patch.indexOf(">>>>>>> REPLACE");
      if (sep >= 0 && end > sep) {
        return args.patch.slice(sep + "=======".length, end).replace(/^\r?\n/, "");
      }
    }
  }
  return "";
}

function approvalTargetPath(call: ToolCall): string | undefined {
  const args = call.arguments ?? {};
  const path = typeof args.path === "string" ? args.path : undefined;
  if (path) return path;
  if (call.name === "apply_search_replace" && typeof args.patch === "string") {
    const match = args.patch.match(/(?:^|\n)PATH:\s*(.+)\s*(?:\n|$)/i);
    return match?.[1]?.trim() || undefined;
  }
  return undefined;
}

function makeApprovalRequest(call: ToolCall): AgentApprovalRequest {
  const targetPath = approvalTargetPath(call);
  const pending = pendingSourceFromCall(call);
  const diagnostics = pending
    ? findEplSourceDiagnostics(pending)
        .filter((item) => item.severity === "error")
        .map((item) => `第 ${item.line} 行：${item.message}`)
    : [];
  const summary =
    call.name === "save_text_file"
      ? `写入文件 ${targetPath ?? "(未知路径)"}（${pending.length} 字符）`
      : `补丁修改 ${targetPath ?? "(未知路径)"}`;
  const diffPreview = pending
    ? pending.length > 1200
      ? `${pending.slice(0, 1200)}\n... [预览截断，共 ${pending.length} 字符]`
      : pending
    : undefined;
  return {
    toolName: call.name,
    summary,
    targetPath,
    diffPreview,
    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
  };
}

/** Build the tool result substituted for a rejected/paused-then-rejected
 *  mutating call, so the model sees the refusal and can adjust instead of
 *  assuming the write happened. */
function makeRejectedToolResult(call: ToolCall, reason: string | undefined): ToolResult {
  const note = reason?.trim()
    ? `用户拒绝了这次写入：${reason.trim()}`
    : "用户拒绝了这次写入。请根据用户意图调整方案，不要重复完全相同的写入。";
  return {
    toolCallId: call.id,
    toolName: call.name,
    ok: false,
    content: { success: false, rejected_by_user: true, error: note },
    error: note,
    durationMs: 0,
  };
}

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export function startAgentRun(options: AgentRunOptions): AgentRunHandle {
  const providerRef: { current: BaseLLMProvider | null } = { current: null };
  let aborted = false;
  const controller = new AbortController();
  const signal = controller.signal;

  const abort = () => {
    aborted = true;
    controller.abort();
    providerRef.current?.abort();
    // Wake any pauseWaiters so an abort during a paused run doesn't hang.
    const waiters = pauseWaiters;
    pauseWaiters = [];
    for (const wake of waiters) wake();
  };

  // Pause/resume: `paused` is the flag; `pauseWaiters` holds the resolvers of
  // any `waitWhilePaused()` promises currently parked. resume() drains them.
  let paused = false;
  let pauseWaiters: Array<() => void> = [];
  const pause = () => { paused = true; };
  const resume = () => {
    paused = false;
    const waiters = pauseWaiters;
    pauseWaiters = [];
    for (const wake of waiters) wake();
  };
  const isPaused = () => paused;
  /** Block until resume() is called (or the run is aborted). Cheap no-op when
   *  not paused, so it is safe to await at every loop boundary. */
  const waitWhilePaused = async (): Promise<void> => {
    while (paused && !aborted) {
      options.onStatus?.("已暂停，等待继续");
      await new Promise<void>((resolve) => { pauseWaiters.push(resolve); });
    }
  };

  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }

    const startedAt = Date.now();
    const trace: AgentTrace = {
      goal: options.userInput,
      steps: [],
      finalAnswer: "",
      outcome: "max_steps",
      startedAt,
      endedAt: startedAt,
      toolCallCount: 0,
    };
  const publishPendingTool = (index: number, startedAt: number, assistantText: string, toolCalls: ToolCall[], toolResults: ToolResult[], activeToolId: string) => {
    const step: AgentStep = { index, startedAt, endedAt: Date.now(), assistantText, toolCalls, toolResults: [...toolResults], finishReason: "tool_call" };
    options.onToolProgress?.(step, { ...trace, steps: [...trace.steps, step], endedAt: step.endedAt, toolCallCount: trace.toolCallCount + toolCalls.length - toolResults.length }, activeToolId);
  };
  const promise = (async (): Promise<AgentTrace> => {
    const socialTurn = isSocialTurn(options.userInput);
    // Native tool turns have no arbitrary desktop-wide step ceiling. An
    // integration can still request a strict limit without changing that UI.
    const maxSteps = socialTurn ? 1 : options.maxSteps === undefined
      ? Number.POSITIVE_INFINITY
      : Number.isFinite(options.maxSteps) ? Math.max(1, Math.floor(options.maxSteps)) : 1;
    let consecutiveUnfinishedAnswers = 0;
    let answerSelfCheckRevisionCount = 0;
    let mutationEpoch = 0;
    const repeatedTools = new Map<string, { epoch: number; count: number }>();
    let stalledTool: string | null = null;

    const restricted = options.mode === "plan" || options.mode === "read-only";
    const useNativeTools = selectAgentToolTransport(options.config) === "native-openai-tools";
    const decide = (state: AgentTrace, answer: string | undefined): ContinueDecision => restricted || socialTurn
      ? { shouldContinue: false, reminder: "" } : evaluateContinueAfterFinalAnswer(state, answer);
    const stalledCompletion = (decision: ContinueDecision): boolean => {
      if (!decision.shouldContinue) return false;
      if (++consecutiveUnfinishedAnswers < 3) return false;
      trace.outcome = "error";
      trace.finalAnswer = `任务尚未完成：${decision.reminder}\n\n模型连续回复完成说明，却没有执行所需工具，已停止无进展的重复请求。现有源码和工具结果已保留。`;
      return true;
    };
    const systemMsg = socialTurn ? {
      id: `sys_${nanoid(8)}`, role: "system" as const, timestamp: Date.now(),
      content: "你是 EAiCoding 的易语言编程助手。请用简洁、自然的中文回应用户当前的问候、致谢或自我介绍问题。需要介绍时，可以简短说明你能编写和修改易语言代码、生成窗口界面。不要自行开始开发、检索、编译或汇报执行步骤。",
    } : makeSystemMessage(options.config.systemPrompt, maxSteps);
    if (restricted) systemMsg.content += options.mode === "plan"
      ? "\n【当前模式：计划】此项限制优先于项目闭环要求：只读取和分析，输出目标、步骤、依赖与验收方案。不要执行修改、生成、构建或编译，不要声称已经实现。"
      : "\n【当前模式：只读】此项限制优先于项目闭环要求：只读取和分析，给出建议。禁止修改、生成、构建或编译，不要声称已修改。";
    // 历史中的每条 agentTrace 消息已由 shapeHistoryForLLM 压缩为 summarizeTrace
    // 摘要；此前这里还会再附加一份 makeAgentMemoryMessage（同一函数对同一批
    // trace 的第二份摘要），纯重复注入，已移除。
    const conversation: ChatMessage[] = [
      systemMsg,
      ...(socialTurn ? [] : shapeHistoryForLLM(options.history)),
      {
        id: `u_${nanoid(8)}`,
        role: "user",
        content: options.userInput,
        timestamp: Date.now(),
      },
    ];

    let firstModelStepIndex = 1;
    const uploadedEcParseTargets = socialTurn ? [] : getRecentUploadedEcModuleParseTargets(
      options.userInput,
      options.history,
    );
    if (uploadedEcParseTargets.length > 0 && !aborted) {
      const stepIndex = firstModelStepIndex;
      const stepStart = Date.now();
      const toolCalls = uploadedEcParseTargets.map(makeParseEFileToolCall);
      const assistantText = "先解析用户上传的 .ec 模块公开接口，再基于该模块写代码。";
      conversation.push({
        id: `a_${nanoid(8)}`,
        role: "assistant",
        content: JSON.stringify({ thought: assistantText, tool_calls: toolCalls }),
        timestamp: Date.now(),
        toolCalls,
      });

      const toolResults: ToolResult[] = [];
      for (const call of toolCalls) {
        options.onStatus?.(`解析上传模块`);
        publishPendingTool(stepIndex, stepStart, assistantText, toolCalls, toolResults, call.id);
        const result = await executeTool(call.name, call.id, call.arguments, {
          sessionId: options.sessionId,
          userInput: options.userInput,
          allowDialog: options.allowDialog ?? true,
          onStatus: options.onStatus,
        signal,
        });
        toolResults.push(result);
        conversation.push(toolResultToMessage(result));
        trace.toolCallCount += 1;
      }

      const step: AgentStep = {
        index: stepIndex,
        assistantText,
        toolCalls,
        toolResults,
        finishReason: "tool_call",
        startedAt: stepStart,
        endedAt: Date.now(),
      };
      trace.steps.push(step);
      options.onStep?.(step, trace);
      firstModelStepIndex = 2;
    }

    const selectedImplementation = describeSelectedImplementationFromChoice(
      options.userInput,
      options.history,
    );
    const selectedEvidenceQuery = buildSelectedImplementationEvidenceQuery(
      options.userInput,
      options.history,
    );
    if (!socialTurn && selectedEvidenceQuery && !aborted) {
      const stepIndex = firstModelStepIndex;
      const stepStart = Date.now();
      const call = makeJingyiSearchToolCall(selectedEvidenceQuery);
      const assistantText = "根据用户已选择的实现方式，先补齐精易模块知识库证据。";
      conversation.push({
        id: `a_${nanoid(8)}`,
        role: "assistant",
        content: JSON.stringify({ thought: assistantText, tool_calls: [call] }),
        timestamp: Date.now(),
        toolCalls: [call],
      });

      options.onStatus?.(`查询所选实现证据`);
      publishPendingTool(stepIndex, stepStart, assistantText, [call], [], call.id);
      const result = await executeTool(call.name, call.id, call.arguments, {
        sessionId: options.sessionId,
        userInput: selectedEvidenceQuery,
        allowDialog: options.allowDialog ?? true,
        onStatus: options.onStatus,
        signal,
      });
      conversation.push(toolResultToMessage(result));
      if (selectedImplementation) {
        conversation.push(makeSelectedImplementationReminder(selectedImplementation));
      }
      trace.toolCallCount += 1;

      const step: AgentStep = {
        index: stepIndex,
        assistantText,
        toolCalls: [call],
        toolResults: [result],
        finishReason: "tool_call",
        startedAt: stepStart,
        endedAt: Date.now(),
      };
      trace.steps.push(step);
      options.onStep?.(step, trace);
      firstModelStepIndex = 2;
    }

    if (
      !socialTurn && firstModelStepIndex === 1 &&
      shouldPrimeJingyiKnowledge(options.userInput, options.history) &&
      !aborted
    ) {
      const stepIndex = firstModelStepIndex;
      const stepStart = Date.now();
      const call = makeJingyiSearchToolCall(options.userInput);
      const assistantText = "先查询本地精易模块知识库，获取真实 API 证据和可选实现路线。";
      conversation.push({
        id: `a_${nanoid(8)}`,
        role: "assistant",
        content: JSON.stringify({ thought: assistantText, tool_calls: [call] }),
        timestamp: Date.now(),
        toolCalls: [call],
      });

      options.onStatus?.(`查询精易模块`);
      publishPendingTool(stepIndex, stepStart, assistantText, [call], [], call.id);
      const result = await executeTool(call.name, call.id, call.arguments, {
        sessionId: options.sessionId,
        userInput: options.userInput,
        allowDialog: options.allowDialog ?? true,
        onStatus: options.onStatus,
        signal,
      });
      conversation.push(toolResultToMessage(result));
      trace.toolCallCount += 1;

      const step: AgentStep = {
        index: stepIndex,
        assistantText,
        toolCalls: [call],
        toolResults: [result],
        finishReason: "tool_call",
        startedAt: stepStart,
        endedAt: Date.now(),
      };

      const pendingUserChoice = findPendingUserChoiceFromToolResults(
        [result],
        options.userInput,
      );
      if (pendingUserChoice) {
        trace.steps.push(step);
        finishWithPendingUserChoice(
          trace,
          step,
          pendingUserChoice,
          options.onStatus,
          options.onStep,
        );
        trace.endedAt = Date.now();
        return trace;
      }

      trace.steps.push(step);
      options.onStep?.(step, trace);
      firstModelStepIndex = 2;
    }

    for (let stepIndex = firstModelStepIndex; stepIndex <= maxSteps; stepIndex++) {
      if (aborted) {
        trace.outcome = "aborted";
        break;
      }

      options.onStatus?.(`模型推理中`);

      const stepStart = Date.now();
      let assistantText = "";
      let reasoningContent = "";
      let streamError: Error | null = null;
      let nativeToolCalls: ToolCall[] = [];
      let networkRetries = 0;
      let outputRecoveries = 0;

      while (true) {
        if (aborted) break;

        assistantText = "";
        reasoningContent = "";
        streamError = null;
        nativeToolCalls = [];
        options.onAssistantStart?.(stepIndex);
        const provider = createLLMProvider({ ...options.config, maxTokens: options.config.maxTokens ?? DEEPSEEK_DEFAULT_MAX_TOKENS, systemPrompt: undefined });
        providerRef.current = provider;
        // Discard the incomplete assistant turn entirely. Only this retry gets
        // the instruction; completed tools and their results remain unchanged.
        const requestConversation = outputRecoveries === 0 ? conversation : conversation.map((message, index) => index === 0 ? {
          ...message,
          content: message.content + `\n【输出截断恢复 ${outputRecoveries}/${LLM_OUTPUT_RECOVERY_ATTEMPTS}】上一轮因输出 Token 上限被丢弃，该轮没有执行任何工具。不要续写截断内容，也不要重做已有成功工具结果中的工作。请缩小本轮操作：${outputRecoveries === 1 ? "只调用一个工具，优先修改单个文件中的一个小片段" : "只处理一个最小子程序或补丁，省略进度正文和重复说明"}。保证参数 JSON 完整；其余工作留到工具返回后的下一轮继续。若只需回答，直接简洁作答。`,
        } : message);

        let accepting = true;
        let timeoutId: number | undefined;
        try {
          await Promise.race([
            abortable(provider.stream(requestConversation, {
              onToken: (token) => {
                if (!accepting || aborted) return;
                assistantText += token;
                options.onAssistantToken?.(token, stepIndex);
              },
              onReasoningToken: (token) => {
                if (!accepting || aborted) return;
                reasoningContent += token;
                options.onReasoningToken?.(token, stepIndex);
              },
              onComplete: (full, metadata) => {
                if (!accepting || aborted) return;
                assistantText = full || assistantText;
                reasoningContent = metadata?.reasoningContent ?? reasoningContent;
              },
              onError: (err) => {
                if (!accepting || aborted) return;
                streamError = err;
              },
              onToolCall: (call) => {
                if (!accepting || aborted) return;
                nativeToolCalls.push(call);
              },
            }, {
              tools: socialTurn ? [] : restricted ? TOOL_DEFINITIONS.filter(tool => isReadOnlyTool(tool.name)) : TOOL_DEFINITIONS,
              nativeTools: useNativeTools,
            }), signal, () => provider.abort()),
            new Promise<never>((_, reject) => {
              timeoutId = window.setTimeout(() => {
                provider.abort();
                reject(
                  new Error(
                    `LLM step timed out after ${Math.round(LLM_STEP_TIMEOUT_MS / 1000)}s`,
                  ),
                );
              }, LLM_STEP_TIMEOUT_MS);
            }),
          ]);
        } catch (err) {
          streamError = err instanceof Error ? err : new Error(String(err));
        } finally {
          if (timeoutId !== undefined) {
            window.clearTimeout(timeoutId);
          }
          accepting = false;
          providerRef.current = null;
        }

        if (!streamError) break;
        if (aborted) break;
        if (streamError instanceof LLMOutputLimitError) {
          if (outputRecoveries >= LLM_OUTPUT_RECOVERY_ATTEMPTS) {
            streamError.message += `已自动尝试拆小本轮输出 ${outputRecoveries} 次仍被截断，任务尚未完成。请在设置中提高最大输出 Token 后继续。`;
            break;
          }
          outputRecoveries++;
          options.onStatus?.(`输出达到上限，正在自动拆小操作并重试（${outputRecoveries}/${LLM_OUTPUT_RECOVERY_ATTEMPTS}）`);
          continue;
        }
        const isRetryable =
          streamError instanceof LLMError
            ? streamError.retryable
            : streamError.message.includes("timed out") ||
              streamError.message.includes("Failed to fetch") ||
              streamError.message.includes("NetworkError") ||
              streamError.message.includes("network") ||
              !navigator.onLine;
        if (!isRetryable || networkRetries >= LLM_MAX_RETRIES) break;
        networkRetries++;
        options.onStatus?.(`重试中（${networkRetries}/${LLM_MAX_RETRIES}）`);
        await abortableDelay(LLM_RETRY_BASE_MS * 2 ** (networkRetries - 1), signal);
        // If offline, wait until back online (up to 30s) before retrying
        if (!navigator.onLine) {
          await abortableDelay(3_000, signal);
        }
      }

      if (aborted) {
        trace.outcome = "aborted";
        break;
      }

      if (streamError) {
        if (streamError instanceof LLMOutputLimitError) {
          assistantText = "";
          reasoningContent = "";
          options.onAssistantStart?.(stepIndex);
        }
        const step: AgentStep = {
          index: stepIndex,
          assistantText,
          reasoningContent,
          toolCalls: [],
          toolResults: [],
          finishReason: "error",
          startedAt: stepStart,
          endedAt: Date.now(),
        };
        trace.steps.push(step);
        trace.outcome = "error";
        trace.finalAnswer = `LLM 请求失败：${(streamError as Error).message ?? String(streamError)}`;
        options.onStep?.(step, trace);
        break;
      }

      if (!assistantText.trim() && nativeToolCalls.length === 0) {
        const priorEmptyCount = countTrailingBlankRetries(trace);

        if (priorEmptyCount < 2 && stepIndex < maxSteps) {
          const step: AgentStep = {
            index: stepIndex,
            assistantText,
            reasoningContent,
            toolCalls: [],
            toolResults: [],
            finishReason: "format_retry",
            startedAt: stepStart,
            endedAt: Date.now(),
          };
          trace.steps.push(step);
          options.onStep?.(step, trace);

          conversation.push({
            id: `blank_${nanoid(8)}`,
            role: "user",
            content: makeBlankResponseReminder(),
            timestamp: Date.now(),
          });
          options.onStatus?.(`空响应重试`);
          continue;
        }

        const step: AgentStep = {
          index: stepIndex,
          assistantText,
          reasoningContent,
          toolCalls: [],
          toolResults: [],
          finishReason: "error",
          startedAt: stepStart,
          endedAt: Date.now(),
        };
        trace.steps.push(step);
        trace.outcome = "error";
        trace.finalAnswer = "LLM 返回了空响应，任务在中途终止。";
        options.onStep?.(step, trace);
        break;
      }

      const parsed: ParsedAgentTurn = nativeToolCalls.length > 0
        ? {
            unstructured: false,
            thought: assistantText.trim() || undefined,
            toolCalls: nativeToolCalls,
          }
        : useNativeTools
          ? { unstructured: true, finalAnswer: assistantText }
          : parseAgentTurn(assistantText);

      if (parsed.unstructured) {
        // Model didn't follow JSON contract. If tools already produced a
        // complete observation chain, accept a plain Markdown answer instead
        // of burning an extra round just to wrap it as JSON. Before any tool
        // has run we still give the model one protocol reminder, so file tasks
        // do not accidentally stop before parse/export/read.
        const unstructuredAnswer = parsed.finalAnswer ?? assistantText;
        const continueDecision = decide(trace, unstructuredAnswer);
        if (stalledCompletion(continueDecision)) break;

        if (continueDecision.shouldContinue && stepIndex >= maxSteps) {
          trace.outcome = "max_steps";
          trace.finalAnswer = `已达到调用方指定的执行上限，任务尚未完成：${continueDecision.reminder}`;
          break;
        }
        if (continueDecision.shouldContinue && stepIndex < maxSteps) {
          const step: AgentStep = {
            index: stepIndex,
            assistantText,
            reasoningContent,
            toolCalls: [],
            toolResults: [],
            finishReason: "format_retry",
            startedAt: stepStart,
            endedAt: Date.now(),
          };
          trace.steps.push(step);
          options.onStep?.(step, trace);
          conversation.push({
            id: `a_${nanoid(8)}`,
            role: "assistant",
            content: assistantText,
            reasoningContent,
            timestamp: Date.now(),
          });
          conversation.push(makeContinueReminder(trace, unstructuredAnswer));
          options.onStatus?.(`继续未完成任务`);
          continue;
        }

        const pendingUserChoice = findPendingUserChoiceFromTrace(trace, options.userInput);
        if (pendingUserChoice) {
          const step: AgentStep = {
            index: stepIndex,
            assistantText,
            reasoningContent,
            toolCalls: [],
            toolResults: [],
            finishReason: "answer",
            startedAt: stepStart,
            endedAt: Date.now(),
          };
          trace.steps.push(step);
          finishWithPendingUserChoice(
            trace,
            step,
            pendingUserChoice,
            options.onStatus,
            options.onStep,
          );
          break;
        }

        const priorUnstructuredCount = trace.steps.filter(
          (s) => s.finishReason === "format_retry",
        ).length;

        if (!useNativeTools && trace.toolCallCount === 0 && priorUnstructuredCount < 1 && stepIndex < maxSteps) {
          const step: AgentStep = {
            index: stepIndex,
            assistantText,
            reasoningContent,
            toolCalls: [],
            toolResults: [],
            finishReason: "format_retry",
            startedAt: stepStart,
            endedAt: Date.now(),
          };
          trace.steps.push(step);
          options.onStep?.(step, trace);

          conversation.push({
            id: `a_${nanoid(8)}`,
            role: "assistant",
            content: assistantText,
            reasoningContent,
            timestamp: Date.now(),
          });
          conversation.push({
            id: `fmt_${nanoid(8)}`,
            role: "user",
            content:
              "【格式提醒】你的上一轮输出不是合法 JSON。请严格按照协议输出 JSON 对象（包含 tool_calls 或 final_answer）。" +
              "如果你需要读取 .e/.ec 文件，请调用 parse_efile 工具而不是 read_file。",
            timestamp: Date.now(),
          });
          options.onStatus?.(`格式重试`);
          continue;
        }

        options.onStatus?.(
          shouldUseHeavyAnswerSelfCheck(trace)
            ? `答案自检`
            : `本地检查`,
        );
        const selfCheck = socialTurn ? { pass: true, confidence: 1, issues: [], followup: "" } : restricted ? {
          pass: !findEplAnswerDiagnostics(parsed?.finalAnswer ?? assistantText).some(item => item.severity === "error"),
          confidence: 0.9, issues: ["请修正示例的语法结构。"], followup: "只读/计划模式下请给出分析和实施计划，不要调用写入或编译工具。",
        } : await runAnswerSelfCheck(
          options.config,
          options.userInput,
          options.history,
          trace,
          unstructuredAnswer,
          signal,
        );
        throwIfAborted(signal);
        if (
          !selfCheck.pass &&
          answerSelfCheckRevisionCount < ANSWER_SELF_CHECK_MAX_REVISIONS &&
          stepIndex < maxSteps
        ) {
          answerSelfCheckRevisionCount += 1;
          const step = { ...makeAnswerSelfCheckRetryStep(stepIndex, assistantText, stepStart), reasoningContent };
          trace.steps.push(step);
          options.onStep?.(step, trace);

          conversation.push({
            id: `a_${nanoid(8)}`,
            role: "assistant",
            content: assistantText,
            reasoningContent,
            timestamp: Date.now(),
          });
          conversation.push(
            makeAnswerSelfCheckReminder(
              selfCheck,
              answerSelfCheckRevisionCount,
            ),
          );
          options.onStatus?.(`根据自检继续修正`);
          continue;
        }
        if (!selfCheck.pass) {
          const step = { ...makeAnswerSelfCheckRetryStep(stepIndex, assistantText, stepStart), reasoningContent };
          trace.steps.push(step);
          options.onStep?.(step, trace);

          trace.outcome = "max_steps";
          trace.finalAnswer =
            "这次没有拿到足够可靠的最终答案。请再试一次，我会继续从工具证据开始重新检查。";
          break;
        }

        const step: AgentStep = {
          index: stepIndex,
          assistantText,
          reasoningContent,
          toolCalls: [],
          toolResults: [],
          finishReason: "answer",
          startedAt: stepStart,
          endedAt: Date.now(),
        };
        trace.steps.push(step);
        trace.outcome = "answer";
        trace.finalAnswer = unstructuredAnswer;
        options.onStep?.(step, trace);
        break;
      }

      // Tool calls?
      if (parsed.toolCalls && parsed.toolCalls.length > 0) {
        consecutiveUnfinishedAnswers = 0;
        const baselineCall = !restricted && parsed.toolCalls
          .map((call) => shouldRunBaselineBeforeTool(trace, call) ? makeBaselineToolCall(trace) : null)
          .find((call): call is ToolCall => Boolean(call));
        if (baselineCall) {
          parsed.toolCalls = [baselineCall];
          parsed.thought =
            "改动导出的易语言源码前，先对原始 .e 工程执行未修改基线构建，确认工具链和依赖状态。";
        }

        // Append assistant message with embedded tool_calls
        const assistantTurnMsg: ChatMessage = {
          id: `a_${nanoid(8)}`,
          role: "assistant",
          content: useNativeTools ? assistantText : parsed.thought
            ? JSON.stringify({ thought: parsed.thought, tool_calls: parsed.toolCalls })
            : JSON.stringify({ tool_calls: parsed.toolCalls }),
          timestamp: Date.now(),
          toolCalls: parsed.toolCalls,
          reasoningContent,
        };
        conversation.push(assistantTurnMsg);

        const toolResults: ToolResult[] = [];
        const publishToolProgress = (activeToolId?: string) => {
          const current: AgentStep = {
            index: stepIndex, assistantText: parsed.thought ?? assistantText, reasoningContent,
            toolCalls: parsed.toolCalls!, toolResults: [...toolResults],
            finishReason: "tool_call", startedAt: stepStart, endedAt: Date.now(),
          };
          options.onToolProgress?.(current, {
            ...trace, steps: [...trace.steps, current], endedAt: Date.now(),
            toolCallCount: trace.toolCallCount + parsed.toolCalls!.length - toolResults.length,
          }, activeToolId);
        };
        for (const call of parsed.toolCalls) {
          if (aborted) break;
          // Honor a pause requested between/within steps before doing anything.
          await waitWhilePaused();
          if (aborted) break;

          // Opt-in approval gate: only source-mutating calls, only when the
          // caller wired onApprovalRequest. EL pre-flight (control-structure
          // pairing / repeated statements) runs on the pending content so the
          // user can reject a patch the compiler would reject, before the
          // expensive .e round-trip.
          if (options.onApprovalRequest && isSourceMutatingCall(call)) {
            const decision = await abortable(options.onApprovalRequest(
              makeApprovalRequest(call),
            ), signal);
            if (decision.verdict === "pause") {
              pause();
              await waitWhilePaused();
            }
            if (aborted) break;
            if (decision.verdict === "reject") {
              const rejection = makeRejectedToolResult(call, decision.reason);
              toolResults.push(rejection);
              conversation.push(toolResultToMessage(rejection));
              continue;
            }
          }

          options.onStatus?.(
            `执行 ${call.name}`,
          );
          publishToolProgress(call.id);
          const ctx: ToolExecContext = {
            sessionId: options.sessionId,
            userInput: options.userInput,
            allowDialog: options.allowDialog ?? true,
            onStatus: options.onStatus,
            signal,
            readOnly: restricted,
          };
          const signature = call.name + JSON.stringify(call.arguments, (_key, value) =>
            value && typeof value === "object" && !Array.isArray(value)
              ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value);
          const previous = repeatedTools.get(signature);
          const attempts = previous?.epoch === mutationEpoch ? previous.count + 1 : 1;
          repeatedTools.set(signature, { epoch: mutationEpoch, count: attempts });
          const result: ToolResult = attempts > 2 ? {
            toolCallId: call.id, toolName: call.name, ok: false, durationMs: 0,
            content: { error: "相同操作已重复两次且没有新的源码修改，已停止重复执行。" },
            error: "相同操作无进展",
          } : await executeTool(call.name, call.id, call.arguments, ctx);
          if (attempts > 2) stalledTool = call.name;
          if (toolResultSucceeded(result) && ["save_text_file", "apply_search_replace", "restore_project_snapshot", "generate_gui_project", "generate_efile_from_code", "generate_efile_from_ecode"].includes(call.name)) mutationEpoch++;

          toolResults.push(result);
          conversation.push(toolResultToMessage(result));
          trace.toolCallCount += 1;
          applyPlanUpdateFromToolResult(trace, call, result);
          publishToolProgress();
        }

        const step: AgentStep = {
          index: stepIndex,
          assistantText,
          reasoningContent,
          toolCalls: parsed.toolCalls,
          toolResults,
          finishReason: "tool_call",
          startedAt: stepStart,
          endedAt: Date.now(),
        };
        trace.steps.push(step);
        options.onStep?.(step, trace);

        if (stalledTool) {
          trace.outcome = "error";
          trace.finalAnswer = `执行 ${stalledTool} 时连续重复相同操作，未取得新进展，已停止。当前结果尚未完成验证。`;
          break;
        }

        const pendingUserChoice = findPendingUserChoiceFromToolResults(
          toolResults,
          options.userInput,
        );
        if (pendingUserChoice) {
          finishWithPendingUserChoice(
            trace,
            step,
            pendingUserChoice,
            options.onStatus,
            options.onStep,
          );
          break;
        }

        if (aborted) {
          trace.outcome = "aborted";
          break;
        }
        const continueDecision = decide(trace, undefined);
        if (continueDecision.shouldContinue) {
          conversation.push(makeContinueReminder(trace, undefined));
          options.onStatus?.(`继续未完成任务`);
        }
        continue;
      }

      // Final answer
      const finalAnswer = parsed.finalAnswer ?? assistantText;
      const pendingUserChoice = findPendingUserChoiceFromTrace(trace, options.userInput);
      if (pendingUserChoice) {
        const step: AgentStep = {
          index: stepIndex,
          assistantText,
          reasoningContent,
          toolCalls: [],
          toolResults: [],
          finishReason: "answer",
          startedAt: stepStart,
          endedAt: Date.now(),
        };
        trace.steps.push(step);
        finishWithPendingUserChoice(
          trace,
          step,
          pendingUserChoice,
          options.onStatus,
          options.onStep,
        );
        break;
      }
      const continueDecision = decide(trace, finalAnswer);
      if (stalledCompletion(continueDecision)) break;
      if (continueDecision.shouldContinue && stepIndex >= maxSteps) {
        trace.outcome = "max_steps";
        trace.finalAnswer = `已达到调用方指定的执行上限，任务尚未完成：${continueDecision.reminder}`;
        break;
      }
      if (continueDecision.shouldContinue && stepIndex < maxSteps) {
        const step: AgentStep = {
          index: stepIndex,
          assistantText,
          reasoningContent,
          toolCalls: [],
          toolResults: [],
          finishReason: "format_retry",
          startedAt: stepStart,
          endedAt: Date.now(),
        };
        trace.steps.push(step);
        options.onStep?.(step, trace);
        conversation.push({
          id: `a_${nanoid(8)}`,
          role: "assistant",
          content: assistantText,
            reasoningContent,
          timestamp: Date.now(),
        });
        conversation.push(makeContinueReminder(trace, finalAnswer));
        options.onStatus?.(`继续未完成任务`);
        continue;
      }

      options.onStatus?.(
        shouldUseHeavyAnswerSelfCheck(trace)
          ? `答案自检`
          : `本地检查`,
      );
      const selfCheck = socialTurn ? { pass: true, confidence: 1, issues: [], followup: "" } : restricted ? {
          pass: !findEplAnswerDiagnostics(parsed?.finalAnswer ?? assistantText).some(item => item.severity === "error"),
          confidence: 0.9, issues: ["请修正示例的语法结构。"], followup: "只读/计划模式下请给出分析和实施计划，不要调用写入或编译工具。",
        } : await runAnswerSelfCheck(
        options.config,
        options.userInput,
        options.history,
        trace,
        finalAnswer,
        signal,
      );
      throwIfAborted(signal);
      if (
        !selfCheck.pass &&
        answerSelfCheckRevisionCount < ANSWER_SELF_CHECK_MAX_REVISIONS &&
        stepIndex < maxSteps
      ) {
        answerSelfCheckRevisionCount += 1;
        const step = { ...makeAnswerSelfCheckRetryStep(stepIndex, assistantText, stepStart), reasoningContent };
        trace.steps.push(step);
        options.onStep?.(step, trace);

        conversation.push({
          id: `a_${nanoid(8)}`,
          role: "assistant",
          content: assistantText,
            reasoningContent,
          timestamp: Date.now(),
        });
        conversation.push(
          makeAnswerSelfCheckReminder(
            selfCheck,
            answerSelfCheckRevisionCount,
          ),
        );
        options.onStatus?.(`根据自检继续修正`);
        continue;
      }
      if (!selfCheck.pass) {
        const step = { ...makeAnswerSelfCheckRetryStep(stepIndex, assistantText, stepStart), reasoningContent };
        trace.steps.push(step);
        options.onStep?.(step, trace);

        trace.outcome = "max_steps";
        trace.finalAnswer =
          "这次没有拿到足够可靠的最终答案。请再试一次，我会继续从工具证据开始重新检查。";
        break;
      }

      const step: AgentStep = {
        index: stepIndex,
        assistantText,
        reasoningContent,
        toolCalls: [],
        toolResults: [],
        finishReason: "answer",
        startedAt: stepStart,
        endedAt: Date.now(),
      };
      trace.steps.push(step);
      trace.outcome = "answer";
      trace.finalAnswer = finalAnswer;
      options.onStep?.(step, trace);
      break;
    }

    if (trace.outcome === "max_steps" && !trace.finalAnswer && trace.steps.length > 0) {
      const lastAssistantText = trace.steps[trace.steps.length - 1].assistantText;
      const continueDecision = decide(
        trace,
        lastAssistantText || undefined,
      );
      trace.finalAnswer = continueDecision.shouldContinue
        ? `已达到调用方指定的执行上限，任务尚未完成：${continueDecision.reminder}`
        : "已达到最大推理步数，尚未获得通过验证的最终答案。";
    }

    trace.endedAt = Date.now();
    return trace;
  })().catch((error): AgentTrace => {
    trace.outcome = aborted ? "aborted" : "error";
    trace.finalAnswer = aborted ? "操作已停止。" : `执行失败：${error instanceof Error ? error.message : String(error)}`;
    trace.endedAt = Date.now();
    return trace;
  }).finally(() => {
    options.signal?.removeEventListener("abort", abort);
    providerRef.current = null;
  });

  return { promise, abort, providerRef, pause, resume, isPaused };
}

// Re-export tool definitions for places that just need the catalog (e.g. UI).
export { TOOL_DEFINITIONS, TOOL_REGISTRY };
