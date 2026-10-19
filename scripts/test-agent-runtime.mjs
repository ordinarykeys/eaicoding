import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { mockIPC, clearMocks } from '@tauri-apps/api/mocks';

const root = process.cwd();
const temp = await mkdtemp(path.join(tmpdir(), 'eaicoding-runtime-'));
globalThis.window = globalThis;
globalThis.fixtureIdb = new Map();
globalThis.localStorage = { getItem: () => null, removeItem: () => {} };
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
const config = { provider: 'deepseek', protocol: 'openai-chat-completions', baseUrl: 'https://api.deepseek.com', apiKey: 'fixture-only', model: 'deepseek-flash' };
const response = content => {
  let message = { content };
  try {
    const turn = JSON.parse(content);
    if (Array.isArray(turn.tool_calls)) message = { content: '', tool_calls: turn.tool_calls.map((call, index) => ({ id: call.id ?? 'fixture-' + index, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) };
    else if (typeof turn.final_answer === 'string') message = { content: turn.final_answer };
  } catch { /* Plain Markdown and reviewer JSON pass through unchanged. */ }
  return { status: 200, statusText: 'OK', text: JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }) };
};
const step = (name, content = { success: true }, args = {}) => ({ index: 1, assistantText: '', toolCalls: [{ id: name, name, arguments: args }], toolResults: [{ toolCallId: name, toolName: name, ok: true, content, durationMs: 1 }], finishReason: 'tool_call', startedAt: 0, endedAt: 1 });
const traceOf = steps => ({ goal: '优化工程', steps, finalAnswer: '', outcome: 'max_steps', startedAt: 0, endedAt: 1, toolCallCount: steps.length });
const code = '.版本 2\n.程序集 程序集1\n.子程序 _启动子程序, 整数型\n返回 (0)';
try {
  await build({
    stdin: { contents: `export * from './agent/runner'; export * from './agent/epl-syntax'; export * from './agent/answer-compile-check'; export * from './llm/openai'; export * from './llm/index'; export * from './agent/tools'; export { searchUserModules } from './knowledge/module-search'; export { useSettingsStore, DEFAULT_PROVIDER_PROFILE } from '../stores/settings';`, resolveDir: path.join(root, 'src/services'), loader: 'ts' },
    outfile: path.join(temp, 'runtime.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
    external: ['@huggingface/transformers', 'onnxruntime-node'],
    plugins: [{ name: 'inspect-runner-policies', setup(b) {
      b.onResolve({ filter: /^idb-keyval$/ }, () => ({ path: 'idb-fixture', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const get = async key => globalThis.fixtureIdb.get(key); export const set = async (key,value) => { globalThis.fixtureIdb.set(key,value); }; export const del = async key => { globalThis.fixtureIdb.delete(key); };', loader: 'js' }));
      b.onLoad({ filter: /[\\/]agent[\\/]runner\.ts$/ }, async ({ path: file }) => ({
        contents: (await readFile(file, 'utf8')) + '\nexport { toolResultToMessage, shapeHistoryForLLM, makeAgentWorkflowState, evaluateContinueAfterFinalAnswer, shouldPrimeJingyiKnowledge, collectSuccessfulReadFilePaths, isSocialTurn, shouldRequireJingyiEvidence };',
        loader: 'ts', resolveDir: path.dirname(file),
      }));
    } }],
  });
  const api = await import(pathToFileURL(path.join(temp, 'runtime.mjs')).href);
  assert.equal(api.isCompleteExample(code), true);
  assert(api.findEplAnswerDiagnostics('```epl\n' + code + '\n如果真 (真)\n调试输出 (1)\n```').some(d => d.severity === 'error'));
  mockIPC(cmd => {
    if (cmd === 'generate_efile_from_code') return { success: true, output_path: 'D:\\fixture\\main.e' };
    if (cmd === 'compile_efile') return { success: true, output_path: 'D:\\fixture\\main.exe' };
    throw new Error(cmd);
  }, { shouldMockEvents: true });
  assert.equal((await api.checkAnswerCompiles('```epl\n' + code + '\n```', [])).stage, 'ok');
  assert.equal((await api.checkAnswerCompiles('```epl\n.版本 2\n.程序集 窗口程序集1\n.子程序 _按钮1_被单击\n```', [])).attempted, false);
  clearMocks();
  console.log('PASS Chinese syntax and actual compile gate invocation');

  const source = 'A'.repeat(5990) + 'CRITICAL_SOURCE_IN_MIDDLE' + 'B'.repeat(5990);
  const payload = JSON.parse(api.toolResultToMessage({ toolCallId: 'r', toolName: 'read_file', ok: true, content: { content: source, code_hash: 'h', truncated: false } }).content);
  assert.equal(payload.content.content, source);
  const answer = '解释'.repeat(200) + '\n```epl\n' + code + '\n关键业务处理 (“KEEP_SOURCE”）\n```';
  assert(api.shapeHistoryForLLM([{ id: 'a', role: 'assistant', content: answer, agentTrace: traceOf([]) }])[0].content.includes('KEEP_SOURCE'));
  assert.equal(api.shouldPrimeJingyiKnowledge('你好', []), false);
  assert.equal(api.shouldPrimeJingyiKnowledge('JavaScript 怎么排序数组', []), false);
  assert.equal(api.shouldPrimeJingyiKnowledge('写个多线程POST案例', []), true);
  const srcPath = 'D:\\fixture\\代码\\main.e.txt';
  const page = (start, length, hash = 'h') => step('read_file', { path: srcPath, content: 'source', code_hash: hash, start_char: start, returned_chars: length, total_chars: 100, truncated: start + length < 100, is_partial: length < 100 });
  assert.equal(api.collectSuccessfulReadFilePaths(traceOf([page(0, 50)])).size, 0);
  assert.equal(api.collectSuccessfulReadFilePaths(traceOf([page(0, 50), page(50, 50)])).size, 1);
  assert.equal(api.collectSuccessfulReadFilePaths(traceOf([page(0, 50), page(50, 50, 'new')])).size, 0);
  for (const edit of ['save_text_file', 'apply_search_replace']) {
    const t = traceOf([step('start_project_closed_loop'), step(edit), step('finish_project_closed_loop')]);
    assert.equal(api.evaluateContinueAfterFinalAnswer(t, '完成').shouldContinue, false);
    t.steps.push(step(edit));
    assert.equal(api.evaluateContinueAfterFinalAnswer(t, '完成').shouldContinue, true, 'a later edit invalidates a previous build');
  }
  const gui = traceOf([step('generate_gui_project')]);
  const guiBuilt = traceOf([step('generate_gui_project'), step('save_text_file'), step('build_ecode_project')]);
  assert.equal(api.evaluateContinueAfterFinalAnswer(guiBuilt, '完成').shouldContinue, false, 'combined build already includes compilation');
  guiBuilt.steps.push(step('apply_search_replace'));
  assert.equal(api.evaluateContinueAfterFinalAnswer(guiBuilt, '完成').shouldContinue, true, 'a combined build still cannot verify later edits');
  const failedBuilds = traceOf([step('save_text_file'), ...Array.from({ length: 3 }, () => step('build_ecode_project', { success: false, stderr: 'syntax error' }))]);
  assert.equal(api.evaluateContinueAfterFinalAnswer(failedBuilds, '构建失败，尚未生成可运行程序。').shouldContinue, false, 'failed builds stop at the retry budget');
  failedBuilds.steps.push(step('apply_search_replace'));
  assert.equal(api.evaluateContinueAfterFinalAnswer(failedBuilds, '完成').shouldContinue, true, 'new edits still need a new build');
  assert.equal(api.evaluateContinueAfterFinalAnswer(gui, '完成').shouldContinue, true);
  gui.steps.push(step('compile_efile'));
  assert.equal(api.evaluateContinueAfterFinalAnswer(gui, '完成').shouldContinue, false);
  console.log('PASS exact source pages, recent history, retrieval intent, hash-aware coverage and latest-edit build guard');

  const migrate = api.useSettingsStore.persist.getOptions().migrate;
  for (const [oldModel, expected] of [['deepseek-chat', 'deepseek-flash'], ['deepseek-reasoner', 'deepseek-v4-pro'], ['deepseek-v4-flash', 'deepseek-flash'], ['deepseek-v4-pro', 'deepseek-v4-pro']]) {
    const migrated = migrate({ profiles: [{ id: 'old', provider: 'deepseek', baseUrl: 'https://proxy.example/v1', apiKeyEncrypted: 'KEEP_KEY', model: oldModel, maxTokens: 4096, temperature: 0.3, models: [{ id: 'obsolete' }] }], activeProfileId: 'old', theme: 'dark' }, 5);
    assert.equal(migrated.profiles[0].model, expected);
    assert.equal(migrated.profiles[0].apiKeyEncrypted, '');
    assert.equal(migrated.profiles[0].baseUrl, 'https://api.deepseek.com');
    assert.equal(migrated.profiles[0].maxTokens, 4096);
    assert.equal(migrated.theme, 'dark');
    assert.deepEqual(migrated.modelCatalogs.old.map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro']);
  }
  console.log('PASS supported model migration retains model parameters, clears old keys and fixes the official origin');
  assert.equal(api.DEFAULT_PROVIDER_PROFILE.maxTokens, 256000);
  const oldProfile = { id: 'default', ...api.DEFAULT_PROVIDER_PROFILE, apiKeyEncrypted: 'KEEP_KEY', maxTokens: 8192 };
  for (const [baseUrl, version, budget, expected] of [
    ['https://api.deepseek.com', 6, 8192, 256000],
    ['https://api.deepseek.com', 6, 4096, 4096],
    ['https://api.deepseek.com', 7, 8192, 8192],
    ['https://proxy.example/v1', 6, 8192, 8192],
    ['https://api.deepseek.com', 6, undefined, 256000],
  ]) {
    const migrated = migrate({ profiles: [{ ...oldProfile, baseUrl, maxTokens: budget }] }, version);
    assert.equal(migrated.profiles[0].maxTokens, expected);
    assert.equal(migrated.profiles[0].apiKeyEncrypted, '');
  }
  console.log('PASS Harness output default and migration of legacy official default without changing custom limits');

  for (const input of ['你好啊', '你好！', '谢谢你', '你是谁？', '你能做什么']) {
    assert.equal(api.isSocialTurn(input), true);
    let requests = 0;
    const answer = '你好！我是易语言编程助手，可以帮你生成窗口和事件代码，也能查阅精易模块接口。';
    mockIPC((cmd, args) => {
      if (cmd !== 'llm_proxy_stream') assert.fail('social turn reached tool backend: ' + cmd);
      requests++;
      assert.equal(args.request.body.max_tokens, 256000);
      assert.equal(args.request.body.tools, undefined);
      assert.equal(args.request.body.messages.length, 2, 'stale uploads or failed project turns must not hijack greetings');
      return response(answer);
    }, { shouldMockEvents: true });
    const history = [
      { id: 'old', role: 'user', content: '用户上传了以下本地文件，请用工具读取后再分析：\n- D:\\fixture\\old.ec' },
      { id: 'failed', role: 'assistant', content: '检索到32个入口，请选择', agentTrace: { ...traceOf([step('save_text_file')]), pendingUserChoice: { question: '选哪个入口', options: [{ label: 'POST' }, { label: 'GET' }] } } },
    ];
    const trace = await api.startAgentRun({ config, userInput: input, history, sessionId: null }).promise;
    assert.equal(requests, 1); assert.equal(trace.outcome, 'answer');
    assert.equal(trace.finalAnswer, answer); assert.equal(trace.toolCallCount, 0);
    assert.equal(trace.steps.length, 1);
    clearMocks();
  }
  for (const input of ['你好，帮我写登录窗口', '好的继续', '谢谢，继续修改 main.e', '帮我用精易模块写POST']) assert.equal(api.isSocialTurn(input), false);
  assert.equal(api.shouldRequireJingyiEvidence('你能做什么', '可以使用精易模块的 网页_访问 ()', traceOf([])), false);
  assert.equal(api.shouldRequireJingyiEvidence('写易语言窗口', '```epl\n.子程序 _按钮1_被单击\n_按钮1_被单击 ()\n```', traceOf([])), false);
  assert.equal(api.shouldRequireJingyiEvidence('写易语言网络请求', '```epl\n网页_访问 (“https://example.com”)\n```', traceOf([])), true);
  console.log('PASS greetings finish in one request without tools, stale-history retrieval, reviewer or compile checks');

  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const calls = [];
  mockIPC(cmd => { calls.push(cmd); if (cmd === 'llm_proxy_stream') { started(); return pending; } }, { shouldMockEvents: true });
  const provider = new api.OpenAIChatCompletionsProvider(config);
  let callbacks = 0;
  const running = provider.stream([], { onToken() { callbacks++; }, onComplete() { callbacks++; }, onError() { callbacks++; } }, { nativeTools: false });
  await ready;
  provider.abort();
  await Promise.race([running, new Promise((_, reject) => setTimeout(() => reject(new Error('abort hung')), 300))]);
  assert(calls.includes('cancel_agent_task'));
  release(response('late reply'));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(callbacks, 0);
  clearMocks();
  console.log('PASS DeepSeek transport cancellation and ignored late reply');

  const truncatedPayload = { choices: [{ message: { content: 'INCOMPLETE_SOURCE', tool_calls: [{ id: 'partial', type: 'function', function: { name: 'save_text_file', arguments: '{"path":"partial' } }] }, finish_reason: 'length' }] };
  for (const text of [JSON.stringify(truncatedPayload), 'data: ' + JSON.stringify(truncatedPayload) + '\n\ndata: [DONE]\n\n']) {
    let attempts = 0;
    mockIPC(cmd => { if (cmd === 'llm_proxy_stream') { attempts++; return { status: 200, statusText: 'OK', text }; } throw new Error(cmd); }, { shouldMockEvents: true });
    let failure;
    const p = new api.OpenAIChatCompletionsProvider(config);
    await p.stream([], { onToken() {}, onToolCall() { assert.fail('truncated tool call executed'); }, onComplete() { assert.fail('truncated output accepted'); }, onError(error) { failure = error; } });
    assert.match(failure?.message ?? '', /Token 上限/);
    assert(failure instanceof api.LLMOutputLimitError);
    attempts = 0;
    const trace = await api.startAgentRun({ config, userInput: '你好', history: [], sessionId: null, maxSteps: 3 }).promise;
    assert.equal(attempts, 3, 'two output recoveries must be bounded within the same turn');
    assert.equal(trace.outcome, 'error');
    assert(!trace.finalAnswer.includes('INCOMPLETE_SOURCE'));
    assert.match(trace.finalAnswer, /Token 上限/);
    assert.match(trace.finalAnswer, /自动尝试拆小本轮输出 2 次/);
    assert.equal(trace.steps[0].assistantText, '');
    clearMocks();
  }
  console.log('PASS truncated JSON/SSE output cannot execute tools or become the final answer');

  // Even complete-looking calls in a truncated batch must be discarded. Retry
  // just that model turn, preserving previously executed file operations.
  const partialBatch = { choices: [{ message: { content: 'INCOMPLETE_SOURCE', tool_calls: [
    { id: 'unsafe-complete', type: 'function', function: { name: 'save_text_file', arguments: JSON.stringify({ path: 'D:/fixture/result.txt', content: 'DO_NOT_WRITE' }) } },
    ...truncatedPayload.choices[0].message.tool_calls,
  ] }, finish_reason: 'length' }] };
  const partialSse = 'data: ' + JSON.stringify({ choices: [{ delta: partialBatch.choices[0].message, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n';
  for (const text of [JSON.stringify(partialBatch), partialSse]) {
    let requests = 0, reads = 0, writes = 0, resets = 0;
    const statuses = [];
    mockIPC((cmd, args) => {
      if (cmd === 'read_text_file_for_agent') { reads++; return { path: args.filePath, content: 'old', truncated: false }; }
      if (cmd === 'write_text_file') { writes++; assert.equal(args.content, 'RECOVERED'); return { path: args.filePath, bytes: 9 }; }
      if (cmd !== 'llm_proxy_stream') throw new Error(cmd);
      const body = args.request.body;
      requests++;
      assert.equal(body.max_tokens, 4096, 'recovery must respect an explicit output allowance');
      if (requests === 1) return response(JSON.stringify({ tool_calls: [{ id: 'read-once', name: 'read_file', arguments: { file_path: 'D:/fixture/result.txt' } }] }));
      assert.equal(body.messages.filter(message => message.role === 'tool').length, 1);
      assert(!JSON.stringify(body.messages).includes('INCOMPLETE_SOURCE'));
      assert(!JSON.stringify(body.messages).includes('DO_NOT_WRITE'));
      if (requests === 2) return { status: 200, statusText: 'OK', text };
      assert.match(body.messages[0].content, /输出截断恢复 1\/2/);
      return response(JSON.stringify({ tool_calls: [{ id: 'write-once', name: 'save_text_file', arguments: { path: 'D:/fixture/result.txt', content: 'RECOVERED' } }] }));
    }, { shouldMockEvents: true });
    const trace = await api.startAgentRun({ config: { ...config, maxTokens: 4096 }, userInput: '读取 D:/fixture/result.txt 并更新其中的内容', history: [], sessionId: null, maxSteps: 2, onAssistantStart: () => resets++, onStatus: value => statuses.push(value) }).promise;
    assert.equal(requests, 3); assert.equal(reads, 1); assert.equal(writes, 1);
    assert.equal(trace.steps.length, 2); assert.equal(trace.toolCallCount, 2);
    assert.equal(trace.steps[1].toolResults[0].ok, true);
    assert.equal(resets, 3);
    assert(statuses.some(value => value.includes('自动拆小操作')));
    clearMocks();
  }
  console.log('PASS truncated JSON/SSE turns recover without executing partial batches or replaying completed tools');

  let mixedAttempts = 0;
  mockIPC((cmd, args) => {
    if (cmd !== 'llm_proxy_stream') throw new Error(cmd);
    mixedAttempts++;
    assert.equal(args.request.body.max_tokens, 8192);
    if (mixedAttempts === 1 || mixedAttempts === 3) return { status: 200, statusText: 'OK', text: JSON.stringify(truncatedPayload) };
    if (mixedAttempts === 2) return { status: 503, statusText: 'Unavailable', text: '{"error":{"message":"temporary outage"}}' };
    assert.match(args.request.body.messages[0].content, /输出截断恢复 2\/2/);
    return response('你好！我可以帮你编写易语言代码。');
  }, { shouldMockEvents: true });
  const recoveredAnswer = await api.startAgentRun({ config: { ...config, maxTokens: 8192 }, userInput: '你好', history: [], sessionId: null }).promise;
  assert.equal(mixedAttempts, 4);
  assert.equal(recoveredAnswer.outcome, 'answer'); assert.equal(recoveredAnswer.steps.length, 1);
  assert.equal(recoveredAnswer.finalAnswer, '你好！我可以帮你编写易语言代码。');
  clearMocks();
  console.log('PASS independent network/output retry budgets can recover to a complete answer in the same turn');

  let cancelledRequests = 0;
  const cancelRecovery = new AbortController();
  mockIPC(cmd => {
    if (cmd === 'llm_proxy_stream') { cancelledRequests++; return { status: 200, statusText: 'OK', text: JSON.stringify(truncatedPayload) }; }
    if (cmd !== 'cancel_agent_task') throw new Error(cmd);
  }, { shouldMockEvents: true });
  const cancelledRecoveryTrace = await api.startAgentRun({ config, userInput: '你好', history: [], sessionId: null, signal: cancelRecovery.signal, onStatus: value => { if (value.includes('自动拆小操作')) cancelRecovery.abort(); } }).promise;
  assert.equal(cancelledRecoveryTrace.outcome, 'aborted'); assert.equal(cancelledRequests, 1);
  clearMocks();
  let rejectedRequests = 0;
  mockIPC(cmd => {
    if (cmd === 'llm_proxy_stream') { rejectedRequests++; return { status: 400, statusText: 'Bad Request', text: '{"error":{"message":"invalid max_tokens"}}' }; }
    throw new Error(cmd);
  }, { shouldMockEvents: true });
  const rejected = await api.startAgentRun({ config, userInput: '你好', history: [], sessionId: null }).promise;
  assert.equal(rejected.outcome, 'error'); assert.equal(rejectedRequests, 1);
  clearMocks();
  console.log('PASS output recovery respects cancellation and does not retry unrelated HTTP 400 errors');

  // A successful compile is evidence; do not ask a separate reviewer to
  // rewrite a deliverable or hide it after a global revision budget.
  for (const maxSteps of [3, 12]) {
    let main = 0;
    mockIPC((cmd, args) => {
      if (cmd === 'compile_efile') return { success: true, output_path: 'D:/fixture/main.exe' };
      if (cmd === 'llm_proxy_stream') {
        assert(args.request.body.messages[0].content.startsWith('你是 易语言 AI Coding Agent'), 'no independent reviewer request');
        main++;
        return response(JSON.stringify(main === 1 ? { tool_calls: [{ name: 'compile_efile', arguments: { target_path: 'D:/fixture/main.e' } }] } : { final_answer: '编译通过：D:/fixture/main.exe' }));
      }
      throw new Error(cmd);
    }, { shouldMockEvents: true });
    const trace = await api.startAgentRun({ config, userInput: '检查 D:/fixture/main.e 编译结果', history: [], sessionId: null, allowDialog: false, maxSteps }).promise;
    assert.equal(main, 2);
    assert.equal(trace.outcome, 'answer');
    assert.match(trace.finalAnswer, /main.exe/);
    clearMocks();
  }
  console.log('PASS compiled deliverable completes without reviewer requests or a global revision cap');

  let reads = 0;
  mockIPC((cmd, args) => {
    if (cmd === 'read_text_file_for_agent') return { path: args.filePath, content: 'same source', encoding: 'utf-8', bytes: 11, truncated: false };
    if (cmd === 'llm_proxy_stream') return response(++reads <= 4 ? JSON.stringify({ tool_calls: [{ name: 'read_file', arguments: { file_path: 'D:/fixture/config.json' } }] }) : '配置已读取。');
    throw new Error(cmd);
  }, { shouldMockEvents: true });
  const readTrace = await api.startAgentRun({ config, userInput: '检查配置内容', history: [], sessionId: null }).promise;
  assert.equal(readTrace.outcome, 'answer'); assert.equal(reads, 5);
  clearMocks();
  console.log('PASS repeated successful reads do not trigger a false no-progress stop');

  const uploadedPath = 'D:/fixture/user-modules/fish.ec';
  const uploaded = { id: 'fish', name: '鱼刺类.多线程6', storedPath: uploadedPath, status: 'indexing', apiCount: 1, hasVectorIndex: false };
  const apiEntry = { id: 'start', kind: 'subprogram', name: '启动线程', className: '鱼刺线程池', returnType: '整数型', description: '启动多线程任务', line: 3, params: [], signature: '启动线程 ()', isPublic: true };
  globalThis.fixtureIdb.set('eaicoding-user-module:fish', { moduleId: 'fish', apis: [apiEntry], assemblies: [], vectorIndex: null });
  api.useSettingsStore.setState({ userModules: [uploaded, { ...uploaded, id: 'waiting', name: '正在解析模块', status: 'parsing', apiCount: 0 }] });
  const matches = await api.searchUserModules('启动线程', { useVector: false });
  assert.equal(matches.matches[0].module_path, uploadedPath);
  assert.deepEqual(matches.module_paths, [uploadedPath]);
  assert.deepEqual(matches.searched_modules.map(m => m.id), ['fish']);
  assert.deepEqual(matches.unavailable_modules.map(m => m.id), ['waiting']);
  let moduleRound = 0;
  mockIPC((cmd, args) => {
    if (cmd === 'generate_gui_project') {
      assert.deepEqual(args.modulePaths, [uploadedPath], 'retrieval dependencies reach generation without manually repeating a path');
      return { success: true, output_path: 'D:/fixture/login.e' };
    }
    if (cmd === 'compile_efile') {
      assert.deepEqual(args.modulePaths, [uploadedPath]);
      return { success: true, output_path: 'D:/fixture/login.exe' };
    }
    if (cmd === 'llm_proxy_stream') {
      moduleRound++;
      const messages = args.request.body.messages;
      assert(!JSON.stringify(messages).includes('auto_jingyi_') || messages.some(m => m.tool_calls?.some(c => c.function?.name === 'search_user_modules')));
      if (moduleRound === 1) {
        assert(messages[0].content.includes('鱼刺类.多线程6'));
        assert(messages.some(m => m.role === 'tool' && m.content.includes('module_paths')));
        return response(JSON.stringify({ tool_calls: [{ name: 'generate_gui_project', arguments: { project: { windows: [] } } }, { name: 'compile_efile', arguments: { target_path: 'D:/fixture/login.e' } }] }));
      }
      return response('窗口已生成并编译通过：D:/fixture/login.exe');
    }
    throw new Error(cmd);
  }, { shouldMockEvents: true });
  const moduleTrace = await api.startAgentRun({ config, userInput: '帮我写多线程窗口', history: [], sessionId: null }).promise;
  assert.equal(moduleTrace.outcome, 'answer', moduleTrace.finalAnswer);
  assert.equal(moduleTrace.steps[0].toolCalls[0].name, 'search_user_modules');
  assert(!moduleTrace.steps.some(s => s.toolCalls.some(c => c.name === 'search_jingyi_module')));
  api.useSettingsStore.setState({ userModules: [] });
  clearMocks();
  console.log('PASS indexing lexical search, truthful consulted modules, user-library priority and automatic dependency propagation');

  // Reproduce the live failure: edits in turn 12 must reach a build in 13,
  // followed by a final answer. Neither 12, 20, 32 nor 64 is a default ceiling.
  for (const mutations of [12, 70]) {
    let rounds = 0, builds = 0;
    const projectDir = 'D:/fixture/login-project';
    const sourcePath = projectDir + '/代码/窗口程序集_启动窗口.form.e.txt';
    mockIPC((cmd, args) => {
      if (cmd === 'generate_gui_project') return { success: true, ecode_dir: projectDir, output_path: projectDir + '/登录窗口.e' };
      if (cmd === 'read_text_file_for_agent') return { path: args.filePath, content: 'metadata', encoding: 'utf-8', bytes: 8, truncated: false };
      if (cmd === 'write_text_file') return { path: args.filePath, bytes: args.content.length };
      if (cmd === 'generate_efile_from_ecode') { builds++; return { success: true, output_path: projectDir + '/最新登录窗口.e', stdout: 'SUCC:', stderr: '', files: [] }; }
      if (cmd === 'compile_efile') return { success: true, output_path: projectDir + '/最新登录窗口.exe', stdout: '编译成功', stderr: '' };
      if (cmd !== 'llm_proxy_stream') throw new Error(cmd);
      const body = args.request.body;
      if (!body.messages[0].content.startsWith('你是 易语言 AI Coding Agent')) return response('{"pass":true,"confidence":1,"issues":[]}');
      assert(!/最多 (?:12|20|32|64|Infinity) (?:步|轮)/.test(body.messages[0].content));
      assert(body.tools.some(tool => tool.function.name === 'build_ecode_project'));
      rounds++;
      if (rounds === 1) return response(JSON.stringify({ tool_calls: [{ name: 'generate_gui_project', arguments: { project: { windows: [] } } }] }));
      if (rounds < mutations) return response(JSON.stringify({ tool_calls: [{ name: 'read_file', arguments: { file_path: projectDir + '/metadata-' + rounds + '.json' } }] }));
      if (rounds === mutations) return response(JSON.stringify({ tool_calls: [{ name: 'save_text_file', arguments: { path: sourcePath, content: code } }] }));
      if (rounds === mutations + 1) {
        assert.match(body.messages.at(-1).content, /最新源码修改尚未验证/);
        return response(JSON.stringify({ tool_calls: [{ name: 'build_ecode_project', arguments: { ecode_dir: projectDir } }] }));
      }
      assert.equal(builds, 1);
      return response('最新窗口源码已回编并编译通过。');
    }, { shouldMockEvents: true });
    const statuses = [];
    const trace = await api.startAgentRun({ config, userInput: '制作登录窗口，检查界面并完成编译', history: [], sessionId: null, onStatus: status => statuses.push(status) }).promise;
    assert.equal(trace.outcome, 'answer', trace.finalAnswer); assert.equal(rounds, mutations + 2); assert.equal(builds, 1);
    assert.equal(trace.steps.at(-2).toolCalls[0].name, 'build_ecode_project');
    assert.equal(trace.steps.at(-1).finishReason, 'answer');
    assert(!statuses.some(status => /Infinity|第 \d+\/\d+ 步/.test(status)));
    clearMocks();
  }
  console.log('PASS default native loop crosses 12/20/32/64 turns and builds the latest edit before completing');

  let prematureRounds = 0;
  mockIPC((cmd) => {
    if (cmd === 'generate_gui_project') return { success: true, ecode_dir: 'D:/fixture/pending', output_path: 'D:/fixture/pending/main.e' };
    if (cmd === 'llm_proxy_stream') {
      prematureRounds++;
      return response(prematureRounds === 1 ? JSON.stringify({ tool_calls: [{ name: 'generate_gui_project', arguments: { project: { windows: [] } } }] }) : '已经完成，可以使用了。');
    }
    throw new Error(cmd);
  }, { shouldMockEvents: true });
  const premature = await api.startAgentRun({ config, userInput: '制作窗口并编译', history: [], sessionId: null }).promise;
  assert.equal(premature.outcome, 'error'); assert.equal(prematureRounds, 4);
  assert.match(premature.finalAnswer, /没有执行所需工具/);
  assert(!premature.finalAnswer.includes('安全步骤上限'));
  clearMocks();
  console.log('PASS no-tool premature completion stops for lack of progress without a default step cap');

  const sse = events => ({ status: 200, statusText: 'OK', text: events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') + 'data: [DONE]\n\n' });
  const delta = part => ({ choices: [{ index: 0, delta: part, finish_reason: null }] });
  const finish = { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
  const fragments = sse([
    delta({ reasoning_content: 'REPLAY_STATE_' }), delta({ reasoning_content: 'ONE' }),
    delta({ tool_calls: [{ index: 0, id: 'plan-1', function: { name: 'update_plan', arguments: '{"items":[' } }, { index: 1, id: 'plan-2', function: { name: 'update_plan', arguments: '{"items":[' } }] }),
    delta({ tool_calls: [{ index: 1, function: { arguments: '{"title":"第二项","status":"done"}]}' } }, { index: 0, function: { arguments: '{"title":"第一项","status":"done"}]}' } }] }), finish,
  ]);
  let nativeRounds = 0;
  mockIPC((cmd, args) => {
    if (cmd !== 'llm_proxy_stream') throw new Error(cmd);
    const body = args.request.body;
    assert.equal(body.model, 'deepseek-v4-pro');
    assert(body.tools.some(tool => tool.function.name === 'update_plan'), 'native tools must remain enabled after tool results');
    assert(!body.messages[0].content.includes('跨服务商文本 JSON'), 'main prompt must use native tools');
    if (++nativeRounds === 1) return fragments;
    const assistant = body.messages.find(message => message.tool_calls?.some(call => call.id === 'plan-1'));
    assert.equal(assistant.reasoning_content, 'REPLAY_STATE_ONE');
    assert.deepEqual(assistant.tool_calls.map(call => [call.id, JSON.parse(call.function.arguments).items[0].title]), [['plan-1', '第一项'], ['plan-2', '第二项']]);
    assert.deepEqual(body.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['plan-1', 'plan-2']);
    return response('计划已整理完成。');
  }, { shouldMockEvents: true });
  const progress = [], assistantStarts = [], reasoningDeltas = [];
  const nativeTrace = await api.startAgentRun({ config: { ...config, model: 'deepseek-v4-pro' }, userInput: '整理开发步骤', history: [], sessionId: null,
    onAssistantStart: index => assistantStarts.push(index),
    onReasoningToken: (token, index) => reasoningDeltas.push([token, index]),
    onToolProgress: (step, trace, activeToolId) => progress.push({ step, trace, activeToolId }),
  }).promise;
  assert.equal(nativeTrace.outcome, 'answer'); assert.equal(nativeRounds, 2);
  assert.equal(nativeTrace.toolCallCount, 2);
  assert(!nativeTrace.finalAnswer.includes('REPLAY_STATE'));
  assert.deepEqual(reasoningDeltas, [['REPLAY_STATE_', 1], ['ONE', 1]]);
  assert.equal(nativeTrace.steps[0].reasoningContent, 'REPLAY_STATE_ONE');
  assert(progress.every(item => item.step.reasoningContent === 'REPLAY_STATE_ONE'), 'reasoning must survive the transition to pending/running/completed tools');
  assert.deepEqual(assistantStarts, [1, 2]);
  assert.deepEqual(progress.map(item => [item.activeToolId, item.step.toolResults.length]), [['plan-1', 0], [undefined, 1], ['plan-2', 1], [undefined, 2]]);
  assert.equal(progress[0].trace.steps.length, 1, 'a saved progress snapshot must not gain later steps');
  assert.equal(progress[0].step.toolResults.length, 0, 'pending snapshot must stay pending after execution');
  assert(progress.every(item => item.trace.toolCallCount === 2));
  clearMocks();
  console.log('PASS fragmented/interleaved native tools, Reasoner replay, all-round tool definitions and immediate Markdown completion');

  for (const malformed of [
    sse([delta({ tool_calls: [{ index: 0, id: 'partial', function: { name: 'update_plan', arguments: '{"items":' } }] })]),
    sse([delta({ tool_calls: [{ index: 0, id: 'invalid', function: { name: 'update_plan', arguments: '{broken' } }] }), finish]),
  ]) {
    mockIPC(cmd => { if (cmd === 'llm_proxy_stream') return malformed; throw new Error(cmd); }, { shouldMockEvents: true });
    let failure;
    await new api.OpenAIChatCompletionsProvider(config).stream([], { onToken() {}, onComplete() { assert.fail('malformed call accepted'); }, onToolCall() { assert.fail('malformed call executed'); }, onError(error) { failure = error; } });
    assert(failure); clearMocks();
  }
  console.log('PASS interrupted SSE and malformed tool arguments fail before any tool is released');

  mockIPC(cmd => {
    if (cmd !== 'llm_proxy_stream') assert.fail('tool example in answer text must never execute');
    return { status: 200, statusText: 'OK', text: JSON.stringify({ choices: [{ message: { content: '下面是协议示例：\n```json\n{"tool_calls":[{"name":"save_text_file","arguments":{"path":"D:/never.txt","content":"example"}}]}\n```' }, finish_reason: 'stop' }] }) };
  }, { shouldMockEvents: true });
  const protocolExample = await api.startAgentRun({ config, userInput: '解释协议格式', history: [], sessionId: null }).promise;
  assert.equal(protocolExample.outcome, 'answer'); assert.equal(protocolExample.toolCallCount, 0);
  clearMocks();

  let repeats = 0;
  const repeatedPlan = JSON.stringify({ tool_calls: [{ name: 'update_plan', arguments: { items: [{ title: 'unchanged' }] } }] });
  mockIPC(cmd => { if (cmd === 'llm_proxy_stream') { repeats++; return response(repeatedPlan); } throw new Error(cmd); }, { shouldMockEvents: true });
  const stalled = await api.startAgentRun({ config, userInput: '整理步骤', history: [], sessionId: null }).promise;
  assert.equal(stalled.outcome, 'error'); assert.equal(repeats, 3); assert.match(stalled.finalAnswer, /重复相同操作/);
  clearMocks();
  for (const mode of ['plan', 'read-only']) {
    let rounds = 0;
    mockIPC((cmd, args) => {
      if (cmd !== 'llm_proxy_stream') assert.fail('restricted mode reached a write/build backend: ' + cmd);
      assert(!args.request.body.tools.some(tool => ['save_text_file', 'generate_gui_project', 'compile_efile'].includes(tool.function.name)));
      return response(++rounds === 1 ? JSON.stringify({ tool_calls: [{ name: 'save_text_file', arguments: { path: 'D:\\fixture\\never-written.txt', content: 'forbidden' } }] }) : '已完成分析，建议先确认依赖，再实现窗口事件。');
    }, { shouldMockEvents: true });
    const trace = await api.startAgentRun({ config, mode, userInput: '分析开发步骤', history: [], sessionId: null }).promise;
    assert.equal(trace.outcome, 'answer'); assert.equal(rounds, 2);
    assert.equal(trace.steps[0].toolResults[0].ok, false);
    clearMocks();
  }
  const choiceArgs = { question: '请选择技术入口', options: [{ label: 'A' }, { label: 'B' }] };
  const technicalChoice = await api.executeTool('ask_user_choice', 'technical', choiceArgs, { sessionId: null, userInput: '帮我实现', allowDialog: false });
  assert.equal(technicalChoice.content.needs_user_choice, false);
  const essentialChoice = await api.executeTool('ask_user_choice', 'essential', { ...choiceArgs, required_information: true }, { sessionId: null, userInput: '帮我实现', allowDialog: false });
  assert.equal(essentialChoice.content.needs_user_choice, true);
  console.log('PASS no-progress termination, plan/read-only enforcement and autonomous technical selection');

  let toolStarted;
  const toolReady = new Promise(resolve => { toolStarted = resolve; });
  let cancelled = false;
  mockIPC((cmd) => {
    if (cmd === 'llm_proxy_stream') return response(JSON.stringify({ tool_calls: [{ name: 'compile_efile', arguments: { target_path: 'D:\\fixture\\main.e' } }] }));
    if (cmd === 'compile_efile') { toolStarted(); return new Promise(() => {}); }
    if (cmd === 'cancel_agent_task') { cancelled = true; return; }
    throw new Error(cmd);
  }, { shouldMockEvents: true });
  const handle = api.startAgentRun({ config, userInput: '编译 D:\\fixture\\main.e', history: [], sessionId: null });
  await toolReady; handle.abort();
  const aborted = await Promise.race([handle.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('tool abort hung')), 300))]);
  assert.equal(aborted.outcome, 'aborted'); assert(cancelled);
  clearMocks();
  assert.throws(() => api.createLLMProvider({ ...config, provider: 'gemini' }), /仅支持 DeepSeek/);
  assert.equal(api.useSettingsStore.getState().profiles[0].provider, 'deepseek');
  assert(api.TOOL_DEFINITIONS.some(t => t.name === 'generate_gui_project'));
  console.log('PASS cancellation during tool execution, DeepSeek-only factory and GUI registration');
} finally {
  clearMocks(); delete globalThis.window;
  await rm(temp, { recursive: true, force: true });
}
