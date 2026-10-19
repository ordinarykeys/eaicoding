import { useEffect, useMemo, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { invoke } from "@tauri-apps/api/core";
import { Eye, EyeSlash, Plus, X } from "@phosphor-icons/react";
import { useDeepSeekAccount } from "@/stores/deepseek-account";
import {
  useSettingsStore,
  type ProviderProfile,
  type ProviderModel,
} from "@/stores/settings";
import type { LLMProtocol } from "@/types/llm";
import catalogData from "@/lib/provider-catalog.json";
import css from "./ModelsSection.module.css";
import authCatalog from "@/lib/provider-auth-catalog.json";
import { ProviderAuthorization } from "./provider-authorization";

export const PROVIDER_CATALOG = catalogData as unknown as {
  id: string;
  name: string;
  baseUrl: string;
  envKey: string;
  protocol: LLMProtocol;
  models: ProviderModel[];
  methods: { id: string; label: string }[];
}[];
export const PROTOCOLS: [LLMProtocol, string][] = [
  ["openai-chat-completions", "OpenAI Chat Completions"],
  ["openai-responses", "OpenAI Responses"],
  ["anthropic-messages", "Anthropic Messages"],
  ["google-generative-ai", "Google Gemini"],
  ["bedrock-converse", "Amazon Bedrock Converse（Bearer Token）"],
];
export function ModelSettings() {
  const profiles = useSettingsStore((s) => s.profiles),
    remove = useSettingsStore((s) => s.removeProfile);
  const view = useDeepSeekAccount((s) => s.view),
    start = useDeepSeekAccount((s) => s.start);
  const [editing, setEditing] = useState<string | null>(null),
    [adding, setAdding] = useState(false),
    [mode, setMode] = useState<"catalog" | "custom">("catalog");
  const [target, setTarget] = useState("anthropic"),
    [visited, setVisited] = useState(new Set(["catalog"])),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState(""),
    [notice, setNotice] = useState("");
  const [deleting, setDeleting] = useState<ProviderProfile | null>(null),
    [disconnecting, setDisconnecting] = useState(false),
    [status, setStatus] = useState<Record<string, boolean>>({});
  useEffect(() => {
    let active = true;
    void invoke<Record<string, boolean>>("model_provider_status")
      .then((s) => {
        if (active) setStatus(s);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [profiles]);
  const close = (saved = false) => {
    setAdding(false);
    setEditing(null);
    setBusy(false);
    setNotice(saved ? "模型提供商已保存，可在输入框右下角选择模型。" : "");
  };
  return (
    <section className={css.section} aria-label="模型设置">
      <h2 className={css.title}>模型</h2>
      <p className={css.intro}>使用 API 密钥、账号授权或提供商的本地凭据连接模型。</p>
      {notice && (
        <p className={css.savedNotice} role="status">
          {notice}
        </p>
      )}
      <ul className={css.rows}>
        <li className={css.rowCard}>
          <div className={css.rowHead}>
            <span className={css.rowIdentity}>
              <span className={css.rowName}>DeepSeek 账号</span>
              <span
                className={`${css.credentialDot} ${view.signedIn ? css.credentialDotConfigured : css.credentialDotMissing}`}
              />
              <span className={css.accountStatus}>
                {view.signedIn ? "已登录" : "未登录"}
              </span>
            </span>
            {!view.signedIn && (
              <button
                type="button"
                className={css.secondaryButton}
                onClick={() => void start()}
              >
                登录
              </button>
            )}
          </div>
        </li>
        {profiles
          .filter((p) => p.authMode === "api-key")
          .map((p) => (
            <li className={css.rowCard} key={p.id}>
              <div className={css.rowHead}>
                <span className={css.rowIdentity}>
                  <span className={css.rowName}>{p.name}</span>
                  {p.custom && <span className={css.rowTag}>自定义</span>}
                  <span
                    role="img"
                    aria-label={status[p.id] ? "密钥已配置" : "未配置密钥"}
                    className={`${css.credentialDot} ${status[p.id] ? css.credentialDotConfigured : css.credentialDotMissing}`}
                  />
                </span>
                <span className={css.rowActions}>
                  {p.protocol === "pi-ai" && status[p.id] && <button className={css.secondaryButton} disabled={busy} aria-label={`断开 ${p.name}`} onClick={() => { setFailure(""); setDisconnecting(true); setDeleting(p); }}>断开</button>}
                  <button
                    className={css.secondaryButton}
                    disabled={busy}
                    aria-label={`编辑 ${p.name}`}
                    onClick={() => {
                      setAdding(false);
                      setEditing(editing === p.id ? null : p.id);
                      setNotice("");
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className={css.dangerButton}
                    disabled={busy}
                    aria-label={`删除 ${p.name}`}
                    onClick={() => {
                      setFailure("");
                      setDisconnecting(false);
                      setDeleting(p);
                    }}
                  >
                    删除
                  </button>
                </span>
              </div>
              {editing === p.id && (
                <ProviderForm
                  key={p.id}
                  profile={p}
                  onClose={close}
                  onBusy={setBusy}
                />
              )}
            </li>
          ))}
      </ul>
      {adding ? (
        <div className={css.addCard}>
          <div
            className={css.addModes}
            role="tablist"
            aria-label="添加模型提供商方式"
          >
            {(
              [
                ["catalog", "第三方模型提供商"],
                ["custom", "自定义模型 API"],
              ] as const
            ).map(([id, label]) => (
              <button
                type="button"
                role="tab"
                aria-selected={mode === id}
                key={id}
                disabled={busy}
                onClick={() => {
                  setMode(id);
                  setVisited((v) => new Set([...v, id]));
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {visited.has("catalog") && (
            <div className={css.addPanel} hidden={mode !== "catalog"}>
              <p className={css.advancedHint}>
                选择提供商，使用 API 密钥或它支持的其他认证方式完成连接。
              </p>
              <label className={css.field}>
                <span className={css.fieldLabel}>提供商</span>
                <select
                  className={`${css.input} ${css.selectInput}`}
                  aria-label="提供商"
                  value={target}
                  disabled={busy}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  {PROVIDER_CATALOG.filter(
                    (c) =>
                      !profiles.some(
                        (p) =>
                          p.authMode === "api-key" &&
                          !p.custom &&
                          p.provider === c.id,
                      ),
                  ).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <ProviderForm
                key={target}
                preset={target}
                onClose={close}
                onBusy={setBusy}
              />
            </div>
          )}
          {visited.has("custom") && (
            <div className={css.addPanel} hidden={mode !== "custom"}>
              <ProviderForm onClose={close} onBusy={setBusy} />
            </div>
          )}
        </div>
      ) : (
        <div className={css.addBlock}>
          <button
            className={css.addButton}
            type="button"
            disabled={busy}
            onClick={() => {
              setEditing(null);
              setAdding(true);
              setVisited(new Set([mode]));
              const first = PROVIDER_CATALOG.find(
                (c) =>
                  !profiles.some(
                    (p) =>
                      p.provider === c.id &&
                      p.authMode === "api-key" &&
                      !p.custom,
                  ),
              );
              if (first) setTarget(first.id);
            }}
          >
            <Plus size={14} />
            添加模型提供商
          </button>
        </div>
      )}
      <Dialog.Root
        open={deleting !== null}
        onOpenChange={(value) => {
          if (!value && !busy) setDeleting(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="account-signout-overlay" />
          <Dialog.Content className="account-signout-dialog"
            onEscapeKeyDown={event => { if (busy) event.preventDefault(); }}
            onInteractOutside={event => { if (busy) event.preventDefault(); }}>
            <header><Dialog.Title>{disconnecting ? "断开模型提供商" : "删除模型提供商"}</Dialog.Title>
              <Dialog.Close aria-label="关闭确认" disabled={busy}><X size={14} /></Dialog.Close>
            </header>
            <Dialog.Description>
              {disconnecting ? `清除 ${deleting?.name} 已保存的登录授权和密钥？模型配置会保留，环境凭据仍可使用。` : `删除 ${deleting?.name} 及其已保存的授权和密钥？聊天记录会保留。`}
            </Dialog.Description>
            {failure && (
              <p role="alert" className={css.error}>
                {failure}
              </p>
            )}
            <footer>
              <button disabled={busy} onClick={() => setDeleting(null)}>
                取消
              </button>
              <button
                type="button"
                className="account-primary"
                disabled={busy}
                onClick={() => {
                  if (!deleting) return;
                  setBusy(true);
                  void (disconnecting ? invoke("model_provider_logout", { id: deleting.id }).then(() => useSettingsStore.getState().updateProfile(deleting.id, { credentialConfigured: false })) : remove(deleting.id))
                    .then(() => setDeleting(null))
                    .catch((e) => setFailure(String(e)))
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? "处理中…" : disconnecting ? "断开" : "删除"}
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </section>
  );
}

function ProviderForm({
  profile,
  preset,
  onClose,
  onBusy,
}: {
  profile?: ProviderProfile;
  preset?: string;
  onClose: (saved?: boolean) => void;
  onBusy: (busy: boolean) => void;
}) {
  const entry = PROVIDER_CATALOG.find(
    (c) => c.id === (preset ?? profile?.provider),
  );
  const custom = profile?.custom ?? !preset;
  const authMethods = authCatalog.find(p => p.id === entry?.id)?.methods ?? [];
  const hasKey = custom || authMethods.some(m => m.id === "api_key");
  const [authMethod, setAuthMethod] = useState(authMethods[0]?.id ?? "api_key");
  const [authorization, setAuthorization] = useState<{ id: string; method: string } | null>(null);
  const savedId = useRef(profile?.id);
  const [route, setRoute] = useState(profile?.provider ?? ""),
    [name, setName] = useState(profile?.name ?? entry?.name ?? ""),
    [base, setBase] = useState(profile?.baseUrl ?? entry?.baseUrl ?? ""),
    [protocol, setProtocol] = useState<LLMProtocol>(
      !custom && entry ? "pi-ai" : profile?.protocol ?? "openai-chat-completions",
    );
  const [key, setKey] = useState(""),
    [showKey, setShowKey] = useState(false),
    [models, setModels] = useState<ProviderModel[]>(
      profile?.models ?? entry?.models ?? [],
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<ProviderModel[] | null>(null),
    [picked, setPicked] = useState<Set<string>>(new Set()),
    [candidateQuery, setCandidateQuery] = useState(""),
    [page, setPage] = useState(0);
  const add = useSettingsStore((s) => s.addProfile),
    update = useSettingsStore((s) => s.updateProfile);
  useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);
  const field = (
    label: string,
    value: string,
    set: (v: string) => void,
    type = "text",
  ) => (
    <label className={css.field}>
      <span className={css.fieldLabel}>{label}</span>
      <input
        className={css.input}
        aria-label={label}
        type={type}
        value={value}
        onChange={(e) => set(e.target.value)}
        disabled={busy}
      />
    </label>
  );
  const patchModel = (index: number, patch: Partial<ProviderModel>) =>
    setModels((ms) => ms.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  const validate = () => {
    const url = base ? new URL(base) : null;
    if (
      (!url && custom) || (url && (! ["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash))
    )
      throw new Error("请填写正确的 HTTP/HTTPS 接口根地址。");
    if (custom && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(route))
      throw new Error("提供商标识使用小写字母开头，可包含数字和短横线。");
    if ((custom && !models.length) || models.some((m) => !m.id.trim()))
      throw new Error("请至少添加一个模型，并填写模型 ID。");
    if (new Set(models.map((m) => m.id.trim())).size !== models.length)
      throw new Error("模型 ID 不能重复。");
    if (
      !profile &&
      custom &&
      useSettingsStore.getState().profiles.some((p) => p.provider === route)
    )
      throw new Error("提供商标识已存在，请换一个。");
  };
  const save = async (closeAfter = true): Promise<string | undefined> => {
    setError("");
    try {
      validate();
      setBusy(true);
      const normalized = models.map((m) => ({
        ...m,
        protocol: custom ? m.protocol : "pi-ai" as const,
        baseUrl: custom ? undefined : m.baseUrl,
        id: m.id.trim(),
        name: m.name?.trim() || m.id.trim(),
      }));
      const value = {
        name: name.trim() || route || entry?.name || "自定义",
        provider: custom ? route : (entry?.id ?? profile!.provider),
        protocol,
        baseUrl: base.trim().replace(/\/+$/, ""),
        models: normalized,
        model: normalized.some((m) => m.id === profile?.model)
          ? profile!.model
          : normalized[0]?.id ?? "",
        maxTokens: profile?.maxTokens ?? normalized[0]?.maxTokens ?? 8192,
        temperature: profile?.temperature ?? 0.2,
        custom,
        envKey: entry?.envKey,
        apiKey: key,
      };
      if (savedId.current) await update(savedId.current, value);
      else savedId.current = await add(value);
      setKey("");
      if (closeAfter) onClose(true);
      return savedId.current;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const discover = async () => {
    setError("");
    setBusy(true);
    try {
      const id = !custom ? await save(false) : undefined;
      if (!custom && !id) return;
      const found = !custom ? await invoke<ProviderModel[]>("model_runtime_run", { requestId: crypto.randomUUID(), profileId: id, input: { operation: "discover" } }) : await invoke<ProviderModel[]>("model_provider_discover", {
        input: {
          id: profile?.id ?? "draft",
          baseUrl: base.trim(),
          protocol,
          apiKey: key,
          envKey: entry?.envKey,
        },
      });
      if (!found.length) throw new Error("没有发现可用模型，请手动添加。");
      setCandidates(found);
      setCandidateQuery("");
      setPage(0);
      setPicked(
        new Set(
          found
            .filter((m) => !models.some((saved) => saved.id === m.id))
            .map((m) => m.id),
        ),
      );
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };
  const filteredCandidates = useMemo(
    () =>
      candidates?.filter((m) =>
        (m.id + " " + m.name)
          .toLowerCase()
          .includes(candidateQuery.toLowerCase()),
      ) ?? [],
    [candidates, candidateQuery],
  );
  const filteredModels = models
    .map((m, index) => ({ m, index }))
    .filter(({ m }) =>
      (m.id + " " + m.name).toLowerCase().includes(query.toLowerCase()),
    );
  return (
    <div className={css.editor} aria-busy={busy}>
      {custom && (
        <>
          {field("提供商标识", route, setRoute)}
          {field("显示名称", name, setName)}
          {field("API 地址", base, setBase)}
          <label className={css.field}>
            <span className={css.fieldLabel}>API 协议</span>
            <select
              className={css.input}
              aria-label="API 协议"
              value={protocol}
              disabled={busy}
              onChange={(e) => setProtocol(e.target.value as LLMProtocol)}
            >
              {PROTOCOLS.slice(0, 4).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {hasKey && <label className={css.field}>
        <span className={css.fieldLabel}>
          API 密钥{" "}
          <span title="密钥由桌面后台加密保存，不会写入聊天记录。">ⓘ</span>
        </span>
        <span className={css.keyInput}>
          <input
            className={css.input}
            type={showKey ? "text" : "password"}
            aria-label="API 密钥"
            autoComplete="new-password"
            placeholder={
              profile
                ? "留空保留已保存的密钥"
                : entry?.envKey
                  ? `留空使用环境凭证（${entry.envKey}）`
                  : "输入 API 密钥；本地免鉴权服务可留空"
            }
            value={key}
            disabled={busy}
            onChange={(e) => setKey(e.target.value)}
          />
          <button
            className={css.keyToggle}
            type="button"
            aria-label={showKey ? "隐藏密钥" : "显示密钥"}
            onClick={() => setShowKey((v) => !v)}
          >
            {showKey ? <EyeSlash size={14} /> : <Eye size={14} />}
          </button>
        </span>
      </label>}
      {!custom && authMethods.length > 0 && <div className={css.authMethods}>
        <label className={css.field}>
          <span className={css.fieldLabel}>其他认证方式</span>
          <select aria-label="认证方式" className={css.input} value={authMethod} onChange={e => setAuthMethod(e.target.value)} disabled={busy}>
            {authMethods.map(method => <option key={method.id} value={method.id}>{method.label}</option>)}
          </select>
        </label>
        <button className={css.secondaryButton} disabled={busy} onClick={() => { void save(false).then(id => { if (id) setAuthorization({ id, method: authMethod }); }); }}>连接提供商</button>
      </div>}
      {authorization && <ProviderAuthorization profileId={authorization.id} name={name || entry?.name || "提供商"} method={authorization.method} onClose={() => setAuthorization(null)} onSuccess={async (found) => {
        await update(authorization.id, { credentialConfigured: true });
        if (found.length) { setModels(found); await update(authorization.id, { models: found, model: found.some(m => m.id === profile?.model) ? profile!.model : found[0].id }); }
        onClose(true);
      }} />}
      <CustomSettings custom={custom}>
        {!custom && (
          <>
            {field("API 地址", base, setBase)}
            {field("显示名称", name, setName)}
          </>
        )}
        <div className={css.modelCatalog}>
          <div className={css.modelCatalogHeading}>
            <span className={css.modelCatalogTitle}>
              模型（{models.length}）
            </span>
            <button
              className={css.secondaryButton}
              disabled={busy || (custom && !base)}
              onClick={() => void discover()}
            >
              获取模型列表
            </button>
          </div>
          {models.length > 8 && (
            <input
              className={css.input}
              type="search"
              aria-label="筛选已配置模型"
              placeholder="搜索模型"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}
          <div className={css.modelListHead}>
            <span>模型 ID</span>
            <span>显示名称</span>
            <span />
          </div>
          {filteredModels.slice(0, 40).map(({ m, index }) => (
            <div className={css.modelEntry} key={index}>
              <div className={css.modelRow}>
                <input
                  className={css.input}
                  aria-label={`模型 ID ${index + 1}`}
                  value={m.id}
                  disabled={busy}
                  onChange={(e) => patchModel(index, { id: e.target.value })}
                />
                <input
                  className={css.input}
                  aria-label={`模型名称 ${index + 1}`}
                  value={m.name ?? m.id}
                  disabled={busy}
                  onChange={(e) => patchModel(index, { name: e.target.value })}
                />
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={`移除模型 ${m.id}`}
                  disabled={busy}
                  onClick={() =>
                    setModels((ms) => ms.filter((_, i) => i !== index))
                  }
                >
                  <X size={14} />
                </button>
              </div>
              {custom && (
                <details>
                  <summary className={css.advancedHint}>推理强度</summary>
                  <input
                    className={css.input}
                    aria-label={`推理强度 ${index + 1}`}
                    placeholder="例如 low,medium,high（留空为不支持）"
                    value={Object.entries(m.thinkingLevelMap ?? {})
                      .filter(([, v]) => v !== null)
                      .map(([k]) => k)
                      .join(",")}
                    onChange={(e) => {
                      const levels = e.target.value
                        .split(",")
                        .map((v) => v.trim())
                        .filter(Boolean);
                      patchModel(index, {
                        reasoning: levels.length > 0,
                        thinkingLevelMap: Object.fromEntries(
                          [
                            "off",
                            "minimal",
                            "low",
                            "medium",
                            "high",
                            "xhigh",
                            "max",
                          ].map((v) => [v, levels.includes(v) ? v : null]),
                        ),
                      });
                    }}
                  />
                </details>
              )}
            </div>
          ))}
          {filteredModels.length > 40 && (
            <p className={css.advancedHint}>
              仅展示前 40 条，输入模型名筛选其余 {filteredModels.length - 40}{" "}
              条。
            </p>
          )}
          {!models.length && (
            <p className={css.modelEmpty}>还没有模型，请获取列表或手动添加。</p>
          )}
          <button
            type="button"
            className={css.addModelButton}
            disabled={busy}
            onClick={() => {
              setQuery("");
              setModels((ms) => [{ id: "", name: "", ownedBy: null }, ...ms]);
            }}
          >
            <Plus size={14} />
            添加模型
          </button>
        </div>
      </CustomSettings>
      {error && (
        <p className={css.error} role="alert">
          {error}
        </p>
      )}
      <div className={css.editorActions}>
        <button
          className={css.secondaryButton}
          disabled={busy}
          onClick={() => onClose(false)}
        >
          取消
        </button>
        <button
          className={css.primaryButton}
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "处理中…" : "保存"}
        </button>
      </div>
      <Dialog.Root
        open={candidates !== null}
        onOpenChange={(value) => {
          if (!value) setCandidates(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="account-signout-overlay" />
          <Dialog.Content className="provider-discovery-dialog">
            <header>
              <Dialog.Title>选择要添加的模型</Dialog.Title>
              <Dialog.Close aria-label="关闭模型列表">
                <X size={16} />
              </Dialog.Close>
            </header>
            <Dialog.Description>已配置的模型不会被覆盖。</Dialog.Description>
            <input
              className={css.input}
              type="search"
              aria-label="搜索发现的模型"
              placeholder="搜索模型"
              value={candidateQuery}
              onChange={(e) => {
                setCandidateQuery(e.target.value);
                setPage(0);
              }}
            />
            <div className={css.candidateToolbar}>
              <button
                onClick={() =>
                  setPicked(new Set(filteredCandidates.map((m) => m.id)))
                }
              >
                全选搜索结果
              </button>
              <button onClick={() => setPicked(new Set())}>取消全选</button>
              <span>已选 {picked.size}</span>
            </div>
            <div className={css.candidateList}>
              {filteredCandidates.slice(page * 40, (page + 1) * 40).map((m) => (
                <label className={css.candidate} key={m.id}>
                  <input
                    type="checkbox"
                    checked={picked.has(m.id)}
                    onChange={(e) =>
                      setPicked((old) => {
                        const next = new Set(old);
                        if (e.target.checked) next.add(m.id);
                        else next.delete(m.id);
                        return next;
                      })
                    }
                  />
                  <span>
                    {m.name ?? m.id}
                    <small className={css.candidateId}>{m.id}</small>
                  </span>
                </label>
              ))}
            </div>
            <footer>
              <button
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                上一页
              </button>
              <span>
                {page + 1}/
                {Math.max(1, Math.ceil(filteredCandidates.length / 40))}
              </span>
              <button
                disabled={(page + 1) * 40 >= filteredCandidates.length}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </button>
              <button
                className={css.primaryButton}
                onClick={() => {
                  setModels((ms) => [
                    ...ms,
                    ...(candidates ?? []).filter(
                      (m) =>
                        picked.has(m.id) &&
                        !ms.some((saved) => saved.id === m.id),
                    ),
                  ]);
                  setCandidates(null);
                }}
              >
                添加所选
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

function CustomSettings({
  custom,
  children,
}: {
  custom: boolean;
  children: React.ReactNode;
}) {
  return custom ? (
    <>{children}</>
  ) : (
    <details className={css.customized}>
      <summary className={css.customizedSummary}>自定义设置</summary>
      <div className={css.customizedBody}>{children}</div>
    </details>
  );
}
