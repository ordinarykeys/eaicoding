import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { nanoid } from "nanoid";
import type { AgentTrace, ChatMessage, ChatSession } from "@/types/llm";
import { idbStorage } from "@/lib/idb-storage";
import { deriveSessionTitle, shouldReplaceSessionTitle } from "@/lib/session-title";

interface ChatState {
  sessions: ChatSession[];
  activeSessionId: string | null;

  createSession: (title?: string) => string;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  setActiveSession: (id: string) => void;
  clearAll: () => void;

  appendMessage: (sessionId: string, msg: Omit<ChatMessage, "id" | "timestamp">) => string;
  updateMessage: (sessionId: string, messageId: string, patch: Partial<ChatMessage>) => void;
  deleteMessage: (sessionId: string, messageId: string) => void;
  /** Attach / overwrite the agent trace stored on a particular message. */
  setAgentTrace: (sessionId: string, messageId: string, trace: AgentTrace) => void;
}

export const useChatStore = create<ChatState>()(
  persist(
    (set) => ({
      sessions: [],
      activeSessionId: null,

      createSession: (title = "新会话") => {
        const id = nanoid();
        const now = Date.now();
        const session: ChatSession = {
          id,
          title,
          messages: [],
          createdAt: now,
          updatedAt: now,
        };
        set((s) => ({
          sessions: [
            session,
            ...s.sessions.filter((item) => item.messages.length > 0),
          ],
          activeSessionId: id,
        }));
        return id;
      },

      deleteSession: (id) =>
        set((s) => {
          const sessions = s.sessions.filter((x) => x.id !== id);
          const activeSessionId =
            s.activeSessionId === id ? sessions[0]?.id ?? null : s.activeSessionId;
          return { sessions, activeSessionId };
        }),

      renameSession: (id, title) =>
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.id === id ? { ...x, title, updatedAt: Date.now() } : x,
          ),
        })),

      setActiveSession: (id) => set({ activeSessionId: id }),

      clearAll: () => set({ sessions: [], activeSessionId: null }),

      appendMessage: (sessionId, msg) => {
        const id = nanoid();
        const fullMsg: ChatMessage = {
          ...msg,
          id,
          timestamp: Date.now(),
        };
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId
              ? {
                  ...sess,
                  messages: [...sess.messages, fullMsg],
                  updatedAt: Date.now(),
                  title:
                    sess.messages.length === 0 &&
                    msg.role === "user" &&
                    shouldReplaceSessionTitle(sess.title)
                      ? deriveSessionTitle(msg.content, sess.title)
                      : sess.title,
                }
              : sess,
          ),
        }));
        return id;
      },

      updateMessage: (sessionId, messageId, patch) =>
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId
              ? {
                  ...sess,
                  messages: sess.messages.map((m) =>
                    m.id === messageId ? { ...m, ...patch } : m,
                  ),
                  updatedAt: Date.now(),
                }
              : sess,
          ),
        })),

      deleteMessage: (sessionId, messageId) =>
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId
              ? { ...sess, messages: sess.messages.filter((m) => m.id !== messageId) }
              : sess,
          ),
        })),

      setAgentTrace: (sessionId, messageId, trace) =>
        set((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === sessionId
              ? {
                  ...sess,
                  messages: sess.messages.map((m) =>
                    m.id === messageId ? { ...m, agentTrace: trace } : m,
                  ),
                  updatedAt: Date.now(),
                }
              : sess,
          ),
        })),
    }),
    {
      name: "eaicoding-chat",
      version: 2,
      storage: createJSONStorage(() => idbStorage),
      partialize: (s) => ({
        sessions: s.sessions,
        activeSessionId: s.activeSessionId,
      }),
    },
  ),
);

export function useActiveSession(): ChatSession | null {
  return useChatStore((s) => {
    if (!s.activeSessionId) return null;
    return s.sessions.find((x) => x.id === s.activeSessionId) ?? null;
  });
}
