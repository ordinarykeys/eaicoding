import { invoke } from "@tauri-apps/api/core";
import { invokeTask, throwIfAborted } from "@/services/tauri-task";
import { useSettingsStore } from "@/stores/settings";
import {
  findEplSourceDiagnostics,
  type EplSyntaxDiagnostic,
} from "@/services/agent/epl-syntax";
import type {
  CompileResult,
  ECodeBaselineBuildResult,
  ECodeContextPackResult,
  ECodeProjectAnalysisResult,
  ECodeProjectBuildResult,
  ECodeProjectMapResult,
  ECodeProjectResult,
  ParseResult,
  ReadFileResult,
  WriteTextResult,
} from "@/services/agent/tools";

const SNAPSHOT_READ_MAX_CHARS = 8_000_000;
const DIFF_READ_MAX_CHARS = 8_000_000;
const DEFAULT_WORKFLOW_MAX_FILES = 500;

export interface ClosedLoopWorkflowDeps {
  analyzeProject: (
    ecodeDir: string,
    includeModules: boolean,
    maxFiles: number | null,
  ) => Promise<ECodeProjectAnalysisResult>;
  buildContextPack: (
    ecodeDir: string,
    focus: string | null,
    includeModules: boolean,
    maxFiles: number | null,
    maxSnippets: number | null,
  ) => Promise<ECodeContextPackResult>;
}

export interface ClosedLoopWorkflowInput {
  signal?: AbortSignal;
  targetPath?: string | null;
  ecodeDir?: string | null;
  goal: string;
  includeModules?: boolean;
  maxFiles?: number | null;
  modulePaths?: string[];
  staticLink?: boolean;
  runBaseline?: boolean;
  sourceOutputPath?: string | null;
  exeOutputPath?: string | null;
  onStatus?: (status: string) => void;
}

export interface ClosedLoopFinishInput {
  signal?: AbortSignal;
  workflowId?: string | null;
  workflowStatePath?: string | null;
  snapshotPath?: string | null;
  ecodeDir?: string | null;
  modulePaths?: string[];
  staticLink?: boolean;
  sourceOutputPath?: string | null;
  exeOutputPath?: string | null;
  onStatus?: (status: string) => void;
}

export interface ClosedLoopRestoreInput {
  signal?: AbortSignal;
  workflowId?: string | null;
  workflowStatePath?: string | null;
  snapshotPath?: string | null;
  ecodeDir?: string | null;
  onStatus?: (status: string) => void;
}

export interface ClosedLoopStageLog {
  stage: string;
  ok: boolean;
  startedAt: number;
  endedAt: number;
  summary: string;
  detail?: unknown;
  error?: string;
}

export interface ClosedLoopSnapshotFile {
  path: string;
  relativePath: string;
  encoding: string;
  content: string;
  bytes: number;
  hash: string;
}

export interface ClosedLoopSnapshot {
  id: string;
  workflowId: string;
  createdAt: number;
  goal: string;
  ecodeDir: string;
  sourcePath?: string | null;
  sourceFileCount: number;
  capturedFileCount: number;
  complete: boolean;
  files: ClosedLoopSnapshotFile[];
}

export interface ClosedLoopChangedFile {
  path: string;
  relativePath: string;
  beforeHash: string;
  afterHash: string;
  beforeBytes: number;
  afterBytes: number;
  addedLines: number;
  removedLines: number;
  preview: string;
}

export interface ClosedLoopWorkflowState {
  workflowId: string;
  createdAt: number;
  updatedAt: number;
  goal: string;
  sourcePath?: string | null;
  ecodeDir: string;
  snapshotPath: string;
  statePath: string;
  buildReportPath?: string | null;
  modulePaths: string[];
  staticLink: boolean;
  includeModules: boolean;
  maxFiles: number | null;
  projectMap?: ECodeProjectMapResult;
  analysis?: ECodeProjectAnalysisResult;
  contextPack?: ECodeContextPackResult;
  baseline?: ECodeBaselineBuildResult | null;
}

export interface ClosedLoopStartResult {
  success: boolean;
  ready_for_edit: boolean;
  workflow_id: string;
  source_path?: string | null;
  ecode_dir?: string | null;
  snapshot_path?: string | null;
  workflow_state_path?: string | null;
  logs: ClosedLoopStageLog[];
  parse?: ParseResult | null;
  project_map?: ECodeProjectMapResult;
  analysis?: ECodeProjectAnalysisResult;
  context_pack?: ECodeContextPackResult;
  baseline?: ECodeBaselineBuildResult | null;
  recommended_reads: string[];
  next_instruction: string;
}

/** A control-structure pairing error found by pre-flight, before compile. */
export interface ClosedLoopPreflightFinding {
  relativePath: string;
  path: string;
  line: number;
  message: string;
  source: string;
}

