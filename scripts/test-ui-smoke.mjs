import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';

// Uses an installed Playwright or the desktop app's bundled browser runtime.
const { chromium } = process.env.EAICODING_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.EAICODING_PLAYWRIGHT_MODULE).href)
  : await import('playwright');
const root = process.cwd();
const sourceRoot = path.join(root, 'src').replaceAll('\\', '/');
await mkdir(path.join(root, '.tmp'), { recursive: true });
const fixture = await mkdtemp(path.join(root, '.tmp/ui-smoke-'));
const screenshots = path.join(root, '.tmp/ui-validation');
await mkdir(screenshots, { recursive: true });
await writeFile(path.join(fixture, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/assets/entry.js"></script></body></html>');
await writeFile(path.join(fixture, 'entry.tsx'), `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { idbStorage } from '${sourceRoot}/lib/idb-storage';
import '${sourceRoot}/i18n';
import '${sourceRoot}/index.css';
import '${sourceRoot}/styles/syntax.css';
import '${sourceRoot}/styles/epl.css';
import '${sourceRoot}/styles/harness.css';
import '${sourceRoot}/styles/settings.css';
import '${sourceRoot}/styles/composer.css';
window.fixtureIpc = [];
window.fixtureRequests = [];
const writeSettings = idbStorage.setItem.bind(idbStorage);
idbStorage.setItem = async (name, value) => {
  if (window.fixtureFailStorage && name === 'eaicoding-settings') throw new Error('fixture IndexedDB write failed');
  return writeSettings(name, value);
};
mockIPC((cmd, args) => {
  window.fixtureIpc.push(cmd);
  if (cmd === 'read_text_file_for_agent') {
    window.fixtureReads = [...(window.fixtureReads ?? []), args];
    if (window.fixtureReadFailure) throw new Error('fixture 文件暂时不可读');
    return { path: args.filePath, encoding: 'utf-8', bytes: 100, ...window.fixtureReadResponse };
  }
  if (cmd === 'llm_proxy_stream') {
    window.fixtureRequests.push(args.request.body);
    if (window.fixtureStreamMode) {
      window.fixturePendingRequest = args.request;
      return new Promise(resolve => { window.fixtureResolveStream = resolve; });
    }
    return { status: 200, statusText: 'OK', text: JSON.stringify({ choices: [{ message: { content: '开发步骤已整理。' }, finish_reason: 'stop' }] }) };
  }
  if (cmd === 'plugin:dialog|open') return ['D:\\\\fixture\\\\示例.ec'];
  if (cmd === 'encrypt_secret') { if (window.fixtureFailSave) throw new Error('fixture save failed'); return 'encrypted-fixture'; }
  if (cmd === 'decrypt_secret') return 'fixture-key';
  if (cmd === 'fetch_llm_models') {
    const result = { models: (window.fixtureLegacyCatalog ? ['deepseek-chat', 'deepseek-reasoner'] : ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'unsupported-fixture']).map(id => ({ id, ownedBy: 'DeepSeek' })) };
    if (window.fixtureDeferModels) return new Promise(resolve => { window.fixtureResolveModels = () => { window.fixtureDeferModels = false; resolve(result); }; });
    return result;
  }
  if (cmd.includes('is_maximized')) return false;
  return null;
}, { shouldMockEvents: true });
mockWindows('main');
window.fixtureEmitToken = async content => emit('llm-proxy-stream-chunk', { requestId: window.fixturePendingRequest.requestId, text: 'data: ' + JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] }) + '\\n\\n' });
window.fixtureEmitReasoning = async reasoning_content => emit('llm-proxy-stream-chunk', { requestId: window.fixturePendingRequest.requestId, text: 'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content }, finish_reason: null }] }) + '\\n\\n' });
window.fixtureFinishStream = async () => {
  await emit('llm-proxy-stream-chunk', { requestId: window.fixturePendingRequest.requestId, text: 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\\n\\ndata: [DONE]\\n\\n' });
  window.fixtureResolveStream({ status: 200, statusText: 'OK', text: '' });
  window.fixtureStreamMode = false;
};
await writeSettings('eaicoding-settings', JSON.stringify({ version: 5, state: {
  profiles: [{ id: 'default', name: 'DeepSeek', provider: 'deepseek', protocol: 'openai-chat-completions', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }], apiKeyEncrypted: '', maxTokens: 8192, temperature: 0.2 }],
  activeProfileId: 'default', modelCatalogs: { default: [{ id: 'obsolete-fixture' }] }
} }));
const { useSettingsStore } = await import('${sourceRoot}/stores/settings');
const { useChatStore } = await import('${sourceRoot}/stores/chat');
await useSettingsStore.persist.rehydrate();
await useChatStore.persist.rehydrate();
// A legacy approval preference must not turn the coding UI into a gated mode.
useSettingsStore.setState({ petEnabled: false, approveSourceEdits: true });
window.fixtureSettings = useSettingsStore;
window.fixtureChat = useChatStore;
window.fixtureFlushChat = (await import('${sourceRoot}/stores/chat-storage')).flushChatStorage;
const { default: App } = await import('${sourceRoot}/App');
createRoot(document.getElementById('root')).render(<App />);
`);
await build({ entryPoints: [path.join(fixture, 'entry.tsx')], outdir: path.join(fixture, 'assets'), bundle: true,
  splitting: true, format: 'esm', platform: 'browser', tsconfig: path.join(root, 'tsconfig.json'),
  external: ['@huggingface/transformers'], loader: { '.css': 'empty' }, logLevel: 'error' });
const builtCss = (await readdir(path.join(root, 'dist/assets'))).find(name => /^index-.*\.css$/.test(name));
if (!builtCss) throw new Error('Run npm run build before the browser smoke');
await writeFile(path.join(fixture, 'style.css'), await readFile(path.join(root, 'dist/assets', builtCss)));
const server = createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.resolve(fixture, '.' + (name === '/' ? '/index.html' : name));
    if (!file.startsWith(fixture + path.sep)) { res.writeHead(403); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(await readFile(name === '/icon.ico' ? path.join(root, 'public/icon.ico') : file));
  } catch { res.writeHead(404); res.end(); }
});
let browser;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  browser = await chromium.launch({ headless: true, ...(process.env.EAICODING_BROWSER_CHANNEL ? { channel: process.env.EAICODING_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByRole('textbox', { name: '消息输入框', exact: true }).fill('设置弹窗关闭后保留这份需求');
  await page.evaluate(() => { window.fixtureComposerNode = document.querySelector('[aria-label="消息输入框"]'); });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const settingsDialog = page.getByRole('dialog', { name: '设置', exact: true });
  await settingsDialog.waitFor();
  assert.equal(await settingsDialog.getAttribute('aria-modal'), 'true');
  assert.equal(await page.evaluate(() => window.fixtureComposerNode.isConnected), true, 'opening settings must keep the chat mounted');
  assert.equal(await page.evaluate(() => document.querySelector('.settings-dialog').contains(document.activeElement)), true, 'focus moves into settings');
  assert.equal(await page.getByRole('tab', { name: '通用', selected: true }).count(), 1);
  assert.deepEqual(await page.getByRole('tab').allTextContents(), ['通用', '模型', '易语言环境', '模块库']);
  await settingsDialog.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
  const layout = await page.evaluate(() => ({
    modal: document.querySelector('.settings-dialog').getBoundingClientRect().toJSON(),
    rail: document.querySelector('.settings-nav').getBoundingClientRect().width,
    nav: document.querySelector('.settings-navigation button').getBoundingClientRect().height,
    header: document.querySelector('.settings-header').getBoundingClientRect().height,
  }));
  assert.equal(layout.modal.width, 800);
  assert.equal(layout.modal.height, 800);
  assert.equal(layout.rail, 188);
  assert.equal(layout.nav, 40);
  assert.equal(layout.header, 54);
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  const openProviderEditor = async () => {
    if (!await page.locator('#deepseek-editor').isVisible()) await page.getByRole('button', { name: '编辑', exact: true }).click();
    if (!await page.locator('.settings-customized').evaluate(node => node.open)) await page.locator('.settings-customized > summary').click();
  };
  await page.locator('#deepseek-key').waitFor();
  assert.equal(await page.locator('.provider-row-head').count(), 0, 'initial setup directly shows the key editor');
  assert.equal(await page.locator('#deepseek-url').isVisible(), false, 'custom settings start collapsed');
  await page.screenshot({ path: path.join(screenshots, 'settings-light.png'), fullPage: true, animations: 'disabled' });
  await openProviderEditor();
  assert.equal(await page.locator('#deepseek-key').inputValue(), '');
  assert.equal(await page.locator('#deepseek-url').inputValue(), 'https://api.deepseek.com');
  const defaultModels = page.locator('#deepseek-model input[type="radio"]');
  assert.deepEqual(await defaultModels.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro']);
  assert.equal(await defaultModels.filter({ visible: true }).count(), 2);
  assert.deepEqual(await page.locator('.settings-model-id').evaluateAll(nodes => nodes.map(node => node.value)), ['deepseek-flash', 'deepseek-v4-pro']);
  assert.equal(await page.locator('#deepseek-model input:checked').inputValue(), 'deepseek-flash');
  await page.screenshot({ path: path.join(screenshots, 'settings-customized.png'), fullPage: true, animations: 'disabled' });
  await page.locator('#deepseek-key').fill('fixture-only-key');
  await page.getByRole('button', { name: '显示密钥', exact: true }).click();
  assert.equal(await page.locator('#deepseek-key').getAttribute('type'), 'text');
  await page.locator('#deepseek-key').fill('changed-fixture-key');
  assert.equal(await page.locator('#deepseek-key').getAttribute('type'), 'password');
  const detectionCount = await page.evaluate(() => window.fixtureIpc.filter(command => command === 'fetch_llm_models').length);
  await page.locator('#deepseek-url').fill('not-a-url');
  await page.getByRole('button', { name: '检测连接并获取模型', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '请输入完整的 http/https' }).waitFor();
  assert.equal(await page.locator('#deepseek-url').getAttribute('aria-invalid'), 'true');
  assert.equal(await page.locator('#deepseek-url').evaluate(node => node === document.activeElement), true);
  assert.equal(await page.evaluate(() => window.fixtureIpc.filter(command => command === 'fetch_llm_models').length), detectionCount, 'invalid connection fields must not issue a request');
  await page.locator('#deepseek-url').fill('https://api.deepseek.com');
  assert.equal(await page.getByRole('alert').count(), 0);
  await page.locator('.settings-advanced summary').click();
  await page.locator('#deepseek-tokens').fill('0');
  await page.locator('.settings-advanced summary').click();
  await page.locator('.settings-customized > summary').click();
  await page.getByRole('button', { name: '应用', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '必须是正整数' }).waitFor();
  assert.equal(await page.locator('#deepseek-tokens').evaluate(node => node === document.activeElement), true);
  await page.locator('#deepseek-tokens').fill('8192');
  await page.locator('.settings-advanced summary').click();
  await page.locator('.settings-model-choice').nth(1).click({ position: { x: 15, y: 12 } });
  assert.equal(await page.getByRole('radio', { name: 'DeepSeek-V4-Pro', exact: true }).isChecked(), true, 'clicking the model row selects its default radio');
  await page.getByRole('button', { name: '显示密钥', exact: true }).click();
  await page.getByRole('tab', { name: '通用', exact: true }).click();
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  assert.equal(await page.locator('#deepseek-key').inputValue(), 'changed-fixture-key', 'category switches must retain the key draft');
  assert.equal(await page.locator('#deepseek-key').getAttribute('type'), 'password', 'returning to the section must conceal a revealed key');
  assert.equal(await page.locator('#deepseek-model input:checked').inputValue(), 'deepseek-v4-pro');
  await page.getByRole('radio', { name: 'DeepSeek-V4.1-Flash', exact: true }).check();
  await page.getByRole('button', { name: '应用', exact: true }).click();
  await page.getByLabel('密钥已配置', { exact: true }).waitFor();
  await page.locator('#deepseek-editor').waitFor({ state: 'hidden' });
  await page.screenshot({ path: path.join(screenshots, 'settings-saved.png'), animations: 'disabled' });
  await openProviderEditor();
  assert.equal(await page.locator('#deepseek-key').inputValue(), '', 'stored keys must not be loaded into the input');
  assert.equal(await page.evaluate(() => window.fixtureIpc.filter(c => c === 'decrypt_secret').length), 0);
  await page.locator('#deepseek-url').fill('https://cancelled.example');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByText('未保存', { exact: true }).waitFor();
  await openProviderEditor();
  assert.equal(await page.locator('#deepseek-url').inputValue(), 'https://cancelled.example', 'collapsing the editor must retain its draft');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await openProviderEditor();
  assert.equal(await page.locator('#deepseek-url').inputValue(), 'https://api.deepseek.com');
  await page.evaluate(() => { window.fixtureFailSave = true; });
  await page.locator('#deepseek-key').fill('failed-fixture-key');
  await page.getByRole('button', { name: '应用', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '保存失败' }).waitFor();
  assert.equal(await page.locator('#deepseek-key').inputValue(), 'failed-fixture-key');
  await page.evaluate(() => { window.fixtureFailSave = false; });
  await page.evaluate(() => { window.fixtureFailStorage = true; });
  await page.locator('#deepseek-url').fill('https://unsaved.example');
  await page.getByRole('button', { name: '应用', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'IndexedDB write failed' }).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureSettings.getState().profiles[0].baseUrl), 'https://api.deepseek.com');
  await page.evaluate(() => { window.fixtureFailStorage = false; });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await openProviderEditor();
  await page.getByRole('button', { name: '检测连接并获取模型', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
  await page.evaluate(() => { window.fixtureDeferModels = true; });
  await page.getByRole('button', { name: '检测连接并获取模型', exact: true }).click();
  await page.getByRole('button', { name: '检测中…', exact: true }).waitFor();
  await page.getByRole('tab', { name: '通用', exact: true }).click();
  await page.evaluate(() => window.fixtureResolveModels());
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
  assert.deepEqual(await page.locator('.settings-model-name').evaluateAll(nodes => nodes.map(node => node.value)), ['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro']);
  await page.evaluate(() => { window.fixtureLegacyCatalog = true; });
  await page.getByRole('button', { name: '检测连接并获取模型', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '未返回 DeepSeek' }).waitFor();
  assert.equal(await page.locator('.settings-model-name').count(), 2);
  await page.evaluate(() => { window.fixtureLegacyCatalog = false; });
  await page.getByRole('button', { name: '检测连接并获取模型', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '连接成功' }).waitFor();
  const savedKey = await page.evaluate(() => window.fixtureSettings.getState().profiles[0].apiKeyEncrypted);
  await page.getByRole('button', { name: '移除密钥', exact: true }).click();
  await page.getByRole('group', { name: '确认移除密钥', exact: true }).waitFor();
  await page.getByRole('button', { name: '保留密钥', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixtureSettings.getState().profiles[0].apiKeyEncrypted), savedKey);
  await page.getByRole('button', { name: '移除密钥', exact: true }).click();
  await page.getByRole('button', { name: '确认移除', exact: true }).click();
  await page.getByLabel('未配置密钥', { exact: true }).waitFor();
  assert.equal(await page.locator('#deepseek-key').inputValue(), '');
  await page.locator('#deepseek-key').fill('replacement-fixture-key');
  await page.getByRole('button', { name: '应用', exact: true }).click();
  await page.locator('#deepseek-editor').waitFor({ state: 'hidden' });
  await openProviderEditor();
  console.log('PASS V5 model migration, exactly two supported models, write-only key, encryption/storage rollback and discovery filtering');
  await page.evaluate(() => window.fixtureSettings.getState().setTheme('dark'));
  await page.screenshot({ path: path.join(screenshots, 'settings-dark.png'), fullPage: true, animations: 'disabled' });
  await page.evaluate(() => window.fixtureSettings.getState().setTheme('light'));
  const modelPanelBounds = await settingsDialog.boundingBox();
  await page.getByRole('tab', { name: '通用', exact: true }).click();
  const appearancePanelBounds = await settingsDialog.boundingBox();
  assert.deepEqual(appearancePanelBounds, modelPanelBounds, 'switching sections must not resize the modal');
  await page.getByRole('radio', { name: '深色', exact: true }).focus();
  await page.keyboard.press('Space');
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), true);
  await page.getByRole('radio', { name: '浅色', exact: true }).focus();
  await page.keyboard.press('Space');
  const petSwitch = page.getByRole('switch', { name: '显示宠物', exact: true });
  await petSwitch.check();
  assert.equal(await page.evaluate(() => window.fixtureSettings.getState().petEnabled), true);
  await petSwitch.uncheck();
  await page.screenshot({ path: path.join(screenshots, 'settings-appearance.png'), animations: 'disabled' });
  await page.getByRole('tab', { name: '易语言环境', exact: true }).click();
  await page.getByRole('textbox', { name: '源码生成目录', exact: true }).fill('D:/fixture/generated');
  assert.equal(await page.evaluate(() => window.fixtureSettings.getState().easyLanguageGenerateDir), 'D:/fixture/generated');
  await page.screenshot({ path: path.join(screenshots, 'settings-environment.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await settingsDialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('textbox', { name: '消息输入框', exact: true }).inputValue(), '设置弹窗关闭后保留这份需求');
  assert.equal(await page.getByRole('button', { name: '设置', exact: true }).evaluate(node => node === document.activeElement), true, 'closing settings restores focus to its trigger');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: '易语言环境', selected: true }).count(), 1, 'reopening retains the selected section');
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await openProviderEditor();
  for (const viewport of [{ width: 960, height: 600 }, { width: 390, height: 700 }]) {
    await page.setViewportSize(viewport);
    await page.locator('.settings-pane[data-state="active"]').evaluate(node => { node.scrollTop = 0; });
    await page.screenshot({ path: path.join(screenshots, `settings-${viewport.width}.png`), animations: 'disabled' });
    const bounds = await settingsDialog.boundingBox();
    assert(bounds.x > 0 && bounds.y > 0 && bounds.x + bounds.width < viewport.width && bounds.y + bounds.height < viewport.height, 'settings stays within the viewport');
    const activeSettingsPane = page.locator('.settings-pane[data-state="active"]');
    assert.equal(await activeSettingsPane.evaluate(node => node.scrollWidth > node.clientWidth), false, 'settings content must not overflow horizontally');
    await activeSettingsPane.evaluate(node => { node.scrollTop = 0; });
    const footer = await page.locator('.settings-editor-footer').boundingBox();
    assert(footer.y >= bounds.y && footer.y + footer.height <= bounds.y + bounds.height, 'save actions must stay visible while the long form starts at the top');
    const paneBounds = await activeSettingsPane.boundingBox();
    if (footer.y + footer.height + 6 < paneBounds.y + paneBounds.height) {
      assert.equal(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('.settings-editor-footer')), { x: footer.x + footer.width / 2, y: footer.y + footer.height + 6 }), true, 'form controls must not peek out below the sticky action bar');
    }
    await page.getByRole('radio', { name: 'DeepSeek-V4-Pro', exact: true }).focus();
    assert.equal(await page.getByRole('radio', { name: 'DeepSeek-V4-Pro', exact: true }).evaluate(node => {
      const box = node.getBoundingClientRect();
      return document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === node;
    }), true, 'keyboard focus must reveal the model option above the action bar');
    await activeSettingsPane.evaluate(node => { node.scrollTop = node.scrollHeight; });
    const settingsPosition = await activeSettingsPane.evaluate(node => node.scrollTop);
    await page.getByRole('tab', { name: '通用', exact: true }).click();
    await page.getByRole('tab', { name: '模型', exact: true }).click();
    assert(Math.abs(await activeSettingsPane.evaluate(node => node.scrollTop) - settingsPosition) < 2, 'category switches must retain each section scroll position');
    await page.getByRole('button', { name: '应用', exact: true }).waitFor({ state: 'visible' });
    await page.getByRole('button', { name: '应用', exact: true }).scrollIntoViewIfNeeded();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.querySelector('.settings-dialog').contains(document.activeElement)), true, 'keyboard focus must stay inside the modal');
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.locator('#deepseek-key').fill('discard-on-modal-close-fixture');
  await page.mouse.click(20, 450);
  await settingsDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await openProviderEditor();
  assert.equal(await page.locator('#deepseek-key').inputValue(), '', 'closing the modal must discard uncommitted secrets');
  await page.keyboard.press('Control+,');
  await settingsDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  const retainedInput = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await retainedInput.focus();
  await page.keyboard.press('Control+,');
  await settingsDialog.waitFor();
  await page.keyboard.press('Escape');
  await settingsDialog.waitFor({ state: 'hidden' });
  assert.equal(await retainedInput.evaluate(node => node === document.activeElement), true, 'keyboard settings returns focus even with the sidebar hidden');
  await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  console.log('PASS modal settings: stable size, theme/preferences, environment fields, focus trap/restore, Escape/mask close, narrow layout and retained chat draft');
  await page.evaluate(() => {
    window.fixtureSettings.setState({ userModules: Array.from({ length: 10000 }, (_, index) => ({
      id: 'module-' + index, name: '测试模块 ' + index, sourcePath: 'D:/modules/' + index + '.ec', storedPath: '',
      fileBytes: 4096, status: 'ready', lastError: null, apiCount: 100, classCount: 3, indexedCount: 0, hasVectorIndex: false, createdAt: 0, updatedAt: 0,
    })) });
  });
  const moduleStart = Date.now();
  await page.getByRole('tab', { name: '模块库', exact: true }).click();
  await page.locator('.module-library-row').first().waitFor();
  assert.equal(await page.locator('.module-library-row').count(), 20);
  console.log('PASS module tab with 10,000 modules: only 20 mounted rows; cold open ' + (Date.now() - moduleStart) + 'ms');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.locator('.module-library-row').first().filter({ hasText: '测试模块 20' }).waitFor();
  await page.getByRole('tab', { name: '模型', exact: true }).click();
  await page.getByRole('tab', { name: '模块库', exact: true }).click();
  assert.match(await page.locator('.module-library-row').first().textContent(), /测试模块 20/);
  await page.getByRole('textbox', { name: '搜索模块', exact: true }).fill('测试模块 9999');
  await page.getByRole('status').filter({ hasText: '共 1 个模块' }).waitFor();
  assert.equal(await page.locator('.module-library-row').count(), 1);
  await page.screenshot({ path: path.join(screenshots, 'module-library.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('tab', { name: '易语言环境', exact: true }).click();
  await page.getByRole('tab', { name: '模块库', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '搜索模块', exact: true }).inputValue(), '测试模块 9999');
  await page.getByRole('button', { name: '清除模块搜索', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '共 10000 个模块' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: '搜索模块', exact: true }).evaluate(node => node === document.activeElement), true);
  await page.evaluate(() => window.fixtureSettings.setState({ userModules: [] }));
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await settingsDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.waitFor();
  assert.match(await input.getAttribute('placeholder'), /易语言/);
  assert.equal(await page.getByRole('combobox', { name: '操作权限' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '计划', exact: true }).count(), 0);
  const initialHeight = await input.evaluate(element => element.getBoundingClientRect().height);
  assert(initialHeight <= 40, 'empty editor should occupy one line');
  assert((await page.locator('[data-composer-card]').boundingBox()).height <= 110, 'empty composer must stay compact');
  for (const viewport of [{ width: 1280, height: 800 }, { width: 960, height: 600 }, { width: 1366, height: 900 }]) {
    await page.setViewportSize(viewport);
    await input.fill(Array.from({ length: 30 }, (_, index) => '第 ' + index + ' 行易语言需求').join('\n'));
    const expanded = await input.evaluate(element => ({ height: element.getBoundingClientRect().height, scroll: element.scrollHeight }));
    assert(expanded.height <= 168 && expanded.scroll > expanded.height, 'long input must scroll within its height limit');
    await input.fill('一行需求');
    assert((await input.boundingBox()).height <= 40, 'short input must shrink');
    await input.fill('');
    assert((await input.boundingBox()).height <= 40, 'clearing input must restore one line');
    const picker = page.getByRole('button', { name: '选择模型', exact: true });
    assert.match(await picker.textContent(), /^DeepSeek-V4\.1-Flash$/);
    const bounds = await picker.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height, 'model selector must stay visible');
  }
  await input.focus();
  for (const target of [input, page.locator('[data-composer-card]')]) {
    const border = await target.evaluate(element => ({ border: getComputedStyle(element).borderTopWidth, outline: getComputedStyle(element).outlineStyle }));
    assert.equal(border.border, '0px'); assert.equal(border.outline, 'none');
  }
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  const modelOptions = page.getByRole('listbox', { name: '可用模型', exact: true }).getByRole('option');
  assert.equal(await modelOptions.count(), 2);
  assert.equal(await page.getByText('日常对话与代码生成', { exact: true }).count(), 0);
  assert.deepEqual(await modelOptions.allTextContents(), ['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro']);
  assert.equal(await modelOptions.locator('small').count(), 0);
  await page.getByRole('option').filter({ hasText: 'DeepSeek-V4-Pro' }).click();
  assert.match(await page.getByRole('button', { name: '选择模型', exact: true }).textContent(), /^DeepSeek-V4-Pro$/);
  assert.equal(await page.evaluate(async () => (await window.fixtureSettings.persist.getOptions().storage.getItem('eaicoding-settings')).state.profiles[0].model), 'deepseek-v4-pro');
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.screenshot({ path: path.join(screenshots, 'composer-models-light.png'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog', { name: '选择 DeepSeek 模型' }).count(), 0);
  await page.evaluate(() => {
    const state = window.fixtureSettings.getState(); const id = state.activeProfileId;
    window.fixtureSettings.setState({ modelCatalogs: { ...state.modelCatalogs, [id]: [...state.profiles[0].models, ...['a', 'b', 'c'].map(id => ({ id: 'deepseek-fixture-' + id }))] } });
  });
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  assert.equal(await page.getByRole('textbox', { name: '搜索模型', exact: true }).count(), 0);
  assert.equal(await modelOptions.count(), 2, 'stale and custom catalogs must not add unsupported models');
  assert.equal(await modelOptions.nth(1).evaluate(element => element === document.activeElement), true);
  await page.keyboard.press('ArrowUp');
  assert.equal(await modelOptions.nth(0).evaluate(element => element === document.activeElement), true);
  const anchorRect = await page.getByRole('button', { name: '选择模型', exact: true }).boundingBox();
  const menuRect = await page.getByRole('dialog', { name: '选择 DeepSeek 模型' }).boundingBox();
  assert(menuRect.y + menuRect.height <= anchorRect.y && Math.abs(menuRect.x + menuRect.width - anchorRect.x - anchorRect.width) < 2);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.fixtureSettings.setState({ modelCatalogs: {} }));
  await page.getByRole('button', { name: '添加与快捷操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '插入代码块', exact: true }).click();
  assert.equal(await input.inputValue(), '```epl\n\n```');
  await page.getByRole('button', { name: '添加与快捷操作', exact: true }).click();
  await page.getByRole('menuitem').filter({ hasText: '添加文件' }).click();
  await page.getByRole('button', { name: '移除附件 示例.ec', exact: true }).click();
  await input.fill('保留这份易语言需求');
  const encryptedKey = await page.evaluate(() => window.fixtureSettings.getState().profiles[0].apiKeyEncrypted);
  await page.evaluate(() => window.fixtureSettings.setState(state => ({ profiles: state.profiles.map(profile => ({ ...profile, apiKeyEncrypted: '' })) })));
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  assert.equal(await page.evaluate(() => window.fixtureRequests.length), 0, 'IME Enter must not submit');
  await input.press('Enter');
  await page.getByText('请先在设置页配置 API Key', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '保留这份易语言需求');
  await page.evaluate(key => window.fixtureSettings.setState(state => ({ profiles: state.profiles.map(profile => ({ ...profile, apiKeyEncrypted: key })) })), encryptedKey);
  await input.fill('整理开发步骤');
  await input.press('Enter');
  await page.getByText('开发步骤已整理。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureRequests[0].model), 'deepseek-v4-pro', 'selected model must reach the actual request');
  const toolNames = await page.evaluate(() => window.fixtureRequests[0].tools.map(tool => tool.function.name));
  for (const name of ['read_file', 'save_text_file', 'apply_search_replace', 'generate_gui_project', 'compile_efile']) assert(toolNames.includes(name), 'automatic coding must provide ' + name);
  assert.equal(await input.inputValue(), '');
  console.log('PASS compact autosizing at 960/1280/1366px, aligned compact model menu, automatic tools, model persistence/keyboard, file actions and IME');
  await page.evaluate(() => { window.fixtureStreamMode = true; window.fixturePendingRequest = null; });
  await input.fill('你好啊');
  await input.press('Enter');
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  assert.equal(await page.evaluate(() => window.fixturePendingRequest.body.tools), undefined);
  const reply = page.locator('.assistant-message-content').last();
  await page.evaluate(() => window.fixtureEmitReasoning('用户在打招呼。\n\n用简短的中文回复，并说明可以继续编写易语言窗口。'));
  const reasoningToggle = reply.locator('.assistant-reasoning-toggle');
  await reasoningToggle.waitFor();
  assert.equal(await reasoningToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await reply.locator('.assistant-reasoning-body').count(), 0, 'reasoning stays lazy and collapsed by default');
  assert.equal(await reply.locator('.assistant-response').textContent(), '', 'reasoning must never paint into the answer');
  assert.equal(await reply.locator('.assistant-activity').count(), 0, 'reasoning replaces the generic waiting indicator');
  await reasoningToggle.click();
  await reply.locator('.assistant-reasoning-body').getByText('用户在打招呼。', { exact: true }).waitFor();
  await page.evaluate(() => window.fixtureEmitReasoning('\n\n等待用户提供具体需求。'));
  await reply.locator('.assistant-reasoning-body').getByText('等待用户提供具体需求。', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(screenshots, 'reasoning-streaming.png'), animations: 'disabled', style: '[data-sonner-toaster] { visibility: hidden; }' });
  await page.evaluate(() => window.fixtureEmitToken('你好！'));
  await reply.getByText('你好！', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '停止生成', exact: true }).count(), 1, 'partial Markdown must paint while IPC is still pending');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await settingsDialog.waitFor();
  await page.evaluate(() => window.fixtureEmitToken('我可以帮你编写易语言窗口和事件代码，也能查阅精易模块接口。'));
  await reply.getByText('你好！我可以帮你编写易语言窗口和事件代码，也能查阅精易模块接口。', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await settingsDialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '停止生成', exact: true }).count(), 1, 'opening and closing settings must not stop a live model request');
  assert.equal(await reply.locator('.agent-trace-panel').count(), 0);
  await page.screenshot({ path: path.join(screenshots, 'greeting-streaming.png'), fullPage: true, animations: 'disabled' });
  await page.evaluate(() => window.fixtureFinishStream());
  await reply.getByRole('button', { name: '复制回复', exact: true }).waitFor();
  assert.equal(await reply.locator('.assistant-reasoning-body').getByText('用户在打招呼。', { exact: true }).count(), 1, 'settling must preserve reasoning without duplication');
  assert.equal(await reply.locator('.assistant-reasoning[data-running="true"]').count(), 0);
  const storedReasoning = await page.evaluate(() => window.fixtureChat.getState().sessions.find(session => session.id === window.fixtureChat.getState().activeSessionId).messages.at(-1));
  assert.equal(storedReasoning.reasoningContent, '');
  assert.match(storedReasoning.agentTrace.steps.at(-1).reasoningContent, /等待用户提供具体需求/);
  assert.equal(await reply.locator('.assistant-activity').count(), 0);
  assert.equal(await reply.locator('.agent-trace-panel').count(), 0);
  await reply.getByRole('button', { name: '复制回复', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '你好！我可以帮你编写易语言窗口和事件代码，也能查阅精易模块接口。');

  await page.evaluate(() => { window.fixtureStreamMode = true; window.fixturePendingRequest = null; });
  await input.fill('你好');
  await input.press('Enter');
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await page.evaluate(() => window.fixtureEmitToken('停止前的草稿'));
  await reply.getByText('停止前的草稿', { exact: true }).waitFor();
  await page.getByRole('button', { name: '停止生成', exact: true }).click();
  await page.getByRole('button', { name: '发送消息', exact: true }).waitFor();
  const stopped = await reply.textContent();
  await page.evaluate(async () => { await window.fixtureEmitToken('LATE_CHUNK_SHOULD_NOT_PAINT'); await window.fixtureEmitReasoning('LATE_REASONING_SHOULD_NOT_PAINT'); await window.fixtureFinishStream(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
  assert.equal(await reply.textContent(), stopped, 'late tokens cannot overwrite the stopped result');
  console.log('PASS live SSE reasoning/answer separation, retained reasoning, one-round greeting, reply copy and ignored late chunks after stop');

  await page.evaluate(() => {
    const state = window.fixtureChat.getState();
    window.fixtureLongMessage = state.appendMessage(state.activeSessionId, { role: 'assistant', content: Array.from({ length: 100 }, (_, index) => '第 ' + index + ' 段：窗口、按钮与事件处理说明。').join('\n\n') });
  });
  const viewport = page.locator('.chat-message-scroll [data-radix-scroll-area-viewport]');
  await page.waitForFunction(() => { const v = document.querySelector('.chat-message-scroll [data-radix-scroll-area-viewport]'); return v.scrollHeight - v.clientHeight - v.scrollTop < 48; });
  await viewport.evaluate(element => { element.scrollTop = 100; });
  await page.getByRole('button', { name: '回到最新', exact: true }).waitFor();
  const readerPosition = await viewport.evaluate(element => element.scrollTop);
  await page.evaluate(() => {
    const state = window.fixtureChat.getState();
    const message = state.sessions.find(session => session.id === state.activeSessionId).messages.find(message => message.id === window.fixtureLongMessage);
    state.updateMessage(state.activeSessionId, window.fixtureLongMessage, { content: message.content + '\n\n新增内容。'.repeat(20) });
  });
  await page.waitForFunction(() => document.querySelector('.assistant-message-content:last-of-type') !== null);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert(Math.abs(await viewport.evaluate(element => element.scrollTop) - readerPosition) < 2, 'content growth must preserve the reader scroll position');
  await page.getByRole('button', { name: '回到最新', exact: true }).click();
  assert(await viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop < 48));
  console.log('PASS stream/layout follow, reader scroll preservation and jump to latest');
  const streamLayout = await page.evaluate(async () => {
    const state = window.fixtureChat.getState(), sid = state.activeSessionId;
    const id = state.appendMessage(sid, { role: 'assistant', content: '', isStreaming: true });
    const viewport = document.querySelector('.chat-message-scroll [data-radix-scroll-area-viewport]');
    const samples = [];
    let frame, measuring = true;
    const sample = () => {
      samples.push({ top: viewport.scrollTop, height: viewport.scrollHeight, gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop });
      if (measuring) frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    let code = Array.from({ length: 35 }, (_, i) => 'const value' + i + ' = "窗口与事件处理";').join('\n');
    let firstPre, firstLine;
    for (let i = 0; i < 12; i++) {
      code += '\nconst appended' + i + ' = ' + i + ';';
      state.updateMessage(sid, id, { content: '代码示例：\n\n```javascript\n' + code + '\n```' });
      await new Promise(resolve => setTimeout(resolve, 240));
      const response = document.querySelectorAll('.assistant-response');
      const pre = response[response.length - 1].querySelector('pre');
      if (i === 0) { firstPre = pre; firstLine = pre.querySelector('.line'); }
      else if (pre !== firstPre || pre.querySelector('.line') !== firstLine) throw new Error('streaming highlighting replaced existing code lines');
    }
    state.updateMessage(sid, id, { isStreaming: false });
    await new Promise(resolve => setTimeout(resolve, 300));
    measuring = false; cancelAnimationFrame(frame);
    return {
      backwards: samples.filter((sample, i) => i > 3 && sample.top < samples[i - 1].top - 1).length,
      shrinks: samples.filter((sample, i) => i > 3 && sample.height < samples[i - 1].height - 1).length,
      maxGap: Math.max(...samples.slice(4).map(sample => sample.gap)),
    };
  });
  assert.equal(streamLayout.backwards, 0, 'appending code must not pull the transcript backwards');
  assert.equal(streamLayout.shrinks, 0, 'highlighting must keep code geometry stable');
  assert(streamLayout.maxGap <= 1, 'the displayed frame must already follow the new line: ' + JSON.stringify(streamLayout));
  await viewport.evaluate(element => {
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -24, bubbles: true }));
    element.scrollTop -= 24;
  });
  await page.getByRole('button', { name: '回到最新', exact: true }).waitFor();
  const nearTailReaderPosition = await viewport.evaluate(element => element.scrollTop);
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(), sid = state.activeSessionId;
    const message = state.sessions.find(session => session.id === sid).messages.at(-1);
    state.updateMessage(sid, message.id, { content: message.content + '\n\n新一段说明。' });
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert(Math.abs(await viewport.evaluate(element => element.scrollTop) - nearTailReaderPosition) < 2, 'even a small upward scroll must suspend following');
  await page.getByRole('button', { name: '回到最新', exact: true }).click();
  console.log('PASS streaming code: stable DOM and heights, pre-paint bottom alignment, small upward scroll retains reading position ' + JSON.stringify(streamLayout));
  const protocolExample = '下面是 JSON 协议示例：\n```json\n{"thought":"这是字段示例","tool_calls":[{"name":"save_text_file"}]}\n```';
  await page.evaluate(content => { const state = window.fixtureChat.getState(); state.appendMessage(state.activeSessionId, { role: 'assistant', content }); }, protocolExample);
  await page.locator('.source-card').last().waitFor();
  assert.match(await page.locator('.source-card').last().textContent(), /这是字段示例/);
  assert.match(await page.locator('.source-card').last().textContent(), /save_text_file/);

  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'DeepSeek-V4.1-Flash' }).click();
  await input.fill('整理开发步骤');
  await input.press('Enter');
  await page.getByText('开发步骤已整理。', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.fixtureRequests.at(-1).model), 'deepseek-flash', 'Flash display name must send the production API ID');
  const source = '.版本 2\n.程序集 窗口程序集_启动窗口\n\n.子程序 _按钮1_被单击\n编辑框1.内容 ＝ “你好，世界”\n' + "' 长注释 ".repeat(50);
  await page.evaluate(source => {
    const state = window.fixtureChat.getState();
    state.appendMessage(state.activeSessionId, { role: 'user', content: '帮我生成一个带按钮的窗口' });
    state.appendMessage(state.activeSessionId, { role: 'assistant', content: '已生成窗口、按钮和事件代码。\n\n```易语言\n' + source + '\n```', agentTrace: {
      goal: '写窗口', outcome: 'answer', startedAt: 0, endedAt: 1000, toolCallCount: 1, finalAnswer: '', steps: [{
        index: 1, assistantText: '先核对窗口事件接口。', finishReason: 'tool_call', startedAt: 0, endedAt: 100,
        toolCalls: [{ id: 'search', name: 'search_jingyi_module', arguments: { query: '窗口 按钮 事件' } }],
        toolResults: [{ toolCallId: 'search', toolName: 'search_jingyi_module', ok: true, durationMs: 100, content: { count: 2, success: true } }],
      }],
    } });
  }, source);
  const tracePanel = page.locator('.agent-trace-panel').last();
  assert.equal(await tracePanel.locator('.agent-step').count(), 0, 'tools stay compact until expanded');
  await tracePanel.getByRole('button').first().click();
  assert.match(await tracePanel.locator('.agent-tool-line').textContent(), /查询精易模块.*窗口 按钮 事件/);
  assert.equal(await tracePanel.locator('.agent-tool-details').count(), 0);
  await tracePanel.locator('.agent-tool-toggle').click();
  assert.equal(await tracePanel.locator('.agent-tool-details').count(), 1);
  await tracePanel.getByRole('button').first().click();
  console.log('PASS native JSON examples stay intact and compact tool activity expands to readable arguments and details');
  const card = page.locator('.source-card').first();
  await card.waitFor();
  assert.equal(await card.locator('.line').count(), 6);
  await card.getByRole('button', { name: '复制代码', exact: true }).click();
  // Windows clipboard normalizes LF to CRLF; all source characters must remain intact.
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'), source);
  await card.getByRole('button', { name: '自动换行', exact: true }).click();
  assert.equal(await card.getAttribute('data-code-wrap'), 'false');
  await card.getByRole('button', { name: '自动换行', exact: true }).click();
  await page.screenshot({ path: path.join(screenshots, 'chat-light.png'), fullPage: true, animations: 'disabled' });
  await card.getByRole('button', { name: '易语言视图', exact: true }).click();
  await card.locator('.source-ide').waitFor();
  await card.getByRole('button', { name: '源码视图', exact: true }).click();
  await card.getByRole('button', { name: '在右侧预览', exact: true }).click();
  await page.getByRole('complementary', { name: '文件预览' }).waitFor();
  assert.equal(await page.getByRole('complementary', { name: '文件预览' }).locator('.line').count(), 6);
  await page.getByRole('button', { name: '关闭预览', exact: true }).click();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.equal(overflow, false, 'long lines must not overflow the app');
  await page.evaluate(() => window.fixtureSettings.getState().setTheme('dark'));
  await page.screenshot({ path: path.join(screenshots, 'chat-dark.png'), fullPage: true, animations: 'disabled' });
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.screenshot({ path: path.join(screenshots, 'composer-models-dark.png'), fullPage: true, animations: 'disabled' });
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.fixtureSettings.getState().setTheme('light'));
  await page.getByRole('button', { name: '新建任务', exact: true }).click();
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(), now = Date.now();
    const calls = [
      { id: 'plan', name: 'update_plan', arguments: { items: [{ id: 1, title: '生成登录窗口和事件', status: 'in_progress' }, { id: 2, title: '读取源码并编译验证', status: 'pending' }] } },
      { id: 'gui', name: 'generate_gui_project', arguments: { project: { windows: [{ name: '_启动窗口', title: '登录窗口', controls: [{ type: '编辑框' }, { type: '按钮' }] }] } } },
    ];
    window.fixtureComplexTrace = { goal: '制作登录窗口', startedAt: now - 1400, endedAt: now, toolCallCount: 2, outcome: 'max_steps', finalAnswer: '', steps: [
      { index: 1, startedAt: now - 1400, endedAt: now, assistantText: '先生成窗口布局，再检查按钮事件。', toolCalls: calls, toolResults: [], finishReason: 'tool_call' },
    ] };
    state.appendMessage(state.activeSessionId, { role: 'user', content: '帮我制作一个登录窗口，自动写好事件并编译。' });
    state.appendMessage(state.activeSessionId, { role: 'assistant', content: '', isStreaming: true, activeToolCallId: 'plan', agentTrace: window.fixtureComplexTrace });
    window.fixtureComplexId = window.fixtureChat.getState().sessions.find(s => s.id === state.activeSessionId).messages.at(-1).id;
  });
  const executionPanel = page.locator('.agent-trace-panel').last();
  assert.equal(await executionPanel.locator('.agent-process-toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await executionPanel.locator('[data-state="running"]').count(), 1);
  assert.equal(await executionPanel.locator('[data-state="queued"]').count(), 1);
  assert.equal(await executionPanel.locator('.agent-tool-details').count(), 0);
  assert(!await executionPanel.textContent().then(text => text.includes('"items"') || text.includes('"project"')), 'collapsed tool rows must hide raw JSON');
  await executionPanel.locator('.agent-tool-toggle').first().click();
  await executionPanel.locator('.agent-plan-checklist').waitFor();
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(), trace = structuredClone(window.fixtureComplexTrace);
    const result = (id, content) => ({ toolCallId: id, toolName: id === 'plan' ? 'update_plan' : 'generate_gui_project', ok: true, durationMs: 50, content });
    trace.steps[0].toolResults = [result('plan', { success: true })];
    window.fixtureComplexTrace = trace;
    state.updateMessage(state.activeSessionId, window.fixtureComplexId, { agentTrace: trace, activeToolCallId: 'gui' });
  });
  assert.equal(await executionPanel.locator('.agent-plan-checklist').count(), 1, 'live status updates must preserve manually expanded tool rows');
  assert.equal(await executionPanel.locator('.agent-tool-diagnostics pre').count(), 0, 'raw data must mount only when explicitly requested');
  await executionPanel.locator('.agent-tool-diagnostics summary').click();
  await executionPanel.locator('.agent-tool-diagnostics pre').waitFor();
  assert.match(await executionPanel.locator('.agent-tool-diagnostics pre').textContent(), /"items"/);
  await executionPanel.locator('.agent-tool-toggle').first().click();
  await page.screenshot({ path: path.join(screenshots, 'execution-running.png'), animations: 'disabled' });
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(), trace = structuredClone(window.fixtureComplexTrace), now = Date.now();
    window.fixtureLayoutPath = 'C:/Users/Administrator/AppData/Local/com.eaicoding.desktop/generated-ecode/gui-example/窗口/_启动窗口.form.json';
    window.fixtureCodePath = 'C:/Users/Administrator/AppData/Local/com.eaicoding.desktop/generated-ecode/gui-example/代码/窗口程序集_启动窗口.form.e.txt';
    window.fixtureJsonFirst = '{\n  "title": "登录窗口",\n  "controls": [\n';
    window.fixtureReadResponse = { content: '    { "type": "按钮", "text": "登录" }\n  ]\n}', start_char: window.fixtureJsonFirst.length, start_line: 4, truncated: false, next_start_char: null, code_hash: 'fixture-layout-v1' };
    trace.steps[0].toolResults.push({ toolCallId: 'gui', toolName: 'generate_gui_project', ok: true, durationMs: 580, content: { success: true, output_path: 'D:/fixture/登录窗口.e', layout_path: window.fixtureLayoutPath } });
    trace.steps.push({ index: 2, startedAt: now, endedAt: now, assistantText: '工程骨架已生成，检查窗口定义和事件代码。', finishReason: 'tool_call', toolCalls: [
      { id: 'json', name: 'read_file', arguments: { file_path: window.fixtureLayoutPath } },
      { id: 'code', name: 'read_file', arguments: { file_path: window.fixtureCodePath } },
      { id: 'compile', name: 'compile_efile', arguments: { target_path: 'D:/fixture/登录窗口.e' } },
    ], toolResults: [
      { toolCallId: 'code', toolName: 'read_file', ok: true, durationMs: 5, content: { path: window.fixtureCodePath, content: '.版本 2\n.程序集 窗口程序集_启动窗口\n' + Array.from({ length: 170 }, (_, i) => "' 事件说明 " + i).join('\n'), encoding: 'utf-8', truncated: false } },
      { toolCallId: 'json', toolName: 'read_file', ok: true, durationMs: 19, content: { path: window.fixtureLayoutPath, content: window.fixtureJsonFirst, encoding: 'utf-8', truncated: true, start_line: 1, start_char: 0, next_start_char: window.fixtureJsonFirst.length, code_hash: 'fixture-layout-v1' } },
    ] });
    trace.toolCallCount = 5;
    window.fixtureComplexTrace = trace;
    state.updateMessage(state.activeSessionId, window.fixtureComplexId, { agentTrace: trace, activeToolCallId: 'compile' });
  });
  assert.equal(await page.getByRole('complementary', { name: '文件预览' }).count(), 0, 'tool results must not open the pane automatically');
  assert.equal(await executionPanel.locator('.agent-tool-row').count(), 5);
  await executionPanel.locator('.agent-tool-file').filter({ hasText: '_启动窗口.form.json' }).click();
  const pane = page.getByRole('complementary', { name: '文件预览' });
  await pane.waitFor();
  assert.match(await pane.locator('.source-language').textContent(), /json/);
  await page.evaluate(() => { window.fixtureReadResponse.code_hash = 'fixture-layout-v2'; });
  await pane.getByRole('button', { name: '加载更多', exact: true }).click();
  await pane.getByRole('alert').filter({ hasText: '文件已更新' }).waitFor();
  assert(!await pane.locator('.source-body').textContent().then(text => text.includes('"按钮"')), 'pages from different file revisions must never be concatenated');
  await page.evaluate(() => { window.fixtureReadResponse.code_hash = 'fixture-layout-v1'; });
  await pane.getByRole('button', { name: '加载更多', exact: true }).click();
  await pane.getByText('已加载部分文件', { exact: true }).waitFor({ state: 'detached' });
  assert.match(await pane.locator('.source-body').textContent(), /登录窗口[\s\S]*按钮/);
  assert.equal(await page.evaluate(() => window.fixtureReads.at(-1).startChar), await page.evaluate(() => window.fixtureJsonFirst.length));
  await page.evaluate(() => { window.fixtureReadFailure = true; });
  await pane.getByRole('button', { name: '刷新文件', exact: true }).click();
  await pane.getByRole('alert').filter({ hasText: '暂时不可读' }).waitFor();
  assert.match(await pane.locator('.source-body').textContent(), /登录窗口[\s\S]*按钮/, 'refresh failure must preserve loaded content');
  await page.evaluate(() => {
    window.fixtureReadFailure = false;
    window.fixtureReadResponse = { ...window.fixtureReadResponse, content: window.fixtureJsonFirst + window.fixtureReadResponse.content, start_char: 0, start_line: 1 };
  });
  await pane.getByRole('button', { name: '重试', exact: true }).click();
  await pane.getByRole('alert').waitFor({ state: 'detached' });
  await executionPanel.locator('.agent-tool-file').filter({ hasText: '窗口程序集_启动窗口.form.e.txt' }).click();
  assert.equal(await pane.getByRole('tab').count(), 2);
  const documentBody = pane.locator('.document-body');
  await documentBody.evaluate(element => { element.scrollTop = 500; });
  const filePosition = await documentBody.evaluate(element => element.scrollTop);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await settingsDialog.waitFor({ state: 'hidden' });
  assert.equal(await pane.getByRole('tab', { selected: true }).textContent(), '窗口程序集_启动窗口.form.e.txt', 'settings must preserve the active document');
  assert(Math.abs(await documentBody.evaluate(element => element.scrollTop) - filePosition) < 2, 'settings must preserve the document reading position');
  await pane.getByRole('tab', { name: '_启动窗口.form.json', exact: true }).click();
  await pane.getByRole('tab', { name: '_启动窗口.form.json', exact: true }).press('ArrowRight');
  assert.equal(await pane.getByRole('tab', { selected: true }).textContent(), '窗口程序集_启动窗口.form.e.txt');
  assert.equal(await pane.getByRole('tab', { selected: true }).evaluate(node => node === document.activeElement), true);
  await pane.getByRole('tab', { selected: true }).press('Home');
  assert.equal(await pane.getByRole('tab', { selected: true }).textContent(), '_启动窗口.form.json');
  await pane.getByRole('tab', { name: '窗口程序集_启动窗口.form.e.txt', exact: true }).click();
  assert(Math.abs(await documentBody.evaluate(element => element.scrollTop) - filePosition) < 2, 'each tab must restore its reading position');
  await pane.getByRole('tab', { name: '_启动窗口.form.json', exact: true }).click();
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(), trace = structuredClone(window.fixtureComplexTrace);
    trace.steps[1].toolResults.push({ toolCallId: 'compile', toolName: 'compile_efile', ok: true, durationMs: 400, content: { success: true, output_path: 'D:/fixture/登录窗口.exe' } });
    trace.steps.push({ index: 3, assistantText: '窗口和事件代码已完成，编译通过。', toolCalls: [], toolResults: [], finishReason: 'answer', startedAt: Date.now(), endedAt: Date.now() });
    trace.outcome = 'answer'; trace.finalAnswer = '窗口和事件代码已完成，编译通过。'; trace.endedAt = Date.now();
    window.fixtureComplexTrace = trace;
    state.updateMessage(state.activeSessionId, window.fixtureComplexId, { content: trace.finalAnswer, isStreaming: false, agentTrace: trace, activeToolCallId: undefined });
  });
  assert.equal(await executionPanel.locator('.agent-process-toggle').getAttribute('aria-expanded'), 'false', 'settled process collapses');
  assert.equal(await page.locator('.agent-artifacts button').count(), 2, '.e and .exe stay directly accessible');
  assert.equal(await pane.getByRole('tab', { selected: true }).textContent(), '_启动窗口.form.json', 'finishing must not switch the selected file');
  await executionPanel.locator('.agent-process-toggle').click();
  assert.equal(await executionPanel.getByText('窗口和事件代码已完成，编译通过。', { exact: true }).count(), 0, 'final answer must not be duplicated inside the process');
  // A second edit of a previously read path must invalidate its disk cache.
  for (const edit of [1, 2]) {
    await page.evaluate(edit => {
      const state = window.fixtureChat.getState(), trace = structuredClone(window.fixtureComplexTrace);
      const id = 'edit-layout-' + edit;
      trace.steps.push({ index: 10 + edit, assistantText: '', startedAt: Date.now(), endedAt: Date.now(), finishReason: 'tool_call', toolCalls: [{ id, name: 'apply_search_replace', arguments: { file_path: window.fixtureLayoutPath } }], toolResults: [{ toolCallId: id, toolName: 'apply_search_replace', ok: true, content: { success: true }, durationMs: 1 }] });
      trace.toolCallCount++;
      window.fixtureReadResponse = { content: JSON.stringify({ title: '最新窗口版本 ' + edit, controls: [] }), start_char: 0, start_line: 1, truncated: false, code_hash: 'updated-layout-' + edit };
      window.fixtureComplexTrace = trace;
      state.updateMessage(state.activeSessionId, window.fixtureComplexId, { agentTrace: trace });
    }, edit);
    await pane.locator('.source-body').getByText(new RegExp('最新窗口版本 ' + edit)).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureReads.at(-1).startChar), 0);
  }
  assert.match(await executionPanel.locator('.agent-process-summary').textContent(), /7 次工具调用/);
  assert.equal(await executionPanel.locator('.agent-tool-file').filter({ hasText: '_启动窗口.form.json' }).count(), 3, 'each edit must expose its file alongside reads');
  await page.screenshot({ path: path.join(screenshots, 'execution-preview-light.png'), animations: 'disabled' });
  await page.evaluate(() => window.fixtureSettings.getState().setTheme('dark'));
  await page.screenshot({ path: path.join(screenshots, 'execution-preview-dark.png'), animations: 'disabled' });
  await page.evaluate(() => window.fixtureSettings.getState().setTheme('light'));
  await pane.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.evaluate(() => {
    const state = window.fixtureChat.getState();
    state.appendMessage(state.activeSessionId, { role: 'assistant', content: '你好，可以继续修改窗口。' });
  });
  assert.equal(await pane.count(), 0, 'later replies must not reopen a closed pane');
  await page.getByRole('button', { name: '代码预览', exact: true }).click();
  assert.equal(await pane.getByRole('tab').count(), 2, 'later greetings must preserve opened files');
  assert.equal(await pane.getByRole('button', { name: '加载更多', exact: true }).count(), 0, 'closing/reopening must preserve loaded pages');
  await page.setViewportSize({ width: 960, height: 600 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert((await pane.boundingBox()).width <= 960);
  await pane.getByRole('button', { name: '关闭预览', exact: true }).click();
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(), trace = structuredClone(window.fixtureComplexTrace);
    trace.outcome = 'aborted'; trace.finalAnswer = '已停止。';
    trace.steps[1].toolResults = trace.steps[1].toolResults.filter(result => result.toolCallId !== 'compile');
    trace.steps[0].toolResults[1] = { ...trace.steps[0].toolResults[1], ok: false, error: 'fixture 窗口文件不可写' };
    state.updateMessage(state.activeSessionId, window.fixtureComplexId, { content: '已停止。', agentTrace: trace });
  });
  assert.equal(await executionPanel.locator('[data-state="failed"]').count(), 1);
  assert.equal(await executionPanel.locator('[data-state="stopped"]').count(), 1);
  assert.match(await executionPanel.locator('.agent-tool-error').textContent(), /窗口文件不可写/);
  console.log('PASS live multi-tool timeline, lazy details, completion collapse, failures/stops, keyboard file tabs, JSON paging, repeated-edit cache invalidation, scroll retention and narrow preview');
  await page.evaluate(async () => {
    const state = window.fixtureChat.getState(), trace = structuredClone(window.fixtureComplexTrace);
    trace.outcome = 'max_steps'; trace.finalAnswer = '';
    trace.steps[1].toolResults = trace.steps[1].toolResults.filter(result => result.toolCallId !== 'compile');
    state.updateMessage(state.activeSessionId, window.fixtureComplexId, { content: '', isStreaming: true, activeToolCallId: 'compile', agentTrace: trace });
    await window.fixtureFlushChat();
    await window.fixtureChat.persist.rehydrate();
  });
  await page.waitForFunction(() => {
    const state = window.fixtureChat.getState();
    return state.sessions.find(session => session.id === state.activeSessionId).messages.find(message => message.id === window.fixtureComplexId)?.isStreaming === false;
  });
  await executionPanel.locator('.agent-process-toggle').filter({ hasText: '已停止' }).waitFor();
  if (await executionPanel.locator('.agent-process-toggle').getAttribute('aria-expanded') === 'false') await executionPanel.locator('.agent-process-toggle').click();
  assert.equal(await executionPanel.locator('[data-state="running"]').count(), 0, 'saved native tool tasks must not look active after restoring a session');
  assert.equal(await executionPanel.locator('[data-state="stopped"]').count(), 1);
  await page.getByText('上次执行已中断，可发送消息继续。', { exact: true }).waitFor();
  console.log('PASS interrupted-session restoration retains results and clears stale running indicators');
  assert.deepEqual(errors, []);
  console.log('PASS Chinese fence, source copy, wrap toggle, IDE toggle, light/dark rendering and no page errors');
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}
