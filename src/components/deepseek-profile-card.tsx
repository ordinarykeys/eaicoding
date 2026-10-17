import { useEffect, useRef, useState } from "react";
import { ArrowClockwise, CaretDown, CheckCircle, Eye, EyeSlash, WarningCircle } from "@phosphor-icons/react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { type ProviderProfile, type ProviderModel } from "@/stores/settings";
import { DEEPSEEK_MODELS, deepSeekModelCatalog, normalizeDeepSeekModel } from "@/lib/deepseek-models";

type Patch = Partial<Omit<ProviderProfile, "id" | "apiKeyEncrypted">> & { apiKey?: string };
type Draft = Pick<ProviderProfile, "baseUrl" | "model" | "maxTokens" | "temperature">;
type Field = "key" | keyof Draft;
type FieldIssue = { field: Field; message: string };

function draftOf(profile: ProviderProfile): Draft {
  return { baseUrl: profile.baseUrl, model: normalizeDeepSeekModel(profile.model), maxTokens: profile.maxTokens, temperature: profile.temperature };
}

function endpointIssue(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return;
  } catch { /* Invalid pasted URLs are reported next to the field. */ }
  return "请输入完整的 http/https API 地址，不包含账号、查询参数或片段。";
}

export function DeepSeekProfileCard({ profile, active = true, onUpdate }: {
  profile: ProviderProfile;
  active?: boolean;
  onUpdate: (patch: Patch) => Promise<void>;
}) {
  const [editing, setEditing] = useState(!profile.apiKeyEncrypted);
  const [draft, setDraft] = useState(() => draftOf(profile));
  const [key, setKey] = useState("");
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [issue, setIssue] = useState<FieldIssue | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!active) setRevealed(false); }, [active]);
  const dirty = key.length > 0 || JSON.stringify(draft) !== JSON.stringify(draftOf(profile));
  const pending = busy || fetching;
  const setup = editing && !profile.apiKeyEncrypted;

  const clearFeedback = () => { setIssue(null); setError(""); setNotice(""); };
  const reset = () => { setDraft(draftOf(profile)); setKey(""); setRevealed(false); setRemoving(false); clearFeedback(); };
  const patch = <K extends keyof Draft>(field: K, value: Draft[K]) => {
    setDraft(previous => ({ ...previous, [field]: value }));
    clearFeedback();
  };
  const rejectField = (field: Field, message: string) => {
    setIssue({ field, message });
    const ids: Record<Field, string> = { key: "deepseek-key", baseUrl: "deepseek-url", model: "deepseek-model", maxTokens: "deepseek-tokens", temperature: "deepseek-temperature" };
    const input = document.getElementById(ids[field]);
    for (let parent = input?.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    input?.focus();
  };
  const connectionValid = () => {
    const invalidEndpoint = endpointIssue(draft.baseUrl);
    if (invalidEndpoint) { rejectField("baseUrl", invalidEndpoint); return false; }
    if (!key.trim() && !profile.apiKeyEncrypted) { rejectField("key", "请填写 DeepSeek API Key。"); return false; }
    return true;
  };
  const apply = async () => {
    clearFeedback();
    if (!connectionValid()) return;
    if (!DEEPSEEK_MODELS.some(model => model.id === draft.model)) { rejectField("model", "请选择可用的 DeepSeek 模型。"); return; }
    if (!Number.isInteger(draft.maxTokens) || draft.maxTokens < 1) { rejectField("maxTokens", "最大输出 Token 数必须是正整数。"); return; }
    if (!Number.isFinite(draft.temperature) || draft.temperature < 0 || draft.temperature > 2) { rejectField("temperature", "生成随机性应在 0 到 2 之间。"); return; }
    setBusy(true);
    const normalized = { ...draft, baseUrl: draft.baseUrl.trim().replace(/\/+$/, "") };
    try {
      await onUpdate({ ...normalized, models: deepSeekModelCatalog(), provider: "deepseek", protocol: "openai-chat-completions", ...(key.trim() ? { apiKey: key.trim() } : {}) });
      if (mounted.current) { setDraft(normalized); setKey(""); setRevealed(false); setEditing(false); setNotice("配置已保存"); }
      toast.success("DeepSeek 配置已保存");
    } catch (err) { if (mounted.current) setError(`保存失败：${String(err)}`); }
    finally { if (mounted.current) setBusy(false); }
  };
  const fetchModels = async () => {
    clearFeedback();
    if (!connectionValid()) return;
    setFetching(true);
    try {
      let apiKey = key.trim();
      if (!apiKey && profile.apiKeyEncrypted) apiKey = await invoke<string>("decrypt_secret", { encrypted: profile.apiKeyEncrypted });
      const result = await invoke<{ models: ProviderModel[] }>("fetch_llm_models", { provider: "deepseek", baseUrl: draft.baseUrl.trim(), apiKey });
      if (!result.models.length) throw new Error("接口未返回可用模型");
      const supported = new Set(result.models.filter(model => DEEPSEEK_MODELS.some(item => item.id === model.id)).map(model => model.id));
      if (!supported.size) throw new Error("接口未返回 DeepSeek V4.1 Flash / V4 Pro，请检查 API 地址是否正确");
      if (mounted.current) setNotice(`连接成功，已验证 ${supported.size} 个 DeepSeek 模型。`);
    } catch (err) { if (mounted.current) setError(`连接失败：${String(err)}`); }
    finally { if (mounted.current) setFetching(false); }
  };
  const removeKey = async () => {
    setBusy(true);
    clearFeedback();
    try {
      await onUpdate({ apiKey: "" });
      if (mounted.current) { reset(); setEditing(true); setNotice("已移除保存的密钥"); }
    } catch (err) { if (mounted.current) setError(`移除失败：${String(err)}`); }
    finally { if (mounted.current) setBusy(false); }
  };
  const feedback = <>
    {error && <p className="settings-feedback is-error" role="alert"><WarningCircle size={16} /><span>{error}</span></p>}
    {notice && <p className="settings-feedback is-success" role="status"><CheckCircle size={16} /><span>{notice}</span></p>}
  </>;
  const fieldError = (field: Field) => issue?.field === field
    ? <span id={`deepseek-${field}-error`} className="settings-field-error" role="alert">{issue.message}</span> : null;
  const fieldProps = (field: Field) => ({ "aria-invalid": issue?.field === field || undefined, "aria-describedby": issue?.field === field ? `deepseek-${field}-error` : undefined });

  return <section className="model-settings-section">
    <h3>模型</h3>
    <p className="settings-intro">填写 API 密钥以使用 DeepSeek 模型。</p>
    <div className="provider-row-card" data-setup={setup}>
      {!setup && <div className="provider-row-head">
        <span className="provider-identity"><strong>DeepSeek</strong><span className={`credential-dot ${profile.apiKeyEncrypted ? "configured" : "missing"}`} role="img" title={profile.apiKeyEncrypted ? "密钥已配置" : "未配置密钥"} aria-label={profile.apiKeyEncrypted ? "密钥已配置" : "未配置密钥"} /></span>
        {!editing && dirty && <span className="settings-collapsed-draft">未保存</span>}
        <div className="provider-row-actions">
          <button type="button" disabled={pending} aria-expanded={editing} aria-controls="deepseek-editor" onClick={() => { setRevealed(false); setEditing(value => !value); }}>编辑</button>
          {profile.apiKeyEncrypted && <button type="button" disabled={pending} onClick={() => setRemoving(value => !value)} className="settings-danger" aria-expanded={removing}>移除密钥</button>}
        </div>
      </div>}
      {removing && <div className="settings-key-removal" role="group" aria-label="确认移除密钥">
        <p>移除后需要重新填写密钥才能使用 DeepSeek。</p>
        <div><button type="button" disabled={pending} onClick={() => setRemoving(false)}>保留密钥</button><button type="button" className="settings-danger" disabled={pending} onClick={() => void removeKey()}>确认移除</button></div>
      </div>}
      {editing && <form id="deepseek-editor" className="provider-editor" noValidate onSubmit={event => { event.preventDefault(); void apply(); }} aria-busy={pending}>
        <div className="settings-editor-heading"><span>DeepSeek</span>{setup && <span className="sr-only" role="img" aria-label="未配置密钥" />}</div>
        <fieldset disabled={pending}>
          <div className="settings-field">
            <label htmlFor="deepseek-key">API 密钥</label>
            <div className="settings-key-input">
              <input id="deepseek-key" type={revealed ? "text" : "password"} autoComplete="new-password" spellCheck={false} value={key}
                placeholder={profile.apiKeyEncrypted ? "已配置，留空保留现有密钥" : "输入 DeepSeek API Key"} {...fieldProps("key")}
                onChange={event => { setKey(event.target.value); setRevealed(false); clearFeedback(); }} />
              {key && <button type="button" aria-label={revealed ? "隐藏密钥" : "显示密钥"} aria-pressed={revealed} onClick={() => setRevealed(value => !value)}>{revealed ? <EyeSlash size={16} /> : <Eye size={16} />}</button>}
            </div>
            {fieldError("key")}
          </div>
          <details className="settings-customized">
            <summary><CaretDown size={13} />自定义设置</summary>
            <div className="settings-customized-body">
          <div className="settings-field">
            <label htmlFor="deepseek-url">API 地址</label>
            <input id="deepseek-url" value={draft.baseUrl} placeholder="https://api.deepseek.com" onChange={event => patch("baseUrl", event.target.value)} spellCheck={false} {...fieldProps("baseUrl")} />
            {fieldError("baseUrl")}
          </div>
          <fieldset id="deepseek-model" className="settings-model-catalog" tabIndex={-1} {...fieldProps("model")}>
            <legend>模型</legend>
            <p className="settings-hint">选择默认模型，也可在输入框右下角切换。</p>
            <div className="settings-model-columns" aria-hidden="true"><span>模型 ID</span><span>显示名称</span><span>默认</span></div>
            <div className="settings-model-options">
            {DEEPSEEK_MODELS.map(model => <label className="settings-model-choice" key={model.id} htmlFor={`deepseek-default-${model.id}`} data-selected={draft.model === model.id}>
              <input className="settings-model-id" value={model.id} readOnly aria-label={`${model.name} 模型 ID`} tabIndex={-1} />
              <input className="settings-model-name" value={model.name} readOnly aria-label={`${model.name} 显示名称`} tabIndex={-1} />
              <input id={`deepseek-default-${model.id}`} type="radio" name="default-model" value={model.id} checked={draft.model === model.id} onChange={() => patch("model", model.id)} aria-label={model.name} />
            </label>)}
            </div>
            {fieldError("model")}
          </fieldset>
          <div className="settings-connection-row"><button type="button" className="settings-check-connection" onClick={() => void fetchModels()}><ArrowClockwise size={14} className={fetching ? "animate-spin" : ""} />{fetching ? "检测中…" : "检测连接并获取模型"}</button></div>
          <details className="settings-advanced"><summary><CaretDown size={13} />高级参数<span>生成随机性与输出长度</span></summary><div className="settings-two-columns">
            <div className="settings-field"><label htmlFor="deepseek-temperature">生成随机性</label><input id="deepseek-temperature" type="number" min="0" max="2" step="0.1" value={Number.isNaN(draft.temperature) ? "" : draft.temperature} onChange={event => patch("temperature", event.target.valueAsNumber)} {...fieldProps("temperature")} />{fieldError("temperature")}<span className="settings-hint">0–2，较低值适合稳定生成代码。</span></div>
            <div className="settings-field"><label htmlFor="deepseek-tokens">最大输出 Token</label><input id="deepseek-tokens" type="number" min="1" step="1" value={Number.isNaN(draft.maxTokens) ? "" : draft.maxTokens} onChange={event => patch("maxTokens", event.target.valueAsNumber)} {...fieldProps("maxTokens")} />{fieldError("maxTokens")}</div>
          </div></details>
            </div>
          </details>
        </fieldset>
        {feedback}
        <div className="settings-editor-footer"><span className="settings-draft-state">{busy ? "正在保存…" : dirty ? "有未保存的修改" : ""}</span><button type="button" disabled={pending} onClick={() => { reset(); setEditing(false); }}>取消</button><button type="submit" className="settings-primary" disabled={pending || !dirty}>{busy ? "应用中…" : "应用"}</button></div>
      </form>}
    </div>
    {!editing && feedback}
  </section>;
}
