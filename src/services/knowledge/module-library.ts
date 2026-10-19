import { nanoid } from "nanoid";
import { moduleWorkerRequest } from "./module-worker-client";
export { parseRawModuleApis } from "./module-parser";
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
  phase?: "copying" | "native_parse" | "structure" | "model_loading" | "embedding";
  phaseDone?: number;
  phaseTotal?: number;
  vectorError?: string | null;
  publicApiCount?: number;
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
export interface ModuleDeclaration {
  kind: string;
  name: string;
  signature: string;
  line: number;
}

export interface StoredModuleIndex {
  moduleId: string;
  parsedTextHash: string;
  apis: UserModuleApi[];
  assemblies: UserModuleAssembly[];
  declarations?: ModuleDeclaration[];
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

  const now = Date.now();
  const entry: UserModuleEntry = {
    id,
    name: friendlyName,
    sourcePath: input.sourcePath,
    storedPath: "",
    fileBytes: input.fileBytes,
    status: "pending",
    phase: "copying",
    lastError: null,
    apiCount: 0,
    classCount: 0,
    indexedCount: 0,
    hasVectorIndex: false,
    createdAt: now,
    updatedAt: now,
  };
  useSettingsStore.getState().addUserModule(entry);

  try {
    const copied = await invoke<{ stored_path: string; bytes: number }>("copy_user_module_to_local", { sourcePath: input.sourcePath, moduleId: id });
    useSettingsStore.getState().updateUserModule(id, { storedPath: copied.stored_path, fileBytes: copied.bytes, status: "parsing", phase: "native_parse" });
    void runUploadPipeline(id, copied.stored_path);
  } catch (error) {
    useSettingsStore.getState().updateUserModule(id, { status: "error", lastError: String(error) });
    throw error;
  }
  return id;
}

export async function rebuildUserModule(moduleId: string): Promise<void> {
  const entry = useSettingsStore.getState().userModules.find((m) => m.id === moduleId);
  if (!entry) return;
  useSettingsStore.getState().updateUserModule(moduleId, {
    status: "parsing",
    phase: "native_parse",
    lastError: null,
    updatedAt: Date.now(),
  });
  await runUploadPipeline(moduleId, entry.storedPath);
}

export async function removeUserModule(moduleId: string): Promise<void> {
  activePipelines.delete(moduleId);
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

const activePipelines = new Map<string, symbol>();
async function runUploadPipeline(moduleId: string, storedPath: string): Promise<void> {
  const run = Symbol(moduleId);
  activePipelines.set(moduleId, run);
  const current = () => activePipelines.get(moduleId) === run && useSettingsStore.getState().userModules.some(m => m.id === moduleId);
  const updateEntry = (patch: Partial<UserModuleEntry>) => {
    if (!current()) return;
    useSettingsStore.getState().updateUserModule(moduleId, {
      ...patch,
      updatedAt: Date.now(),
    });
  };

  try {
    const parseResult = await invoke<ParseResult>("parse_efile", { filePath: storedPath });
    if (!current()) return;
    if (!parseResult.success) {
      throw new Error(parseResult.error ?? "parse_efile 返回失败");
    }
    const parsedText = parseResult.output ?? "";
    updateEntry({ phase: "structure", phaseDone: 0, phaseTotal: 0 });
    const { apis, assemblies, declarations } = await moduleWorkerRequest("parse", parsedText, (done, total) => updateEntry({ phaseDone: done, phaseTotal: total }));
    if (!current()) return;

    const stored: StoredModuleIndex = {
      moduleId,
      parsedTextHash: fingerprint(parsedText),
      apis,
      assemblies,
      declarations,
      vectorIndex: null,
    };
    await saveStoredIndex(stored);
    if (!current()) return;

    // Lexical-only ready state — agent can already search via search_user_modules
    // before the vector index finishes building.
    updateEntry({
      status: "indexing",
      apiCount: apis.length,
      publicApiCount: apis.filter(api => api.isPublic).length,
      phase: "model_loading",
      vectorError: null,
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
      let lastReportedAt = 0;
      vectorIndex = await moduleWorkerRequest("vector", apis, (done, total) => {
        const now = Date.now();
        if (done === total || now - lastReportedAt >= 120) {
          lastReportedAt = now;
          updateEntry({ phase: done > 0 ? "embedding" : "model_loading", indexedCount: done });
        }
      });
    } catch (vectorError) {
      updateEntry({ vectorError: vectorError instanceof Error ? vectorError.message : String(vectorError) });
    }

    if (vectorIndex) {
      if (!current()) return;
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
      indexedCount: vectorIndex ? apis.length : 0,
      phase: undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateEntry({ status: "error", lastError: message });
  } finally {
    if (activePipelines.get(moduleId) === run) activePipelines.delete(moduleId);
  }
}
