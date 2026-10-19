import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { invoke } from "@tauri-apps/api/core";
import type { LLMProvider, LLMProtocol, LLMConfig } from "@/types/llm";
import { idbStorage } from "@/lib/idb-storage";
import { DEEPSEEK_DEFAULT_MAX_TOKENS, deepSeekModelCatalog, normalizeDeepSeekModel } from "@/lib/deepseek-models";
import type { UserModuleEntry } from "@/services/knowledge/module-library";

export interface ProviderProfile {
  id: string;
  authMode?: "account" | "api-key";
  custom?: boolean;
  envKey?: string;
  credentialConfigured?: boolean;
  reasoningEffort?: string;
  name: string;
  provider: LLMProvider;
  protocol: LLMProtocol;
  baseUrl: string;
  /** Legacy storage field, cleared during migration; account credentials are native-only. */
  apiKeyEncrypted: string;
  model: string;
  models?: ProviderModel[];
  maxTokens: number;
  temperature: number;
}

export interface ProviderModel {
  api?: string;
  baseUrl?: string;
  id: string;
  ownedBy: string | null;
  name?: string;
  protocol?: LLMProtocol;
  maxTokens?: number;
  reasoning?: boolean;
  defaultEffort?: string;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, unknown>;
  contextWindow?: number;
}

