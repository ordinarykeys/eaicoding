import { nanoid } from "nanoid";
import type {
  AgentStep,
  AgentTrace,
  AgentChoiceOption,
  AgentUserChoiceRequest,
  ChatMessage,
  LLMConfig,
  ToolCall,
  ToolResult,
} from "@/types/llm";
import { createLLMProvider, type BaseLLMProvider, LLMError } from "@/services/llm";
import {
  TOOL_DEFINITIONS,
  TOOL_REGISTRY,
  executeTool,
  type ToolExecContext,
} from "@/services/agent/tools";
import {
  makeAgentMemoryMessage,
  summarizeTraceForHistory,
} from "@/services/agent/memory";
import { saveAgentCheckpoint } from "@/services/agent/checkpoint";
import {
  selectAgentToolTransport,
  type AgentToolTransport,
} from "@/services/agent/runner-transport";
import {
  extractJsonObject,
  extractProtocolStringValue,
  parseAgentTurn,
  tryParseJsonWithRepair,
  type ParsedAgentTurn,
} from "@/services/agent/runner-parser";
import {
  answerContainsEplCode,
  findEplAnswerDiagnostics,
  formatEplDiagnostics,
} from "@/services/agent/epl-syntax";
import { createJingyiImplementationChoiceRequestFromToolResults } from "@/services/agent/implementation-choice";
import { JINGYI_MODULE_SUMMARY } from "@/services/agent/knowledge/jingyi-module";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentRunOptions {
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
  /** Maximum number of (assistant ↔ tool) turns before the runner gives up. */
  maxSteps?: number;
  /** Status callback for transient UI updates. */
  onStatus?: (status: string) => void;
  /** Streaming token callback for the *current* step's assistant text. */
  onAssistantToken?: (token: string, stepIndex: number) => void;
  /** Called whenever a step finishes — useful for live trace rendering. */
  onStep?: (step: AgentStep, runningTrace: AgentTrace) => void;
  /** Allow the runner to pop native dialogs (only true for foreground turns). */
  allowDialog?: boolean;
  /** Optional abort signal carrying the cancellation source. */
  signal?: AbortSignal;
}

export interface AgentRunHandle {
  /** Resolves with the final trace once the loop terminates. */
  promise: Promise<AgentTrace>;
  /** Aborts the underlying provider stream and stops the loop ASAP. */
  abort: () => void;
  /** Reference to the underlying provider — exposed so the UI can hook into
   *  its native abort if desired. */
  providerRef: { current: BaseLLMProvider | null };
}

const LLM_STEP_TIMEOUT_MS = 180_000;
const TOOL_TEXT_PROMPT_LIMIT = 6_000;
const LLM_MAX_RETRIES = 5;
const LLM_RETRY_BASE_MS = 1_000;
const DEFAULT_AGENT_MAX_STEPS = 32;
const HARD_AGENT_MAX_STEPS = 64;
const AGENT_STEP_EXTENSION_STEPS = 8;
const ANSWER_SELF_CHECK_TIMEOUT_MS = 90_000;
const ANSWER_SELF_CHECK_MAX_REVISIONS = 2;
const ANSWER_SELF_CHECK_EXTRA_STEP_BUDGET = 6;
const CHOICE_EVIDENCE_SEARCH_LIMIT = 12;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const ENGLISH_LIKE_TOOL_BLOCK = TOOL_DEFINITIONS.map((definition) => {
  return `- name: ${definition.name}\n  description: ${definition.description}\n  parameters: ${JSON.stringify(definition.parameters)}`;
}).join("\n");

