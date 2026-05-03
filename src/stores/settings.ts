import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import type { LLMProvider, LLMConfig } from "@/types/llm";
import { idbStorage } from "@/lib/idb-storage";
import type { UserKnowledgeDocument } from "@/services/knowledge/user-knowledge";

export interface ProviderProfile {
  id: string;
  name: string;
  provider: LLMProvider;
  baseUrl: string;
  /** Encrypted API key blob (base64 of nonce+ciphertext, AES-GCM via Rust). */
  apiKeyEncrypted: string;
  model: string;
  models?: ProviderModel[];
  maxTokens: number;
  temperature: number;
}

export interface ProviderModel {
  id: string;
  ownedBy: string | null;
}

interface SettingsState {
  /** Configured provider profiles. */
  profiles: ProviderProfile[];
  /** Persisted fetched model lists by profile id. */
  modelCatalogs: Record<string, ProviderModel[]>;
  /** Currently active profile id. */
  activeProfileId: string | null;
  /** Global system prompt prefix. */
  systemPrompt: string;
  /** UI theme. */
  theme: "dark" | "light";
  /** Show floating desktop pet (Clawd crab). */
  petEnabled: boolean;
  /** Pet sound effects enabled. */
  petSoundEnabled: boolean;
  /** Persist pet position relative to the window (px from top-left). */
  petPosition: { x: number; y: number } | null;
  /** Optional user-selected 易语言 installation root, e.g. D:\e. */
  easyLanguageRoot: string;
  /** Optional directory for generated 易语言 source artifacts: .ecode/.e. */
  easyLanguageGenerateDir: string;
  /** Optional directory for compiled 易语言 executables. */
  easyLanguageCompileDir: string;
  /** User-uploaded local knowledge bases managed from Settings. */
  userKnowledgeDocuments: UserKnowledgeDocument[];

  addProfile: (
    profile: Omit<ProviderProfile, "id" | "apiKeyEncrypted"> & { apiKey: string },
  ) => Promise<string>;
  updateProfile: (
    id: string,
    patch: Partial<Omit<ProviderProfile, "id" | "apiKeyEncrypted">> & { apiKey?: string },
  ) => Promise<void>;
  removeProfile: (id: string) => void;
  setActiveProfile: (id: string) => void;
  setProfileModels: (id: string, models: ProviderModel[]) => void;
  setSystemPrompt: (prompt: string) => void;
  setTheme: (theme: "dark" | "light") => void;
  setPetEnabled: (enabled: boolean) => void;
  setPetSoundEnabled: (enabled: boolean) => void;
  setPetPosition: (pos: { x: number; y: number } | null) => void;
  setEasyLanguageRoot: (path: string) => void;
  setEasyLanguageGenerateDir: (path: string) => void;
  setEasyLanguageCompileDir: (path: string) => void;
  addUserKnowledgeDocument: (document: UserKnowledgeDocument) => void;
  updateUserKnowledgeDocument: (id: string, patch: Partial<UserKnowledgeDocument>) => void;
  removeUserKnowledgeDocument: (id: string) => void;

  /** Resolve the active profile + decrypt API key into a usable LLMConfig. */
  resolveLLMConfig: () => Promise<LLMConfig | null>;
}

const DEFAULT_SYSTEM_PROMPT = `你是 EAiCoding 的易语言开发助手，擅长把用户的自然语言需求整理成清晰、可落地的易语言实现方案。

工作原则：
- 始终使用中文回答，语气简洁、专业、直接。
- 先理解用户目标，再给出实现思路、关键步骤和必要代码。
- 当需求不完整时，优先基于常见易语言开发习惯补全合理假设；只有关键信息缺失且会影响结果时才追问。
- 输出易语言代码时使用 \`\`\`epl 代码块，并保持变量名、子程序名和注释清晰可读。
- 解释问题时先指出原因，再给出修改方式；避免只描述概念而不给可执行方案。
- 修复代码时尽量保留用户原有结构，只改动必要部分。
- 不向用户暴露内部实现细节、检测过程或技术封装，只呈现用户需要的结果和建议。

易语言代码风格：
- 优先使用清楚的中文命名。
- 注意子程序参数、返回值、判断分支、循环和错误处理。
- 涉及界面、文件、网络、数据库或多线程时，说明关键注意事项。
- 如果给出多段代码，标明每段代码应该放置的位置或用途。`;

