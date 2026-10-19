import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { chromium } = process.env.EAICODING_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.EAICODING_PLAYWRIGHT_MODULE).href) : await import('playwright');
const run = promisify(execFile);
let browser;
try {
  for (let i = 0; i < 40 && !browser; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9336', { timeout: 1000 }); }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  assert(browser, 'isolated native WebView2 not available');
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    page = browser.contexts().flatMap(context => context.pages()).find(page => /tauri.localhost/.test(page.url()));
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert(page, 'main test view not found');
  await page.getByRole('button', { name: '使用其他模型提供商', exact: true }).click();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  const input = page.getByRole('textbox', { name: '消息输入框', exact: true });
  await input.click();
  await input.pressSequentially('abcdef');
  await input.evaluate(node => {
    window.menuProbeEvents = [];
    for (const type of ['keydown', 'input']) node.addEventListener(type, event => window.menuProbeEvents.push({ type, key: event.key, ctrl: event.ctrlKey, inputType: event.inputType, value: node.value }));
  });
  const bar = page.getByRole('menubar', { name: '应用菜单' });
  async function choose(menu, index) {
    await bar.getByRole('menuitem', { name: menu, exact: true }).click();
    const { stdout } = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.resolve('scripts/native-menu-probe.ps1'), '-AppProcessId', process.env.EAICODING_MENU_TEST_PID, '-Select', String(index)], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('[role="menubar"] [aria-expanded="true"]') === null);
    return JSON.parse(stdout.replace(/^\uFEFF/, ''));
  }
  await input.evaluate(node => node.setSelectionRange(1, 4));
  const editLabels = await choose('编辑', 3);
  assert.deepEqual(editLabels.map(label => label.split('\t')[0]), ['撤销', '重做', '剪切', '复制', '粘贴', '删除', '全选']);
  await choose('编辑', 2);
  await page.waitForFunction(() => document.querySelector('[aria-label="消息输入框"]').value === 'aef');
  await choose('编辑', 0);
  await page.waitForFunction(() => document.querySelector('[aria-label="消息输入框"]').value === 'abcdef');
  await choose('编辑', 1);
  await page.waitForFunction(() => document.querySelector('[aria-label="消息输入框"]').value === 'aef');
  await choose('编辑', 6);
  assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd]), [0, 3]);
  await choose('编辑', 4);
  await page.waitForFunction(() => document.querySelector('[aria-label="消息输入框"]').value === 'bcd');
  await input.evaluate(node => node.setSelectionRange(2, 3));
  await choose('编辑', 5);
  await page.waitForFunction(() => document.querySelector('[aria-label="消息输入框"]').value === 'bc');
  assert.equal(await input.inputValue(), 'bc');
  const keys = await page.evaluate(() => window.menuProbeEvents.filter(event => event.type === 'keydown').map(event => event.key));
  for (const key of ['c', 'x', 'z', 'y', 'a', 'v', 'Delete']) assert(keys.includes(key), `missing native editing key: ${key}`);
  console.log('PASS real Windows native edit menu, preserved selection, copy/cut/paste, undo/redo, select all and delete');
  const appLabels = await choose('应用', 0);
  assert.deepEqual(appLabels, ['关于 EAiCoding', '检查更新…', '退出 EAiCoding']);
  await page.getByRole('dialog', { name: '关于 EAiCoding' }).waitFor();
  await page.screenshot({ path: '.tmp/native-menu/about.png' });
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await choose('应用', 2);
  await page.getByRole('dialog', { name: '退出 EAiCoding？' }).waitFor();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await input.inputValue(), 'bc');
  await page.screenshot({ path: '.tmp/native-menu/workspace.png' });
  assert.equal(await page.locator('[title], [role="tooltip"]').count(), 0);
  console.log('PASS native application menu, about, quit cancellation, own branding and no tooltip attributes');
} finally { await browser?.close(); }