export interface ClosedLoopFinishResult {
  success: boolean;
  workflow_id?: string | null;
  ecode_dir: string;
  snapshot_path?: string | null;
  workflow_state_path?: string | null;
  build_report_path?: string | null;
  /** "preflight" → rejected by EL syntax pre-flight before the compile
   *  round-trip; the others are the regenerate/compile stages. */
  stage: "preflight" | "ecode_to_efile" | "ecl_compile" | "done";
  source_path?: string | null;
  output_path?: string | null;
  logs: ClosedLoopStageLog[];
  build: ECodeProjectBuildResult | null;
  changed_files: ClosedLoopChangedFile[];
  /** EL pre-flight findings (control-structure pairing errors) when the build
   *  was skipped because the edited source is obviously broken. */
  preflight_findings?: ClosedLoopPreflightFinding[];
  repair_instruction?: string;
  next_instruction: string;
}

export interface ClosedLoopRestoreResult {
  success: boolean;
  workflow_id?: string | null;
  snapshot_path: string;
  ecode_dir: string;
  restored_count: number;
  restored_files: string[];
  logs: ClosedLoopStageLog[];
}

function makeWorkflowId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, "")
    .slice(0, 14);
  const random = globalThis.crypto?.randomUUID?.().slice(0, 8)
    ?? Math.random().toString(36).slice(2, 10);
  return `cl_${stamp}_${random}`;
}

function trimOutput(text: string | null | undefined, maxChars = 4_000): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  const head = text.slice(0, Math.floor(maxChars * 0.42));
  const tail = text.slice(-Math.floor(maxChars * 0.58));
  return `${head}\n... [truncated ${text.length - maxChars} chars] ...\n${tail}`;
}