const shouldReplaceSystemPrompt = (prompt: unknown) =>
  typeof prompt !== "string" ||
  prompt.trim().length === 0 ||
  prompt.includes("本地工具") ||
  prompt.includes("纯桌面端工作流") ||
  prompt.includes("自动闭环") ||
  prompt.includes("解析器") ||
  prompt.includes("编译链");

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      profiles: [],
      modelCatalogs: {},
      activeProfileId: null,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      theme: "light",
      petEnabled: true,
      petSoundEnabled: false,
      petPosition: null,
      easyLanguageRoot: "D:\\e",
      easyLanguageGenerateDir: "",
      easyLanguageCompileDir: "",
      userKnowledgeDocuments: [],

      addProfile: async (input) => {
        const apiKeyEncrypted = input.apiKey
          ? await invoke<string>("encrypt_secret", { plaintext: input.apiKey })
          : "";
        const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const profile: ProviderProfile = {
          id,
          name: input.name,
          provider: input.provider,
          baseUrl: input.baseUrl,
          apiKeyEncrypted,
          model: input.model,
          models: input.models,
          maxTokens: input.maxTokens,
          temperature: input.temperature,
        };
        set((s) => ({
          profiles: [...s.profiles, profile],
          modelCatalogs: input.models
            ? {
                ...s.modelCatalogs,
                [id]: input.models,
              }
            : s.modelCatalogs,
          activeProfileId: s.activeProfileId ?? id,
        }));
        return id;
      },

      updateProfile: async (id, patch) => {
        let apiKeyEncrypted: string | undefined;
        if (patch.apiKey !== undefined) {
          apiKeyEncrypted = patch.apiKey
            ? await invoke<string>("encrypt_secret", { plaintext: patch.apiKey })
            : "";
        }
        set((s) => ({
          profiles: s.profiles.map((profile) => {
            if (profile.id !== id) return profile;
            const { apiKey: _omit, ...rest } = patch as { apiKey?: string };
            return {
              ...profile,
              ...rest,
              ...(apiKeyEncrypted !== undefined ? { apiKeyEncrypted } : {}),
            };
          }),
        }));
      },

      removeProfile: (id) =>
        set((s) => {
          const profiles = s.profiles.filter((profile) => profile.id !== id);
          const { [id]: _removed, ...modelCatalogs } = s.modelCatalogs;
          const activeProfileId =
            s.activeProfileId === id ? profiles[0]?.id ?? null : s.activeProfileId;
          return { profiles, modelCatalogs, activeProfileId };
        }),

      setActiveProfile: (id) => set({ activeProfileId: id }),
      setProfileModels: (id, models) =>
        set((s) => ({
          modelCatalogs: {
            ...s.modelCatalogs,
            [id]: models,
          },
          profiles: s.profiles.map((profile) =>
            profile.id === id ? { ...profile, models } : profile,
          ),
        })),
      setSystemPrompt: (systemPrompt) => set({ systemPrompt }),
      setTheme: (theme) => {
        document.documentElement.classList.toggle("dark", theme === "dark");
        set({ theme });
      },
      setPetEnabled: (petEnabled) => set({ petEnabled }),
      setPetSoundEnabled: (petSoundEnabled) => set({ petSoundEnabled }),
      setPetPosition: (petPosition) => set({ petPosition }),
      setEasyLanguageRoot: (easyLanguageRoot) => set({ easyLanguageRoot }),
      setEasyLanguageGenerateDir: (easyLanguageGenerateDir) =>
        set({ easyLanguageGenerateDir }),
      setEasyLanguageCompileDir: (easyLanguageCompileDir) =>
        set({ easyLanguageCompileDir }),
      addUserKnowledgeDocument: (document) =>
        set((s) => ({
          userKnowledgeDocuments: [document, ...s.userKnowledgeDocuments],
        })),
      updateUserKnowledgeDocument: (id, patch) =>
        set((s) => ({
          userKnowledgeDocuments: s.userKnowledgeDocuments.map((document) =>
            document.id === id
              ? { ...document, ...patch, updatedAt: Date.now() }
              : document,
          ),
        })),
      removeUserKnowledgeDocument: (id) =>
        set((s) => ({
          userKnowledgeDocuments: s.userKnowledgeDocuments.filter((document) => document.id !== id),
        })),

      resolveLLMConfig: async () => {
        const { profiles, activeProfileId, systemPrompt } = get();
        const profile = profiles.find((item) => item.id === activeProfileId);
        if (!profile) return null;
        let apiKey = "";
        if (profile.apiKeyEncrypted) {
          try {
            apiKey = await invoke<string>("decrypt_secret", {
              encrypted: profile.apiKeyEncrypted,
            });
          } catch (error) {
            console.error("Failed to decrypt API key:", error);
          }
        }
        return {
          provider: profile.provider,
          apiKey,
          baseUrl: profile.baseUrl,
          model: profile.model,
          maxTokens: profile.maxTokens,
          temperature: profile.temperature,
          systemPrompt,
        };
      },
    }),
    {
      name: "eaicoding-settings",
      storage: createJSONStorage(() => idbStorage),
      version: 1,
      migrate: (persistedState) => {
        if (!persistedState || typeof persistedState !== "object") {
          return persistedState;
        }
        const state = persistedState as Partial<SettingsState>;
        return {
          ...state,
          systemPrompt: shouldReplaceSystemPrompt(state.systemPrompt)
            ? DEFAULT_SYSTEM_PROMPT
            : state.systemPrompt,
        };
      },
      partialize: (s) => ({
        profiles: s.profiles,
        modelCatalogs: s.modelCatalogs,
        activeProfileId: s.activeProfileId,
        systemPrompt: s.systemPrompt,
        theme: s.theme,
        petEnabled: s.petEnabled,
        petSoundEnabled: s.petSoundEnabled,
        petPosition: s.petPosition,
        easyLanguageRoot: s.easyLanguageRoot,
        easyLanguageGenerateDir: s.easyLanguageGenerateDir,
        easyLanguageCompileDir: s.easyLanguageCompileDir,
        userKnowledgeDocuments: s.userKnowledgeDocuments,
      }),
    },
  ),
);
