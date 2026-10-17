import { invokeTask, throwIfAborted } from "@/services/tauri-task";
import { extractEplCodeBlocks, isCompleteExample } from "@/services/agent/epl-syntax";
import type { ECodeProjectResult, CompileResult } from "@/services/agent/tools";
import { useSettingsStore } from "@/stores/settings";

// ---------------------------------------------------------------------------
// Silent compile-validation for candidate final answers.
//
// The agent answer-self-check runs this *after* all rule-based validators pass,
// to catch the failure mode that prompts can't reach: "looks correct but ecl
// rejects it." Failure feeds stderr back to the model so it can fix and retry,
// the way a human would after a compiler error.
//
// This is intentionally a side path that does NOT register as an agent tool —
// it produces no trace entries and consumes no model turns.
// ---------------------------------------------------------------------------

export interface AnswerCompileCheckResult {
  /** True iff we found a complete-looking EPL block and tried to compile it. */
  attempted: boolean;
  /** Compile success. Only meaningful when attempted=true. */
  ok: boolean;
  stage: "no_complete_block" | "generate_failed" | "compile_failed" | "ok";
  stderr: string;
  stdout: string;
  /** First ~200 chars of the code we attempted to verify, for telemetry/debug. */
  codePreview: string;
  /** Module paths actually passed to generate/compile. */
  modulePathsUsed: string[];
}

const STDERR_PREVIEW_LIMIT = 3500;
const STDOUT_PREVIEW_LIMIT = 1500;

function trim(text: string | undefined | null, limit: number): string {
  if (!text) return "";
  return text.length <= limit ? text : `${text.slice(0, limit)}\n... [trimmed ${text.length - limit} chars]`;
}

/**
 * Try to compile the first complete EPL example found in `answer`. Caller is
 * responsible for collecting `modulePaths` from the user input and from any
 * already-uploaded user modules whose stored .ec paths are needed at compile
 * time. The function never throws — all failure modes return a populated
 * AnswerCompileCheckResult so the caller can decide whether to feed stderr
 * back to the model.
 */
export async function checkAnswerCompiles(
  answer: string,
  modulePaths: string[],
  signal?: AbortSignal,
): Promise<AnswerCompileCheckResult> {
  throwIfAborted(signal);
  const blocks = extractEplCodeBlocks(answer);
  // Window event source needs a form resource; the console template cannot
  // validate such a fragment. The generated GUI is verified by compile_efile.
  const completeBlock = blocks.find((block) => isCompleteExample(block.code)
    && !/窗口程序集|_启动窗口|_\S+_(?:创建完毕|被单击)/.test(block.code));
  if (!completeBlock) {
    return {
      attempted: false,
      ok: false,
      stage: "no_complete_block",
      stderr: "",
      stdout: "",
      codePreview: "",
      modulePathsUsed: [],
    };
  }

  const codePreview = completeBlock.code.slice(0, 200);
  const dedupedModules = Array.from(new Set(modulePaths.filter(Boolean)));

  let generated: ECodeProjectResult;
  try {
    generated = await invokeTask<ECodeProjectResult>("generate_efile_from_code", {
      code: completeBlock.code,
      outputPath: "",
      modulePaths: dedupedModules.length > 0 ? dedupedModules : null,
    }, signal);
  } catch (err) {
    throwIfAborted(signal);
    return {
      attempted: true,
      ok: false,
      stage: "generate_failed",
      stderr: trim(err instanceof Error ? err.message : String(err), STDERR_PREVIEW_LIMIT),
      stdout: "",
      codePreview,
      modulePathsUsed: dedupedModules,
    };
  }
  if (!generated.success || !generated.output_path) {
    return {
      attempted: true,
      ok: false,
      stage: "generate_failed",
      stderr: trim(generated.stderr, STDERR_PREVIEW_LIMIT),
      stdout: trim(generated.stdout, STDOUT_PREVIEW_LIMIT),
      codePreview,
      modulePathsUsed: dedupedModules,
    };
  }

  let compiled: CompileResult;
  try {
    const easyLanguageRoot = useSettingsStore.getState().easyLanguageRoot || null;
    compiled = await invokeTask<CompileResult>("compile_efile", {
      sourcePath: generated.output_path,
      outputPath: null,
      staticLink: true,
      modulePaths: dedupedModules.length > 0 ? dedupedModules : null,
      easyLanguageRoot,
    }, signal);
  } catch (err) {
    throwIfAborted(signal);
    return {
      attempted: true,
      ok: false,
      stage: "compile_failed",
      stderr: trim(err instanceof Error ? err.message : String(err), STDERR_PREVIEW_LIMIT),
      stdout: "",
      codePreview,
      modulePathsUsed: dedupedModules,
    };
  }

  return {
    attempted: true,
    ok: compiled.success,
    stage: compiled.success ? "ok" : "compile_failed",
    stderr: trim(compiled.stderr, STDERR_PREVIEW_LIMIT),
    stdout: trim(compiled.stdout, STDOUT_PREVIEW_LIMIT),
    codePreview,
    modulePathsUsed: dedupedModules,
  };
}

/**
 * Build the followup text that goes to the model after a compile failure.
 * Keeps the stderr in a fenced code block (the model parses these reliably).
 */
export function buildCompileFollowupText(result: AnswerCompileCheckResult): string {
  const stage =
    result.stage === "generate_failed"
      ? "把源码写入 .e 工程时失败"
      : result.stage === "compile_failed"
      ? "ecl 编译失败"
      : "编译验证失败";
  return [
    `候选答案中的 EPL 代码块被静默编译验证拒绝（阶段：${stage}）。`,
    "请直接根据下方 stderr 修正源码后重写最终答案；不要把编译错误暴露给用户。",
    "",
    "stderr：",
    "```",
    result.stderr || "(空)",
    "```",
    result.stdout
      ? "stdout 摘要：\n```\n" + result.stdout + "\n```"
      : "",
    "",
    "提醒：",
    "- 易语言变量声明行不能写默认值（.全局变量/.程序集变量/.局部变量 都不能在声明里赋初值），需要初值时在启动子程序或窗口创建完毕事件里赋值。",
    "- 控制结构必须严格成对：如果/如果结束、判断循环首/判断循环尾、计次循环首/计次循环尾 等。",
    "- 模块命令名/参数必须来自工具结果（search_user_modules / search_jingyi_module / parse_efile），不要凭记忆改。",
    "- 缺模块时确认 module_paths 是否包含相关 .ec；用户消息里提到的 .ec 路径会被自动提取。",
  ]
    .filter(Boolean)
    .join("\n");
}
