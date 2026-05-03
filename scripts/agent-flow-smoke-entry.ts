import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TextDecoder } from "node:util";

import { startAgentRun } from "@/services/agent/runner";
import type { AgentTrace, LLMConfig } from "@/types/llm";

interface SmokeOptions {
  repoRoot: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  userInput: string;
  maxSteps?: number;
}

interface RunProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const gbkDecoder = new TextDecoder("gbk");

function decodeBytes(bytes: Uint8Array): string {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return gbkDecoder.decode(bytes);
  }
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 180_000,
): Promise<RunProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let finished = false;

    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill();
      reject(new Error(`process timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolve({
        exitCode,
        stdout: decodeBytes(Buffer.concat(stdoutChunks)),
        stderr: decodeBytes(Buffer.concat(stderrChunks)),
      });
    });
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function waitForPath(
  targetPath: string,
  timeoutMs: number,
  pollIntervalMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await pathExists(targetPath)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  return pathExists(targetPath);
}

async function stageModuleDependencies(erootDir: string, modulePaths: string[]): Promise<string[]> {
  if (modulePaths.length === 0) return [];

  const ecomDir = path.join(erootDir, "ecom");
  await fs.mkdir(ecomDir, { recursive: true });
  const staged: string[] = [];

  for (const modulePath of modulePaths) {
    const fileName = path.basename(modulePath);
    const targetPath = path.join(ecomDir, fileName);
    await fs.copyFile(modulePath, targetPath);
    staged.push(targetPath);
  }

  return staged;
}

async function writeEcodeModuleRefs(ecodeDir: string, modulePaths: string[]): Promise<string[]> {
  if (modulePaths.length === 0) return [];
  const moduleDir = path.join(ecodeDir, "模块");
  await fs.mkdir(moduleDir, { recursive: true });
  const refs: string[] = [];

  for (const modulePath of modulePaths) {
    const stem = path.basename(modulePath, path.extname(modulePath));
    const displayName = stem.includes("精易") ? "精易模块" : stem;
    const descPath = path.join(moduleDir, `${displayName}.desc.json`);
    await fs.writeFile(
      descPath,
      `${JSON.stringify({ Source: modulePath }, null, 4)}\n`,
      "utf8",
    );
    refs.push(descPath);
  }

  return refs;
}

async function listFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = [];

  async function visit(currentPath: string): Promise<void> {
    if (files.length >= limit) return;
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= limit) return;
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  }

  await visit(root);
  return files;
}

async function readTextAuto(filePath: string, maxChars = 12_000) {
  const bytes = await fs.readFile(filePath);
  const content = decodeBytes(bytes);
  const truncated = [...content].length > maxChars;
  return {
    path: filePath,
    content: truncated
      ? `${[...content].slice(0, maxChars).join("")}\n\n... [已截断，原始文件 ${bytes.length} 字节] ...`
      : content,
    encoding: content === decodeBytes(bytes) ? "UTF-8/GBK" : "unknown",
    bytes: bytes.length,
    truncated,
  };
}

function relativeWinPath(root: string, filePath: string): string {
  return path.relative(root, filePath).replace(/\//g, "\\");
}

function isEcodeSourceFile(filePath: string): boolean {
  return path.basename(filePath).endsWith(".e.txt");
}

async function countEcodeSourceFiles(root: string): Promise<number> {
  const stat = await fs.stat(root).catch(() => null);
  if (!stat) return 0;
  if (stat.isFile()) return isEcodeSourceFile(root) ? 1 : 0;

  let count = 0;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    count += await countEcodeSourceFiles(path.join(root, entry.name));
  }
  return count;
}

async function collectEcodeSourceFiles(
  root: string,
  includeModules: boolean,
  out: string[],
  skipped: { count: number },
): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!includeModules && entry.name === "模块") {
        skipped.count += await countEcodeSourceFiles(fullPath);
        continue;
      }
      await collectEcodeSourceFiles(fullPath, includeModules, out, skipped);
    } else if (isEcodeSourceFile(fullPath)) {
      out.push(fullPath);
    }
  }
}

function ecodeReadRank(relativePath: string): number {
  const normalized = relativePath.replace(/\//g, "\\");
  if (normalized === "全局变量.e.txt" || normalized.endsWith("\\全局变量.e.txt")) return 0;
  if (normalized.includes("\\代码\\") && normalized.endsWith(".form.e.txt")) return 1;
  if (normalized.includes("\\代码\\") && normalized.endsWith(".class.e.txt")) return 2;
  if (normalized.includes("\\代码\\") && normalized.endsWith(".static.e.txt")) return 3;
  return 9;
}

function ecodeFileKind(filePath: string): string {
  const name = path.basename(filePath);
  if (name.endsWith(".form.e.txt")) return "窗口程序集";
  if (name.endsWith(".class.e.txt")) return "类模块";
  if (name.endsWith(".static.e.txt")) return "程序集";
  if (name === "全局变量.e.txt") return "全局变量";
  if (name === "常量.e.txt") return "常量";
  if (name === "自定义类型.e.txt") return "自定义类型";
  return "源码";
}

function afterPrefix(line: string, prefix: string): string | null {
  const trimmed = line.trimStart();
  return trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : null;
}

function splitESignatureName(text: string): string {
  return text.split(/[,，]/, 1)[0]?.trim() || text.trim();
}

function pushLimitedUnique(items: string[], value: string, limit: number): void {
  const clean = value.trim();
  if (!clean || items.includes(clean) || items.length >= limit) return;
  items.push(clean);
}

function collectLineCalls(line: string, calls: string[]): void {
  for (const marker of [" (", "（"]) {
    let start = 0;
    while (true) {
      const index = line.indexOf(marker, start);
      if (index < 0) break;
      const before = line.slice(0, index).trimEnd();
      const candidate = before
        .split(/[\s＝=+＋]+/)
        .filter(Boolean)
        .at(-1)
        ?.replace(/^[（(]+/g, "")
        .replace(/[.:：]+$/g, "")
        .trim() ?? "";
      if (
        candidate &&
        !candidate.startsWith(".") &&
        [...candidate].length <= 40 &&
        (candidate.includes("_") || candidate.includes(".") || /[\u4e00-\u9fff]/.test(candidate))
      ) {
        pushLimitedUnique(calls, candidate, 16);
      }
      start = index + marker.length;
    }
  }
}

async function summarizeEcodeSourceFile(ecodeDir: string, filePath: string) {
  const text = (await readTextAuto(filePath, Number.MAX_SAFE_INTEGER)).content;
  const lines = text.split(/\r?\n/);
  const supportLibraries: string[] = [];
  const assemblyVariables: string[] = [];
  const subprograms: Array<{
    name: string;
    signature: string;
    line: number;
    line_count: number;
    locals: string[];
    calls: string[];
  }> = [];
  let assembly: string | null = null;
  let current = -1;

  lines.forEach((line, index) => {
    const support = afterPrefix(line, ".支持库");
    if (support) {
      pushLimitedUnique(supportLibraries, support, 80);
      return;
    }

    const assemblyVariable = afterPrefix(line, ".程序集变量");
    if (assemblyVariable) {
      pushLimitedUnique(assemblyVariables, assemblyVariable, 80);
      return;
    }

    const assemblyName = afterPrefix(line, ".程序集");
    if (assemblyName && !line.trimStart().startsWith(".程序集变量")) {
      assembly = splitESignatureName(assemblyName);
      return;
    }

    const subprogram = afterPrefix(line, ".子程序");
    if (subprogram) {
      subprograms.push({
        name: splitESignatureName(subprogram),
        signature: line.trim(),
        line: index + 1,
        line_count: 0,
        locals: [],
        calls: [],
      });
      current = subprograms.length - 1;
      return;
    }

    const local = afterPrefix(line, ".局部变量");
    if (local && current >= 0) {
      pushLimitedUnique(subprograms[current].locals, local, 40);
      return;
    }

    if (current >= 0) collectLineCalls(line, subprograms[current].calls);
  });

  subprograms.forEach((subprogram, index) => {
    const endLine = subprograms[index + 1]?.line - 1 || lines.length;
    subprogram.line_count = Math.max(1, endLine - subprogram.line + 1);
  });

  return {
    path: filePath,
    relative_path: relativeWinPath(ecodeDir, filePath),
    kind: ecodeFileKind(filePath),
    chars: [...text].length,
    lines: lines.length,
    support_libraries: supportLibraries,
    assembly,
    assembly_variables: assemblyVariables,
    subprograms,
  };
}

function replaceExtension(filePath: string, nextExtension: string): string {
  return path.join(
    path.dirname(filePath),
    `${path.basename(filePath, path.extname(filePath))}.${nextExtension}`,
  );
}

function normalizeCodeForTemplate(code: string): string {
  const trimmed = code.trim();
  if (trimmed.includes(".版本") && trimmed.includes(".程序集")) {
    return trimmed;
  }

  const body = trimmed
    .split(/\r?\n/)
    .map((line) => (line.trim() ? `    ${line}` : ""))
    .join("\n");

  return [
    ".版本 2",
    "",
    ".程序集 程序集1",
    "",
    ".子程序 _启动子程序, 整数型, , 本子程序在程序启动后最先执行",
    "",
    body,
    "",
    "    返回 (0)",
  ].join("\n");
}

function trimOutput(text: string, maxChars: number): string {
  if (!text || text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.4));
  const tail = text.slice(-Math.floor(maxChars * 0.6));
  return `${head}\n... [truncated ${text.length - maxChars} chars] ...\n${tail}`;
}

function makeToolchain(repoRoot: string) {
  const resourceRoot = path.join(repoRoot, "src-tauri", "resources", "eagent-tools");
  const appDataRoot = path.join(
    process.env.LOCALAPPDATA ?? os.tmpdir(),
    "eaicoding-desktop",
    "eagent-tools",
  );
  const erootDir = path.join(appDataRoot, "eroot");
  const eExe = path.join(erootDir, "e.exe");
  const eparserExe = path.join(resourceRoot, "eparser32", "eparser32.exe");
  const eparserDll = path.join(resourceRoot, "ecodeparser", "ECodeParser.dll");
  const e2txtExe = path.join(resourceRoot, "e2txt", "e2txt.exe");
  const e2txtCwd = path.join(resourceRoot, "e2txt");
  const eclExe = path.join(resourceRoot, "ecl", "ecl.exe");
  const eclCwd = path.join(resourceRoot, "ecl");
  const templateDir = path.join(resourceRoot, "templates", "console.ecode");
  const generatedRoot = path.join(
    process.env.LOCALAPPDATA ?? os.tmpdir(),
    "eaicoding-desktop",
    "generated-ecode",
  );
  const autoRunsRoot = path.join(
    process.env.LOCALAPPDATA ?? os.tmpdir(),
    "eaicoding-desktop",
    "auto-runs",
  );

  return {
    resourceRoot,
    erootDir,
    eExe,
    eparserExe,
    eparserDll,
    e2txtExe,
    e2txtCwd,
    eclExe,
    eclCwd,
    templateDir,
    generatedRoot,
    autoRunsRoot,
  };
}

async function invokeBackend(
  repoRoot: string,
  command: string,
  rawArgs: Record<string, unknown>,
): Promise<unknown> {
  const tools = makeToolchain(repoRoot);

  if (command === "llm_proxy_request") {
    const request = rawArgs.request && typeof rawArgs.request === "object"
      ? rawArgs.request as {
          url?: unknown;
          method?: unknown;
          headers?: unknown;
          body?: unknown;
          timeoutSecs?: unknown;
        }
      : {};
    const url = typeof request.url === "string" ? request.url : "";
    const method = typeof request.method === "string" ? request.method : "POST";
    const headers = request.headers && typeof request.headers === "object"
      ? request.headers as Record<string, string>
      : {};
    const timeoutSecs = typeof request.timeoutSecs === "number"
      ? Math.max(1, Math.min(request.timeoutSecs, 300))
      : 120;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutSecs * 1000);
    try {
      const response = await fetch(url, {
        method,
        headers,
        body: method.toUpperCase() === "GET" ? undefined : JSON.stringify(request.body ?? {}),
        signal: controller.signal,
      });
      return {
        status: response.status,
        statusText: response.statusText,
        text: await response.text(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  if (command === "read_text_file_for_agent") {
    const filePath = String(rawArgs.filePath ?? "");
    const maxChars =
      typeof rawArgs.maxChars === "number" ? rawArgs.maxChars : 12_000;
    return readTextAuto(filePath, maxChars);
  }

  if (command === "write_text_file") {
    const filePath = String(rawArgs.filePath ?? "");
    const content = String(rawArgs.content ?? "");
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const bytes = Buffer.from(content, "utf8");
    await fs.writeFile(filePath, bytes);
    return {
      path: filePath,
      bytes: bytes.length,
    };
  }

  if (command === "parse_efile") {
    const filePath = String(rawArgs.filePath ?? "");
    const outputPath = replaceExtension(filePath, "parse_output.txt");
    const result = await runProcess(
      tools.eparserExe,
      [tools.eparserDll, tools.erootDir, filePath, outputPath],
      path.dirname(tools.eparserExe),
      180_000,
    );
    const success = result.exitCode === 0;
    const output = (await pathExists(outputPath))
      ? decodeBytes(await fs.readFile(outputPath))
      : result.stdout;
    const summaryPath = replaceExtension(filePath, "summary.json");
    let summary: unknown = null;
    if (await pathExists(summaryPath)) {
      summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
    }
    return {
      success,
      output,
      summary,
      error: result.stderr || null,
    };
  }

  if (command === "export_efile_to_ecode") {
    const sourcePath = String(rawArgs.sourcePath ?? "");
    const outputDir =
      typeof rawArgs.outputDir === "string" && rawArgs.outputDir.trim()
        ? rawArgs.outputDir.trim()
        : path.join(
            process.env.LOCALAPPDATA ?? os.tmpdir(),
            "eaicoding-desktop",
            "ecode",
            `${path.basename(sourcePath, path.extname(sourcePath))}-${Date.now()}`,
          );
    await fs.mkdir(outputDir, { recursive: true });
    const result = await runProcess(
      tools.e2txtExe,
      [
        "-log",
        "-enc",
        "UTF-8",
        "-ns",
        "2",
        "-e",
        "-src",
        sourcePath,
        "-dst",
        outputDir,
        "-mode",
        "e2t",
      ],
      tools.e2txtCwd,
      180_000,
    );
    return {
      success:
        result.exitCode === 0 &&
        (result.stdout.includes("SUCC:") || result.stderr.includes("SUCC:")),
      stdout: result.stdout,
      stderr: result.stderr,
      source_path: sourcePath,
      ecode_dir: outputDir,
      output_path: null,
      files: await listFiles(outputDir, 200),
    };
  }

  if (command === "summarize_ecode_project_for_agent") {
    const ecodeDir = String(rawArgs.ecodeDir ?? "");
    const includeModules = rawArgs.includeModules === true;
    const maxFiles = typeof rawArgs.maxFiles === "number"
      ? Math.max(1, Math.min(rawArgs.maxFiles, 120))
      : 40;
    const skipped = { count: 0 };
    const sourcePaths: string[] = [];
    await collectEcodeSourceFiles(ecodeDir, includeModules, sourcePaths, skipped);
    sourcePaths.sort((left, right) => {
      const leftRel = relativeWinPath(ecodeDir, left);
      const rightRel = relativeWinPath(ecodeDir, right);
      return ecodeReadRank(leftRel) - ecodeReadRank(rightRel) ||
        leftRel.localeCompare(rightRel, "zh-CN");
    });

    const sourceFiles = await Promise.all(
      sourcePaths.slice(0, maxFiles).map((filePath) => summarizeEcodeSourceFile(ecodeDir, filePath)),
    );
    const supportLibraries = [...new Set(sourceFiles.flatMap((item) => item.support_libraries))].sort();
    const assemblies = [...new Set(sourceFiles.map((item) => item.assembly).filter(Boolean) as string[])].sort();
    const entrypoints: string[] = [];
    for (const file of sourceFiles) {
      for (const subprogram of file.subprograms) {
        if (
          subprogram.name.startsWith("_") ||
          subprogram.name.includes("创建完毕") ||
          subprogram.name.includes("被单击") ||
          subprogram.name.includes("周期事件")
        ) {
          pushLimitedUnique(
            entrypoints,
            `${file.relative_path}:${subprogram.line} ${subprogram.name}`,
            40,
          );
        }
      }
    }
    const subprogramCount = sourceFiles.reduce((total, file) => total + file.subprograms.length, 0);

    return {
      success: true,
      ecode_dir: ecodeDir,
      source_file_count: sourcePaths.length,
      skipped_module_file_count: skipped.count,
      support_libraries: supportLibraries,
      assemblies,
      entrypoints,
      recommended_read_order: sourceFiles.slice(0, 12).map((item) => item.path),
      source_files: sourceFiles,
      summary:
        `发现主工程源码文件 ${sourcePaths.length} 个，本次摘要返回 ${sourceFiles.length} 个，` +
        `跳过模块源码 ${skipped.count} 个；程序集 ${assemblies.length} 个，` +
        `子程序 ${subprogramCount} 个，支持库 ${supportLibraries.length} 个。`,
    };
  }

  if (command === "generate_efile_from_ecode") {
    const ecodeDir = String(rawArgs.ecodeDir ?? "");
    const explicitOutputPath = String(rawArgs.outputPath ?? "").trim();
    const outputPath =
      explicitOutputPath ||
      path.join(tools.autoRunsRoot, `run-${Date.now()}`, "generated-from-ecode.e");
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const result = await runProcess(
      tools.e2txtExe,
      [
        "-log",
        "-enc",
        "UTF-8",
        "-ns",
        "2",
        "-e",
        "-src",
        ecodeDir,
        "-dst",
        outputPath,
        "-mode",
        "t2e",
      ],
      tools.e2txtCwd,
      180_000,
    );
    const outputReady = await waitForPath(outputPath, 3_000, 50);
    const success =
      result.exitCode === 0 &&
      (result.stdout.includes("SUCC:") || result.stderr.includes("SUCC:")) &&
      outputReady;
    return {
      success,
      stdout: result.stdout,
      stderr:
        result.exitCode === 0 &&
        !outputReady &&
        !(result.stdout.includes("SUCC:") || result.stderr.includes("SUCC:"))
          ? `${result.stderr}\ne2txt 已退出，但目标 .e 文件未在预期时间内确认。`.trim()
          : result.stderr,
      source_path: null,
      ecode_dir: ecodeDir,
      output_path: outputPath,
      files: await listFiles(ecodeDir, 200),
    };
  }

  if (command === "generate_efile_from_code") {
    const code = String(rawArgs.code ?? "");
    const explicitOutputPath = String(rawArgs.outputPath ?? "");
    const modulePaths = Array.isArray(rawArgs.modulePaths)
      ? rawArgs.modulePaths.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const timestamp = Date.now();
    const workDir = path.join(tools.generatedRoot, `project-${timestamp}`);
    await fs.cp(tools.templateDir, workDir, { recursive: true });
    const moduleRefs = await writeEcodeModuleRefs(workDir, modulePaths);
    const codePath = path.join(workDir, "代码", "程序集1.static.e.txt");
    await fs.writeFile(codePath, normalizeCodeForTemplate(code), "utf8");

    const outputPath =
      explicitOutputPath.trim() ||
      path.join(tools.autoRunsRoot, `run-${timestamp}`, "generated.e");
    const result = await invokeBackend(repoRoot, "generate_efile_from_ecode", {
      ecodeDir: workDir,
      outputPath,
    });
    if (result && typeof result === "object" && moduleRefs.length > 0) {
      const r = result as { stdout?: string };
      r.stdout = `已写入模块引用：\n${moduleRefs.join("\n")}\n\n${r.stdout ?? ""}`;
    }
    return result;
  }

  if (command === "compile_efile") {
    const sourcePath = String(rawArgs.sourcePath ?? "");
    const outputPath =
      typeof rawArgs.outputPath === "string" && rawArgs.outputPath.trim()
        ? rawArgs.outputPath.trim()
        : replaceExtension(sourcePath, "exe");
    const staticLink = rawArgs.staticLink !== false;
    const modulePaths = Array.isArray(rawArgs.modulePaths)
      ? rawArgs.modulePaths.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    const stagedModules = await stageModuleDependencies(tools.erootDir, modulePaths);
    const result = await runProcess(
      tools.eclExe,
      [
        "make",
        sourcePath,
        outputPath,
        "-epath",
        tools.eExe,
        "-nologo",
        staticLink ? "-s" : "-d",
      ],
      tools.eclCwd,
      staticLink ? 180_000 : 120_000,
    );
    const outputExists = await pathExists(outputPath);
    const statusOk = result.exitCode === 0 || result.exitCode === 1;
    const stderr = statusOk && !outputExists
      ? [
          `ecl.exe 未生成目标 EXE：${outputPath}`,
          `退出码：${result.exitCode ?? "未知"}`,
          `静态链接：${staticLink}`,
          result.stderr.trim() || result.stdout.trim()
            ? `编译器输出：\n${[result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n")}`
            : "没有捕获到编译器输出。",
        ].join("\n")
      : result.stderr;
    return {
      success: statusOk && outputExists,
      stdout:
        stagedModules.length > 0
          ? `已放置依赖模块：\n${stagedModules.join("\n")}\n\n${result.stdout}`
          : result.stdout,
      stderr,
      output_path: outputExists ? outputPath : null,
    };
  }

  throw new Error(`unsupported invoke command in smoke harness: ${command}`);
}

export async function runSmoke(options: SmokeOptions): Promise<{
  trace: AgentTrace;
  steps: Array<{
    index: number;
    finishReason: string;
    toolCalls: string[];
    toolOk: boolean[];
  }>;
}> {
  const globalObject = globalThis as typeof globalThis & {
    __EAICODING_LOCAL_EMBEDDING_MODEL_PATH__?: string;
    window: typeof globalThis & {
      __TAURI_INTERNALS__?: {
        invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
        transformCallback: (callback?: unknown, once?: boolean) => number;
        unregisterCallback: (id: number) => void;
      };
    };
  };

  globalObject.window = globalObject;
  globalObject.window.addEventListener ??= () => {};
  globalObject.window.removeEventListener ??= () => {};
  globalObject.__EAICODING_LOCAL_EMBEDDING_MODEL_PATH__ = path.join(
    options.repoRoot,
    "public",
    "models",
    "Xenova",
    "bge-small-zh-v1.5",
  );

  const nativeFetch = globalObject.fetch.bind(globalObject);
  globalObject.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (url.startsWith("/models/")) {
      const normalizedAssetPath = url
        .replace(/^\/models\//, "")
        .split(/[?#]/, 1)[0]
        .replace(/\//g, path.sep);
      const filePath = path.join(options.repoRoot, "public", "models", normalizedAssetPath);
      if (await pathExists(filePath)) {
        return new Response(await fs.readFile(filePath), { status: 200 });
      }
      return new Response("", { status: 404, statusText: "Not Found" });
    }

    return nativeFetch(input, init);
  };

  let callbackId = 1;
  globalObject.window.__TAURI_INTERNALS__ = {
    invoke: (cmd, args = {}) => invokeBackend(options.repoRoot, cmd, args),
    transformCallback: () => callbackId++,
    unregisterCallback: () => {},
  };

  const config: LLMConfig = {
    provider: "openai",
    baseUrl: options.baseUrl,
    apiKey: options.apiKey,
    model: options.model,
    temperature: 0,
    maxTokens: 4096,
  };

  const handle = startAgentRun({
    config,
    userInput: options.userInput,
    history: [],
    sessionId: null,
    maxSteps: options.maxSteps ?? 12,
    allowDialog: false,
  });
  const trace = await handle.promise;

  return {
    trace,
    steps: trace.steps.map((step) => ({
      index: step.index,
      finishReason: step.finishReason,
      toolCalls: step.toolCalls.map((call) => call.name),
      toolOk: step.toolResults.map((result) => result.ok),
    })),
  };
}
