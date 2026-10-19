import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { chromium } = process.env.EAICODING_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.EAICODING_PLAYWRIGHT_MODULE).href) : await import('playwright');
const fixtureRoot = path.resolve(process.env.EAICODING_WORKBENCH_SMOKE_DIR ?? '.tmp/native-workbench');
await mkdir(fixtureRoot, { recursive: true });
const probe = path.join(fixtureRoot, 'probe.ps1');
await writeFile(probe, '\ufeff[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()\n[Console]::WriteLine("WORKBENCH_PID=$PID")\n[Console]::WriteLine("CWD=" + (Get-Location).Path)\n[Console]::WriteLine("中文终端验证")\n', 'utf8');
let childVisits = 0, remoteResult;
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/result') { remoteResult = Object.fromEntries(url.searchParams); res.end('ok'); return; }
  childVisits++;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><title>工作区浏览器测试</title><h1>原生网页已加载</h1><script>
    const access = async (command, args) => {
      if (!window.__TAURI_INTERNALS__?.invoke) return 'denied';
      try { await window.__TAURI_INTERNALS__.invoke(command, args); return 'ALLOWED'; } catch { return 'denied'; }
    };
    Promise.all([access('default_workspace', {}), access('plugin:clipboard-manager|write_text', {text:'NEVER'})]).then(([custom, clipboard]) => fetch('/result?custom=' + custom + '&clipboard=' + clipboard));
  </script>`);
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
const terminalId = 'smoke-' + Date.now(), browserId = 'browser-smoke-' + Date.now();
let page;
const invoke = async (cmd, args = {}) => {
  let timer;
  try { return await Promise.race([
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Native IPC timeout: " + cmd)), 15000); }),
    page.evaluate(({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args), { cmd, args }),
  ]); } finally { clearTimeout(timer); }
};
try {
  for (let i = 0; i < 20 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(process.env.EAICODING_CDP_URL ?? 'http://127.0.0.1:9333', { timeout: 1000 }); }
    catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert(browser, 'native WebView2 CDP endpoint did not start');
  for (let i = 0; i < 100 && !page; i++) {
    page = browser.contexts().flatMap(c => c.pages()).find(p => /tauri.localhost/.test(p.url()));
    if (!page) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(page, 'main native webview not found');
  console.log('Native main webview connected');
  await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === 'function');
  await page.getByTestId('deepseek-login').waitFor();
  const account = await invoke('deepseek_account_status');
  assert.equal(account.signedIn, false);
  assert.equal('token' in account, false);
  const nativeSize = await invoke('plugin:window|inner_size', { label: 'main' });
  const scale = await invoke('plugin:window|scale_factor', { label: 'main' });
  assert(Math.abs(nativeSize.width / scale - 600) < 2 && Math.abs(nativeSize.height / scale - 700) < 2);
  assert.equal(await invoke('plugin:window|is_resizable', { label: 'main' }), false);
  await assert.rejects(() => invoke('llm_proxy_request', { request: { url: 'https://untrusted.example/chat/completions' } }), /官方模型接口/);
  await assert.rejects(() => invoke('llm_proxy_request', { request: { url: 'https://api.deepseek.com/chat/completions' } }), /授权登录/);
  console.log('PASS native login-first 600x700 fixed window, safe status, custom-origin rejection and signed-out inference guard without network requests');
  const listing = await invoke('list_workspace_directory', { root: fixtureRoot });
  assert(listing.entries.some(entry => entry.name === 'probe.ps1'));
  await invoke('plugin:opener|open_path', { path: fixtureRoot });
  await invoke('plugin:clipboard-manager|write_text', { text: 'EAiCoding 原生复制验证' });
  console.log('PASS native opener ACL, workspace listing and clipboard');

  const envRoot = path.join(fixtureRoot, 'environment');
  for (const folder of ['help/core/nested', 'lib', 'ecom']) await mkdir(path.join(envRoot, folder), { recursive: true });
  for (const file of ['example.E', 'help/core/cmd1.htm', 'help/core/nested/info.html', 'lib/core.fne', 'ecom/sample.ec']) {
    await writeFile(path.join(envRoot, file), 'fixture');
  }
  const [environment, responsiveListing] = await Promise.all([
    invoke('scan_easy_language_env', { rootPath: envRoot }),
    invoke('list_workspace_directory', { root: fixtureRoot }),
  ]);
  assert.equal(environment.counts_complete, true);
  assert.deepEqual(environment.counts, { support_library_files: 1, module_files: 1, sample_e_files: 1, help_html_files: 2 });
  assert(responsiveListing.entries.length > 0);
  console.log('PASS async native environment command and actual nested fixture counts alongside workspace IPC');

  await page.evaluate(async () => {
    window.smokeTerminalOutput = [];
    const handler = window.__TAURI_INTERNALS__.transformCallback(event => window.smokeTerminalOutput.push(event.payload), false);
    await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'workspace-terminal-output', target: { kind: 'Any' }, handler });
  });
  await invoke('terminal_open', { id: terminalId, root: fixtureRoot, cols: 250, rows: 24 });
  await invoke('terminal_write', { id: terminalId, data: '\x1b[1;1R' });
  await invoke('terminal_write', { id: terminalId, data: "& '" + probe.replaceAll("'", "''") + "'\r" });
  await page.waitForFunction(id => {
    const output = new TextDecoder().decode(new Uint8Array(window.smokeTerminalOutput.filter(x => x.id === id).flatMap(x => x.data)));
    return /WORKBENCH_PID=\d+/.test(output) && output.includes('中文终端验证');
  }, terminalId, { timeout: 30000 });
  const output = await page.evaluate(id => new TextDecoder().decode(new Uint8Array(window.smokeTerminalOutput.filter(x => x.id === id).flatMap(x => x.data))), terminalId);
  assert(output.replaceAll('Microsoft.PowerShell.Core\\FileSystem::', '').replaceAll('\\\\?\\', '').replace(/[\r\n]/g, '').includes('CWD=' + fixtureRoot), output);
  await invoke('terminal_resize', { id: terminalId, cols: 110, rows: 30 });
  await invoke('terminal_close', { id: terminalId });
  await assert.rejects(invoke('terminal_write', { id: terminalId, data: 'never' }), /终端已退出/);
  console.log('PASS actual PowerShell PTY, workspace cwd, UTF-8 output, resize and close');

  const url = `http://127.0.0.1:${server.address().port}/`;
  await invoke('browser_open', { id: browserId, url, x: 500, y: 100, width: 500, height: 500 });
  // Child WebViews may own a separate WebView2 CDP environment. Observe the
  // real served page instead of assuming Playwright exposes it as a Page.
  for (let i = 0; i < 100 && !remoteResult; i++) await new Promise(resolve => setTimeout(resolve, 100));
  assert(childVisits > 0, 'native child webview did not load the local page');
  assert(remoteResult, 'loaded page did not finish its isolation probes');
  assert.equal(remoteResult.custom, 'denied', 'remote page must not invoke application commands');
  assert.equal(remoteResult.clipboard, 'denied', 'remote page must not invoke desktop plugins');
  await invoke('browser_layout', { id: browserId, x: 450, y: 90, width: 550, height: 450, visible: false });
  await invoke('browser_layout', { id: browserId, x: 450, y: 90, width: 550, height: 450, visible: true });
  await invoke('browser_action', { id: browserId, action: 'reload' });
  await invoke('browser_close', { id: browserId });
  console.log('PASS real child webview navigation/layout/close and isolation from desktop commands');

  assert.notEqual(await invoke('plugin:tray|get_by_id', { id: 'main-tray' }), null, 'system tray icon is registered');
  await page.getByRole('button', { name: /^(Close|隐藏到系统托盘)$/ }).click();
  for (let attempt = 0; attempt < 30; attempt++) {
    if (!await invoke('plugin:window|is_visible', { label: 'main' })) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await invoke('plugin:window|is_visible', { label: 'main' }), false, 'close hides the live window');
  assert(process.env.EAICODING_NATIVE_TEST_EXE, 'isolated test executable is required');
  await promisify(execFile)(process.env.EAICODING_NATIVE_TEST_EXE, [], { windowsHide: true, timeout: 15000 });
  for (let attempt = 0; attempt < 30; attempt++) {
    if (await invoke('plugin:window|is_visible', { label: 'main' })) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(await invoke('plugin:window|is_visible', { label: 'main' }), true, 'launching again restores the existing hidden window');
  assert((await invoke('list_workspace_directory', { root: fixtureRoot })).entries.length > 0);
  console.log('PASS tray registration, close-to-tray without process exit and single-instance window restoration');
} finally {
  if (page) { await invoke('terminal_close', { id: terminalId }).catch(() => {}); await invoke('browser_close', { id: browserId }).catch(() => {}); }
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
