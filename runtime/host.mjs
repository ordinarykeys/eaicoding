import { createInterface } from 'node:readline';
import { operate } from './model-runtime.mjs';
// Pipes are asynchronous on Windows. Flush the final frame before exiting,
// otherwise long tool arguments / replay signatures can be cut mid-JSON.
const output = value => new Promise(resolve => process.stdout.write(JSON.stringify(value) + '\n', () => resolve()));
process.stdout.on('error', () => process.exit(0));
// stdout is a protocol pipe; dependencies may log diagnostics only to stderr.
console.log = console.info = console.warn = console.error = () => {};
const controller = new AbortController();
const waiting = new Map();
let sequence = 0, started = false;
const secrets = new Set();
const rememberSecrets = value => {
  if (!value || typeof value !== 'object') return;
  for (const [key, member] of Object.entries(value)) {
    if (/^(key|access|refresh)$|TOKEN|SECRET|API_KEY/.test(key) && typeof member === 'string' && member.length >= 8) secrets.add(member);
    else if (typeof member === 'object') rememberSecrets(member);
  }
};
const redact = message => { let text = String(message); for (const secret of secrets) text = text.replaceAll(secret, '[已隐藏]'); return text; };
const exchange = (type, payload, signal = controller.signal) => new Promise((resolve, reject) => {
  signal.throwIfAborted();
  const promptId = String(++sequence);
  const abort = () => { waiting.delete(promptId); output({ type: 'prompt_cancel', promptId }); reject(new Error('操作已取消')); };
  signal.addEventListener('abort', abort, { once: true });
  waiting.set(promptId, { type, complete(value, error) { signal.removeEventListener('abort', abort); waiting.delete(promptId); error ? reject(new Error(error)) : resolve(value); } });
  output({ type, promptId, ...payload });
});
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('close', () => { controller.abort(); setTimeout(() => process.exit(0), 50).unref(); });
lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { process.exit(2); }
  if (message.type === 'prompt_reply' || message.type === 'persist_ack') {
    const pending = waiting.get(message.promptId);
    if (pending && ((pending.type === 'persist') === (message.type === 'persist_ack'))) pending.complete(message.value, message.error);
    return;
  }
  if (message.type === 'abort') { controller.abort(); return; }
  if (started) return;
  started = true;
  rememberSecrets(message.credential);
  void operate(message, {
    signal: controller.signal,
    emit: output,
    persist: credential => { rememberSecrets(credential); return exchange('persist', { credential }); },
    prompt: prompt => {
      const { signal, ...visible } = prompt;
      return exchange('prompt', { prompt: visible }, signal ? AbortSignal.any([signal, controller.signal]) : controller.signal);
    },
  }).then(result => output({ type: 'result', result }))
    .catch(error => output({ type: 'failure', code: error.code, message: redact(error.message || '模型认证或请求失败') }))
    .finally(() => { lines.close(); process.exit(0); });
});
