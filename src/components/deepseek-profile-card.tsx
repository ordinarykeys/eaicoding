import { useEffect, useRef, useState } from "react";
import { CaretDown, CheckCircle, WarningCircle, SignOut } from "@phosphor-icons/react";
import { type ProviderProfile } from "@/stores/settings";
import { DEEPSEEK_MODELS, normalizeDeepSeekModel } from "@/lib/deepseek-models";
import { useDeepSeekAccount } from "@/stores/deepseek-account";

type Draft = Pick<ProviderProfile, "model" | "maxTokens" | "temperature">;
function draftOf(profile: ProviderProfile): Draft {
  return { model: normalizeDeepSeekModel(profile.model), maxTokens: profile.maxTokens, temperature: profile.temperature };
}
export function DeepSeekProfileCard({ profile, onUpdate }: {
  profile: ProviderProfile;
  active?: boolean;
  onUpdate: (patch: Partial<Omit<ProviderProfile, "id" | "apiKeyEncrypted">>) => Promise<void>;
}) {
  const { view, logout, busy: accountBusy } = useDeepSeekAccount();
  const [draft, setDraft] = useState(() => draftOf(profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(profile));
  const patch = <K extends keyof Draft>(field: K, value: Draft[K]) => {
    setDraft(previous => ({ ...previous, [field]: value })); setError(""); setNotice("");
  };
  const apply = async () => {
    setError(""); setNotice("");
    if (!DEEPSEEK_MODELS.some(model => model.id === draft.model)) { setError("请选择可用的 DeepSeek 模型。"); return; }
    if (!Number.isInteger(draft.maxTokens) || draft.maxTokens < 1) { setError("最大输出 Token 数必须是正整数。"); return; }
    if (!Number.isFinite(draft.temperature) || draft.temperature < 0 || draft.temperature > 2) { setError("生成随机性应在 0 到 2 之间。"); return; }
    setBusy(true);
    try { await onUpdate(draft); if (mounted.current) setNotice("模型配置已保存"); }
    catch (err) { if (mounted.current) setError(`保存失败：${String(err)}`); }
    finally { if (mounted.current) setBusy(false); }
  };
  return <section className="model-settings-section">
    <h3>DeepSeek 账号</h3>
    <p className="settings-intro">通过 DeepSeek 官方浏览器授权使用模型。</p>
    <div className="provider-row-card">
      <div className="provider-row-head">
        <span className="provider-identity"><strong>{view.name || "DeepSeek"}</strong><span className="credential-dot configured" role="img" aria-label="已授权登录" /></span>
        <div className="provider-row-actions"><button type="button" className="settings-danger" disabled={accountBusy} onClick={() => void logout()}><SignOut size={14} />退出登录</button></div>
      </div>
      <p className="settings-hint" style={{ padding: "0 16px 16px" }}>{view.contact || "已通过 DeepSeek 官方授权"}</p>
    </div>
    <h3 style={{ marginTop: 28 }}>模型</h3>
    <p className="settings-intro">选择默认模型，也可在输入框右下角切换。</p>
    <form id="deepseek-editor" className="provider-editor" noValidate onSubmit={event => { event.preventDefault(); void apply(); }} aria-busy={busy}>
      <fieldset disabled={busy}>
        <fieldset id="deepseek-model" className="settings-model-catalog">
          <legend className="sr-only">默认模型</legend>
          <div className="settings-model-columns" aria-hidden="true"><span>模型 ID</span><span>显示名称</span><span>默认</span></div>
          <div className="settings-model-options">
            {DEEPSEEK_MODELS.map(model => <label className="settings-model-choice" key={model.id} htmlFor={`deepseek-default-${model.id}`} data-selected={draft.model === model.id}>
              <input className="settings-model-id" value={model.id} readOnly aria-label={`${model.name} 模型 ID`} tabIndex={-1} />
              <input className="settings-model-name" value={model.name} readOnly aria-label={`${model.name} 显示名称`} tabIndex={-1} />
              <input id={`deepseek-default-${model.id}`} type="radio" name="default-model" checked={draft.model === model.id} value={model.id} onChange={() => patch("model", model.id)} aria-label={model.name} />
            </label>)}
          </div>
        </fieldset>
        <details className="settings-advanced"><summary><CaretDown size={13} />高级参数<span>生成随机性与输出长度</span></summary><div className="settings-two-columns">
          <div className="settings-field"><label htmlFor="deepseek-temperature">生成随机性</label><input id="deepseek-temperature" type="number" min="0" max="2" step="0.1" value={Number.isNaN(draft.temperature) ? "" : draft.temperature} onChange={event => patch("temperature", event.target.valueAsNumber)} /><span className="settings-hint">0–2，较低值适合稳定生成代码。</span></div>
          <div className="settings-field"><label htmlFor="deepseek-tokens">最大输出 Token</label><input id="deepseek-tokens" type="number" min="1" step="1" value={Number.isNaN(draft.maxTokens) ? "" : draft.maxTokens} onChange={event => patch("maxTokens", event.target.valueAsNumber)} /></div>
        </div></details>
      </fieldset>
      {error && <p className="settings-feedback is-error" role="alert"><WarningCircle size={16} /><span>{error}</span></p>}
      {notice && <p className="settings-feedback is-success" role="status"><CheckCircle size={16} /><span>{notice}</span></p>}
      <div className="settings-editor-footer"><span className="settings-draft-state">{busy ? "正在保存…" : dirty ? "有未保存的修改" : ""}</span><button type="button" disabled={busy || !dirty} onClick={() => { setDraft(draftOf(profile)); setError(""); setNotice(""); }}>重置</button><button type="submit" className="settings-primary" disabled={busy || !dirty}>{busy ? "应用中…" : "应用"}</button></div>
    </form>
  </section>;
}
