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
  return parseJson<ChatSession>(await idbStorage.getItem(`${SESSION_PREFIX}${id}`));
}

async function writeSplitState(value: string): Promise<void> {
  const parsed = parseJson<PersistedChatState>(value);
  const sessions = parsed?.state?.sessions ?? [];
  const activeSessionId = parsed?.state?.activeSessionId ?? null;
  const previousIndex = parseJson<ChatIndex>(await idbStorage.getItem(INDEX_KEY));
  const nextIdSet = new Set(sessions.map((session) => session.id));
  const ids: string[] = [];

  for (const session of sessions) {
    ids.push(session.id);
    await idbStorage.setItem(`${SESSION_PREFIX}${session.id}`, JSON.stringify(session));
  }

  for (const staleId of previousIndex?.sessionIds ?? []) {
    if (!nextIdSet.has(staleId)) {
      await idbStorage.removeItem(`${SESSION_PREFIX}${staleId}`);
    }
  }

  const index: ChatIndex = { activeSessionId, sessionIds: ids };
  await idbStorage.setItem(INDEX_KEY, JSON.stringify(index));
}

async function readSplitState(): Promise<string | null> {
  const index = parseJson<ChatIndex>(await idbStorage.getItem(INDEX_KEY));
  if (!index) return null;

  const sessions: ChatSession[] = [];
  for (const id of index.sessionIds ?? []) {
    const session = await readSession(id);
    if (session) sessions.push(session);
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
      return legacy;
    }
    return null;
  },

  setItem: async (name, value) => {
    if (name !== LEGACY_KEY) {
      await idbStorage.setItem(name, value);
      return;
    }
    await writeSplitState(value);
  },

  removeItem: async (name) => {
    if (name !== LEGACY_KEY) {
      await idbStorage.removeItem(name);
      return;
    }
    const index = parseJson<ChatIndex>(await idbStorage.getItem(INDEX_KEY));
    for (const id of index?.sessionIds ?? []) {
      await idbStorage.removeItem(`${SESSION_PREFIX}${id}`);
    }
    await idbStorage.removeItem(INDEX_KEY);
    await idbStorage.removeItem(LEGACY_KEY);
  },
};

export const splitChatJsonStorage = createJSONStorage(() => splitChatStorage);
