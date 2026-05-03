import { nanoid } from "nanoid";
import type {
  AgentStep,
  AgentTrace,
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
如果当前模型通道提供原生 function/tool_calls 能力，优先直接调用已注册工具；不要把工具调用写成给用户看的文字。
如果当前模型通道只能输出文本，则你的每一轮回答必须严格满足以下两种 JSON 格式之一，且**只输出一个 JSON 对象**，外面不要套 markdown：

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

【强制工具使用规则 — 违反即为错误】
- 用户消息中出现任何文件路径→先判断文件类型再选工具：
  - .e 源程序文件：必须先调 parse_efile 获取完整结构摘要和反编译源码。切勿对 .e 调 read_file（二进制格式，返回乱码）。
  - .ec 模块文件：【重要】模块是被主程序引用的依赖库，通常包含数千个子程序，但主程序可能只用了其中几十个。
    - 如果用户只上传了 .ec 没有 .e：调 parse_efile 查看模块概览。
    - 如果用户同时上传了 .e 和 .ec：先解析 .e 主程序，从摘要中找到引用了哪些模块命令，再决定是否需要深入查看 .ec。通常不需要对 .ec 调 parse_efile，因为主程序的解析结果已经包含了它调用的模块命令名。
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
- 普通知识问答、参数解释、单个功能代码片段或示例案例：可以先按需查询精易模块，再直接输出 final_answer。不要因为回答里含有易语言代码就强行生成 .e 或编译；只有用户明确要求生成文件、编译、测试、运行，或正在优化已有 .e 项目时，才进入生成/编译闭环。
- 缺路径时用 pick_file / pick_save_path 让用户选。
- 知识库只允许使用本地精易模块知识库；不要读取/解析易语言 IDE help 或其他支持库文档作为知识库。
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
- 调用方式：直接使用命令名或自然语言功能描述；不要凭记忆猜参数。
- search_jingyi_module 可能返回 related_implementations。用户问“怎么实现某功能/写个案例/有哪些方式”时，先根据 related_implementations 和 matches 对比多个可用实现的返回值、参数、适用场景，再给推荐和代码；不要只因为第一条能用就忽略同族实现。
- 精易模块是 .ec 文件；生成单文件项目时，通过 generate_efile_from_code 的 module_paths 引用；编译时通过 compile_efile 的 module_paths 引用。若用户消息里已有精易模块 .ec 路径，工具会自动提取。
- 如果用户没有提供精易模块 .ec 路径，先用 search_jingyi_module 完成代码方案；生成/编译阶段如果需要模块路径但缺失，再在 final_answer 中明确说明需要引用精易模块。
- 不要因为需要精易模块就改用 COM 对象或其他支持库绕开，除非 search_jingyi_module 没有相关能力。
`;

// ---------------------------------------------------------------------------
// JSON extraction — robust to models that wrap JSON in markdown / prose.
// ---------------------------------------------------------------------------

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Fast path: pure JSON
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  // Look for fenced code block first.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    const inner = fenced[1].trim();
    if (inner.startsWith("{")) return inner;
  }

  // Greedy bracket matcher: find first '{' then walk to its match.
  const start = trimmed.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (escape) { escape = false; continue; }
    if (c === "\\") { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

function repairJsonStringEscapes(text: string): string {
  let repaired = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (!inString) {
      repaired += char;
      if (char === '"') {
        inString = true;
        escaped = false;
      }
      continue;
    }

    if (escaped) {
      repaired += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      const next = text[i + 1];
      const isSimpleEscape =
        next !== undefined && /["\\/bfnrt]/.test(next);
      const isUnicodeEscape =
        next === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6));

      if (isSimpleEscape || isUnicodeEscape) {
        repaired += char;
        escaped = true;
      } else {
        repaired += "\\\\";
      }
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === "\n") {
      repaired += "\\n";
      continue;
    }
    if (char === "\r") {
      repaired += "\\r";
      continue;
    }
    if (char === "\t") {
      repaired += "\\t";
      continue;
    }

    if (char < " ") {
      repaired += `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;
      continue;
    }

    repaired += char;
  }

  return repaired;
}

