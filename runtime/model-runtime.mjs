// pi-ai 1.1.0 is also Harness's provider/auth implementation. This module runs
// in the bundled Node host, never in the webview. The parent owns durable keys.
import { createModels } from '@earendil-works/pi-ai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth';
import { bedrockProviderModule } from '@earendil-works/pi-ai/bedrock-provider';
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Explicit static hooks are provided by the SDK for bundled desktop hosts.
// Variable-specifier Node imports cannot resolve once folded into one file.
registerBunOAuthFlows();
setBedrockProviderModule(bedrockProviderModule);
export const providers = builtinProviders();
// Harness intentionally does not offer OpenAI's newer ChatGPT flow: it needs
// an installation identity. Keep its exact served method set (legacy Codex
// remains available). See llm-pi-ai/src/login.ts, UNSERVED_OAUTH.
export function methods(provider) {
  return [
    ...(provider.id !== 'openai' && provider.auth.oauth ? [{ id: 'oauth', label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name }] : []),
    ...(provider.auth.apiKey?.login ? [{ id: 'api_key', label: provider.auth.apiKey.name }] : []),
  ];
}
export const catalog = providers.map(p => ({ id: p.id, name: p.name, methods: methods(p) }));
const displayModels = (rows, provider) => rows.map(model => ({ ...model, ownedBy: provider, protocol: 'pi-ai' }));

export async function operate(input, bridge, dependencies = {}) {
  if (input.operation === 'status_all') {
    const result = {};
    for (const entry of input.entries) {
      try { result[entry.id] = (await operate({ ...entry, operation: 'status' }, bridge, dependencies)).configured; }
      catch { result[entry.id] = false; /* A broken route must not hide independent providers. */ }
    }
    return result;
  }
  const provider = (dependencies.providers ?? providers).find(p => p.id === input.provider);
  if (!provider) throw new Error('模型提供商不受支持，请重新添加。');
  let credential = input.credential ?? undefined;
  const models = createModels({
    credentials: {
      read: async () => credential,
      list: async () => credential ? [{ providerId: provider.id, type: credential.type }] : [],
      modify: async (_id, change) => {
        const next = await change(credential);
        if (next !== undefined) {
          // Await native durable acknowledgement before reporting login/refresh.
          await bridge.persist(next);
          credential = next;
        }
        return credential;
      },
      delete: async () => { await bridge.persist(null); credential = undefined; },
    },
    authContext: dependencies.authContext ?? {
      env: async name => process.env[name],
      fileExists: async name => {
        try { await access(name.startsWith('~') ? resolve(homedir(), name.slice(1).replace(/^[/\\]/, '')) : name); return true; }
        catch { return false; /* Existence checks never read credential contents. */ }
      },
    },
  });
  models.setProvider(provider);
  if (input.operation === 'status') return { configured: !!(await models.checkAuth(provider.id, { signal: bridge.signal })) };
  if (input.operation === 'login') {
    if (!methods(provider).some(m => m.id === input.method)) throw new Error('此提供商不支持该认证方式。');
    await models.login(provider.id, input.method, {
      signal: bridge.signal,
      notify: event => bridge.emit({ type: 'notice', notice: event }),
      prompt: prompt => bridge.prompt(prompt),
    }, { agentName: 'EAiCoding' });
    return { configured: !!(await models.checkAuth(provider.id, { signal: bridge.signal })), models: displayModels(await models.getAvailable(provider.id, { signal: bridge.signal }), provider.id) };
  }
  if (input.operation === 'discover') {
    const result = await models.refresh({ providers: [provider.id], force: true, signal: bridge.signal });
    if (result.errors.size) throw result.errors.values().next().value;
    return displayModels(await models.getAvailable(provider.id, { signal: bridge.signal }), provider.id);
  }
  if (input.operation !== 'stream') throw new Error('未知模型运行操作。');
  const config = input.config ?? {};
  const known = models.getModel(provider.id, config.model);
  const override = (input.models ?? []).find(m => m.id === config.model);
  if (!known && !override) throw new Error('模型不存在，请重新获取模型列表。');
  const model = { type: 'chat', name: config.model, input: ['text'], contextWindow: 128000, maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...known, ...override, provider: provider.id, id: config.model };
  // Catalog metadata, including protocol, is native-registered at settings save.
  delete model.protocol;
  delete model.ownedBy;
  if (!model.api) model.api = provider.getModels()[0]?.api;
  if (!model.api) throw new Error('缺少模型协议，请重新保存提供商。');
  if (input.baseUrl && input.baseUrl !== provider.baseUrl) model.baseUrl = input.baseUrl;
  const options = { signal: bridge.signal, maxTokens: config.maxTokens, temperature: config.temperature, reasoning: config.reasoningEffort, maxRetries: 0 };
  const events = models.streamSimple(model, input.context, options);
  let done = false;
  for await (const event of events) {
    bridge.signal.throwIfAborted();
    if (event.type === 'text_delta' || event.type === 'thinking_delta') bridge.emit({ type: event.type, delta: event.delta });
    if (event.type === 'error') throw new Error(event.error.errorMessage || '模型请求失败');
    if (event.type === 'done') {
      if (event.message.stopReason === 'length') { const e = new Error('模型输出达到 Token 上限，本轮工具未执行。'); e.code = 'output_limit'; throw e; }
      done = true;
      bridge.emit({ type: 'done', message: event.message });
    }
  }
  if (!done) throw new Error('模型响应在结束标记之前中断，本轮工具未执行。');
  return { completed: true };
}