const AGENT_SYSTEM_PROMPT = `你是 易语言 AI Coding Agent 的多轮推理内核（ReAct）。
你可以一边思考一边调用桌面端注册的工具，再根据工具结果继续推理，直到给出最终答案。

【可用工具（近似 MCP 的 JSON Schema 注册表）】
${ENGLISH_LIKE_TOOL_BLOCK}

【工具调用协议】
当前 Agent 使用跨服务商文本 JSON ReAct 协议，不使用原生 function/tool_calls。你的每一轮回答必须严格满足以下两种 JSON 格式之一，且**只输出一个 JSON 对象**，外面不要套 markdown：

1) 调工具：
{
  "thought": "用一句话解释为什么调这个工具",
  "tool_calls": [
    { "name": "<工具名>", "arguments": { ... } }
  ]
}

2) 给最终答案：
{
  "thought": "可省略",
  "final_answer": "对用户的最终回复，可包含 markdown 与 \`\`\`epl 代码块"
}

允许同一轮发起多个 tool_calls，下一轮你会看到对应的 tool 角色消息。
若工具失败，继续推理并尝试更小的步骤；不要重复完全相同的失败调用。
所有路径必须由用户提供或上一步工具返回，禁止编造路径。
提到易语言源码时优先使用 \`\`\`epl 代码块。

【易语言语法硬约束】
- 控制结构必须使用真实易语言配对：如果/如果结束，如果真/如果真结束，判断开始/判断结束，判断循环首/判断循环尾，计次循环首/计次循环尾，变量循环首/变量循环尾，循环判断首/循环判断尾。
- 不允许把控制结构的开始语句自行拼接成结束语句；结束语句必须来自真实配对表。
- 不要连续复制同一条可执行语句来表示“多次执行”。需要执行固定次数时使用计次循环首/计次循环尾；需要并发多个任务时为每个线程准备不同参数或任务队列。
- 示例代码中的模块命令名、参数和返回值必须有工具证据：用户上传的 .ec 以 parse_efile 结果为准；精易模块 API 以 search_jingyi_module 返回结果为准；没有证据时不要凭记忆编造对象名或参数个数。

【强制工具使用规则 — 违反即为错误】
- 用户消息中出现任何文件路径→先判断文件类型再选工具：
  - .e 源程序文件：必须先调 parse_efile 获取完整结构摘要和反编译源码。切勿对 .e 调 read_file（二进制格式，返回乱码）。
  - .ec 模块文件：【重要】既可能是主程序依赖，也可能是用户要求你直接使用的自定义模块证据。
    - 如果用户只上传了 .ec 没有 .e：调 parse_efile 查看模块公开接口，再基于解析结果回答或写示例。
    - 如果用户明确说“用/使用/基于/调用/按这个模块/上传的模块/该 .ec”来实现功能或写案例：必须先对相关 .ec 调 parse_efile；解析到的类、公开子程序、参数和返回值是本轮答案的最高优先级证据。
    - 如果用户同时上传了 .e 和 .ec 且任务是分析/优化主程序：先解析 .e 主程序，从摘要中找到引用了哪些模块命令；只有当主程序摘要不足、用户点名某个模块，或需要模块公开接口写代码时，再深入 parse_efile 对应 .ec。
    - 当后续需要编译 .e 项目时，不要尝试用 read_file 读取二进制 .ec；compile_efile 支持接收 module_paths，且会自动使用用户消息中的 .ec 路径把依赖模块放入编译环境。
  - 文本文件（.epl .txt .ini .json .csv 等）：先调 read_file 读取内容。
  - .dll 模块文件：read_file 后分析内容，或配合 parse_efile 处理对应 .ec 接口文件。
  - 切勿对 .e/.ec 调 read_file（二进制格式，返回乱码会导致推理失败）。
- 优化/分析场景的正确步骤：
  1. parse_efile 解析主程序 .e → 了解所有子程序、引用的支持库和模块
  2. 调 export_efile_to_ecode 导出文本工程 → 得到目录路径和文件列表
  3. 调 summarize_ecode_project 生成项目地图 → 了解主工程窗口/类/子程序入口和 recommended_read_order。默认不要包含 模块/ 依赖源码；依赖模块需要签名时用 search_jingyi_module。
  4. 若用户要求优化/完善/找问题/重构，调 analyze_ecode_project 做静态质量分析 → 获取重复逻辑、硬编码、网络调用、空壳组件、推荐读取文件等事实。这个工具是项目观察，不是关键词兜底。
  5. 在改任何源码前，调用 build_original_efile_baseline 对原始 .e 做未修改基线构建；如果基线编译失败，先把环境/依赖/原工程编译问题报告清楚，不要继续靠猜测大改源码。
  6. 调 inspect_ecode_context 生成上下文包 → 像 repo map/context provider 一样拿到关键文件轮廓、风险片段和 recommended_full_reads，减少盲读和中途停顿。
  7. 用 read_file 读取要修改的完整文本源码文件，优先读取 inspect_ecode_context / analyze_ecode_project 推荐的 <ecode_dir>/代码/*.e.txt。不要读取导出目录根部的 代码.e，它通常仍是二进制工程文件。
  8. 结合实际源码、analyze_ecode_project 的 findings、以及基线构建结果分析问题（重复代码、硬编码、缺少错误处理等）
  9. 【关键】用户要求"优化"已有 .e 项目时，必须保留原项目结构：在导出的 ecode_dir 中修改对应的 .e.txt 文件（用 save_text_file 覆盖），然后优先调用 build_ecode_project 一步完成回编和编译验证；也可以用 generate_efile_from_ecode + compile_efile 两步验证。不要把多窗口 GUI 工程改写成单文件 console 模板。
     - 已经读完源码并形成优化方案时，下一轮必须先调用 save_text_file 写入真实文件；不要只把"优化后的代码"贴给用户，也不要问"是否需要生成 .e"。
     - 修改时以当前 read_file 读到的源码和模块命令签名为准，不要凭猜测替换命令名、参数个数或把 HTTP 改成 HTTPS；除非工具结果证明新写法可编译/可访问。
     - 易语言变量声明行不能写默认值/初始化值。例如不要写 .全局变量 URL_主站, 文本型, , , "http://..."；应写 .全局变量 URL_主站, 文本型，然后在启动子程序或窗口创建完毕事件里写 URL_主站 ＝ "http://..."。
  10. 只有在『从零生成新项目』或『用户明确只给了单文件源码字符串』时，才使用 generate_efile_from_code。
  11. 编译失败时根据 stderr/stdout 的具体错误修复源码再次生成（可多轮重试），不要把错误原样交给用户就结束。若出现"变量指定格式错误"或"声明行包含默认值"，优先读取并修复 .全局变量/.程序集变量/.局部变量 声明。如果基线和修改后都是同类 ecl 进程异常，应先归类为编译环境/依赖兼容问题。
  12. 编译成功后再输出 final_answer，附上优化说明
  不要在只看了摘要后就直接跳到 final_answer 给文字建议——用户期望拿到可用的优化代码。
  export_efile_to_ecode 成功后必须继续 summarize_ecode_project/analyze_ecode_project/inspect_ecode_context/read_file，不要停下来。
- 用户明确要"生成文件 / 编译 / 测试 / 运行 / 跑通"：
  - 若已有 ecode_dir / 导出的工程文件：先 save_text_file 修改 .e.txt，再优先调 build_ecode_project；必要时才拆成 generate_efile_from_ecode + compile_efile。
  - 若只有单文件源码字符串：先 generate_efile_from_code，成功后调 compile_efile。
  - 失败时根据 stderr 继续修复并重试（最多 ${"${maxSteps}"} 步）。
- 修改已有文本文件时优先使用 apply_search_replace：
  - 先用 read_file 读取目标文件完整内容，再构造唯一匹配的 SEARCH/REPLACE 补丁。
  - SEARCH 必须包含足够上下文，只匹配一处；如果匹配不到或匹配多处，继续读取上下文后重试。
  - 不要整文件覆盖，除非目标文件很小或用户明确要求重写。
- 普通知识问答、参数解释、单个功能代码片段或示例案例：通常只需要调用一次必要的知识工具，然后直接输出 final_answer。不要因为回答里含有易语言代码就强行生成 .e、编译，或反复自检；只有用户明确要求生成文件、编译、测试、运行，或正在优化已有 .e 项目时，才进入生成/编译闭环。
- 缺路径时用 pick_file / pick_save_path 让用户选。
- 知识库只允许使用本地精易模块知识库；不要读取/解析易语言 IDE help 或其他支持库文档作为知识库。
- 用户上传的 .e/.ec/.epl 文件不是“外部知识库”，而是用户提供的项目事实。用户要求使用上传模块时，不要用精易模块知识库替代它；如果需求同时包含上传模块负责的能力和其他辅助能力，例如“用多线程模块写 POST 案例”，应先用 parse_efile 确认上传模块的多线程/调度接口，再按需调用 search_jingyi_module 查询 POST/网页/编码/JSON 等辅助 API，最后组合成一个示例。
- scan_easy_language_env 只用于检查编译链/本机依赖状态，不能作为回答知识来源。
- 任务完成或无法继续时输出 final_answer。
- 不允许在没有读取文件内容的情况下对文件内容做任何推断或假设。
- 每次 tool_calls 返回结果后，根据结果继续推理或调用下一步工具，不要急于给出 final_answer。
- 【核心原则】工具强度必须匹配任务意图：问答就准确回答，示例就给清晰代码；项目优化和显式编译测试任务才追求可运行产物闭环。

【本地精易模块知识库（唯一知识库）】
精易模块是易语言最流行的开源模块（.ec文件），包含1500+子程序，覆盖以下功能域：
${JINGYI_MODULE_SUMMARY}

使用说明：
- 当你需要精易模块命令/类/全局变量的签名、参数、返回值或用法证据时，调用 search_jingyi_module。不要靠记忆猜参数；也不要把它当成固定关键词触发器，是否调用由当前问题和已知上下文决定。
- 如果用户上传并点名使用非精易 .ec 模块，应优先 parse_efile 该模块；search_jingyi_module 只用于精易模块本身或辅助能力，不得覆盖用户指定模块的 API。
- 调用方式：直接使用命令名或自然语言功能描述；不要凭记忆猜参数。
- search_jingyi_module 可能返回 implementation_options / related_implementations。用户问“怎么实现某功能/写个案例/有哪些方式”时，先按 implementation_options 的 route_type 和 primary_options 识别实现路线，再比较多个可用实现的返回值、关键参数、对象调用链和适用场景；不要只因为 matches 第一条能用就只写一种。
- route_type=function_family 表示同族函数方案，object_workflow 表示对象/类调用链方案，namespace_overview/candidate_pool 只是补充召回；生成代码优先用 primary_options 里的主入口，supporting_options 只作为设置请求头、构造参数、读取状态等辅助步骤。
- 当 search_jingyi_module 返回多个同级可实现入口时，优先让用户选择实现方式；用户选定后再继续生成代码。若用户已经明确点名某个命令/类，则按该选择继续，不要重复询问。
- 如果候选里同时出现“主操作 API”和“辅助构造/状态查询 API”，回答时应先识别调用链：主操作负责真正执行用户要的动作，辅助 API 只用于准备参数、设置状态或读取结果；不要把辅助 API 当成完整方案。
- 精易模块是 .ec 文件；生成单文件项目时，通过 generate_efile_from_code 的 module_paths 引用；编译时通过 compile_efile 的 module_paths 引用。若用户消息里已有精易模块 .ec 路径，工具会自动提取。
- 如果用户没有提供精易模块 .ec 路径，先用 search_jingyi_module 完成代码方案；生成/编译阶段如果需要模块路径但缺失，再在 final_answer 中明确说明需要引用精易模块。
- 不要因为需要精易模块就改用 COM 对象或其他支持库绕开，除非 search_jingyi_module 没有相关能力。
`;

