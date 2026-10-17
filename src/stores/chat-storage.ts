import { createJSONStorage, type StateStorage } from "zustand/middleware";
import type { ChatSession } from "@/types/llm";
import { idbStorage } from "@/lib/idb-storage";

const LEGACY_KEY = "eaicoding-chat";
const INDEX_KEY = "eaicoding-chat-index";
const SESSION_PREFIX = "eaicoding-chat-session:";

interface PersistedChatState {
  state: {
    sessions: ChatSession[];
    activeSessionId: string | null;
  };
  version?: number;
}

interface ChatIndex {
  activeSessionId: string | null;
  sessionIds: string[];
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readSession(id: string): Promise<ChatSession | null> {
  const session = parseJson<ChatSession>(await idbStorage.getItem(`${SESSION_PREFIX}${id}`));
  return session ? restoreInterruptedSession(session) : null;
}

// A saved streaming snapshot cannot resume its native task after a restart.
// Keep the source/results, but settle its transient spinner and pending tools.
function restoreInterruptedSession(session: ChatSession): ChatSession {
  return { ...session, messages: session.messages.map(message => {
    if (!message.isStreaming) return { ...message, activeToolCallId: undefined };
    const note = "上次执行已中断，可发送消息继续。";
    return { ...message, isStreaming: false, activeToolCallId: undefined,
      content: message.content ? `${message.content}\n\n${note}` : note,
      agentTrace: message.agentTrace ? { ...message.agentTrace, outcome: "aborted" as const, finalAnswer: message.content || note } : undefined,
    };
  }) };
}

// Last serialized form we wrote (or loaded) per session id. Persist hands us
// the whole state on every mutation; without this cache each flush rewrote
// every session — including untouched historical ones — to idb.
const lastWrittenBySessionId = new Map<string, string>();

async function writeSplitState(value: string): Promise<void> {
  const parsed = parseJson<PersistedChatState>(value);
  const sessions = parsed?.state?.sessions ?? [];
  const activeSessionId = parsed?.state?.activeSessionId ?? null;
  const previousIndex = parseJson<ChatIndex>(await idbStorage.getItem(INDEX_KEY));
  const nextIdSet = new Set(sessions.map((session) => session.id));
  const ids: string[] = [];

  for (const session of sessions) {
    ids.push(session.id);
    const serialized = JSON.stringify(session);
    if (lastWrittenBySessionId.get(session.id) === serialized) continue;
    await idbStorage.setItem(`${SESSION_PREFIX}${session.id}`, serialized);
    lastWrittenBySessionId.set(session.id, serialized);
  }

  for (const staleId of previousIndex?.sessionIds ?? []) {
    if (!nextIdSet.has(staleId)) {
      await idbStorage.removeItem(`${SESSION_PREFIX}${staleId}`);
      lastWrittenBySessionId.delete(staleId);
    }
  }

  const index: ChatIndex = { activeSessionId, sessionIds: ids };
  await idbStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

// ---------------------------------------------------------------------------
// Write throttling.
//
// The persist middleware calls setItem on every store mutation. During
// streaming, updateMessage fires ~60x/sec, and each call would otherwise
// rewrite *every* session via writeSplitState. We coalesce those writes:
// while throttling is enabled, only the latest value is kept and flushed at
// most once per THROTTLE_MS. All non-streaming operations (create / delete /
// rename / switch) run with throttling disabled, so their writes stay
// immediate and durable exactly as before.
// ---------------------------------------------------------------------------

const THROTTLE_MS = 500;

let throttlingEnabled = false;
let pendingValue: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
// Serialize writes so overlapping writeSplitState calls never interleave
// their INDEX_KEY read/write and corrupt the session index.
let writeChain: Promise<void> = Promise.resolve();

function enqueueWrite(value: string): Promise<void> {
  writeChain = writeChain
    .catch(() => {})
    .then(() => writeSplitState(value));
  return writeChain;
}

/** Force any pending throttled write to disk immediately. */
export function flushChatStorage(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingValue !== null) {
    const value = pendingValue;
    pendingValue = null;
    return enqueueWrite(value);
  }
  return writeChain;
}

/**
 * Enable/disable write coalescing. Disabling flushes any pending write so the
 * latest state (e.g. the final streamed answer) is guaranteed on disk.
 */
export function setChatPersistThrottling(enabled: boolean): void {
  throttlingEnabled = enabled;
  if (!enabled) void flushChatStorage();
}

async function readSplitState(): Promise<string | null> {
  const index = parseJson<ChatIndex>(await idbStorage.getItem(INDEX_KEY));
  if (!index) return null;

  const sessions: ChatSession[] = [];
  for (const id of index.sessionIds ?? []) {
    const session = await readSession(id);
    if (session) {
      sessions.push(session);
      // Warm the dedup cache so the first post-load flush only writes
      // sessions that actually changed.
      lastWrittenBySessionId.set(id, JSON.stringify(session));
    }
  }

  return JSON.stringify({
    state: {
      sessions,
      activeSessionId: index.activeSessionId,
    },
    version: 3,
  });
}

export const splitChatStorage: StateStorage = {
  getItem: async (name) => {
    if (name !== LEGACY_KEY) return idbStorage.getItem(name);

    const split = await readSplitState();
    if (split) return split;

    const legacy = await idbStorage.getItem(LEGACY_KEY);
    if (legacy) {
      await writeSplitState(legacy);
      const parsed = parseJson<PersistedChatState>(legacy);
      if (parsed?.state?.sessions) parsed.state.sessions = parsed.state.sessions.map(restoreInterruptedSession);
      return parsed ? JSON.stringify(parsed) : legacy;
    }
    return null;
  },

  setItem: async (name, value) => {
    if (name !== LEGACY_KEY) {
      await idbStorage.setItem(name, value);
      return;
    }
    if (!throttlingEnabled) {
      // Non-streaming path: write immediately, exactly as before.
      await enqueueWrite(value);
      return;
    }
    // Streaming path: keep only the newest value; flush at most every
    // THROTTLE_MS. setChatPersistThrottling(false) flushes the tail.
    pendingValue = value;
    if (flushTimer === null) {
      flushTimer = setTimeout(() => {
        flushTimer = null;
        if (pendingValue !== null) {
          const next = pendingValue;
          pendingValue = null;
          void enqueueWrite(next);
        }
      }, THROTTLE_MS);
    }
  },

  removeItem: async (name) => {
    if (name !== LEGACY_KEY) {
      await idbStorage.removeItem(name);
      return;
    }
    // Drop any pending throttled write so it cannot land after the removal,
    // then run the clear on the same write chain to avoid interleaving.
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    pendingValue = null;
    writeChain = writeChain
      .catch(() => {})
      .then(async () => {
        const index = parseJson<ChatIndex>(await idbStorage.getItem(INDEX_KEY));
        for (const id of index?.sessionIds ?? []) {
          await idbStorage.removeItem(`${SESSION_PREFIX}${id}`);
        }
        lastWrittenBySessionId.clear();
        await idbStorage.removeItem(INDEX_KEY);
        await idbStorage.removeItem(LEGACY_KEY);
      });
    await writeChain;
  },
};

export const splitChatJsonStorage = createJSONStorage(() => splitChatStorage);