function uniqueStrings(items: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const value = item?.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function normalizeWinPath(path: string): string {
  return path.replace(/\//g, "\\");
}

function joinPath(dir: string, name: string): string {
  return `${normalizeWinPath(dir).replace(/[\\]+$/, "")}\\${name.replace(/^[\\]+/, "")}`;
}

function basename(path: string): string {
  return normalizeWinPath(path).split("\\").pop()?.trim() || "";
}

function fileStem(path: string, fallback = "project"): string {
  const name = basename(path) || fallback;
  const stem = name.replace(/\.[^.]+$/, "").trim();
  return stem || fallback;
}

function sanitizeFileName(name: string, fallback = "project"): string {
  const clean = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");
  return clean || fallback;
}

function looksLikeEFile(path: string | null | undefined): boolean {
  return Boolean(path && /\.e$/i.test(path.trim()));
}

function configuredGenerateDir(): string | null {
  return useSettingsStore.getState().easyLanguageGenerateDir?.trim() || null;
}

function configuredCompileDir(): string | null {
  return useSettingsStore.getState().easyLanguageCompileDir?.trim() || null;
}

function makeExportDir(sourcePath: string, workflowId: string): string | null {
  const dir = configuredGenerateDir();
  if (!dir) return null;
  const stem = sanitizeFileName(fileStem(sourcePath, "project"), "project");
  return joinPath(dir, `${stem}-${workflowId}.ecode`);
}

function workflowRoot(ecodeDir: string): string {
  return joinPath(ecodeDir, ".eagent\\closed-loop");
}

function artifactRoot(ecodeDir: string): string {
  return joinPath(ecodeDir, ".eagent\\artifacts");
}

function snapshotPathFor(ecodeDir: string, workflowId: string): string {
  return joinPath(workflowRoot(ecodeDir), `${workflowId}.snapshot.json`);
}

function statePathFor(ecodeDir: string, workflowId: string): string {
  return joinPath(workflowRoot(ecodeDir), `${workflowId}.state.json`);
}

function buildReportPathFor(ecodeDir: string, workflowId: string): string {
  return joinPath(workflowRoot(ecodeDir), `${workflowId}.build-report.json`);
}

function generatedSourcePathFor(
  ecodeDir: string,
  workflowId: string,
  sourceHint: string | null | undefined,
): string {
  const explicitDir = configuredGenerateDir();
  const baseDir = explicitDir || artifactRoot(ecodeDir);
  const stem = sanitizeFileName(fileStem(sourceHint || ecodeDir, "project"), "project");
  return joinPath(baseDir, `${stem}-${workflowId}.e`);
}

function compiledExePathFor(
  ecodeDir: string,
  workflowId: string,
  sourceHint: string | null | undefined,
): string {
  const explicitDir = configuredCompileDir();
  const baseDir = explicitDir || artifactRoot(ecodeDir);
  const stem = sanitizeFileName(fileStem(sourceHint || ecodeDir, "project"), "project");
  return joinPath(baseDir, `${stem}-${workflowId}.exe`);
}

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function makeDiffPreview(before: string, after: string): {
  addedLines: number;
  removedLines: number;
  preview: string;
} {
  const a = normalizeNewlines(before).split("\n");
  const b = normalizeNewlines(after).split("\n");

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = a.slice(prefix, a.length - suffix);
  const added = b.slice(prefix, b.length - suffix);
  const startLine = prefix + 1;
  const previewLines = [
    `@@ line ${startLine} @@`,
    ...removed.slice(0, 8).map((line) => `- ${line}`),
    ...added.slice(0, 8).map((line) => `+ ${line}`),
  ];
  if (removed.length > 8 || added.length > 8) {
    previewLines.push("... diff preview truncated ...");
  }

  return {
    // added/removed are the exact changed-line slices between the common
    // prefix and suffix, so their lengths are the real +/- line counts.
    addedLines: added.length,
    removedLines: removed.length,
    preview: trimOutput(previewLines.join("\n"), 3_000),
  };
}

function encodingForWrite(readEncoding: string): "gbk" | "utf-8" {
  return /gbk|gb18030/i.test(readEncoding) ? "gbk" : "utf-8";
}

async function readTextFile(filePath: string, maxChars: number): Promise<ReadFileResult> {
  return invoke<ReadFileResult>("read_text_file_for_agent", {
    filePath,
    maxChars,
  });
}

async function writeTextFile(
  filePath: string,
  content: string,
  encoding: "gbk" | "utf-8" = "utf-8",
): Promise<WriteTextResult> {
  return invoke<WriteTextResult>("write_text_file", {
    filePath,
    content,
    encoding,
  });
}

async function runStage<T>(
  logs: ClosedLoopStageLog[],
  stage: string,
  summary: string,
  onStatus: ((status: string) => void) | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  onStatus?.(summary);
  try {
    const detail = await fn();
    logs.push({
      stage,
      ok: true,
      startedAt,
      endedAt: Date.now(),
      summary,
      detail: compactStageDetail(detail),
    });
    return detail;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logs.push({
      stage,
      ok: false,
      startedAt,
      endedAt: Date.now(),
      summary,
      error,
    });
    throw err;
  }
}

function compactStageDetail(detail: unknown): unknown {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return detail;
  const raw = detail as Record<string, unknown>;
  const compact: Record<string, unknown> = { ...raw };
  const snapshot = compact.snapshot;
  if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
    const item = snapshot as Record<string, unknown>;
    compact.snapshot = {
      id: item.id,
      workflowId: item.workflowId,
      ecodeDir: item.ecodeDir,
      sourceFileCount: item.sourceFileCount,
      capturedFileCount: item.capturedFileCount,
      complete: item.complete,
    };
  }
  for (const key of ["stdout", "stderr", "output", "content"]) {
    if (typeof compact[key] === "string") compact[key] = trimOutput(compact[key] as string, 1_200);
  }
  if (Array.isArray(compact.files)) {
    compact.files = compact.files.slice(0, 20).map(compactSourceLikeObject);
  }
  if (Array.isArray(compact.source_files) && compact.source_files.length > 12) {
    compact.source_files = compact.source_files.slice(0, 12).map(compactSourceLikeObject);
  } else if (Array.isArray(compact.source_files)) {
    compact.source_files = compact.source_files.map(compactSourceLikeObject);
  }
  if (Array.isArray(compact.findings) && compact.findings.length > 12) {
    compact.findings = compact.findings.slice(0, 12);
  }
  if (Array.isArray(compact.duplicate_groups) && compact.duplicate_groups.length > 6) {
    compact.duplicate_groups = compact.duplicate_groups.slice(0, 6);
  }
  return compact;
}

function compactSourceLikeObject(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const raw = value as Record<string, unknown>;
  return {
    path: raw.path,
    relative_path: raw.relative_path ?? raw.relativePath,
    kind: raw.kind,
    chars: raw.chars,
    lines: raw.lines,
    assembly: raw.assembly,
    subprogram_count: Array.isArray(raw.subprograms) ? raw.subprograms.length : undefined,
    snippet_count: Array.isArray(raw.snippets) ? raw.snippets.length : undefined,
  };
}

async function createSnapshot(input: {
  workflowId: string;
  goal: string;
  ecodeDir: string;
  sourcePath?: string | null;
  projectMap: ECodeProjectMapResult;
}): Promise<{ snapshot: ClosedLoopSnapshot; snapshotPath: string }> {
  // Parallel reads: each file is one IPC round-trip; serial awaits made large
  // projects pay hundreds of sequential round-trips.
  const files: ClosedLoopSnapshotFile[] = await Promise.all(
    input.projectMap.source_files.map(async (file) => {
      const read = await readTextFile(file.path, SNAPSHOT_READ_MAX_CHARS);
      if (read.truncated) {
        throw new Error(`Snapshot aborted: source file is too large/truncated: ${file.path}`);
      }
      return {
        path: read.path,
        relativePath: file.relative_path,
        encoding: read.encoding,
        content: read.content,
        bytes: read.bytes,
        hash: hashText(read.content),
      };
    }),
  );

  const snapshot: ClosedLoopSnapshot = {
    id: `${input.workflowId}_snapshot`,
    workflowId: input.workflowId,
    createdAt: Date.now(),
    goal: input.goal,
    ecodeDir: input.ecodeDir,
    sourcePath: input.sourcePath ?? null,
    sourceFileCount: input.projectMap.source_file_count,
    capturedFileCount: files.length,
    complete: files.length >= input.projectMap.source_file_count,
    files,
  };
  const path = snapshotPathFor(input.ecodeDir, input.workflowId);
  await writeTextFile(path, JSON.stringify(snapshot, null, 2), "utf-8");
  return { snapshot, snapshotPath: path };
}

async function readSnapshot(path: string): Promise<ClosedLoopSnapshot> {
  const read = await readTextFile(path, SNAPSHOT_READ_MAX_CHARS);
  if (read.truncated) {
    throw new Error(`Snapshot file is truncated: ${path}`);
  }
  const parsed = JSON.parse(read.content) as ClosedLoopSnapshot;
  if (!parsed || !Array.isArray(parsed.files) || !parsed.ecodeDir) {
    throw new Error(`Invalid closed-loop snapshot: ${path}`);
  }
  return parsed;
}

async function writeWorkflowState(state: ClosedLoopWorkflowState): Promise<string> {
  await writeTextFile(state.statePath, JSON.stringify(state, null, 2), "utf-8");
  return state.statePath;
}

async function readWorkflowState(path: string): Promise<ClosedLoopWorkflowState> {
  const read = await readTextFile(path, SNAPSHOT_READ_MAX_CHARS);
  if (read.truncated) {
    throw new Error(`Workflow state file is truncated: ${path}`);
  }
  const parsed = JSON.parse(read.content) as ClosedLoopWorkflowState;
  if (!parsed || !parsed.workflowId || !parsed.ecodeDir) {
    throw new Error(`Invalid closed-loop workflow state: ${path}`);
  }
  return parsed;
}

async function maybeReadWorkflowState(input: {
  workflowStatePath?: string | null;
  ecodeDir?: string | null;
  workflowId?: string | null;
}): Promise<ClosedLoopWorkflowState | null> {
  const explicit = input.workflowStatePath?.trim();
  const inferred = input.ecodeDir && input.workflowId
    ? statePathFor(input.ecodeDir, input.workflowId)
    : null;
  const path = explicit || inferred;
  if (!path) return null;
  try {
    return await readWorkflowState(path);
  } catch {
    return null;
  }
}

async function buildECodeProjectForWorkflow(input: {
  signal?: AbortSignal;
  workflowId: string;
  ecodeDir: string;
  modulePaths: string[];
  staticLink: boolean;
  sourceOutputPath?: string | null;
  exeOutputPath?: string | null;
  sourceHint?: string | null;
}): Promise<ECodeProjectBuildResult> {
  const sourceOutputPath =
    input.sourceOutputPath?.trim()
    || generatedSourcePathFor(input.ecodeDir, input.workflowId, input.sourceHint);
  const generated = await invokeTask<ECodeProjectResult>("generate_efile_from_ecode", {
    ecodeDir: input.ecodeDir,
    outputPath: sourceOutputPath,
  }, input.signal);

  if (!generated.success || !generated.output_path) {
    return {
      success: false,
      ecode_dir: input.ecodeDir,
      stage: "ecode_to_efile",
      source_path: generated.output_path,
      output_path: null,
      generated: {
        success: generated.success,
        output_path: generated.output_path,
        stdout: trimOutput(generated.stdout, 2_000),
        stderr: trimOutput(generated.stderr, 4_000),
      },
      compiled: null,
      module_paths_used: input.modulePaths,
      stdout: trimOutput(generated.stdout, 2_500),
      stderr: trimOutput(generated.stderr, 4_500),
    };
  }

  const exeOutputPath =
    input.exeOutputPath?.trim()
    || compiledExePathFor(input.ecodeDir, input.workflowId, generated.output_path);

  const compiled = await invokeTask<CompileResult>("compile_efile", {
    sourcePath: generated.output_path,
    outputPath: exeOutputPath,
    staticLink: input.staticLink,
    modulePaths: input.modulePaths.length > 0 ? input.modulePaths : null,
    easyLanguageRoot: useSettingsStore.getState().easyLanguageRoot || null,
  }, input.signal);

  return {
    success: compiled.success,
    ecode_dir: input.ecodeDir,
    stage: compiled.success ? "done" : "ecl_compile",
    source_path: generated.output_path,
    output_path: compiled.output_path,
    generated: {
      success: generated.success,
      output_path: generated.output_path,
      stdout: trimOutput(generated.stdout, 1_500),
      stderr: trimOutput(generated.stderr, 1_500),
    },
    compiled: {
      success: compiled.success,
      output_path: compiled.output_path,
      stdout: trimOutput(compiled.stdout, 2_500),
      stderr: trimOutput(compiled.stderr, 5_000),
    },
    module_paths_used: input.modulePaths,
    stdout: trimOutput([generated.stdout, compiled.stdout].filter(Boolean).join("\n\n"), 3_500),
    stderr: trimOutput([generated.stderr, compiled.stderr].filter(Boolean).join("\n\n"), 5_500),
  };
}

function baselineFromBuild(input: {
  sourcePath?: string | null;
  ecodeDir: string;
  build: ECodeProjectBuildResult;
  exported?: ECodeProjectResult | null;
}): ECodeBaselineBuildResult {
  return {
    success: input.build.success,
    source_path: input.sourcePath || input.ecodeDir,
    ecode_dir: input.ecodeDir,
    output_path: input.build.output_path,
    stage: input.build.stage,
    exported: input.exported
      ? {
          success: input.exported.success,
          ecode_dir: input.exported.ecode_dir,
          stdout: trimOutput(input.exported.stdout, 1_000),
          stderr: trimOutput(input.exported.stderr, 1_000),
        }
      : null,
    generated: input.build.generated,
    compiled: input.build.compiled,
    module_paths_used: input.build.module_paths_used,
    stdout: input.build.stdout,
    stderr: input.build.stderr,
    note: input.build.success
      ? "Baseline passed: exported text project can be regenerated and compiled before any AI edit."
      : "Baseline failed before AI edits. Fix toolchain/module/environment issues first, otherwise later compile failures cannot be attributed to AI changes.",
  };
}

function recommendedReadsFrom(
  map: ECodeProjectMapResult | undefined,
  analysis: ECodeProjectAnalysisResult | undefined,
  context: ECodeContextPackResult | undefined,
): string[] {
  return uniqueStrings([
    ...(context?.recommended_full_reads ?? []),
    ...(analysis?.recommended_next_reads ?? []),
    ...(map?.recommended_read_order ?? []),
  ]).slice(0, 16);
}

function makeStartInstruction(result: {
  ready: boolean;
  snapshotComplete: boolean;
  recommendedReads: string[];
  baseline?: ECodeBaselineBuildResult | null;
}): string {
  if (!result.ready) {
    return [
      "STOP before editing source.",
      "The original project baseline did not compile/regenerate successfully.",
      "Ask the user to provide missing .ec modules or fix the EasyLanguage/ecl environment, then run start_project_closed_loop again.",
      result.baseline?.stderr ? `Key stderr:\n${trimOutput(result.baseline.stderr, 1_200)}` : "",
    ].filter(Boolean).join("\n");
  }
  const reads = result.recommendedReads
    .slice(0, 8)
    .map((path, index) => `${index + 1}. ${path}`)
    .join("\n");
  return [
    "Closed-loop project workspace is ready.",
    result.snapshotComplete
      ? "A complete rollback snapshot has been captured."
      : "Snapshot is partial because the project has more files than the current map returned; only edit files included in recommended reads/snapshot.",
    "Next: read the relevant .e.txt files, edit with apply_search_replace/save_text_file, then call finish_project_closed_loop.",
    reads ? `Recommended reads:\n${reads}` : "",
  ].filter(Boolean).join("\n");
}

function makeRepairInstruction(build: ECodeProjectBuildResult, changedFiles: ClosedLoopChangedFile[]): string {
  const changed = changedFiles
    .slice(0, 8)
    .map((file) => `- ${file.relativePath || file.path} (+${file.addedLines}/-${file.removedLines})`)
    .join("\n");
  if (build.success) {
    return "Build passed. Summarize changed files and provide artifact paths to the user.";
  }
  if (build.stage === "ecode_to_efile") {
    return [
      "Regenerating .e from ecode failed. Read stderr and fix the modified .e.txt source.",
      "Priority checks: variable declaration lines must not contain default values; EasyLanguage control blocks must use real paired syntax; do not rewrite GUI structure into a single file.",
      changed ? `Changed files:\n${changed}` : "No changed file was detected against the snapshot.",
      build.stderr ? `stderr:\n${trimOutput(build.stderr, 1_800)}` : "",
    ].filter(Boolean).join("\n");
  }
  return [
    "ecl compile failed. Use stderr to locate missing modules/support libraries or syntax errors, then read and patch the corresponding .e.txt file and call finish_project_closed_loop again.",
    changed ? `Changed files:\n${changed}` : "No changed file was detected against the snapshot.",
    build.stderr ? `stderr:\n${trimOutput(build.stderr, 2_200)}` : "",
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// EL pre-flight: cheap control-structure pairing check on edited .e.txt files,
// run before the expensive regenerate + ecl compile. ecl would reject these
// too, but at the cost of a binary round-trip; catching them here is instant
// and gives line-precise Chinese-keyword diagnostics instead of raw stderr.
// ---------------------------------------------------------------------------

function preflightChangedFiles(
  changedFiles: ClosedLoopChangedFile[],
  currentContentByPath: Map<string, string>,
): ClosedLoopPreflightFinding[] {
  const findings: ClosedLoopPreflightFinding[] = [];
  for (const file of changedFiles) {
    const content = currentContentByPath.get(file.path);
    if (content === undefined) continue;
    for (const diag of findEplSourceDiagnostics(content)) {
      // Only hard control-structure errors gate the build; repeated-executable
      // warnings are advisory and must not block a legitimate compile.
      if (diag.severity !== "error" || diag.kind !== "control_structure") continue;
      findings.push({
        relativePath: file.relativePath,
        path: file.path,
        line: diag.line,
        message: diag.message,
        source: diag.source,
      });
    }
  }
  return findings;
}

function makePreflightRepairInstruction(findings: ClosedLoopPreflightFinding[]): string {
  const lines = findings
    .slice(0, 10)
    .map((f) => `- ${f.relativePath || f.path} 第 ${f.line} 行：${f.message}${f.source ? `\n  源码：${f.source}` : ""}`)
    .join("\n");
  return [
    "跳过回编/编译：修改后的 .e.txt 存在易语言控制结构配对错误，ecl 必然会拒绝。",
    "请先修复下列配对问题（如果/如果结束、计次循环首/计次循环尾 等必须成对且类型匹配），再调用 finish_project_closed_loop。",
    lines,
    "提醒：不要把控制结构开始语句拼成结束语句；结束语句必须来自真实配对表。",
  ].filter(Boolean).join("\n");
}

async function computeChangedFiles(snapshotPath: string): Promise<{
  snapshot: ClosedLoopSnapshot;
  changedFiles: ClosedLoopChangedFile[];
  /** Current on-disk content of each changed file, keyed by absolute path.
   *  Captured here (the diff already read it) so pre-flight validation does
   *  not need a second read. */
  currentContentByPath: Map<string, string>;
}> {
  const snapshot = await readSnapshot(snapshotPath);
  const changedFiles: ClosedLoopChangedFile[] = [];
  const currentContentByPath = new Map<string, string>();
  const currentReads = await Promise.all(
    snapshot.files.map(async (original) => {
      const current = await readTextFile(original.path, DIFF_READ_MAX_CHARS);
      if (current.truncated) {
        throw new Error(`Diff aborted: source file is too large/truncated: ${original.path}`);
      }
      return { original, current };
    }),
  );
  for (const { original, current } of currentReads) {
    const currentHash = hashText(current.content);
    if (currentHash === original.hash) continue;
    const diff = makeDiffPreview(original.content, current.content);
    changedFiles.push({
      path: original.path,
      relativePath: original.relativePath,
      beforeHash: original.hash,
      afterHash: currentHash,
      beforeBytes: original.bytes,
      afterBytes: current.bytes,
      addedLines: diff.addedLines,
      removedLines: diff.removedLines,
      preview: diff.preview,
    });
    currentContentByPath.set(original.path, current.content);
  }
  return { snapshot, changedFiles, currentContentByPath };
}

export async function startProjectClosedLoopWorkflow(
  input: ClosedLoopWorkflowInput,
  deps: ClosedLoopWorkflowDeps,
): Promise<ClosedLoopStartResult> {
  const stage = workflowStages(input.signal);
  const logs: ClosedLoopStageLog[] = [];
  const workflowId = makeWorkflowId();
  const goal = input.goal.trim();
  const includeModules = input.includeModules ?? false;
  const maxFiles = input.maxFiles === null
    ? null
    : Math.max(1, Math.min(input.maxFiles ?? DEFAULT_WORKFLOW_MAX_FILES, DEFAULT_WORKFLOW_MAX_FILES));
  const staticLink = input.staticLink ?? true;
  const modulePaths = uniqueStrings(input.modulePaths ?? []);
  const sourcePath = input.targetPath?.trim() || null;
  let ecodeDir = input.ecodeDir?.trim() || null;
  let parse: ParseResult | null = null;
  let exported: ECodeProjectResult | null = null;

  if (!goal) throw new Error("Missing closed-loop goal.");
  if (!sourcePath && !ecodeDir) throw new Error("Provide targetPath (.e) or ecodeDir.");

  try {
    if (sourcePath && looksLikeEFile(sourcePath)) {
      parse = await stage(logs, "parse_efile", "Parsing original .e metadata", input.onStatus, () =>
        invokeTask<ParseResult>("parse_efile", { filePath: sourcePath }, input.signal));
    }

    if (!ecodeDir) {
      if (!sourcePath) throw new Error("Missing targetPath for ecode export.");
      exported = await stage(logs, "export_efile_to_ecode", "Exporting .e to editable ecode project", input.onStatus, () =>
        invokeTask<ECodeProjectResult>("export_efile_to_ecode", {
          sourcePath,
          outputDir: makeExportDir(sourcePath, workflowId),
        }, input.signal));
      if (!exported.success || !exported.ecode_dir) {
        return {
          success: false,
          ready_for_edit: false,
          workflow_id: workflowId,
          source_path: sourcePath,
          ecode_dir: exported.ecode_dir,
          logs,
          parse,
          baseline: null,
          recommended_reads: [],
          next_instruction: `Export failed. Fix e2txt/toolchain first.\n${trimOutput(exported.stderr || exported.stdout, 1_800)}`,
        };
      }
      ecodeDir = exported.ecode_dir;
    }

    let baseline: ECodeBaselineBuildResult | null = null;
    if (input.runBaseline ?? true) {
      const baselineBuild = await stage(
        logs,
        "baseline_build",
        "Running unmodified baseline regenerate + compile",
        input.onStatus,
        () => buildECodeProjectForWorkflow({
          workflowId: `${workflowId}_baseline`,
          ecodeDir: ecodeDir!,
          modulePaths,
          staticLink,
          sourceOutputPath: null,
          exeOutputPath: null,
          sourceHint: sourcePath || ecodeDir,
          signal: input.signal,
        }),
      );
      baseline = baselineFromBuild({
        sourcePath,
        ecodeDir,
        build: baselineBuild,
        exported,
      });
    }

    // Single project scan, after baseline normalization: the pre-baseline map
    // was only ever used as a fallback for this call, so the same project was
    // read twice for nothing.
    const projectMap = await stage(
      logs,
      "summarize_ecode_project",
      "Building project map",
      input.onStatus,
      () => invokeTask<ECodeProjectMapResult>("summarize_ecode_project_for_agent", {
        ecodeDir,
        includeModules,
        maxFiles,
      }, input.signal),
    );

    // Static analysis and the focused context pack scan the same tree but are
    // independent of each other — run them concurrently.
    const [analysis, contextPack] = await Promise.all([
      stage(
        logs,
        "analyze_ecode_project",
        "Running static project analysis",
        input.onStatus,
        () => deps.analyzeProject(ecodeDir!, includeModules, maxFiles),
      ),
      stage(
        logs,
        "inspect_ecode_context",
        "Building focused context package",
        input.onStatus,
        () => deps.buildContextPack(ecodeDir!, goal, includeModules, maxFiles, 16),
      ),
    ]);

    const { snapshot, snapshotPath } = await stage(
      logs,
      "snapshot",
      "Capturing rollback snapshot",
      input.onStatus,
      () => createSnapshot({
        workflowId,
        goal,
        ecodeDir: ecodeDir!,
        sourcePath,
        projectMap,
      }),
    );

    const statePath = statePathFor(ecodeDir!, workflowId);
    const state: ClosedLoopWorkflowState = {
      workflowId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      goal,
      sourcePath,
      ecodeDir: ecodeDir!,
      snapshotPath,
      statePath,
      modulePaths,
      staticLink,
      includeModules,
      maxFiles,
      projectMap,
      analysis,
      contextPack,
      baseline,
    };
    await stage(logs, "write_workflow_state", "Writing closed-loop workflow state", input.onStatus, () =>
      writeWorkflowState(state));

    const readyForEdit = baseline ? baseline.success : true;
    const recommendedReads = recommendedReadsFrom(projectMap, analysis, contextPack);

    return {
      success: readyForEdit,
      ready_for_edit: readyForEdit,
      workflow_id: workflowId,
      source_path: sourcePath,
      ecode_dir: ecodeDir,
      snapshot_path: snapshotPath,
      workflow_state_path: statePath,
      logs,
      parse,
      project_map: projectMap,
      analysis,
      context_pack: contextPack,
      baseline,
      recommended_reads: recommendedReads,
      next_instruction: makeStartInstruction({
        ready: readyForEdit,
        snapshotComplete: snapshot.complete,
        recommendedReads,
        baseline,
      }),
    };
  } catch (err) {
    return {
      success: false,
      ready_for_edit: false,
      workflow_id: workflowId,
      source_path: sourcePath,
      ecode_dir: ecodeDir,
      logs,
      parse,
      baseline: null,
      recommended_reads: [],
      next_instruction: `Closed-loop start failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function finishProjectClosedLoopWorkflow(
  input: ClosedLoopFinishInput,
): Promise<ClosedLoopFinishResult> {
  const stage = workflowStages(input.signal);
  const logs: ClosedLoopStageLog[] = [];
  const state = await maybeReadWorkflowState(input);
  const workflowId = input.workflowId?.trim() || state?.workflowId || makeWorkflowId();
  const ecodeDir = input.ecodeDir?.trim() || state?.ecodeDir;
  if (!ecodeDir) throw new Error("Provide ecodeDir or workflowStatePath.");
  const snapshotPath =
    input.snapshotPath?.trim()
    || state?.snapshotPath
    || (input.workflowId ? snapshotPathFor(ecodeDir, workflowId) : null);
  if (!snapshotPath) throw new Error("Provide snapshotPath or workflowId + ecodeDir.");
  const modulePaths = uniqueStrings([...(state?.modulePaths ?? []), ...(input.modulePaths ?? [])]);
  const staticLink = input.staticLink ?? state?.staticLink ?? true;

  const { changedFiles, currentContentByPath } = await stage(
    logs,
    "diff_from_snapshot",
    "Computing source diff against snapshot",
    input.onStatus,
    () => computeChangedFiles(snapshotPath),
  );

  // EL pre-flight: reject obvious control-structure pairing errors before the
  // expensive regenerate + ecl compile. Only hard errors gate; warnings pass.
  const preflightFindings = preflightChangedFiles(changedFiles, currentContentByPath);
  stage(logs, "el_preflight", "Validating EL control-structure pairing", input.onStatus, async () => ({
    changed: changedFiles.length,
    findings: preflightFindings.length,
  })).catch(() => {});
  if (preflightFindings.length > 0) {
    const repairInstruction = makePreflightRepairInstruction(preflightFindings);
    const reportPath = buildReportPathFor(ecodeDir, workflowId);
    await writeTextFile(
      reportPath,
      JSON.stringify({ workflowId, ecodeDir, snapshotPath, changedFiles, preflightFindings, repairInstruction }, null, 2),
      "utf-8",
    ).catch(() => {});
    return {
      success: false,
      workflow_id: workflowId,
      ecode_dir: ecodeDir,
      snapshot_path: snapshotPath,
      workflow_state_path: state?.statePath ?? statePathFor(ecodeDir, workflowId),
      build_report_path: reportPath,
      stage: "preflight",
      source_path: state?.sourcePath ?? null,
      output_path: null,
      logs,
      build: null,
      changed_files: changedFiles,
      preflight_findings: preflightFindings,
      repair_instruction: repairInstruction,
      next_instruction:
        "EL 预检发现控制结构配对错误，已跳过回编/编译。请按 repair_instruction 修复对应 .e.txt 的配对问题后再次调用 finish_project_closed_loop。",
    };
  }

  const build = await stage(
    logs,
    "build_ecode_project",
    "Regenerating .e and compiling executable",
    input.onStatus,
    () => buildECodeProjectForWorkflow({
      workflowId,
      ecodeDir,
      modulePaths,
      staticLink,
      sourceOutputPath: input.sourceOutputPath ?? null,
      exeOutputPath: input.exeOutputPath ?? null,
      sourceHint: state?.sourcePath || ecodeDir,
      signal: input.signal,
    }),
  );

  const reportPath = buildReportPathFor(ecodeDir, workflowId);
  const repairInstruction = makeRepairInstruction(build, changedFiles);
  const resultWithoutLogs = {
    workflowId,
    ecodeDir,
    snapshotPath,
    changedFiles,
    build,
    repairInstruction,
  };
  await stage(logs, "write_build_report", "Writing build report", input.onStatus, () =>
    writeTextFile(reportPath, JSON.stringify(resultWithoutLogs, null, 2), "utf-8"));

  if (state) {
    await writeWorkflowState({
      ...state,
      updatedAt: Date.now(),
      buildReportPath: reportPath,
    });
  }

  return {
    success: build.success,
    workflow_id: workflowId,
    ecode_dir: ecodeDir,
    snapshot_path: snapshotPath,
    workflow_state_path: state?.statePath ?? statePathFor(ecodeDir, workflowId),
    build_report_path: reportPath,
    stage: build.stage,
    source_path: build.source_path,
    output_path: build.output_path,
    logs,
    build,
    changed_files: changedFiles,
    repair_instruction: repairInstruction,
    next_instruction: build.success
      ? "Closed-loop build passed. Return final answer with changed-file summary, .e path, .exe path, report path, and rollback snapshot path."
      : "Closed-loop build failed. Read repair_instruction/stderr, patch source, and call finish_project_closed_loop again. If the change is wrong, call restore_project_snapshot.",
  };
}

export async function restoreClosedLoopSnapshot(
  input: ClosedLoopRestoreInput,
): Promise<ClosedLoopRestoreResult> {
  const stage = workflowStages(input.signal);
  const logs: ClosedLoopStageLog[] = [];
  const state = await maybeReadWorkflowState(input);
  const workflowId = input.workflowId?.trim() || state?.workflowId || null;
  const ecodeDirFromInput = input.ecodeDir?.trim() || state?.ecodeDir || null;
  const snapshotPath =
    input.snapshotPath?.trim()
    || state?.snapshotPath
    || (ecodeDirFromInput && workflowId ? snapshotPathFor(ecodeDirFromInput, workflowId) : null);
  if (!snapshotPath) throw new Error("Provide snapshotPath or workflowId + ecodeDir.");

  const snapshot = await stage(
    logs,
    "read_snapshot",
    "Reading rollback snapshot",
    input.onStatus,
    () => readSnapshot(snapshotPath),
  );

  const restoredFiles: string[] = [];
  await stage(logs, "restore_files", "Restoring source files from snapshot", input.onStatus, async () => {
    for (const file of snapshot.files) {
      throwIfAborted(input.signal);
      await writeTextFile(file.path, file.content, encodingForWrite(file.encoding));
      restoredFiles.push(file.path);
    }
    return { restored: restoredFiles.length };
  });

  return {
    success: true,
    workflow_id: workflowId || snapshot.workflowId,
    snapshot_path: snapshotPath,
    ecode_dir: snapshot.ecodeDir,
    restored_count: restoredFiles.length,
    restored_files: restoredFiles,
    logs,
  };
}

function workflowStages(signal?: AbortSignal) {
  return async function<T>(...args: Parameters<typeof runStage<T>>): Promise<T> {
    throwIfAborted(signal);
    const result = await runStage(...args);
    throwIfAborted(signal);
    return result;
  };
}