function tryParseJsonWithRepair(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const repaired = repairJsonStringEscapes(text);
    if (repaired === text) return null;
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

interface ParsedAgentTurn {
  thought?: string;
  toolCalls?: ToolCall[];
  finalAnswer?: string;
  /** True when no JSON could be parsed; caller should treat the entire
   *  assistant text as the final answer (graceful degradation). */
  unstructured: boolean;
}

function parseXmlLikeToolCalls(rawText: string): ToolCall[] | null {
  const toolCallBlocks = [...rawText.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi)];
  if (toolCallBlocks.length === 0) return null;

  const toolCalls: ToolCall[] = [];
  for (const blockMatch of toolCallBlocks) {
    const block = blockMatch[1];
    const functionMatch = block.match(/<function=([^>\s]+)>\s*([\s\S]*?)\s*<\/function>/i);
    if (!functionMatch) continue;

    const name = functionMatch[1]?.trim();
    const body = functionMatch[2] ?? "";
    if (!name) continue;

    const args: Record<string, unknown> = {};
    const parameterMatches = body.matchAll(
      /<parameter=([^>\s]+)>\s*([\s\S]*?)\s*<\/parameter>/gi,
    );
    for (const parameterMatch of parameterMatches) {
      const key = parameterMatch[1]?.trim();
      const value = parameterMatch[2]?.trim() ?? "";
      if (!key) continue;
      args[key] = value;
    }

    toolCalls.push({
      id: `tc_${nanoid(8)}`,
      name,
      arguments: args,
      rawArguments: JSON.stringify(args),
    });
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

function parseAgentTurn(rawText: string): ParsedAgentTurn {
  const json = extractJsonObject(rawText);
  if (!json) {
    const xmlLikeToolCalls = parseXmlLikeToolCalls(rawText);
    if (xmlLikeToolCalls) {
      return {
        unstructured: false,
        toolCalls: xmlLikeToolCalls,
      };
    }
    const bestEffortAnswer = extractProtocolStringValue(rawText, ["final_answer", "answer"]);
    if (bestEffortAnswer) {
      return {
        unstructured: false,
        thought: extractProtocolStringValue(rawText, ["thought"]) ?? undefined,
        finalAnswer: bestEffortAnswer,
      };
    }
    return { unstructured: true, finalAnswer: rawText };
  }

  const parsed = tryParseJsonWithRepair(json);
  if (parsed === null) {
    const xmlLikeToolCalls = parseXmlLikeToolCalls(rawText);
    if (xmlLikeToolCalls) {
      return {
        unstructured: false,
        toolCalls: xmlLikeToolCalls,
      };
    }
    const bestEffortAnswer = extractProtocolStringValue(rawText, ["final_answer", "answer"]);
    if (bestEffortAnswer) {
      return {
        unstructured: false,
        thought: extractProtocolStringValue(rawText, ["thought"]) ?? undefined,
        finalAnswer: bestEffortAnswer,
      };
    }
    return { unstructured: true, finalAnswer: rawText };
  }
  if (!parsed || typeof parsed !== "object") {
    return { unstructured: true, finalAnswer: rawText };
  }

  const obj = parsed as Record<string, unknown>;
  const thought = typeof obj.thought === "string" ? obj.thought : undefined;
  const finalAnswer =
    typeof obj.final_answer === "string"
      ? obj.final_answer
      : typeof obj.answer === "string"
        ? obj.answer
        : undefined;
  const rawCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];

  const toolCalls: ToolCall[] = [];
  for (const entry of rawCalls) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const name = typeof e.name === "string" ? e.name : null;
    if (!name) continue;
    let args: Record<string, unknown> = {};
    let raw: string | undefined;
    if (e.arguments && typeof e.arguments === "object" && !Array.isArray(e.arguments)) {
      args = e.arguments as Record<string, unknown>;
      raw = JSON.stringify(args);
    } else if (typeof e.arguments === "string") {
      raw = e.arguments;
      const parsedArgs = tryParseJsonWithRepair(e.arguments);
      if (parsedArgs && typeof parsedArgs === "object" && !Array.isArray(parsedArgs)) {
        args = parsedArgs as Record<string, unknown>;
      } else {
        args = { _raw: e.arguments };
      }
    }
    toolCalls.push({
      id: typeof e.id === "string" ? e.id : `tc_${nanoid(8)}`,
      name,
      arguments: args,
      rawArguments: raw,
    });
  }

  if (toolCalls.length === 0 && finalAnswer === undefined) {
    return { unstructured: true, finalAnswer: rawText, thought };
  }

  return {
    unstructured: false,
    thought,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finalAnswer,
  };
}

function extractProtocolStringValue(text: string, keys: string[]): string | null {
  for (const key of keys) {
    const marker = `"${key}"`;
    const keyIndex = text.lastIndexOf(marker);
    if (keyIndex < 0) continue;
    const colonIndex = text.indexOf(":", keyIndex + marker.length);
    if (colonIndex < 0) continue;
    const quoteStart = text.indexOf('"', colonIndex + 1);
    if (quoteStart < 0) continue;

    let value = "";
    let escaped = false;
    for (let index = quoteStart + 1; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        if (char === "n") value += "\n";
        else if (char === "r") value += "\r";
        else if (char === "t") value += "\t";
        else if (char === '"') value += '"';
        else if (char === "\\") value += "\\";
        else if (char === "/") value += "/";
        else value += char;
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') {
        return value.trim() ? value : null;
      }
      value += char;
    }
    if (value.trim()) return value;
  }

  return null;
}

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

  if (state.parsedEFile && !state.exported && !state.readAfterExport) {
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

    for (let stepIndex = 1; stepIndex <= maxSteps; stepIndex++) {
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
        const enableNativeTools =
          options.config.provider === "openai" &&
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