export const DEFAULT_PROVIDER_PROFILE = {
  authMode: "account" as const,
  name: "DeepSeek",
  provider: "deepseek" as LLMProvider,
  protocol: "openai-chat-completions" as LLMProtocol,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  models: deepSeekModelCatalog(),
  maxTokens: DEEPSEEK_DEFAULT_MAX_TOKENS,
  temperature: 0.2,
};

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
  busyEnterBehavior: "queue" | "steer";
  codeWorkView: boolean;
  deepseekWebEnabled: boolean;
  deepseekWebCount: number;
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
  /** When true, the agent pauses for user approval before every source-mutating
   *  tool call (save_text_file / apply_search_replace). Off by default so the
   *  autonomous loop is unchanged unless the user opts in. */
  approveSourceEdits: boolean;
  /** Registered user .ec module library (metadata only — full APIs/vectors live in IndexedDB). */
  userModules: UserModuleEntry[];

  addProfile: (
    profile: Omit<ProviderProfile, "id" | "apiKeyEncrypted"> & { apiKey: string },
  ) => Promise<string>;
  updateProfile: (
    id: string,
    patch: Partial<Omit<ProviderProfile, "id" | "apiKeyEncrypted">> & { apiKey?: string },
  ) => Promise<void>;
  removeProfile: (id: string) => Promise<void>;
  selectModel: (profileId: string, model: string) => Promise<void>;
  setActiveProfile: (id: string) => void;
  setProfileModels: (id: string, models: ProviderModel[]) => void;
  setSystemPrompt: (prompt: string) => void;
  setTheme: (theme: "dark" | "light") => void;
  setBusyEnterBehavior: (behavior: "queue" | "steer") => void;
  setCodeWorkView: (enabled: boolean) => void;
  setDeepseekWebEnabled: (enabled: boolean) => void;
  setDeepseekWebCount: (count: number) => void;
  setPetEnabled: (enabled: boolean) => void;
  setPetSoundEnabled: (enabled: boolean) => void;
  setPetPosition: (pos: { x: number; y: number } | null) => void;
  setEasyLanguageRoot: (path: string) => void;
  setEasyLanguageGenerateDir: (path: string) => void;
  setEasyLanguageCompileDir: (path: string) => void;
  setApproveSourceEdits: (enabled: boolean) => void;
  addUserModule: (entry: UserModuleEntry) => void;
  updateUserModule: (id: string, patch: Partial<UserModuleEntry>) => void;
  removeUserModule: (id: string) => void;

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
      profiles: [
        {
          id: "default",
          ...DEFAULT_PROVIDER_PROFILE,
          apiKeyEncrypted: "",
        },
      ],
      modelCatalogs: {},
      activeProfileId: "default",
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
      theme: "light",
      busyEnterBehavior: "queue",
      codeWorkView: true,
      deepseekWebEnabled: false,
      deepseekWebCount: 10,
      setDeepseekWebEnabled: (deepseekWebEnabled) => set({ deepseekWebEnabled }),
      setDeepseekWebCount: (count) => set({ deepseekWebCount: Math.max(1, Math.min(50, Math.round(count) || 10)) }),
      setBusyEnterBehavior: (busyEnterBehavior) => set({ busyEnterBehavior }),
      setCodeWorkView: (codeWorkView) => set({ codeWorkView }),
      petEnabled: true,
      petSoundEnabled: false,
      petPosition: null,
      easyLanguageRoot: "D:\\e",
      easyLanguageGenerateDir: "",
      easyLanguageCompileDir: "",
      approveSourceEdits: false,
      userModules: [],

      addProfile: async (input) => {
        const previous = get();
        const { apiKey, ...metadata } = input;
        const id = `p_${crypto.randomUUID()}`;
        await invoke("model_provider_save", { input: { id, provider: input.provider, runtime: input.protocol === "pi-ai", models: input.models, baseUrl: input.baseUrl, protocol: input.protocol, apiKey, envKey: input.envKey, routes: (input.models??[]).filter(m=>m.baseUrl).map(m=>({baseUrl:m.baseUrl,protocol:m.protocol??input.protocol})) } });
        const profile: ProviderProfile = { ...metadata, id, authMode: "api-key", apiKeyEncrypted: "", credentialConfigured: !!apiKey.trim() };
        try { await set(s => ({ profiles: [...s.profiles, profile], modelCatalogs: { ...s.modelCatalogs, [id]: input.models ?? [] } })); }
        catch (error) {
          try { await set({ profiles: previous.profiles, modelCatalogs: previous.modelCatalogs }); } catch {}
          await invoke("model_provider_remove", { id }).catch(() => {}); throw error;
        }
        return id;
      },
      updateProfile: async (id, patch) => {
        const previous = get();
        const profile = previous.profiles.find(p => p.id === id);
        if (!profile) throw new Error("模型提供商已删除");
        const { apiKey, ...rest } = patch;
        const next = { ...profile, ...rest, apiKeyEncrypted: "" };
        if (profile.authMode !== "api-key") {
          next.model = normalizeDeepSeekModel(next.model);
          next.baseUrl = DEFAULT_PROVIDER_PROFILE.baseUrl;
          next.models = deepSeekModelCatalog();
        } else if (apiKey !== undefined || patch.baseUrl !== undefined || patch.protocol !== undefined || patch.envKey !== undefined || patch.models !== undefined) {
          await invoke("model_provider_save", { input: { id, provider: next.provider, runtime: next.protocol === "pi-ai", models: next.models, baseUrl: next.baseUrl, protocol: next.protocol, apiKey, envKey: next.envKey, routes: (next.models??[]).filter(m=>m.baseUrl).map(m=>({baseUrl:m.baseUrl,protocol:m.protocol??next.protocol})) } });
          if (apiKey?.trim()) next.credentialConfigured = true;
        }
        try { await set(s => ({ profiles: s.profiles.map(p => p.id === id ? next : p), modelCatalogs: { ...s.modelCatalogs, [id]: next.models ?? [] } })); }
        catch (error) {
          try { await set({ profiles: previous.profiles, modelCatalogs: previous.modelCatalogs }); } catch { /* storage unavailable */ }
          throw error;
        }
      },
      removeProfile: async (id) => {
        const previous = get();
        if (previous.profiles.find(p => p.id === id)?.authMode !== "api-key") throw new Error("DeepSeek 账号入口不能删除");
        // Remove credentials before settings, as Harness does; retries stay possible.
        await invoke("model_provider_remove", { id });
        await set(s => { const profiles = s.profiles.filter(p => p.id !== id); const { [id]: _removed, ...modelCatalogs } = s.modelCatalogs;
          return { profiles, modelCatalogs, activeProfileId: s.activeProfileId === id ? profiles[0]?.id ?? null : s.activeProfileId }; });
      },
      selectModel: async (profileId, model) => {
        const previous = get();
        const profile = previous.profiles.find(p => p.id === profileId);
        if (!profile || !(profile.models ?? []).some(m => m.id === model)) throw new Error("模型不在已保存的目录中");
        if(previous.activeProfileId===profileId && profile.model===model)return;
        try { await set(s => ({ activeProfileId: profileId, profiles: s.profiles.map(p => p.id === profileId ? { ...p, model, reasoningEffort: undefined } : p) })); }
        catch (error) { try { await set({ profiles: previous.profiles, activeProfileId: previous.activeProfileId }); } catch {} throw error; }
      },
      setActiveProfile: (activeProfileId) => set({ activeProfileId }),
      setProfileModels: (id, models) => set(s => ({ modelCatalogs: { ...s.modelCatalogs, [id]: models }, profiles: s.profiles.map(p => p.id === id ? { ...p, models } : p) })),
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
      setApproveSourceEdits: (approveSourceEdits) => set({ approveSourceEdits }),
      addUserModule: (entry) =>
        set((s) => ({
          userModules: [entry, ...s.userModules.filter((item) => item.id !== entry.id)],
        })),
      updateUserModule: (id, patch) =>
        set((s) => ({
          userModules: s.userModules.map((entry) =>
            entry.id === id
              ? { ...entry, ...patch, updatedAt: patch.updatedAt ?? Date.now() }
              : entry,
          ),
        })),
      removeUserModule: (id) =>
        set((s) => ({
          userModules: s.userModules.filter((entry) => entry.id !== id),
        })),

      resolveLLMConfig: async () => {
        const { profiles, activeProfileId, systemPrompt } = get();
        const profile = profiles.find((item) => item.id === activeProfileId) ?? profiles[0];
        if (!profile) return null;
        if (profile.authMode !== "api-key") {
          const account = await invoke<{ signedIn: boolean }>("deepseek_account_status");
          if (!account.signedIn) throw new Error("请先登录 DeepSeek 或在模型设置中添加其他提供商。");
        }
        const model = profile.models?.find(m => m.id === profile.model);
        return {
          profileId: profile.authMode === "api-key" ? profile.id : undefined,
          provider: profile.provider,
          protocol: profile.authMode !== "api-key" ? "anthropic-messages" : profile.protocol === "pi-ai" ? "pi-ai" : model?.protocol ?? profile.protocol,
          apiKey: "",
          baseUrl: profile.authMode !== "api-key" ? "https://api.deepseek.com/anthropic" : model?.baseUrl ?? profile.baseUrl,
          model: profile.authMode === "api-key" ? profile.model : normalizeDeepSeekModel(profile.model),
          reasoningEffort: model?.reasoning ? profile.reasoningEffort ?? model.defaultEffort : undefined,
          modelMetadata: model as unknown as Record<string, unknown>,
          maxTokens: profile.authMode === "api-key" ? model?.maxTokens ?? profile.maxTokens : profile.maxTokens,
          temperature: profile.temperature,
          systemPrompt,
        };
      },
    }),
    {
      name: "eaicoding-settings",
      storage: createJSONStorage(() => idbStorage),
      version: 9,
      migrate: (persistedState, fromVersion) => {
        if (!persistedState || typeof persistedState !== "object") {
          return persistedState;
        }
        const state = persistedState as Partial<SettingsState> & {
          userKnowledgeDocuments?: unknown;
        };
        const profiles = Array.isArray(state.profiles) && state.profiles.length > 0
          ? state.profiles
          : [
              {
                id: "default",
                ...DEFAULT_PROVIDER_PROFILE,
                apiKeyEncrypted: "",
              },
            ];
        const normalizedProfiles: ProviderProfile[] = profiles.map(profile => {
          if (profile.authMode === "api-key") return { ...profile, apiKeyEncrypted: "" };
          const maxTokens = fromVersion < 7 && profile.maxTokens === 8192 && /^https:\/\/api\.deepseek\.com\/?$/.test(profile.baseUrl) ? DEEPSEEK_DEFAULT_MAX_TOKENS : profile.maxTokens || DEEPSEEK_DEFAULT_MAX_TOKENS;
          return { ...profile, ...DEFAULT_PROVIDER_PROFILE, authMode: "account", apiKeyEncrypted: "", maxTokens, temperature: profile.temperature ?? 0.2,
            model: normalizeDeepSeekModel(profile.model), models: deepSeekModelCatalog() };
        });
        const activeProfileId =
          state.activeProfileId && profiles.some((profile) => profile.id === state.activeProfileId)
            ? state.activeProfileId
            : normalizedProfiles[0]?.id ?? "default";

        // v3 → v4: drop legacy Markdown user-knowledge docs and seed empty module library.
        // The old field is intentionally discarded — the new "模块库" only accepts .ec uploads.
        const droppedUserDocs = fromVersion < 4 || "userKnowledgeDocuments" in state;
        const userModules = Array.isArray(state.userModules) ? state.userModules : [];
        if (droppedUserDocs) {
          delete (state as Record<string, unknown>).userKnowledgeDocuments;
        }

        return {
          ...state,
          profiles: normalizedProfiles,
          modelCatalogs: Object.fromEntries(normalizedProfiles.map(p => [p.id, p.models ?? DEFAULT_PROVIDER_PROFILE.models])),
          activeProfileId,
          systemPrompt: shouldReplaceSystemPrompt(state.systemPrompt)
            ? DEFAULT_SYSTEM_PROMPT
            : state.systemPrompt,
          userModules,
        };
      },
      partialize: (s) => ({
        profiles: s.profiles,
        modelCatalogs: s.modelCatalogs,
        activeProfileId: s.activeProfileId,
        systemPrompt: s.systemPrompt,
        theme: s.theme,
        busyEnterBehavior: s.busyEnterBehavior,
        codeWorkView: s.codeWorkView,
        deepseekWebEnabled: s.deepseekWebEnabled,
        deepseekWebCount: s.deepseekWebCount,
        petEnabled: s.petEnabled,
        petSoundEnabled: s.petSoundEnabled,
        petPosition: s.petPosition,
        easyLanguageRoot: s.easyLanguageRoot,
        easyLanguageGenerateDir: s.easyLanguageGenerateDir,
        easyLanguageCompileDir: s.easyLanguageCompileDir,
        approveSourceEdits: s.approveSourceEdits,
        userModules: s.userModules,
      }),
    },
  ),
);