// ---------------------------------------------------------------------------
// Message-list construction for the LLM
// ---------------------------------------------------------------------------

function makeSystemMessage(extraSystem: string | undefined, maxSteps: number): ChatMessage {
  const parts = [AGENT_SYSTEM_PROMPT.replace("${maxSteps}", String(maxSteps))];
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
    compacted.content = limitTextForPrompt(compacted.content);
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
    content: JSON.stringify(payload, null, 2),
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
  for (const message of history) {
    if (message.role === "system") continue; // reset; we inject our own system
    shaped.push({
      id: message.id,
      role: message.role,
      content:
        message.role === "assistant" && message.agentTrace
          ? summarizeTraceForHistory(message)
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

function answerMentionsJingyiEvidenceBoundApi(answer: string): boolean {
  return /精易模块/.test(answer) || /[\u4e00-\u9fa5A-Za-z][\u4e00-\u9fa5A-Za-z0-9]*_[\u4e00-\u9fa5A-Za-z0-9_]+/.test(answer);
}

function shouldRequireJingyiEvidence(userInput: string, answer: string, trace: AgentTrace): boolean {
  if (hasJingyiKnowledgeEvidence(trace)) return false;
  if (hasUploadedEcModuleEvidence(userInput, trace)) return false;
  const isEasyLanguageTask = /精易模块|易语言|```epl|```易语言|\.e\b|\.ec\b/i.test(`${userInput}\n${answer}`);
  return isEasyLanguageTask && answerMentionsJingyiEvidenceBoundApi(answer);
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
  return true;
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
  return (
    findPendingUserChoice(results) ??
    createJingyiImplementationChoiceRequestFromToolResults(results, userInput)
  );
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
  for (const step of trace.steps) {
    for (let index = 0; index < step.toolCalls.length; index += 1) {
      const call = step.toolCalls[index];
      const result = step.toolResults[index];
      if (call.name === afterToolName && toolResultSucceeded(result)) {
        sawAfterTool = true;
      } else if (sawAfterTool && call.name === toolName && toolResultSucceeded(result)) {
        return true;
      }
    }
  }
  return false;
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

function hasUploadedEcModuleEvidence(userInput: string, trace: AgentTrace): boolean {
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
  if (call.name !== "save_text_file") return false;
  const path = typeof call.arguments.path === "string"
    ? call.arguments.path.replace(/\//g, "\\").toLowerCase()
    : "";
  return path.includes(".ecode\\") && path.endsWith(".e.txt");
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
  for (const result of collectSuccessfulToolResults(trace, "export_efile_to_ecode")) {
    appendFromResult(result, ["recommended_read_order", "readable_files"]);
  }

  return paths.filter(isMainECodeTextSourcePath).slice(0, 12);
}

function collectSuccessfulReadFilePaths(trace: AgentTrace): Set<string> {
  const paths = new Set<string>();
  for (const step of trace.steps) {
    for (let index = 0; index < step.toolCalls.length; index += 1) {
      const call = step.toolCalls[index];
      const result = step.toolResults[index];
      if (call.name !== "read_file" || !toolResultSucceeded(result)) continue;
      const argPath = typeof call.arguments.file_path === "string" ? call.arguments.file_path : "";
      if (argPath) paths.add(normalizeToolPath(argPath));
      const contentPath = resultContentObject(result)?.path;
      if (typeof contentPath === "string") paths.add(normalizeToolPath(contentPath));
    }
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
  const generatedFromCode = hasSuccessfulToolCall(trace, "generate_efile_from_code");
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
    baselineAttempted: hasAnyToolCall(trace, "build_original_efile_baseline"),
    baselineBuilt: hasSuccessfulToolCall(trace, "build_original_efile_baseline"),
    savedText: hasSuccessfulToolCall(trace, "save_text_file"),
    generated: generatedFromProject || generatedFromCode,
    buildAttempted: hasAnyToolCall(trace, "build_ecode_project"),
    builtProject: hasSuccessfulToolCall(trace, "build_ecode_project"),
    compileAttempted: hasAnyToolCall(trace, "compile_efile"),
    compiled: hasSuccessfulToolCall(trace, "compile_efile"),
    projectEditRequired: answer ? shouldRequireProjectEditBeforeAnswer(trace, answer) : false,
    unreadRecommendedSourcePaths: collectUnreadRecommendedSourcePaths(trace),
  };
}

function makeUnreadSourceHint(paths: string[]): string {
  const preview = paths.slice(0, 4).map((path) => `\n- ${path}`).join("");
  const suffix = paths.length > 4 ? `\n- 另有 ${paths.length - 4} 个推荐源码文件未读取` : "";
  return preview + suffix;
}

function evaluateContinueAfterFinalAnswer(
  trace: AgentTrace,
  answer: string | undefined,
): ContinueDecision {
  const state = makeAgentWorkflowState(trace, answer);

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
    state.savedText &&
    !hasToolCallAfter(trace, "build_ecode_project", "save_text_file") &&
    !hasToolCallAfter(trace, "generate_efile_from_ecode", "save_text_file") &&
    !hasToolCallAfter(trace, "generate_efile_from_code", "save_text_file")
  ) {
    return {
      shouldContinue: true,
      reminder: "你已经保存了源码修改，请继续调用 build_ecode_project 回编并编译验证。",
    };
  }

  if (
    state.generated &&
    !state.compileAttempted &&
    !hasToolCallAfter(trace, "compile_efile", "generate_efile_from_ecode") &&
    !hasToolCallAfter(trace, "compile_efile", "generate_efile_from_code")
  ) {
    return {
      shouldContinue: true,
      reminder: "你已经生成了 .e 文件，请继续调用 compile_efile 编译验证。",
    };
  }

  if (
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

function extendStepBudgetForIncompleteWorkflow(
  decision: ContinueDecision,
  stepIndex: number,
  maxSteps: number,
): number {
  if (!decision.shouldContinue || stepIndex < maxSteps || maxSteps >= HARD_AGENT_MAX_STEPS) {
    return maxSteps;
  }
  return Math.min(HARD_AGENT_MAX_STEPS, maxSteps + AGENT_STEP_EXTENSION_STEPS);
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

  const answerContainsUnappliedCode =
    /```(?:epl|易语言|e|ecode)?\s*[\s\S]*?\.版本\s+2[\s\S]*?```/i.test(answer);

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
      (answer ? `\n\n上一轮未完成回答供参考：\n${trimReminderAnswer(answer)}` : ""),
    timestamp: Date.now(),
  };
}

function trimReminderAnswer(answer: string): string {
  return answer.length > TOOL_TEXT_PROMPT_LIMIT
    ? `${answer.slice(0, TOOL_TEXT_PROMPT_LIMIT)}\n... [已截断，上一轮回答很长，请基于已读源码继续执行工具闭环] ...`
    : answer;
}

function makeBlankResponseReminder(): string {
  return "【空响应重试】你上一轮返回了空内容。请继续当前任务，并严格输出合法 JSON；需要工具就输出 tool_calls，已经能回答就输出 final_answer。";
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

async function runAnswerSelfCheck(
  config: LLMConfig,
  userInput: string,
  history: ChatMessage[],
  trace: AgentTrace,
  answer: string,
): Promise<AnswerSelfCheckDecision> {
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
      issues: ["答案涉及易语言/精易模块 API，但本轮没有成功查询精易模块知识库作为依据。"],
        followup:
        "请先调用 search_jingyi_module 查询相关命令/实现，再根据工具返回的签名、参数和 related_implementations 重写答案。",
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
    const missingComparisonOptions = shouldRequireImplementationComparison(answer, trace);
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
    return {
      pass: true,
      confidence: 0.86,
      issues: [],
      followup: "",
    };
  }

  let checkerText = "";
  let checkerError: Error | null = null;
  const provider = createLLMProvider({ ...config, systemPrompt: undefined });
  let timeoutId: number | undefined;

  try {
    await Promise.race([
      provider.stream(
        makeAnswerSelfCheckMessages(userInput, trace, answer, eplDiagnosticsText, selectedImplementation),
        {
          onToken: (token) => {
            checkerText += token;
          },
          onComplete: (full) => {
            checkerText = full || checkerText;
          },
          onError: (error) => {
            checkerError = error;
          },
        },
        { nativeTools: false },
      ),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          provider.abort();
          reject(new Error(`Answer self-check timed out after ${Math.round(ANSWER_SELF_CHECK_TIMEOUT_MS / 1000)}s`));
        }, ANSWER_SELF_CHECK_TIMEOUT_MS);
      }),
    ]);
  } catch (error) {
    checkerError = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }

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
    return parsed;
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
  answer: string,
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
      `候选答案：\n${trimReminderAnswer(answer)}`,
    timestamp: Date.now(),
  };
}

function makeSelfCheckEscalationReminder(
  answer: string,
  decision: AnswerSelfCheckDecision,
): ChatMessage {
  const issues = decision.issues.length > 0
    ? decision.issues.map((issue) => `- ${issue}`).join("\n")
    : "- Reviewer 没有返回具体问题，但候选答案不可直接交付。";
  const followup = decision.followup.trim()
    ? decision.followup.trim()
    : "请重新审查用户问题、工具证据和候选答案，然后继续调用工具或重写最终答案。";

  return {
    id: `self_check_escalate_${nanoid(8)}`,
    role: "user",
    content:
      "【内部质量门继续修复】候选最终答案仍不可交付，不能把质量门失败信息展示给用户。\n" +
      `问题：\n${issues}\n\n` +
      `下一步：${followup}\n\n` +
      "现在请继续推理：缺证据就调用工具；证据足够就直接输出新的完整 final_answer；不要输出中间态说明。\n\n" +
      `候选答案：\n${trimReminderAnswer(answer)}`,
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
// Public entrypoint
// ---------------------------------------------------------------------------

export function startAgentRun(options: AgentRunOptions): AgentRunHandle {
  const providerRef: { current: BaseLLMProvider | null } = { current: null };
  let aborted = false;

  const abort = () => {
    aborted = true;
    providerRef.current?.abort();
  };

  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }

  const promise = (async (): Promise<AgentTrace> => {
    let maxSteps = Math.max(
      1,
      Math.min(options.maxSteps ?? DEFAULT_AGENT_MAX_STEPS, HARD_AGENT_MAX_STEPS),
    );
    const startedAt = Date.now();
    let answerSelfCheckRevisionCount = 0;
    const trace: AgentTrace = {
      goal: options.userInput,
      steps: [],
      finalAnswer: "",
      outcome: "max_steps",
      startedAt,
      endedAt: startedAt,
      toolCallCount: 0,
    };

    const systemMsg = makeSystemMessage(options.config.systemPrompt, maxSteps);
    const memoryMsg = makeAgentMemoryMessage(options.history);
    const conversation: ChatMessage[] = [
      systemMsg,
      ...shapeHistoryForLLM(options.history),
      ...(memoryMsg ? [memoryMsg] : []),
      {
        id: `u_${nanoid(8)}`,
        role: "user",
        content: options.userInput,
        timestamp: Date.now(),
      },
    ];

    let firstModelStepIndex = 1;
    const uploadedEcParseTargets = getRecentUploadedEcModuleParseTargets(
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
        options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：解析上传模块`);
        const result = await executeTool(call.name, call.id, call.arguments, {
          sessionId: options.sessionId,
          userInput: options.userInput,
          allowDialog: options.allowDialog ?? true,
          onStatus: options.onStatus,
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
    if (selectedEvidenceQuery && !aborted) {
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

      options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：查询所选实现证据`);
      const result = await executeTool(call.name, call.id, call.arguments, {
        sessionId: options.sessionId,
        userInput: selectedEvidenceQuery,
        allowDialog: options.allowDialog ?? true,
        onStatus: options.onStatus,
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
      firstModelStepIndex === 1 &&
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

      options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：查询精易模块`);
      const result = await executeTool(call.name, call.id, call.arguments, {
        sessionId: options.sessionId,
        userInput: options.userInput,
        allowDialog: options.allowDialog ?? true,
        onStatus: options.onStatus,
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

      options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：模型推理中`);

      const stepStart = Date.now();
      let assistantText = "";
      let streamError: Error | null = null;
      let nativeToolCalls: ToolCall[] = [];

      for (let retryAttempt = 0; retryAttempt <= LLM_MAX_RETRIES; retryAttempt++) {
        if (aborted) break;
        if (retryAttempt > 0) {
          const delayMs = LLM_RETRY_BASE_MS * 2 ** (retryAttempt - 1);
          options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：重试中（${retryAttempt}/${LLM_MAX_RETRIES}）`);
          await new Promise((r) => setTimeout(r, delayMs));
          if (aborted) break;
        }

        assistantText = "";
        streamError = null;
        nativeToolCalls = [];
        const provider = createLLMProvider({ ...options.config, systemPrompt: undefined });
        providerRef.current = provider;
        const toolTransport = selectAgentToolTransport(options.config);
        const enableNativeTools =
          toolTransport === "native-openai-tools" &&
          options.config.protocol === "openai-chat-completions" &&
          !conversation.some((message) => message.role === "tool");

        let timeoutId: number | undefined;
        try {
          await Promise.race([
            provider.stream(conversation, {
              onToken: (token) => {
                assistantText += token;
                options.onAssistantToken?.(token, stepIndex);
              },
              onComplete: (full) => {
                assistantText = full || assistantText;
              },
              onError: (err) => {
                streamError = err;
              },
              onToolCall: (call) => {
                nativeToolCalls.push(call);
              },
            }, {
              tools: TOOL_DEFINITIONS,
              nativeTools: enableNativeTools,
            }),
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
          providerRef.current = null;
        }

        if (!streamError) break;
        const isRetryable =
          streamError instanceof LLMError
            ? streamError.retryable
            : streamError.message.includes("timed out") ||
              streamError.message.includes("Failed to fetch") ||
              streamError.message.includes("NetworkError") ||
              streamError.message.includes("network") ||
              !navigator.onLine;
        if (!isRetryable || retryAttempt >= LLM_MAX_RETRIES) break;
        // If offline, wait until back online (up to 30s) before retrying
        if (!navigator.onLine) {
          await new Promise<void>((resolve) => {
            const onOnline = () => { clearTimeout(timer); resolve(); };
            const timer = setTimeout(() => { window.removeEventListener("online", onOnline); resolve(); }, 30_000);
            window.addEventListener("online", onOnline, { once: true });
          });
        }
      }

      if (aborted) {
        trace.outcome = "aborted";
        break;
      }

      if (streamError) {
        const step: AgentStep = {
          index: stepIndex,
          assistantText,
          toolCalls: [],
          toolResults: [],
          finishReason: "error",
          startedAt: stepStart,
          endedAt: Date.now(),
        };
        trace.steps.push(step);
        trace.outcome = "error";
        trace.finalAnswer =
          assistantText ||
          `LLM 请求失败：${(streamError as Error).message ?? String(streamError)}`;
        options.onStep?.(step, trace);
        break;
      }

      if (!assistantText.trim() && nativeToolCalls.length === 0) {
        const priorEmptyCount = countTrailingBlankRetries(trace);

        if (priorEmptyCount < 2 && stepIndex < maxSteps) {
          const step: AgentStep = {
            index: stepIndex,
            assistantText,
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
          options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：空响应重试`);
          continue;
        }

        const step: AgentStep = {
          index: stepIndex,
          assistantText,
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
        : parseAgentTurn(assistantText);

      if (parsed.unstructured) {
        // Model didn't follow JSON contract. If tools already produced a
        // complete observation chain, accept a plain Markdown answer instead
        // of burning an extra round just to wrap it as JSON. Before any tool
        // has run we still give the model one protocol reminder, so file tasks
        // do not accidentally stop before parse/export/read.
        const unstructuredAnswer = parsed.finalAnswer ?? assistantText;
        const continueDecision = evaluateContinueAfterFinalAnswer(trace, unstructuredAnswer);
        const nextMaxSteps = extendStepBudgetForIncompleteWorkflow(
          continueDecision,
          stepIndex,
          maxSteps,
        );
        if (nextMaxSteps !== maxSteps) {
          maxSteps = nextMaxSteps;
          options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：扩展未完成任务预算`);
        }

        if (continueDecision.shouldContinue && stepIndex < maxSteps) {
          const step: AgentStep = {
            index: stepIndex,
            assistantText,
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
            timestamp: Date.now(),
          });
          conversation.push(makeContinueReminder(trace, unstructuredAnswer));
          options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：继续未完成任务`);
          continue;
        }

        const pendingUserChoice = findPendingUserChoiceFromTrace(trace, options.userInput);
        if (pendingUserChoice) {
          const step: AgentStep = {
            index: stepIndex,
            assistantText,
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

        if (trace.toolCallCount === 0 && priorUnstructuredCount < 1 && stepIndex < maxSteps) {
          const step: AgentStep = {
            index: stepIndex,
            assistantText,
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
          options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：格式重试`);
          continue;
        }

        options.onStatus?.(
          shouldUseHeavyAnswerSelfCheck(trace)
            ? `第 ${stepIndex}/${maxSteps} 步：答案自检`
            : `第 ${stepIndex}/${maxSteps} 步：本地检查`,
        );
        const selfCheck = await runAnswerSelfCheck(
          options.config,
          options.userInput,
          options.history,
          trace,
          unstructuredAnswer,
        );
        if (
          !selfCheck.pass &&
          answerSelfCheckRevisionCount < ANSWER_SELF_CHECK_MAX_REVISIONS &&
          stepIndex < maxSteps
        ) {
          answerSelfCheckRevisionCount += 1;
          const step = makeAnswerSelfCheckRetryStep(stepIndex, assistantText, stepStart);
          trace.steps.push(step);
          options.onStep?.(step, trace);

          conversation.push({
            id: `a_${nanoid(8)}`,
            role: "assistant",
            content: assistantText,
            timestamp: Date.now(),
          });
          conversation.push(
            makeAnswerSelfCheckReminder(
              unstructuredAnswer,
              selfCheck,
              answerSelfCheckRevisionCount,
            ),
          );
          options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：根据自检继续修正`);
          continue;
        }
        if (!selfCheck.pass) {
          const step = makeAnswerSelfCheckRetryStep(stepIndex, assistantText, stepStart);
          trace.steps.push(step);
          options.onStep?.(step, trace);
          if (stepIndex < HARD_AGENT_MAX_STEPS) {
            const nextMaxSteps = Math.min(
              HARD_AGENT_MAX_STEPS,
              Math.max(maxSteps, stepIndex + ANSWER_SELF_CHECK_EXTRA_STEP_BUDGET),
            );
            if (nextMaxSteps !== maxSteps) maxSteps = nextMaxSteps;
            conversation.push({
              id: `a_${nanoid(8)}`,
              role: "assistant",
              content: assistantText,
              timestamp: Date.now(),
            });
            conversation.push(makeSelfCheckEscalationReminder(unstructuredAnswer, selfCheck));
            options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：继续修正答案`);
            continue;
          }
          trace.outcome = "max_steps";
          trace.finalAnswer =
            "这次没有拿到足够可靠的最终答案。请再试一次，我会继续从工具证据开始重新检查。";
          break;
        }

        const step: AgentStep = {
          index: stepIndex,
          assistantText,
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
        const baselineCall = parsed.toolCalls
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
          content: parsed.thought
            ? JSON.stringify({ thought: parsed.thought, tool_calls: parsed.toolCalls })
            : JSON.stringify({ tool_calls: parsed.toolCalls }),
          timestamp: Date.now(),
          toolCalls: parsed.toolCalls,
        };
        conversation.push(assistantTurnMsg);

        const toolResults: ToolResult[] = [];
        for (const call of parsed.toolCalls) {
          if (aborted) break;
          options.onStatus?.(
            `第 ${stepIndex}/${maxSteps} 步：执行 ${call.name}`,
          );
          const ctx: ToolExecContext = {
            sessionId: options.sessionId,
            userInput: options.userInput,
            allowDialog: options.allowDialog ?? true,
            onStatus: options.onStatus,
          };
          const result = await executeTool(call.name, call.id, call.arguments, ctx);
          toolResults.push(result);
          conversation.push(toolResultToMessage(result));
          trace.toolCallCount += 1;
        }

        const step: AgentStep = {
          index: stepIndex,
          assistantText,
          toolCalls: parsed.toolCalls,
          toolResults,
          finishReason: "tool_call",
          startedAt: stepStart,
          endedAt: Date.now(),
        };
        trace.steps.push(step);
        options.onStep?.(step, trace);

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
        const continueDecision = evaluateContinueAfterFinalAnswer(trace, undefined);
        const nextMaxSteps = extendStepBudgetForIncompleteWorkflow(
          continueDecision,
          stepIndex,
          maxSteps,
        );
        if (nextMaxSteps !== maxSteps) {
          maxSteps = nextMaxSteps;
          options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：扩展未完成任务预算`);
        }
        if (continueDecision.shouldContinue) {
          conversation.push(makeContinueReminder(trace, undefined));
          options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：继续未完成任务`);
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
      const continueDecision = evaluateContinueAfterFinalAnswer(trace, finalAnswer);
      const nextMaxSteps = extendStepBudgetForIncompleteWorkflow(
        continueDecision,
        stepIndex,
        maxSteps,
      );
      if (nextMaxSteps !== maxSteps) {
        maxSteps = nextMaxSteps;
        options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：扩展未完成任务预算`);
      }
      if (continueDecision.shouldContinue && stepIndex < maxSteps) {
        const step: AgentStep = {
          index: stepIndex,
          assistantText,
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
          timestamp: Date.now(),
        });
        conversation.push(makeContinueReminder(trace, finalAnswer));
        options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：继续未完成任务`);
        continue;
      }

      options.onStatus?.(
        shouldUseHeavyAnswerSelfCheck(trace)
          ? `第 ${stepIndex}/${maxSteps} 步：答案自检`
          : `第 ${stepIndex}/${maxSteps} 步：本地检查`,
      );
      const selfCheck = await runAnswerSelfCheck(
        options.config,
        options.userInput,
        options.history,
        trace,
        finalAnswer,
      );
      if (
        !selfCheck.pass &&
        answerSelfCheckRevisionCount < ANSWER_SELF_CHECK_MAX_REVISIONS &&
        stepIndex < maxSteps
      ) {
        answerSelfCheckRevisionCount += 1;
        const step = makeAnswerSelfCheckRetryStep(stepIndex, assistantText, stepStart);
        trace.steps.push(step);
        options.onStep?.(step, trace);

        conversation.push({
          id: `a_${nanoid(8)}`,
          role: "assistant",
          content: assistantText,
          timestamp: Date.now(),
        });
        conversation.push(
          makeAnswerSelfCheckReminder(
            finalAnswer,
            selfCheck,
            answerSelfCheckRevisionCount,
          ),
        );
        options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：根据自检继续修正`);
        continue;
      }
      if (!selfCheck.pass) {
        const step = makeAnswerSelfCheckRetryStep(stepIndex, assistantText, stepStart);
        trace.steps.push(step);
        options.onStep?.(step, trace);
        if (stepIndex < HARD_AGENT_MAX_STEPS) {
          const nextMaxSteps = Math.min(
            HARD_AGENT_MAX_STEPS,
            Math.max(maxSteps, stepIndex + ANSWER_SELF_CHECK_EXTRA_STEP_BUDGET),
          );
          if (nextMaxSteps !== maxSteps) maxSteps = nextMaxSteps;
          conversation.push({
            id: `a_${nanoid(8)}`,
            role: "assistant",
            content: assistantText,
            timestamp: Date.now(),
          });
          conversation.push(makeSelfCheckEscalationReminder(finalAnswer, selfCheck));
          options.onStatus?.(`第 ${stepIndex}/${maxSteps} 步：继续修正答案`);
          continue;
        }
        trace.outcome = "max_steps";
        trace.finalAnswer =
          "这次没有拿到足够可靠的最终答案。请再试一次，我会继续从工具证据开始重新检查。";
        break;
      }

      const step: AgentStep = {
        index: stepIndex,
        assistantText,
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

    if (trace.outcome === "max_steps" && trace.steps.length > 0) {
      const lastAssistantText = trace.steps[trace.steps.length - 1].assistantText;
      const continueDecision = evaluateContinueAfterFinalAnswer(
        trace,
        lastAssistantText || undefined,
      );
      const extractedAnswer =
        extractProtocolStringValue(lastAssistantText, ["final_answer", "answer"]) ??
        (parseAgentTurn(lastAssistantText).toolCalls ? null : lastAssistantText.trim());
      trace.finalAnswer = continueDecision.shouldContinue
        ? `已达到当前安全步骤上限，但任务还没有完成：${continueDecision.reminder}`
        : extractedAnswer || "已达到最大推理步数，未得到最终答案。";
    }

    trace.endedAt = Date.now();
    return trace;
  })();

  return { promise, abort, providerRef };
}

// Re-export tool definitions for places that just need the catalog (e.g. UI).
export { TOOL_DEFINITIONS, TOOL_REGISTRY };
