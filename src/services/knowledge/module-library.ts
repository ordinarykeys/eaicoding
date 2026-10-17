import { nanoid } from "nanoid";
import { invoke } from "@tauri-apps/api/core";
import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import { useSettingsStore } from "@/stores/settings";

// ---------------------------------------------------------------------------
// Types — used by settings store (metadata) + IndexedDB (full payload).
// Kept here so the module-library is the single source of truth for the shape.
// ---------------------------------------------------------------------------

export interface UserModuleParam {
  name: string;
  type: string;
  array: boolean;
  byRef: boolean;
  optional: boolean;
  description: string;
}

export interface UserModuleApi {
  /** Stable id within the module. Used as vector row key. */
  id: string;
  kind: "subprogram" | "dll" | "datatype";
  name: string;
  className: string;
  returnType: string;
  signature: string;
  description: string;
  line: number;
  params: UserModuleParam[];
  isPublic: boolean;
}

export interface UserModuleAssembly {
  name: string;
  line: number;
  description: string;
  publicMethodCount: number;
}

/** Persisted in `useSettingsStore.userModules`. Small, safe in main settings JSON. */
export interface UserModuleEntry {
  id: string;
  name: string;
  /** User's original .ec path on disk (display only). May become stale if user moves the file. */
  sourcePath: string | null;
  /** Copy under app_local_data/user-modules/<id>.ec — what we actually parse. */
  storedPath: string;
  fileBytes: number;
  status: "pending" | "parsing" | "indexing" | "ready" | "error";
  lastError: string | null;
  apiCount: number;
  classCount: number;
  /** APIs already embedded into the vector index (live counter while status="indexing"). */
  indexedCount: number;
  hasVectorIndex: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Persisted to IndexedDB under `eaicoding-user-module:<id>`.
 *  Kept out of the main settings JSON because vectors are large. */
export interface StoredModuleIndex {
  moduleId: string;
  parsedTextHash: string;
  apis: UserModuleApi[];
  assemblies: UserModuleAssembly[];
  /** Built lazily by Phase-2 module-vector-index.ts; null in Phase 1. */
  vectorIndex: {
    model: string;
    dimension: number;
    encoding: "int8";
    scale: number;
    data: string;
    apiOrder: string[];
    builtAt: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Mirror of Rust ParseResult struct (src-tauri/src/ecode_parser.rs:370)
// ---------------------------------------------------------------------------

interface ParseResult {
  success: boolean;
  output: string;
  summary: unknown;
  error: string | null;
}

// ---------------------------------------------------------------------------
// IndexedDB helpers
// ---------------------------------------------------------------------------

const MODULE_INDEX_KEY_PREFIX = "eaicoding-user-module:";

export function idbModuleKey(moduleId: string): string {
  return `${MODULE_INDEX_KEY_PREFIX}${moduleId}`;
}

export async function loadStoredIndex(moduleId: string): Promise<StoredModuleIndex | undefined> {
  return idbGet<StoredModuleIndex>(idbModuleKey(moduleId));
}

export async function saveStoredIndex(index: StoredModuleIndex): Promise<void> {
  await idbSet(idbModuleKey(index.moduleId), index);
}

export async function removeStoredIndex(moduleId: string): Promise<void> {
  await idbDel(idbModuleKey(moduleId));
}

// ---------------------------------------------------------------------------
// Minimal structural parser for ".e/.ec" parse_efile output.
// Reads `.程序集 / .子程序 / .DLL命令 / .参数` lines, no scoring.
// (Scoring/ranking lives in Phase 2 module-search.ts.)
// ---------------------------------------------------------------------------

function trimCell(value: string | undefined): string {
  return (value ?? "").trim();
}

function splitFields(line: string, prefix: string): string[] {
  const body = line.slice(prefix.length).trim();
  return body.split(",").map(trimCell);
}

function buildSignature(api: UserModuleApi): string {
  const params = api.params
    .map((param) => {
      const annotations: string[] = [];
      if (param.array) annotations.push("数组");
      if (param.byRef) annotations.push("传址");
      if (param.optional) annotations.push("可空");
      const tail = annotations.length > 0 ? ` (${annotations.join("/")})` : "";
      return `${param.name}: ${param.type || "?"}${tail}`;
    })
    .join("，");
  const ret = api.returnType || (api.kind === "subprogram" ? "无返回值" : "");
  return `${ret} ${api.name}（${params}）`.trim();
}

export function parseRawModuleApis(parsedText: string): {
  apis: UserModuleApi[];
  assemblies: UserModuleAssembly[];
} {
  const lines = parsedText.replace(/\r\n/g, "\n").split("\n");
  const apis: UserModuleApi[] = [];
  const assemblies = new Map<string, UserModuleAssembly>();
  let currentAssembly = "";
  let currentAssemblyDescription = "";
  let current: UserModuleApi | null = null;

  const finishCurrent = () => {
    if (!current) return;
    current.signature = buildSignature(current);
    apis.push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (!line) continue;

    if (/^\.程序集(?:\s|$)/.test(line)) {
      finishCurrent();
      const fields = splitFields(line, ".程序集");
      currentAssembly = fields[0] || currentAssembly;
      currentAssemblyDescription = fields.slice(3).filter(Boolean).join("，");
      if (currentAssembly && !assemblies.has(currentAssembly)) {
        assemblies.set(currentAssembly, {
          name: currentAssembly,
          line: index + 1,
          description: currentAssemblyDescription,
          publicMethodCount: 0,
        });
      }
      continue;
    }

    if (line.startsWith(".子程序")) {
      finishCurrent();
      const fields = splitFields(line, ".子程序");
      const attr = fields[2] || "";
      current = {
        id: nanoid(8),
        kind: "subprogram",
        name: fields[0] || "",
        className: currentAssembly,
        returnType: fields[1] || "",
        description: fields.slice(3).filter(Boolean).join("，"),
        line: index + 1,
        params: [],
        signature: "",
        isPublic: attr.includes("公开"),
      };
      continue;
    }

    if (line.startsWith(".DLL命令")) {
      finishCurrent();
      const fields = splitFields(line, ".DLL命令");
      current = {
        id: nanoid(8),
        kind: "dll",
        name: fields[0] || "",
        className: currentAssembly,
        returnType: fields[1] || "",
        description: fields.slice(5).filter(Boolean).join("，"),
        line: index + 1,
        params: [],
        signature: "",
        isPublic: false,
      };
      continue;
    }

    if (line.startsWith(".参数") && current) {
      const fields = splitFields(line, ".参数");
      const attr = fields[2] || "";
      current.params.push({
        name: fields[0] || `参数${current.params.length + 1}`,
        type: fields[1] || "",
        array: attr.includes("数组"),
        byRef: attr.includes("参考") || attr.includes("传址"),
        optional: attr.includes("可空"),
        description: fields.slice(3).filter(Boolean).join("，"),
      });
    }
  }
  finishCurrent();

  for (const api of apis) {
    if (!api.isPublic || !api.className) continue;
    const info = assemblies.get(api.className);
    if (info) info.publicMethodCount += 1;
  }

  return {
    apis,
    assemblies: Array.from(assemblies.values()).sort((a, b) => a.line - b.line),
  };
}

// ---------------------------------------------------------------------------
// Cache fingerprint — non-cryptographic hash, used to detect stale parses.
// ---------------------------------------------------------------------------

function fingerprint(text: string): string {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

// ---------------------------------------------------------------------------
// Filename helpers
// ---------------------------------------------------------------------------

function fileBaseName(pathOrName: string): string {
  const slashIndex = Math.max(pathOrName.lastIndexOf("/"), pathOrName.lastIndexOf("\\"));
  const tail = slashIndex >= 0 ? pathOrName.slice(slashIndex + 1) : pathOrName;
  const dotIndex = tail.lastIndexOf(".");
  return dotIndex > 0 ? tail.slice(0, dotIndex) : tail;
}

// ---------------------------------------------------------------------------
// Public API — orchestration of the upload / rebuild / remove pipeline.
// Phase 1 stops at structural parsing; Phase 2 will additionally build the
// vector index and flip hasVectorIndex / status: indexing → ready accordingly.
// ---------------------------------------------------------------------------

export interface AddUserModuleInput {
  /** Original on-disk path the user picked. */
  sourcePath: string;
  /** Raw byte length on disk; surfaced as fileBytes for display. */
  fileBytes: number;
  /** Filename or path (only the tail is used to derive the friendly name). */
  fileName?: string;
  /** Optional explicit name override; otherwise derived from fileName/sourcePath. */
  name?: string;
}

export async function addUserModule(input: AddUserModuleInput): Promise<string> {
  const id = nanoid();
  const friendlyName = (
    input.name?.trim() ||
    fileBaseName(input.fileName ?? input.sourcePath) ||
    "未命名模块"
  );

  const storedPath = await invoke<string>("copy_user_module_to_local", {
    sourcePath: input.sourcePath,
    moduleId: id,
  });

  const now = Date.now();
  const entry: UserModuleEntry = {
    id,
    name: friendlyName,
    sourcePath: input.sourcePath,
    storedPath,
    fileBytes: input.fileBytes,
    status: "parsing",
    lastError: null,
    apiCount: 0,
    classCount: 0,
    indexedCount: 0,
    hasVectorIndex: false,
    createdAt: now,
    updatedAt: now,
  };
  useSettingsStore.getState().addUserModule(entry);

  void runUploadPipeline(id, storedPath);
  return id;
}

export async function rebuildUserModule(moduleId: string): Promise<void> {
  const entry = useSettingsStore.getState().userModules.find((m) => m.id === moduleId);
  if (!entry) return;
  useSettingsStore.getState().updateUserModule(moduleId, {
    status: "parsing",
    lastError: null,
    updatedAt: Date.now(),
  });
  await runUploadPipeline(moduleId, entry.storedPath);
}

export async function removeUserModule(moduleId: string): Promise<void> {
  await removeStoredIndex(moduleId);
  try {
    const { evictModuleCache } = await import("@/services/knowledge/module-search");
    evictModuleCache(moduleId);
  } catch {
    // search module not yet loaded — nothing to evict
  }
  useSettingsStore.getState().removeUserModule(moduleId);
}

export function renameUserModule(moduleId: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  useSettingsStore.getState().updateUserModule(moduleId, {
    name: trimmed,
    updatedAt: Date.now(),
  });
}

async function runUploadPipeline(moduleId: string, storedPath: string): Promise<void> {
  const updateEntry = (patch: Partial<UserModuleEntry>) => {
    useSettingsStore.getState().updateUserModule(moduleId, {
      ...patch,
      updatedAt: Date.now(),
    });
  };

  try {
    const parseResult = await invoke<ParseResult>("parse_efile", { filePath: storedPath });
    if (!parseResult.success) {
      throw new Error(parseResult.error ?? "parse_efile 返回失败");
    }
    const parsedText = parseResult.output ?? "";
    const { apis, assemblies } = parseRawModuleApis(parsedText);

    const stored: StoredModuleIndex = {
      moduleId,
      parsedTextHash: fingerprint(parsedText),
      apis,
      assemblies,
      vectorIndex: null,
    };
    await saveStoredIndex(stored);

    // Lexical-only ready state — agent can already search via search_user_modules
    // before the vector index finishes building.
    updateEntry({
      status: "indexing",
      apiCount: apis.length,
      classCount: assemblies.length,
      indexedCount: 0,
      hasVectorIndex: false,
      lastError: null,
    });

    // Drop any cached copy from in-flight searches so the next call sees fresh data.
    try {
      const { evictModuleCache } = await import("@/services/knowledge/module-search");
      evictModuleCache(moduleId);
    } catch {
      // module-search may not be loaded yet; cache will be populated lazily.
    }

    // Vector index — slow (model load + per-API embedding) but bounded.
    // Build in this same async task so the UI's "indexing" status reflects reality;
    // failures here downgrade to ready-without-vectors instead of error.
    let vectorIndex: StoredModuleIndex["vectorIndex"] = null;
    try {
      const { buildModuleVectorIndex } = await import("@/services/knowledge/module-vector-index");
      // Throttle progress writes to the store: ~one update per ~64 APIs is enough
      // for a smooth bar without spamming zustand persistence on a 1k-API module.
      let lastReportedDone = 0;
      vectorIndex = await buildModuleVectorIndex(apis, (done, total) => {
        if (done === total || done - lastReportedDone >= 64) {
          lastReportedDone = done;
          updateEntry({ indexedCount: done });
        }
      });
    } catch (vectorError) {
      console.warn(`vector index build failed for module ${moduleId}:`, vectorError);
    }

    if (vectorIndex) {
      const updated: StoredModuleIndex = { ...stored, vectorIndex };
      await saveStoredIndex(updated);
      try {
        const { evictModuleCache } = await import("@/services/knowledge/module-search");
        evictModuleCache(moduleId);
      } catch {
        // ignore — search module not yet loaded
      }
    }

    updateEntry({
      status: "ready",
      hasVectorIndex: Boolean(vectorIndex),
      indexedCount: apis.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateEntry({ status: "error", lastError: message });
  }
}
