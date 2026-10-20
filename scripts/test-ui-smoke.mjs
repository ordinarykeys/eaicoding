import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  writeFile,
  rm,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { build } from "esbuild";

// Uses an installed Playwright or the desktop app's bundled browser runtime.
const { chromium } = process.env.EAICODING_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.EAICODING_PLAYWRIGHT_MODULE).href)
  : await import("playwright");
const root = process.cwd();
const sourceRoot = path.join(root, "src").replaceAll("\\", "/");
await mkdir(path.join(root, ".tmp"), { recursive: true });
const fixture = await mkdtemp(path.join(root, ".tmp/ui-smoke-"));
const screenshots = path.join(root, ".tmp/ui-validation");
await mkdir(screenshots, { recursive: true });
await writeFile(
  path.join(fixture, "index.html"),
  '<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script type="module" src="/assets/entry.js"></script></body></html>',
);
await writeFile(
  path.join(fixture, "entry.tsx"),
  `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import { emit } from '@tauri-apps/api/event';
import { set as idbSet } from 'idb-keyval';
window.fixturePutModuleIndex = (id, value) => idbSet('eaicoding-user-module:' + id, value);
import { idbStorage } from '${sourceRoot}/lib/idb-storage';
import '${sourceRoot}/i18n';
import '${sourceRoot}/index.css';
import '${sourceRoot}/styles/syntax.css';
import '${sourceRoot}/styles/epl.css';
import '${sourceRoot}/styles/harness.css';
import '${sourceRoot}/styles/settings.css';
import '${sourceRoot}/styles/composer.css';
window.isTauri = true;
window.fixtureEmit = emit;
window.fixtureIpc = [];
window.fixtureRequests = [];
window.fixtureStreams = new Map();
window.fixtureAccountView = { signedIn: false, name: null, contact: null, phase: 'signed-out', error: null, attemptId: null };
window.fixtureAccountNumber = 0;
const writeSettings = idbStorage.setItem.bind(idbStorage);
idbStorage.setItem = async (name, value) => {
  if (window.fixtureFailStorage && name === 'eaicoding-settings') throw new Error('fixture IndexedDB write failed');
  return writeSettings(name, value);
};
mockIPC((cmd, args) => {
  window.fixtureIpc.push(cmd);
  if (cmd === 'show_caption_menu') {
    window.fixtureCaptionRequest = { ...args, active: document.activeElement?.getAttribute('aria-label'), start: document.activeElement?.selectionStart, end: document.activeElement?.selectionEnd };
    return new Promise(resolve => { window.fixtureCloseCaption = resolve; });
  }
  if (cmd === 'check_application_update') return { version: 'v0.1.8', url: 'https://github.com/ordinarykeys/eaicoding/releases/tag/v0.1.8' };
  if (cmd === 'deepseek_account_status') {
    if (window.fixtureAccountUnavailable) return { ...window.fixtureAccountView, signedIn: false };
    return { ...window.fixtureAccountView };
  }
  if (cmd === 'model_provider_status') return window.fixtureProviderStatus ?? {};
  if (cmd === 'model_provider_save') { window.fixtureSavedProvider = args.input; window.fixtureProviderStatus = {...window.fixtureProviderStatus,[args.input.id]: !!args.input.apiKey || !!window.fixtureProviderStatus?.[args.input.id]}; return null; }
  if (cmd === 'model_provider_logout') { window.fixtureProviderStatus[args.id] = false; return null; }
  if (cmd === 'model_runtime_run' && args.input.operation === 'login') return new Promise((resolve, reject) => {
    window.fixtureAuthAttempt = { args, resolve, reject, step: 0 };
    void emit('model-runtime-event', {requestId: args.requestId, event:{type:'prompt',promptId:'method',prompt:{type:'select',message:'选择登录方式',options:[{id:'browser',label:'浏览器授权'},{id:'device',label:'设备码登录'}]}}});
  });
  if (cmd === 'model_runtime_reply') {
    const attempt = window.fixtureAuthAttempt;
    if (attempt && args.requestId === attempt.args.requestId) {
      if (args.promptId === 'method' && args.value === 'device') void emit('model-runtime-event', {requestId:args.requestId,event:{type:'notice',notice:{type:'device_code',verificationUri:'https://fixture.invalid/device',userCode:'ABCD-EFGH'}}});
      else if (args.promptId === 'method') void emit('model-runtime-event', {requestId:args.requestId,event:{type:'prompt',promptId:'manual',prompt:{type:'manual_code',message:'粘贴授权码'}}});
      else if (args.promptId === 'manual') void emit('model-runtime-event', {requestId:args.requestId,event:{type:'prompt',promptId:'secret',prompt:{type:'secret',message:'测试秘密输入'}}});
    }
    return null;
  }
  if (cmd === 'cancel_agent_task' && args.requestId === window.fixtureAuthAttempt?.args.requestId) { window.fixtureAuthAttempt.reject(new Error('操作已取消')); return null; }
  if (cmd === 'model_provider_remove') { delete window.fixtureProviderStatus?.[args.id]; return null; }
  if (cmd === 'model_provider_discover') return [{id:'fixture-coder',name:'Fixture Coder',ownedBy:'fixture'},{id:'fixture-reasoner',name:'Fixture Reasoner',ownedBy:'fixture'}];
  if (cmd === 'deepseek_account_notices') return {accountId: 'fixture-account', bonuses: window.fixtureNotices ?? []};
  if (cmd === 'deepseek_account_notice_ack') { window.fixtureNoticeAcks = [...(window.fixtureNoticeAcks ?? []), args]; return true; }
  if (cmd === 'deepseek_account_details') {
    window.fixtureDetailsReads = (window.fixtureDetailsReads ?? 0) + 1;
    if (window.fixtureDetailsUnavailable) return { name: null, contact: null, profileAvailable: false, wallets: null, bonusWallets: null };
    const details = { name: window.fixtureAccountView.name, contact: window.fixtureAccountView.contact, profileAvailable: true, wallets: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [{ currency: 'CNY', balance: '5.60' }] };
    if (window.fixtureDeferDetails) return new Promise(resolve => { window.fixtureResolveDetails = () => resolve(details); });
    return details;
  }
  if (cmd.startsWith('deepseek_platform_')) {
    window.fixtureNativeCalls = [...(window.fixtureNativeCalls ?? []), { cmd, args }];
    if (cmd === 'deepseek_platform_open') {
      if (window.fixturePlatformFailure) throw new Error('fixture platform unavailable');
      if (window.fixtureDeferPlatform) return new Promise(resolve => { window.fixtureResolvePlatform = () => { resolve(null); }; });
      queueMicrotask(() => emit('deepseek-platform-loaded', { id: args.id }));
    }
    return null;
  }
  if (cmd === 'deepseek_account_start') {
    window.fixtureAccountView = { ...window.fixtureAccountView, signedIn: false, phase: 'initializing', error: null, attemptId: 'attempt-' + (++window.fixtureAccountNumber) };
    return window.fixtureAccountView;
  }
  if (cmd === 'deepseek_account_cancel') {
    if (window.fixtureAccountView.attemptId === args.attemptId) window.fixtureAccountView = { ...window.fixtureAccountView, phase: 'signed-out', attemptId: null };
    return window.fixtureAccountView;
  }
  if (cmd === 'deepseek_account_browser') { window.fixtureBrowserAction = args; return null; }
  if (cmd === 'deepseek_account_logout') { window.fixtureAccountView = { signedIn: false, name: null, contact: null, phase: 'signed-out', error: null, attemptId: null }; return null; }
  if (cmd === 'scan_easy_language_env') {
    return new Promise(resolve => { window.fixtureResolveEnv = () => resolve({ root: args.rootPath, exists: true, is_compile_ready: true,
      tools: [], support_libraries: [], modules: [], warnings: [], counts_complete: true,
      counts: { support_library_files: 17, module_files: 12, sample_e_files: 3, help_html_files: 42 } }); });
  }
  if (cmd === 'default_workspace') return 'D:/fixture/workspace';
  if (cmd === 'plugin:clipboard-manager|write_text') {
    if (window.fixtureFailNativeClipboard) throw new Error('fixture native clipboard unavailable');
    return navigator.clipboard.writeText(args.text);
  }
  if (cmd === 'list_workspace_directory') {
    window.fixtureLists = [...(window.fixtureLists ?? []), args];
    if (window.fixtureDirectoryFailure) throw new Error('fixture 目录暂时不可读');
    const root = args.root;
    return { root, directory: args.directory ?? root, next_offset: null, entries: (args.directory && args.directory.endsWith('/代码')) ? [{ name: '示例.epl', path: root + '/代码/示例.epl', directory: false }] : [{ name: '代码', path: root + '/代码', directory: true }, { name: '说明.md', path: root + '/说明.md', directory: false }] };
  }
  if (cmd.startsWith('browser_') || (cmd === 'plugin:opener|open_path' || cmd === 'plugin:opener|open_url')) { window.fixtureNativeCalls = [...(window.fixtureNativeCalls ?? []), { cmd, args }]; return null; }
  if (cmd === 'terminal_open') { window.fixtureTerminals = [...(window.fixtureTerminals ?? []), args]; return null; }
  if (cmd === 'terminal_close') { window.fixtureClosedTerminals = [...(window.fixtureClosedTerminals ?? []), args.id]; return null; }
  if (cmd === 'terminal_write') { window.fixtureTerminalWrites = [...(window.fixtureTerminalWrites ?? []), args]; return null; }
  if (cmd === 'plugin:dialog|save') return 'D:/fixture/export.md';
  if (cmd === 'write_text_file') { window.fixtureWrites = [...(window.fixtureWrites ?? []), args]; return { path: args.filePath, bytes: args.content.length }; }
  if (cmd === 'read_text_file_for_agent') {
    window.fixtureReads = [...(window.fixtureReads ?? []), args];
    if (window.fixtureReadFailure) throw new Error('fixture 文件暂时不可读');
    return { path: args.filePath, encoding: 'utf-8', bytes: 100, ...window.fixtureReadResponse };
  }
  if (cmd === 'llm_proxy_stream') {
    window.fixtureRequests.push(args.request.body);
    if (args.request.headers.Authorization) throw new Error('Renderer must not send account credentials');
    if (window.fixtureStreamMode) {
      window.fixturePendingRequest = args.request;
      void emit("llm-proxy-stream-start",{requestId:args.request.requestId,status:200,statusText:"OK",headers:{"content-type":"text/event-stream"}});
      return new Promise(resolve => {
        window.fixtureResolveStream = resolve;
        window.fixtureStreams.set(args.request.requestId, { resolve, blocks: new Map() });
      });
    }
    return { status: 200, statusText: 'OK', text: fixtureSse({type:'content_block_start',index:0,content_block:{type:'text',text:''}})+fixtureSse({type:'content_block_delta',index:0,delta:{type:'text_delta',text:'开发步骤已整理。'}})+fixtureSse({type:'content_block_stop',index:0})+fixtureSse({type:'message_delta',delta:{stop_reason:'end_turn'}})+fixtureSse({type:'message_stop'}) };
  }
  if (cmd === 'plugin:dialog|open') return args.options?.directory ? 'D:/fixture/selected-workspace' : ['D:\\\\fixture\\\\示例.ec'];
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
const fixtureInvoke=window.__TAURI_INTERNALS__.invoke;
window.__TAURI_INTERNALS__.invoke=(cmd,args,options)=>fixtureInvoke(cmd,cmd==='plugin:event|unlisten'?{...args,id:args.eventId}:args,options);
mockWindows('main');
const fixtureSse = value => 'data: ' + JSON.stringify(value) + '\\n\\n';
window.fixtureMessageBlocks = new Map();
window.fixtureEmitBlock=async(type,text,requestId=window.fixturePendingRequest.requestId)=>{
 const blocks=window.fixtureStreams.get(requestId).blocks;
 const index=blocks.get(type)??blocks.size;
 let data='';
 if(!blocks.has(type)){blocks.set(type,index);data+=fixtureSse({type:'content_block_start',index,content_block:type==='text'?{type:'text',text:''}:{type:'thinking',thinking:''}});}
 data+=fixtureSse({type:'content_block_delta',index,delta:type==='text'?{type:'text_delta',text}:{type:'thinking_delta',thinking:text}});
 await emit('llm-proxy-stream-chunk',{requestId,text:data});
};
window.fixtureEmitToken=(content,requestId)=>window.fixtureEmitBlock('text',content,requestId);
window.fixtureEmitReasoning=(content,requestId)=>window.fixtureEmitBlock('thinking',content,requestId);
window.fixtureFinishStream=async(requestId=window.fixturePendingRequest.requestId,keepStreaming=false)=>{
 const stream=window.fixtureStreams.get(requestId);
 const data=[...stream.blocks.values()].map(index=>fixtureSse({type:'content_block_stop',index})).join('')+fixtureSse({type:'message_delta',delta:{stop_reason:'end_turn'}})+fixtureSse({type:'message_stop'});
 await emit('llm-proxy-stream-chunk',{requestId,text:data});
 window.fixtureStreamMode=keepStreaming;stream.resolve({status:200,statusText:'OK',text:''});window.fixtureStreams.delete(requestId);
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
window.fixtureFormatBalance = (await import('${sourceRoot}/lib/account-balance')).formatBalance;
window.fixtureAccountStore = (await import('${sourceRoot}/stores/deepseek-account')).useDeepSeekAccount;
window.fixtureFlushChat = (await import('${sourceRoot}/stores/chat-storage')).flushChatStorage;
const { default: App } = await import('${sourceRoot}/App');
createRoot(document.getElementById('root')).render(<App />);
`,
);
const productionWorker = (await readdir(path.join(root, "dist/assets"))).find(
  (name) => /^module-index\.worker-.*\.js$/.test(name),
);
if (!productionWorker)
  throw new Error("Build the production module worker before UI smoke");
await build({
  entryPoints: [path.join(fixture, "entry.tsx")],
  outdir: path.join(fixture, "assets"),
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  tsconfig: path.join(root, "tsconfig.json"),
  plugins: [
    {
      name: "serve-production-worker",
      setup(b) {
        // Match Vite's default CSS module names so smoke uses real production styles.
        b.onLoad({ filter: /\.module\.css$/ }, async ({ path: file }) => {
          const css = await readFile(file, "utf8");
          let hash = 5381,
            i = css.length;
          while (i) hash = (hash * 33) ^ css.charCodeAt(--i);
          const suffix = (hash >>> 0).toString(36).slice(0, 5),
            mapping = {};
          for (const [, name] of css.matchAll(/\.([A-Za-z_][\w-]*)/g))
            mapping[name] =
              "_" +
              name +
              "_" +
              suffix +
              "_" +
              css.slice(0, css.indexOf("." + name)).split(/[\r\n]/).length;
          return {
            contents: "export default " + JSON.stringify(mapping),
            loader: "js",
          };
        });
        b.onLoad(
          { filter: /module-worker-client\.ts$/ },
          async ({ path: file }) => ({
            contents: (await readFile(file, "utf8")).replace(
              'new URL("./module-index.worker.ts", import.meta.url)',
              'new URL("/production-assets/' +
                productionWorker +
                '", window.location.href)',
            ),
            loader: "ts",
            resolveDir: path.dirname(file),
          }),
        );
      },
    },
  ],
  external: ["@huggingface/transformers"],
  loader: { ".css": "empty" },
  logLevel: "error",
});
const builtCss = (await readdir(path.join(root, "dist/assets"))).find((name) =>
  /^index-.*\.css$/.test(name),
);
if (!builtCss) throw new Error("Run npm run build before the browser smoke");
await writeFile(
  path.join(fixture, "style.css"),
  (
    await Promise.all(
      (await readdir(path.join(root, "dist/assets")))
        .filter((n) => n.endsWith(".css"))
        .map((n) => readFile(path.join(root, "dist/assets", n), "utf8")),
    )
  ).join("\n") +
    "\n" +
    (await readFile(
      path.join(root, "node_modules/@xterm/xterm/css/xterm.css"),
      "utf8",
    )),
);
const server = createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    if (name.startsWith("/production-assets/")) {
      const target = path.join(root, "dist/assets", path.basename(name));
      res.setHeader(
        "Content-Type",
        name.endsWith(".js") ? "text/javascript" : "application/octet-stream",
      );
      res.end(await readFile(target));
      return;
    }
    const file = path.resolve(
      fixture,
      "." + (name === "/" ? "/index.html" : name),
    );
    if (!file.startsWith(fixture + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.setHeader(
      "Content-Type",
      file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    );
    res.end(
      await readFile(
        name === "/icon.ico" ? path.join(root, "public/icon.ico") : file,
      ),
    );
  } catch {
    res.writeHead(404);
    res.end();
  }
});
let browser;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.EAICODING_BROWSER_CHANNEL
      ? { channel: process.env.EAICODING_BROWSER_CHANNEL }
      : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  // Tauri opener's injected _blank/Ctrl-click listener also runs in desktop.
  // Include its behavior so an embedded action cannot pass only in the browser fixture.
  await context.addInitScript(() => {
    window.addEventListener("click", event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey) return;
      const link = event.composedPath().find(node => node instanceof HTMLAnchorElement);
      if (!link?.href || (link.target !== "_blank" && !event.ctrlKey && !event.shiftKey)) return;
      if (!["http:", "https:", "mailto:", "tel:"].includes(new URL(link.href).protocol)) return;
      event.preventDefault();
      void window.__TAURI_INTERNALS__.invoke("plugin:opener|open_url", { url: link.href });
    });
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.getByTestId("deepseek-login").waitFor();
  await page.setViewportSize({ width: 600, height: 700 });
  assert.equal(await page.locator("#deepseek-key").count(), 0);
  assert.equal(
    await page
      .getByRole("textbox", { name: "消息输入框", exact: true })
      .count(),
    0,
    "workspace must not mount before login",
  );
  await page.screenshot({
    path: path.join(screenshots, "login-entry.png"),
    animations: "disabled",
  });
  const loginGeometry = await page
    .locator(".login-actions .login-primary")
    .boundingBox();
  assert.equal(loginGeometry.width, 240);
  assert.equal(loginGeometry.height, 44);
  await page
    .getByRole("button", { name: "登录 DeepSeek", exact: true })
    .click();
  await page.evaluate(async () => {
    window.fixtureAccountView.phase = "waiting-browser";
    await window.fixtureEmit("deepseek-account-changed");
  });
  await page.getByText("请在浏览器中完成登录", { exact: true }).waitFor();
  await page.getByRole("button", { name: "复制登录链接", exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.fixtureBrowserAction.copy),
    true,
  );
  await page.screenshot({
    path: path.join(screenshots, "login-waiting.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "取消登录", exact: true }).click();
  await page
    .getByRole("button", { name: "登录 DeepSeek", exact: true })
    .waitFor();
  await page
    .getByRole("button", { name: "登录 DeepSeek", exact: true })
    .click();
  await page.evaluate(async () => {
    window.fixtureAccountView = {
      ...window.fixtureAccountView,
      phase: "failed",
      error: "fixture 官方授权暂时不可用",
      attemptId: null,
    };
    await window.fixtureEmit("deepseek-account-changed");
  });
  await page.getByText("fixture 官方授权暂时不可用").waitFor();
  await page
    .getByRole("button", { name: "重新登录 DeepSeek", exact: true })
    .click();
  await page.evaluate(async () => {
    window.fixtureAccountView = {
      signedIn: true,
      name: "测试账号",
      contact: "fixture@example.invalid",
      phase: "signed-in",
      error: null,
      attemptId: null,
    };
    await window.fixtureEmit("deepseek-account-changed");
  });
  await page
    .getByRole("textbox", { name: "消息输入框", exact: true })
    .waitFor();
  await page.setViewportSize({ width: 1366, height: 900 });
  console.log(
    "PASS login-first gate, Harness 600x700 geometry, browser/copy actions, cancellation, failure/retry and account-to-workspace transition",
  );
  assert.deepEqual(
    await page.locator(".harness-composer-send").evaluate((button) => {
      const rect = button.getBoundingClientRect(),
        icon = button.querySelector("svg");
      return {
        width: rect.width,
        height: rect.height,
        radius: getComputedStyle(button).borderRadius,
        iconWidth: icon.getAttribute("width"),
        iconHeight: icon.getAttribute("height"),
      };
    }),
    {
      width: 34,
      height: 34,
      radius: "999px",
      iconWidth: "16",
      iconHeight: "16",
    },
  );
  assert.equal(
    await page
      .getByRole("complementary", { name: "工作区面板", exact: true })
      .isVisible(),
    false,
    "the right workspace starts collapsed, as in Harness",
  );
  await page.getByRole("button", { name: "打开工作区", exact: true }).click();
  await page
    .getByRole("complementary", { name: "工作区面板", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "收起工作区", exact: true }).click();
  await page
    .getByRole("textbox", { name: "消息输入框", exact: true })
    .fill("设置弹窗关闭后保留这份需求");
  await page.evaluate(() => {
    window.fixtureComposerNode = document.querySelector(
      '[aria-label="消息输入框"]',
    );
  });
  const caption = page.getByRole("menubar", { name: "应用菜单" });
  assert.deepEqual(await caption.getByRole("menuitem").allTextContents(), ["应用", "编辑"]);
  await page.evaluate(() => { const input = document.querySelector('[aria-label="消息输入框"]'); input.focus(); input.setSelectionRange(2, 6); });
  await caption.getByRole("menuitem", { name: "编辑", exact: true }).click();
  await page.waitForFunction(() => window.fixtureCaptionRequest?.name === 'edit');
  assert.deepEqual(await page.evaluate(() => ({ active: window.fixtureCaptionRequest.active, start: window.fixtureCaptionRequest.start, end: window.fixtureCaptionRequest.end })), { active: "消息输入框", start: 2, end: 6 });
  await page.evaluate(() => window.fixtureCloseCaption());
  await page.waitForFunction(() => document.querySelector('[role="menubar"] [aria-expanded="true"]') === null);
  await caption.getByRole("menuitem", { name: "应用", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(() => window.fixtureCaptionRequest?.active === '消息输入框');
  assert.deepEqual(await page.evaluate(() => [document.activeElement.selectionStart, document.activeElement.selectionEnd]), [2, 6]);
  await page.evaluate(() => window.fixtureCloseCaption());
  await page.evaluate(() => window.fixtureEmit("caption-menu-action", "about"));
  await page.getByRole("dialog", { name: "关于 EAiCoding" }).waitFor();
  await page.screenshot({ path: path.join(screenshots, "application-about.png") });
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(() => window.fixtureEmit("caption-menu-action", "updates"));
  await page.getByText("最新发布版本 v0.1.8", { exact: true }).waitFor();
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(() => window.fixtureEmit("caption-menu-action", "exit"));
  await page.getByRole("dialog", { name: "退出 EAiCoding？" }).waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await page.evaluate(() => window.fixtureIpc.includes('exit_application')), false);
  assert.equal(await page.locator('[title], [role="tooltip"], .harness-composer-hint, .workbench-hint').count(), 0);
  console.log("PASS caption menu pointer/keyboard focus and selection, about/update/exit actions and no tooltips");
  const openSettings = async () => {
    await page.getByRole("button", { name: "账号菜单", exact: true }).click();
    await page.getByRole("menuitem", { name: "设置", exact: true }).click();
  };
  assert.deepEqual(
    await page.evaluate(() =>
      [
        "0",
        "0.009",
        "-0.001",
        "1.239",
        "-1.239",
        "12345678901234567890.12",
      ].map((amount) => window.fixtureFormatBalance(amount, "¥")),
    ),
    [
      "¥0.00",
      "<¥0.01",
      "-¥0.01",
      "¥1.23",
      "-¥1.24",
      "¥12,345,678,901,234,567,890.12",
    ],
  );
  const accountTrigger = page.getByRole("button", {
    name: "账号菜单",
    exact: true,
  });
  await accountTrigger.getByText("测试账号", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "设置", exact: true }).count(),
    0,
    "sidebar footer is the account identity",
  );
  await accountTrigger.click();
  assert.deepEqual(await page.getByRole("menu", { name: "账号操作" }).getByRole("menuitem").allTextContents(), [
    "设置Ctrl+,",
    "退出登录",
  ]);
  const menuBox = await page
    .getByRole("menu", { name: "账号操作" })
    .boundingBox();
  const triggerBox = await accountTrigger.boundingBox();
  assert(
    menuBox.y + menuBox.height <= triggerBox.y,
    "account menu opens above the footer",
  );
  await page.screenshot({
    path: path.join(screenshots, "account-menu.png"),
    animations: "disabled",
  });
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page
      .getByRole("menuitem", { name: "退出登录", exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await accountTrigger.evaluate((node) => node === document.activeElement),
    true,
  );
  await openSettings();
  const settingsDialog = page.getByRole("dialog", {
    name: "设置",
    exact: true,
  });
  await settingsDialog.waitFor();
  assert.equal(await settingsDialog.getAttribute("aria-modal"), "true");
  assert.deepEqual(await page.evaluate(() => ({
    background: getComputedStyle(document.querySelector('.app-main-surface')).backgroundColor,
    sidebar: getComputedStyle(document.querySelector('.claude-sidebar')).backgroundColor,
    foreground: getComputedStyle(document.body).color,
    send: getComputedStyle(document.querySelector('.harness-composer-send')).backgroundColor,
  })), { background: 'rgb(255, 255, 255)', sidebar: 'rgb(249, 250, 251)', foreground: 'rgb(15, 17, 21)', send: 'rgb(65, 118, 230)' }, 'light palette matches Harness ui-theme');
  assert.equal(
    await page.evaluate(() => window.fixtureComposerNode.isConnected),
    true,
    "opening settings must keep the chat mounted",
  );
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector(".settings-dialog")
        .contains(document.activeElement),
    ),
    true,
    "focus moves into settings",
  );
  assert.equal(
    await page.getByRole("tab", { name: "个人中心", selected: true }).count(),
    1,
  );
  assert.deepEqual(await page.getByRole("tab").allTextContents(), [
    "个人中心",
    "通用",
    "模型",
    "易语言环境",
    "模块库",
  ]);
  await settingsDialog.evaluate(async (node) => {
    await Promise.all(
      node.getAnimations().map((animation) => animation.finished),
    );
  });
  const layout = await page.evaluate(() => ({
    modal: document
      .querySelector(".settings-dialog")
      .getBoundingClientRect()
      .toJSON(),
    rail: document.querySelector(".settings-nav").getBoundingClientRect().width,
    nav: document
      .querySelector(".settings-navigation button")
      .getBoundingClientRect().height,
    header: document.querySelector(".settings-header").getBoundingClientRect()
      .height,
  }));
  assert.equal(layout.modal.width, 800);
  assert.equal(layout.modal.height, 780);
  assert.equal(
    await page
      .locator(".settings-overlay")
      .evaluate((node) => node.getBoundingClientRect().top),
    40,
  );
  assert.equal(
    await page
      .locator(".window-titlebar")
      .first()
      .evaluate((node) => getComputedStyle(node).backgroundColor),
    await page
      .locator(".claude-sidebar")
      .evaluate((node) => getComputedStyle(node).backgroundColor),
  );
  assert.equal(
    await page
      .locator(".app-main-surface")
      .evaluate((node) => getComputedStyle(node).borderTopLeftRadius),
    "16px",
  );
  assert.equal(layout.rail, 188);
  assert.equal(layout.nav, 40);
  assert.equal(layout.header, 54);
  const center = page.getByRole("region", { name: "个人中心", exact: true });
  await center.getByText("测试账号", { exact: true }).waitFor();
  await center.getByText("¥12.34", { exact: true }).waitFor();
  await center.getByText("¥5.60", { exact: true }).waitFor();
  await center.getByRole("button", { name: "查询用量", exact: true }).click();
  const platformDialog = page.getByRole("dialog", {
    name: "查询用量",
    exact: true,
  });
  await platformDialog.waitFor();
  await page.waitForFunction(() =>
    window.fixtureNativeCalls.some(
      (call) =>
        call.cmd === "deepseek_platform_open" && call.args.page === "usage",
    ),
  );
  assert.equal(
    await page.evaluate(() =>
      window.fixtureNativeCalls.some(
        (call) =>
          call.cmd === "plugin:opener|open_url" &&
          /\/usage|\/top_up/.test(call.args.url),
      ),
    ),
    false,
    "usage and recharge must stay embedded",
  );
  await page.screenshot({
    path: path.join(screenshots, "platform-usage.png"),
    animations: "disabled",
  });
  await platformDialog
    .getByRole("button", { name: "返回个人中心", exact: true })
    .click();
  await platformDialog.waitFor({ state: "hidden" });
  await center.waitFor();
  await page.evaluate(() => {
    window.fixturePlatformFailure = true;
  });
  await center.getByRole("button", { name: "充值", exact: true }).click();
  const topupDialog = page.getByRole("dialog", { name: "充值", exact: true });
  await topupDialog.getByText("操作未完成，请重试", { exact: true }).waitFor();
  await page.evaluate(() => {
    window.fixturePlatformFailure = false;
  });
  await topupDialog.getByRole("button", { name: "重试", exact: true }).click();
  await page.waitForFunction(
    () =>
      window.fixtureNativeCalls.filter(
        (call) =>
          call.cmd === "deepseek_platform_open" && call.args.page === "top-up",
      ).length === 2,
  );
  await topupDialog
    .getByRole("button", { name: "返回个人中心", exact: true })
    .click();
  await topupDialog.waitFor({ state: "hidden" });
  await center.waitFor();
  await page.waitForFunction(() =>
    document.querySelector(".settings-dialog").contains(document.activeElement),
  );
  console.log(
    "PASS embedded official usage/recharge, native close, failure/retry and account focus restoration",
  );
  await page.screenshot({
    path: path.join(screenshots, "account-center.png"),
    animations: "disabled",
  });
  await page.evaluate(() => {
    window.fixtureDetailsUnavailable = true;
  });
  await center.getByRole("button", { name: "刷新", exact: true }).click();
  await center
    .getByText("账号资料暂不可用，可重试或前往开放平台查看。", { exact: true })
    .waitFor();
  assert.equal(
    await center.locator(".account-amount").count(),
    0,
    "unavailable wallets must never display a fabricated zero",
  );
  await page.evaluate(() => {
    window.fixtureDetailsUnavailable = false;
  });
  await center.getByRole("button", { name: "刷新", exact: true }).click();
  await center.getByText("¥12.34", { exact: true }).waitFor();
  const reads = await page.evaluate(() => window.fixtureDetailsReads);
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  await page.getByRole("tab", { name: "个人中心", exact: true }).click();
  assert.equal(
    await page.evaluate(() => window.fixtureDetailsReads),
    reads,
    "section switches do not refetch the account",
  );
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  console.log(
    "PASS Harness account identity, upward menu/keyboard, personal center default, real balance projection, official links and unavailable-state retry",
  );
  assert.equal(
    await page.getByText("DeepSeek 账号模型参数", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("spinbutton", { name: "最大输出 Token" }).count(),
    0,
    "no invented global generation parameters",
  );
  const modelSettings = page.getByRole("region", {
    name: "模型设置",
    exact: true,
  });
  await modelSettings
    .getByRole("button", { name: "添加模型提供商", exact: true })
    .click();
  await modelSettings
    .getByRole("combobox", { name: "提供商", exact: true })
    .selectOption("anthropic");
  await modelSettings
    .getByRole("textbox", { name: "API 密钥", exact: true })
    .fill("fixture-provider-secret");
  await modelSettings
    .getByRole("tab", { name: "自定义模型 API", exact: true })
    .click();
  await modelSettings
    .getByRole("textbox", { name: "提供商标识", exact: true })
    .fill("fixture-gateway");
  await modelSettings
    .getByRole("textbox", { name: "显示名称", exact: true })
    .fill("测试中转");
  await modelSettings
    .getByRole("textbox", { name: "API 地址", exact: true })
    .fill("https://gateway.invalid/prefix/v1");
  await modelSettings
    .getByRole("tab", { name: "第三方模型提供商", exact: true })
    .click();
  assert.equal(
    await modelSettings
      .getByRole("textbox", { name: "API 密钥", exact: true })
      .inputValue(),
    "fixture-provider-secret",
    "tab switches preserve credential draft",
  );
  await modelSettings
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await modelSettings
    .getByRole("button", { name: "编辑 Anthropic", exact: true })
    .waitFor();
  assert.equal(
    await modelSettings
      .locator("li")
      .last()
      .evaluate((node) => getComputedStyle(node).borderTopStyle),
    "solid",
    "provider cards use production CSS modules",
  );
  assert.equal(
    await page.evaluate(async () =>
      JSON.stringify(
        await window.fixtureSettings.persist
          .getOptions()
          .storage.getItem("eaicoding-settings"),
      ).includes("fixture-provider-secret"),
    ),
    false,
    "keys stay out of persisted frontend settings",
  );
  await modelSettings
    .getByRole("button", { name: "添加模型提供商", exact: true })
    .click();
  await modelSettings
    .getByRole("tab", { name: "自定义模型 API", exact: true })
    .click();
  await modelSettings
    .getByRole("textbox", { name: "提供商标识", exact: true })
    .fill("fixture-gateway");
  await modelSettings
    .getByRole("textbox", { name: "显示名称", exact: true })
    .fill("测试中转");
  await modelSettings
    .getByRole("textbox", { name: "API 地址", exact: true })
    .fill("https://gateway.invalid/prefix/v1");
  await modelSettings
    .getByRole("button", { name: "获取模型列表", exact: true })
    .click();
  const discovered = page.getByRole("dialog", {
    name: "选择要添加的模型",
    exact: true,
  });
  await discovered.waitFor();
  await discovered
    .getByRole("button", { name: "添加所选", exact: true })
    .click();
  await modelSettings
    .locator("details > summary")
    .filter({ hasText: "推理强度" })
    .first()
    .click();
  await modelSettings
    .getByRole("textbox", { name: "推理强度 1", exact: true })
    .fill("low,high");
  await modelSettings
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await modelSettings
    .getByRole("button", { name: "编辑 测试中转", exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(screenshots, "settings-light.png"),
    animations: "disabled",
  });
  const customId = await page.evaluate(
    () =>
      window.fixtureSettings
        .getState()
        .profiles.find((p) => p.provider === "fixture-gateway").id,
  );
  await page.evaluate(async (id) => {
    await window.fixtureSettings.getState().selectModel(id, "fixture-coder");
    window.fixtureResolvedConfig = await window.fixtureSettings
      .getState()
      .resolveLLMConfig();
  }, customId);
  assert.equal(
    await page.evaluate(() => window.fixtureResolvedConfig.profileId),
    customId,
  );
  assert.equal(
    await page.evaluate(() => window.fixtureResolvedConfig.baseUrl),
    "https://gateway.invalid/prefix/v1",
  );
  await page.keyboard.press("Escape");
  await settingsDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("menuitem", { name: /推理强度/ }).click();
  assert.deepEqual(
    await page
      .getByRole("menu", { name: "推理强度", exact: true })
      .getByRole("menuitemradio")
      .allTextContents(),
    ["提供商默认", "低", "高"],
  );
  await page.getByRole("menuitemradio", { name: "高", exact: true }).click();
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: /^模型/ }).click();
  await page
    .getByRole("searchbox", { name: "搜索模型", exact: true })
    .fill("fixture-reasoner");
  await page
    .getByRole("menuitemradio")
    .filter({ hasText: "Fixture Reasoner" })
    .click();
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  assert.equal(
    await page.getByRole("menuitem", { name: /推理强度/ }).count(),
    0,
    "no effort row for a model without declared capabilities",
  );
  await page.keyboard.press("Escape");
  await openSettings();
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  for (const name of ["测试中转", "Anthropic"]) {
    await page.setViewportSize({ width: 1120, height: 720 });
    await modelSettings
      .getByRole("button", { name: "删除 " + name, exact: true })
      .click();
    const confirmation = page.getByRole("dialog", {
      name: "删除模型提供商",
      exact: true,
    });
    const spacing = await confirmation.evaluate(node => {
      const dialog = node.getBoundingClientRect();
      const title = node.querySelector("h2").getBoundingClientRect();
      const description = node.querySelector('[id="' + node.getAttribute("aria-describedby") + '"]').getBoundingClientRect();
      return { titleLeft: title.left - dialog.left, titleTop: title.top - dialog.top, descriptionLeft: description.left - dialog.left, font: getComputedStyle(node.querySelector("h2")).fontFamily };
    });
    assert(spacing.titleLeft >= 24 && spacing.titleTop >= 22, "confirmation title retains Harness header padding");
    assert(spacing.descriptionLeft >= 0, "confirmation body stays in its card");
    assert(!/Copernicus|Charter|Georgia/.test(spacing.font), "confirmation title uses Harness sans font");
    if (name === "测试中转") await page.screenshot({ path: path.join(screenshots, "provider-delete.png"), animations: "disabled" });
    await confirmation
      .getByRole("button", { name: "删除", exact: true })
      .click();
    await confirmation.waitFor({ state: "hidden" });
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.evaluate(async () => {
    const p = window.fixtureSettings.getState().profiles[0];
    await window.fixtureSettings.getState().selectModel(p.id, "deepseek-flash");
  });
  console.log(
    "PASS provider presets/custom draft retention, native-only key persistence, discovery, grouped model search and per-model reasoning",
  );
  await modelSettings.getByRole("button", { name: "添加模型提供商", exact: true }).click();
  await modelSettings.getByRole("combobox", { name: "提供商", exact: true }).selectOption("openai-codex");
  assert.equal(await modelSettings.getByRole("textbox", { name: "API 密钥", exact: true }).count(), 0, "OAuth-only provider must not show an API-key field");
  await modelSettings.getByRole("button", { name: "连接提供商", exact: true }).click();
  const authDialog = page.getByRole("dialog", { name: "连接 OpenAI Codex (legacy)", exact: true });
  await authDialog.waitFor();
  await authDialog.getByRole("button", { name: "继续", exact: true }).click();
  await authDialog.getByRole("textbox", { name: "粘贴授权码", exact: true }).waitFor();
  await authDialog.getByRole("textbox", { name: "粘贴授权码", exact: true }).fill("fixture-code");
  await authDialog.getByRole("button", { name: "继续", exact: true }).click();
  assert.equal(await authDialog.getByLabel("测试秘密输入", { exact: true }).getAttribute("type"), "password");
  await authDialog.getByRole("button", { name: "关闭认证", exact: true }).click();
  await authDialog.waitFor({ state: "hidden" });
  await page.waitForFunction(() => window.fixtureIpc.includes("cancel_agent_task"));
  await modelSettings.getByRole("button", { name: "连接提供商", exact: true }).click();
  await authDialog.getByRole("combobox", { name: "选择登录方式", exact: true }).selectOption("device");
  await authDialog.getByRole("button", { name: "继续", exact: true }).click();
  await authDialog.getByText("ABCD-EFGH", { exact: true }).waitFor();
  assert.equal(await authDialog.getByRole("button", { name: "复制", exact: true }).count(), 1);
  await page.screenshot({ path: path.join(screenshots, "provider-authorization.png"), fullPage: true, animations: "disabled" });
  await page.evaluate(() => {
    const attempt = window.fixtureAuthAttempt;
    const p = window.fixtureSettings.getState().profiles.find(p => p.id === attempt.args.profileId);
    window.fixtureProviderStatus[p.id] = true;
    attempt.resolve({ configured: true, models: p.models });
  });
  await authDialog.waitFor({ state: "hidden" });
  await modelSettings.getByRole("button", { name: "断开 OpenAI Codex (legacy)", exact: true }).click();
  const disconnect = page.getByRole("dialog", { name: "断开模型提供商", exact: true });
  assert.equal(await disconnect.getByRole('button', { name: '关闭确认', exact: true }).count(), 1);
  await disconnect.getByRole("button", { name: "断开", exact: true }).click();
  await disconnect.waitFor({ state: "hidden" });
  await modelSettings.getByRole("button", { name: "删除 OpenAI Codex (legacy)", exact: true }).click();
  await page.getByRole("dialog", { name: "删除模型提供商", exact: true }).getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog", { name: "删除模型提供商", exact: true }).waitFor({ state: "hidden" });
  console.log("PASS provider authorization UI: method choice, masked/manual prompts, device code/copy, cancel, successful account models and disconnect");
  await page.evaluate(() => window.fixtureSettings.getState().setTheme("dark"));
  assert.deepEqual(await page.evaluate(() => ({
    background: getComputedStyle(document.querySelector('.app-main-surface')).backgroundColor,
    sidebar: getComputedStyle(document.querySelector('.claude-sidebar')).backgroundColor,
    foreground: getComputedStyle(document.body).color,
    send: getComputedStyle(document.querySelector('.harness-composer-send')).backgroundColor,
  })), { background: 'rgb(21, 21, 23)', sidebar: 'rgb(27, 27, 28)', foreground: 'rgb(249, 250, 251)', send: 'rgb(122, 170, 255)' }, 'dark palette matches Harness ui-theme');
  await page.screenshot({
    path: path.join(screenshots, "settings-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() =>
    window.fixtureSettings.getState().setTheme("light"),
  );
  const modelPanelBounds = await settingsDialog.boundingBox();
  await page.getByRole("tab", { name: "通用", exact: true }).click();
  const appearancePanelBounds = await settingsDialog.boundingBox();
  assert.deepEqual(
    appearancePanelBounds,
    modelPanelBounds,
    "switching sections must not resize the modal",
  );
  await page.getByRole("radio", { name: "深色", exact: true }).focus();
  await page.keyboard.press("Space");
  assert.equal(
    await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    ),
    true,
  );
  await page.getByRole("radio", { name: "浅色", exact: true }).focus();
  await page.keyboard.press("Space");
  const busyBehavior = page.getByRole("combobox", {
    name: "繁忙时的发送行为",
    exact: true,
  });
  await busyBehavior.click();
  await page.getByRole("option", { name: "插话发送", exact: true }).click();
  assert.equal(
    await page.evaluate(
      () => window.fixtureSettings.getState().busyEnterBehavior,
    ),
    "steer",
  );
  await busyBehavior.click();
  await page.getByRole("option", { name: "排队发送", exact: true }).click();
  await page
    .getByRole("switch", { name: "显示代码工作视图", exact: true })
    .uncheck();
  await page
    .getByRole("switch", { name: "显示代码工作视图", exact: true })
    .check();
  const petSwitch = page.getByRole("switch", { name: "显示宠物", exact: true });
  await petSwitch.check();
  assert.equal(
    await page.evaluate(() => window.fixtureSettings.getState().petEnabled),
    true,
  );
  await petSwitch.uncheck();
  await page.screenshot({
    path: path.join(screenshots, "settings-appearance.png"),
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "易语言环境", exact: true }).click();
  assert.equal(
    await page.evaluate(
      () =>
        window.fixtureIpc.filter((cmd) => cmd === "scan_easy_language_env")
          .length,
    ),
    0,
    "opening the environment must not scan the disk",
  );
  const scanButton = page.getByRole("button", {
    name: "扫描环境",
    exact: true,
  });
  await scanButton.click();
  await page.getByRole("button", { name: "扫描中…", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "扫描中…", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("tab", { name: "通用", exact: true }).click();
  await page.getByRole("radio", { name: "浅色", exact: true }).waitFor();
  await page.getByRole("tab", { name: "易语言环境", exact: true }).click();
  assert.equal(
    await page.evaluate(
      () =>
        window.fixtureIpc.filter((cmd) => cmd === "scan_easy_language_env")
          .length,
    ),
    1,
    "switching tabs during a scan must not launch duplicates",
  );
  await page
    .getByRole("textbox", { name: "安装目录", exact: true })
    .fill("D:/fixture/new-environment");
  await page.evaluate(() => window.fixtureResolveEnv());
  await scanButton.waitFor();
  assert.equal(await page.getByText(/打开本页不会自动扫描磁盘/).count(), 0, "remove extra environment instruction tips");
  assert.equal(
    await page.getByText("编译链状态正常", { exact: true }).count(),
    0,
    "an old root must not publish a stale scan result",
  );
  await scanButton.click();
  await page.evaluate(() => window.fixtureResolveEnv());
  await page.getByText("编译链状态正常", { exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: "源码生成目录", exact: true })
    .fill("D:/fixture/generated");
  assert.equal(
    await page.evaluate(
      () => window.fixtureSettings.getState().easyLanguageGenerateDir,
    ),
    "D:/fixture/generated",
  );
  await page.screenshot({
    path: path.join(screenshots, "settings-environment.png"),
    animations: "disabled",
  });
  await scanButton.click();
  await page.getByRole("button", { name: "扫描中…", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await settingsDialog.waitFor({ state: "hidden" });
  assert.equal(
    await page
      .getByRole("textbox", { name: "消息输入框", exact: true })
      .inputValue(),
    "设置弹窗关闭后保留这份需求",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "账号菜单", exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
    "closing settings restores focus to its trigger",
  );
  await openSettings();
  assert.equal(
    await page.getByRole("tab", { name: "个人中心", selected: true }).count(),
    1,
    "account settings opens the personal center",
  );
  await page.getByRole("tab", { name: "易语言环境", exact: true }).click();
  await page.evaluate(() => window.fixtureResolveEnv());
  assert.equal(await page.getByText(/打开本页不会自动扫描磁盘/).count(), 0);
  assert.equal(
    await page.getByText("编译链状态正常", { exact: true }).count(),
    0,
    "a closed modal must not publish results into the new one",
  );
  console.log(
    "PASS manual background environment scan, pending tab/close responsiveness, duplicate prevention and stale result isolation",
  );
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  for (const viewport of [
    { width: 1120, height: 720 },
    { width: 960, height: 600 },
    { width: 390, height: 700 },
  ]) {
    await page.setViewportSize(viewport);
    await page.screenshot({
      path: path.join(screenshots, "settings-" + viewport.width + ".png"),
      animations: "disabled",
    });
    const bounds = await settingsDialog.boundingBox();
    assert(
      bounds.y >= 60 && bounds.y + bounds.height <= viewport.height - 60,
      "modal keeps Harness caption clearance",
    );
    assert.equal(
      await page
        .locator('.settings-pane[data-state="active"]')
        .evaluate((node) => node.scrollWidth > node.clientWidth),
      false,
    );
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.mouse.click(20, 450);
  await settingsDialog.waitFor({ state: "hidden" });
  await openSettings();
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  await page.keyboard.press("Control+,");
  await settingsDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  const retainedInput = page.getByRole("textbox", {
    name: "消息输入框",
    exact: true,
  });
  await retainedInput.focus();
  await page.keyboard.press("Control+,");
  await settingsDialog.waitFor();
  await page.keyboard.press("Escape");
  await settingsDialog.waitFor({ state: "hidden" });
  assert.equal(
    await retainedInput.evaluate((node) => node === document.activeElement),
    true,
    "keyboard settings returns focus even with the sidebar hidden",
  );
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await openSettings();
  console.log(
    "PASS modal settings: stable size, theme/preferences, environment fields, focus trap/restore, Escape/mask close, narrow layout and retained chat draft",
  );
  await page.evaluate(() => {
    window.fixtureSettings.setState({
      userModules: Array.from({ length: 10000 }, (_, index) => ({
        id: "module-" + index,
        name: "测试模块 " + index,
        sourcePath: "D:/modules/" + index + ".ec",
        storedPath: "D:/modules/" + index + ".ec",
        fileBytes: 4096,
        status: "ready",
        lastError: null,
        apiCount: 100,
        classCount: 3,
        indexedCount: 0,
        hasVectorIndex: false,
        createdAt: 0,
        updatedAt: 0,
      })),
    });
  });
  const moduleStart = Date.now();
  await page.getByRole("tab", { name: "模块库", exact: true }).click();
  await page.locator(".module-library-row").first().waitFor();
  assert.equal(await page.locator(".module-library-row").count(), 20);
  console.log(
    "PASS module tab with 10,000 modules: only 20 mounted rows; cold open " +
      (Date.now() - moduleStart) +
      "ms",
  );
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await page
    .locator(".module-library-row")
    .first()
    .filter({ hasText: "测试模块 20" })
    .waitFor();
  await page.evaluate(async () => {
    await window.fixturePutModuleIndex("module-20", {
      moduleId: "module-20",
      parsedTextHash: "fixture",
      vectorIndex: null,
      apis: Array.from({ length: 100 }, (_, i) => ({
        id: "api-" + i,
        name: "启动线程" + i,
        kind: "subprogram",
        className: "线程池",
        signature: "整数型 启动线程" + i + "（任务: 整数型）",
        returnType: "整数型",
        description: "启动任务说明",
        line: i + 1,
        params: [
          {
            name: "任务",
            type: "整数型",
            byRef: true,
            description: "任务指针",
          },
        ],
        isPublic: i < 80,
      })),
      assemblies: [
        {
          name: "线程池",
          line: 1,
          publicMethodCount: 80,
          description: "线程池类",
        },
      ],
      declarations: [
        {
          kind: "数据类型",
          name: "任务信息",
          signature: ".数据类型 任务信息, 公开",
          line: 2,
        },
      ],
    });
  });
  await page
    .getByRole("button", { name: "查看模块 测试模块 20", exact: true })
    .click();
  const details = page.getByRole("region", { name: "模块详情", exact: true });
  await details.locator(".module-detail-item").first().waitFor();
  assert.equal(
    await details.locator(".module-detail-item").count(),
    40,
    "large module details paginate their DOM",
  );
  await details
    .getByRole("textbox", { name: "搜索模块内容", exact: true })
    .fill("启动线程99");
  await details
    .locator(".module-detail-item")
    .filter({ hasText: "启动线程99" })
    .click();
  assert.match(
    await details.getByRole("article", { name: "接口详情" }).textContent(),
    /任务指针/,
  );
  await details.getByRole("button", { name: "复制签名", exact: true }).click();
  const copyNotice = page
    .locator('[data-sonner-toast][data-mounted="true"]')
    .filter({ hasText: "签名已复制" });
  await copyNotice.waitFor();
  await copyNotice.evaluate((node) =>
    Promise.all(
      node
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => {})),
    ),
  );
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "整数型 启动线程99（任务: 整数型）",
  );
  assert.equal(
    await copyNotice.evaluate((node) => {
      // Include the passive notice in hit testing without changing modal interaction.
      const original = node.style.pointerEvents;
      node.style.pointerEvents = "auto";
      try {
        const text = node.querySelector("[data-title]");
        const rect = text.getBoundingClientRect();
        return node.contains(
          document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2,
          ),
        );
      } finally {
        node.style.pointerEvents = original;
      }
    }),
    true,
    "settings copy notices must paint above the modal backdrop, without being dimmed or blurred",
  );
  assert.equal(
    await settingsDialog.isVisible(),
    true,
    "copying must leave module settings open",
  );
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector(".settings-dialog")
        .contains(document.activeElement),
    ),
    true,
    "copy notices must retain modal focus",
  );
  await page.screenshot({
    path: path.join(screenshots, "settings-copy-notice.png"),
    animations: "disabled",
  });
  console.log(
    "PASS module signature clipboard, notice paint order above settings and retained modal focus",
  );
  await details
    .getByRole("tab", { name: "类型与其他声明", exact: true })
    .click();
  await details
    .locator(".module-detail-item")
    .filter({ hasText: "任务信息" })
    .waitFor();
  await details.getByRole("tab", { name: "完整解析文本", exact: true }).click();
  await page.waitForFunction(() =>
    window.fixtureReads?.some(
      (r) =>
        r.filePath === "D:/modules/20.parse_output.txt" && r.maxChars === 16000,
    ),
  );
  await details.getByRole("button", { name: "模块库", exact: true }).click();
  await page
    .getByRole("button", { name: "内置精易知识条目 6779 条", exact: true })
    .click();
  await details
    .getByRole("tab", { name: "类型与其他声明", exact: true })
    .click();
  await details.locator(".module-detail-item").first().waitFor();
  assert.match(
    await details.locator(".module-detail-pagination").textContent(),
    /2602 项/,
  );
  await page.screenshot({ path: path.join(screenshots, "module-details.png") });
  await details.getByRole("button", { name: "模块库", exact: true }).click();
  const workerResult = await page.evaluate(async (url) => {
    const worker = new Worker(url, { type: "module" });
    let ticks = 0;
    const clock = setInterval(() => ticks++, 1);
    try {
      const parsed = await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => {
          if ("result" in data) resolve(data.result);
          else if (data.error) reject(new Error(data.error));
        };
        worker.onerror = (event) => reject(new Error(event.message));
        worker.postMessage({
          id: 1,
          kind: "parse",
          input: Array.from(
            { length: 5000 },
            (_, i) => ".子程序 接口" + i + ", 整数型, 公开\n.参数 数值, 整数型",
          ).join("\n"),
        });
      });
      return {
        count: parsed.apis.length,
        last: parsed.apis.at(-1).name,
        ticks,
      };
    } finally {
      clearInterval(clock);
      worker.terminate();
    }
  }, "/production-assets/" + productionWorker);
  assert.equal(workerResult.count, 5000);
  assert.equal(workerResult.last, "接口4999");
  assert(
    workerResult.ticks > 0,
    "main UI remains responsive while the real worker parses",
  );
  console.log(
    "PASS production module worker parses every API while main-thread UI timers continue",
  );
  console.log(
    "PASS module detail paging, private/public metadata, parameter tables, other declarations, raw text and builtin category counts",
  );
  await page.getByRole("tab", { name: "模型", exact: true }).click();
  await page.getByRole("tab", { name: "模块库", exact: true }).click();
  assert.match(
    await page.locator(".module-library-row").first().textContent(),
    /测试模块 20/,
  );
  await page
    .getByRole("textbox", { name: "搜索模块", exact: true })
    .fill("测试模块 9999");
  await page.getByRole("status").filter({ hasText: "共 1 个模块" }).waitFor();
  assert.equal(await page.locator(".module-library-row").count(), 1);
  await page.screenshot({
    path: path.join(screenshots, "module-library.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "易语言环境", exact: true }).click();
  await page.getByRole("tab", { name: "模块库", exact: true }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: "搜索模块", exact: true })
      .inputValue(),
    "测试模块 9999",
  );
  await page.getByRole("button", { name: "清除模块搜索", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "共 10000 个模块" })
    .waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "搜索模块", exact: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await page.evaluate(() =>
    window.fixtureSettings.setState({ userModules: [] }),
  );
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await settingsDialog.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.evaluate(() =>
    window.fixtureSettings
      .getState()
      .updateProfile("default", { model: "deepseek-flash" }),
  );
  const input = page.getByRole("textbox", { name: "消息输入框", exact: true });
  await input.waitFor();
  assert.match(await input.getAttribute("placeholder"), /易语言/);
  assert.equal(
    await page.getByRole("combobox", { name: "操作权限" }).count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "计划", exact: true }).count(),
    0,
  );
  const initialHeight = await input.evaluate(
    (element) => element.getBoundingClientRect().height,
  );
  assert(initialHeight <= 40, "empty editor should occupy one line");
  assert(
    (await page.locator("[data-composer-card]").boundingBox()).height <= 110,
    "empty composer must stay compact",
  );
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1120, height: 720 },
    { width: 960, height: 600 },
    { width: 1366, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await input.fill(
      Array.from(
        { length: 30 },
        (_, index) => "第 " + index + " 行易语言需求",
      ).join("\n"),
    );
    const expanded = await input.evaluate((element) => ({
      height: element.getBoundingClientRect().height,
      scroll: element.scrollHeight,
    }));
    assert(
      expanded.height <= 168 && expanded.scroll > expanded.height,
      "long input must scroll within its height limit",
    );
    await input.fill("一行需求");
    assert((await input.boundingBox()).height <= 40, "short input must shrink");
    await input.fill("");
    assert(
      (await input.boundingBox()).height <= 40,
      "clearing input must restore one line",
    );
    const picker = page.getByRole("button", { name: "选择模型", exact: true });
    assert.match(await picker.textContent(), /^DeepSeek-V4\.1-Flash1017高$/);
    const bounds = await picker.boundingBox();
    assert(
      bounds &&
        bounds.x >= 0 &&
        bounds.x + bounds.width <= viewport.width &&
        bounds.y + bounds.height <= viewport.height,
      "model selector must stay visible",
    );
  }
  await input.focus();
  for (const target of [input, page.locator("[data-composer-card]")]) {
    const border = await target.evaluate((element) => ({
      border: getComputedStyle(element).borderTopWidth,
      outline: getComputedStyle(element).outlineStyle,
    }));
    assert.equal(border.border, "0px");
    assert.equal(border.outline, "none");
  }
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: /^模型/ }).click();
  const modelOptions = page
    .getByRole("menu", { name: "模型", exact: true })
    .getByRole("menuitemradio");
  assert.equal(await modelOptions.count(), 2);
  assert.equal(
    await page.getByText("日常对话与代码生成", { exact: true }).count(),
    0,
  );
  assert.deepEqual(await modelOptions.allTextContents(), [
    "DeepSeek-V4.1-Flash1017",
    "DeepSeek-V4-Pro",
  ]);
  assert.equal(await modelOptions.locator("small").count(), 0);
  await page
    .getByRole("menuitemradio")
    .filter({ hasText: "DeepSeek-V4-Pro" })
    .click();
  assert.match(
    await page
      .getByRole("button", { name: "选择模型", exact: true })
      .textContent(),
    /^DeepSeek-V4-Pro高$/,
  );
  assert.equal(
    await page.evaluate(
      async () =>
        (
          await window.fixtureSettings.persist
            .getOptions()
            .storage.getItem("eaicoding-settings")
        ).state.profiles[0].model,
    ),
    "deepseek-v4-pro",
  );
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.screenshot({
    path: path.join(screenshots, "composer-models-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".harness-model-menu").count(), 0);
  await page.evaluate(() => {
    const state = window.fixtureSettings.getState();
    const id = state.activeProfileId;
    window.fixtureSettings.setState({
      modelCatalogs: {
        ...state.modelCatalogs,
        [id]: [
          ...state.profiles[0].models,
          ...["a", "b", "c"].map((id) => ({ id: "deepseek-fixture-" + id })),
        ],
      },
    });
  });
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  assert.equal(
    await page.getByRole("textbox", { name: "搜索模型", exact: true }).count(),
    0,
  );
  await page.getByRole("menuitem").filter({ hasText: /^模型/ }).click();
  assert.equal(
    await modelOptions.count(),
    2,
    "stale and custom catalogs must not add unsupported models",
  );
  assert.equal(
    await modelOptions
      .nth(1)
      .evaluate((element) => element === document.activeElement),
    true,
  );
  await page.keyboard.press("ArrowUp");
  assert.equal(
    await modelOptions
      .nth(0)
      .evaluate((element) => element === document.activeElement),
    true,
  );
  const anchorRect = await page
    .getByRole("button", { name: "选择模型", exact: true })
    .boundingBox();
  const menuRect = await page.locator(".harness-model-menu").boundingBox();
  assert(
    menuRect.y + menuRect.height <= anchorRect.y &&
      Math.abs(menuRect.x + menuRect.width - anchorRect.x - anchorRect.width) <
        2,
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.fixtureSettings.setState({ modelCatalogs: {} }),
  );
  await page
    .getByRole("button", { name: "添加与快捷操作", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "插入代码块", exact: true }).click();
  assert.equal(await input.inputValue(), "```epl\n\n```");
  await page
    .getByRole("button", { name: "添加与快捷操作", exact: true })
    .click();
  await page.getByRole("menuitem").filter({ hasText: "添加文件" }).click();
  await page
    .getByRole("button", { name: "移除附件 示例.ec", exact: true })
    .click();
  await input.fill("保留这份易语言需求");
  await page.evaluate(() => {
    window.fixtureAccountUnavailable = true;
  });
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  assert.equal(
    await page.evaluate(() => window.fixtureRequests.length),
    0,
    "IME Enter must not submit",
  );
  await input.press("Enter");
  await page.getByText(/读取模型配置失败.*请先登录 DeepSeek/).waitFor();
  assert.equal(await input.inputValue(), "保留这份易语言需求");
  await page.evaluate(() => {
    window.fixtureAccountUnavailable = false;
  });
  await input.fill("整理开发步骤");
  await input.press("Enter");
  await page.getByText("开发步骤已整理。", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.fixtureRequests[0].model),
    "deepseek-v4-pro",
    "selected model must reach the actual request",
  );
  const toolNames = await page.evaluate(() =>
    window.fixtureRequests[0].tools.map(
      (tool) => tool.function?.name ?? tool.name,
    ),
  );
  for (const name of [
    "read_file",
    "save_text_file",
    "apply_search_replace",
    "generate_gui_project",
    "compile_efile",
  ])
    assert(toolNames.includes(name), "automatic coding must provide " + name);
  assert.equal(await input.inputValue(), "");
  console.log(
    "PASS compact autosizing at 960/1120/1280/1366px, aligned compact model menu, automatic tools, model persistence/keyboard, file actions and IME",
  );
  await page.evaluate(() => {
    window.fixtureStreamMode = true;
    window.fixturePendingRequest = null;
  });
  await input.fill("你好啊");
  await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  assert.equal(
    await page.evaluate(() => window.fixturePendingRequest.body.tools),
    undefined,
  );
  const reply = page.locator(".assistant-message-content").last();
  await page.evaluate(() =>
    window.fixtureEmitReasoning(
      "用户在打招呼。\n\n用简短的中文回复，并说明可以继续编写易语言窗口。",
    ),
  );
  const reasoningToggle = reply.locator(".assistant-reasoning-toggle");
  await reasoningToggle.waitFor();
  assert.equal(await reasoningToggle.getAttribute("aria-expanded"), "false");
  assert.equal(
    await reply.locator(".assistant-reasoning-body").count(),
    0,
    "reasoning stays lazy and collapsed by default",
  );
  assert.equal(
    await reply.locator(".assistant-response").textContent(),
    "",
    "reasoning must never paint into the answer",
  );
  assert.equal(
    await reply.locator(".assistant-activity").count(),
    0,
    "reasoning replaces the generic waiting indicator",
  );
  await reasoningToggle.click();
  await reply
    .locator(".assistant-reasoning-body")
    .getByText("用户在打招呼。", { exact: true })
    .waitFor();
  await page.evaluate(() =>
    window.fixtureEmitReasoning("\n\n等待用户提供具体需求。"),
  );
  await reply
    .locator(".assistant-reasoning-body")
    .getByText("等待用户提供具体需求。", { exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(screenshots, "reasoning-streaming.png"),
    animations: "disabled",
    style: "[data-sonner-toaster] { visibility: hidden; }",
  });
  await page.evaluate(() => window.fixtureEmitToken("你好！"));
  await reply.getByText("你好！", { exact: true }).waitFor();
  assert.equal(
    await page.getByRole("button", { name: "停止生成", exact: true }).count(),
    1,
    "partial Markdown must paint while IPC is still pending",
  );
  await openSettings();
  await settingsDialog.waitFor();
  await page.evaluate(() =>
    window.fixtureEmitToken(
      "我可以帮你编写易语言窗口和事件代码，也能查阅精易模块接口。",
    ),
  );
  await reply
    .getByText(
      "你好！我可以帮你编写易语言窗口和事件代码，也能查阅精易模块接口。",
      { exact: true },
    )
    .waitFor();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await settingsDialog.waitFor({ state: "hidden" });
  assert.equal(
    await page.getByRole("button", { name: "停止生成", exact: true }).count(),
    1,
    "opening and closing settings must not stop a live model request",
  );
  assert.equal(await reply.locator(".agent-trace-panel").count(), 0);
  await page.screenshot({
    path: path.join(screenshots, "greeting-streaming.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() => window.fixtureFinishStream());
  await reply.getByRole("button", { name: "复制回复", exact: true }).waitFor();
  assert.equal(
    await reply
      .locator(".assistant-reasoning-body")
      .getByText("用户在打招呼。", { exact: true })
      .count(),
    1,
    "settling must preserve reasoning without duplication",
  );
  assert.equal(
    await reply.locator('.assistant-reasoning[data-running="true"]').count(),
    0,
  );
  const storedReasoning = await page.evaluate(() =>
    window.fixtureChat
      .getState()
      .sessions.find(
        (session) =>
          session.id === window.fixtureChat.getState().activeSessionId,
      )
      .messages.at(-1),
  );
  assert.equal(storedReasoning.reasoningContent, storedReasoning.agentTrace.steps.at(-1).reasoningContent,
    "final reasoning must survive the cleared stream buffer for later model replay");
  assert.match(
    storedReasoning.agentTrace.steps.at(-1).reasoningContent,
    /等待用户提供具体需求/,
  );
  assert.equal(await reply.locator(".assistant-activity").count(), 0);
  assert.equal(await reply.locator(".agent-trace-panel").count(), 0);
  await reply.getByRole("button", { name: "复制回复", exact: true }).click();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    "你好！我可以帮你编写易语言窗口和事件代码，也能查阅精易模块接口。",
  );

  await page.evaluate(() => {
    window.fixtureStreamMode = true;
    window.fixturePendingRequest = null;
  });
  await input.fill("你好");
  await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await page.evaluate(() => window.fixtureEmitToken("停止前的草稿"));
  await reply.getByText("停止前的草稿", { exact: true }).waitFor();
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  const stopped = await reply.textContent();
  await page.evaluate(async () => {
    await window.fixtureEmitToken("LATE_CHUNK_SHOULD_NOT_PAINT");
    await window.fixtureEmitReasoning("LATE_REASONING_SHOULD_NOT_PAINT");
    await window.fixtureFinishStream();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  assert.equal(
    await reply.textContent(),
    stopped,
    "late tokens cannot overwrite the stopped result",
  );
  console.log(
    "PASS live SSE reasoning/answer separation, retained reasoning, one-round greeting, reply copy and ignored late chunks after stop",
  );
  const busyRequestStart = await page.evaluate(
    () => window.fixtureRequests.length,
  );
  await page.evaluate(() => {
    window.fixtureStreamMode = true;
    window.fixturePendingRequest = null;
  });
  await input.fill("你好");
  await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await input.fill("你是谁");
  await page.getByRole("button", { name: "排队发送", exact: true }).click();
  await page.getByLabel("待发送消息", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.fixtureRequests.length),
    busyRequestStart + 1,
  );
  assert.equal(await input.inputValue(), "");
  await page.evaluate(async () => {
    await window.fixtureEmitToken("你好。");
    await window.fixtureFinishStream();
  });
  await page.waitForFunction(
    (start) => window.fixtureRequests.length === start + 2,
    busyRequestStart,
  );
  await page
    .getByLabel("待发送消息", { exact: true })
    .waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  assert.match(
    await page.evaluate(() =>
      JSON.stringify(window.fixtureRequests.at(-1).messages),
    ),
    /你是谁/,
  );
  await page.evaluate(() => {
    window.fixtureStreamMode = true;
    window.fixturePendingRequest = null;
  });
  await input.fill("你好");
  await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await input.fill("改用一句话自我介绍");
  assert.equal(
    await page.getByRole("button", { name: "停止生成", exact: true }).count(),
    1,
  );
  await input.press("Control+Enter");
  assert.equal(await input.inputValue(), "");
  await page.evaluate(async () => {
    await window.fixtureEmitToken("已经过时的答案");
    await window.fixtureFinishStream();
  });
  await page.waitForFunction(
    (start) => window.fixtureRequests.length === start + 4,
    busyRequestStart,
  );
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  assert.match(
    await page.evaluate(() =>
      JSON.stringify(window.fixtureRequests.at(-1).messages),
    ),
    /改用一句话自我介绍/,
  );
  assert.equal(await page.getByLabel("待发送消息", { exact: true }).count(), 0);
  console.log(
    "PASS busy queue admission/drain, separate Stop, Ctrl+Enter steering and greeting-to-steering continuation",
  );

  const originalSession = await page.evaluate(() => window.fixtureChat.getState().activeSessionId);
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.evaluate(() => { window.fixtureStreamMode = true; window.fixturePendingRequest = null; });
  await input.fill("你好");
  await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await page.evaluate(() => {
    window.fixtureQueueRequest = window.fixturePendingRequest.requestId;
    return window.fixtureEmitReasoning("VeryLongReasoningWithoutSpaces".repeat(400));
  });
  const longReasoning = page.locator(".assistant-reasoning-toggle").last();
  await longReasoning.waitFor();
  const assertChatWidth = async () => {
    const widths = await page.evaluate(() => {
      const viewport = document.querySelector(".chat-message-scroll [data-radix-scroll-area-viewport]");
      return { page: [document.documentElement.scrollWidth, document.documentElement.clientWidth], chat: [viewport.scrollWidth, viewport.clientWidth] };
    });
    for (const [label, [scroll, client]] of Object.entries(widths)) assert(scroll <= client + 1, label + " must not overflow horizontally: " + scroll + "/" + client);
  };
  for (const width of [1120, 960]) {
    await page.setViewportSize({ width, height: 720 });
    await assertChatWidth();
    await longReasoning.click();
    await assertChatWidth();
    await longReasoning.click();
    await page.getByRole("button", { name: "打开工作区", exact: true }).click();
    await assertChatWidth();
    await longReasoning.click();
    await assertChatWidth();
    await longReasoning.click();
    await page.getByRole("button", { name: "收起工作区", exact: true }).click();
  }
  await page.setViewportSize({ width: 1366, height: 900 });
  await input.fill("你好呀");
  await input.press("Enter");
  const queueDock = page.getByLabel("待发送消息", { exact: true });
  await queueDock.waitFor();
  assert.equal(await queueDock.locator(".composer-queue-header").count(), 0, "one queued row has no count header");
  assert.equal(await queueDock.getByRole("button", { name: "插话发送排队消息", exact: true }).isEnabled(), true);
  assert.match(await input.getAttribute("placeholder"), /插话发送全部排队消息/);
  await page.screenshot({ path: path.join(screenshots, "harness-queue-single.png") });
  await input.fill("你好啊"); await input.press("Enter");
  await input.fill("再见"); await input.press("Enter");
  const queueHeader = queueDock.getByRole("button", { name: "3 条排队消息", exact: true });
  await queueHeader.waitFor();
  assert.equal(await queueHeader.getAttribute("aria-expanded"), "false");
  await queueHeader.click();
  await queueDock.getByRole("button", { name: "编辑排队消息", exact: true }).nth(1).click();
  await queueDock.getByRole("textbox", { name: "编辑排队消息内容", exact: true }).fill("你是谁");
  await queueDock.getByRole("button", { name: "保存排队消息", exact: true }).click();
  await queueDock.getByRole("button", { name: "取消排队消息", exact: true }).nth(2).click();
  await queueDock.getByRole("button", { name: "插话发送排队消息", exact: true }).nth(1).click();
  assert.equal(await queueDock.locator(".composer-queue-row").count(), 1, "only the clicked row is steered");
  assert.match(await queueDock.textContent(), /你好呀/);
  await page.evaluate(async () => {
    await window.fixtureEmitToken("旧回答");
    await window.fixtureFinishStream(window.fixtureQueueRequest, true);
  });
  await page.waitForFunction(() => window.fixturePendingRequest.requestId !== window.fixtureQueueRequest);
  assert.match(await page.evaluate(() => JSON.stringify(window.fixturePendingRequest.body.messages)), /你是谁/);
  assert.doesNotMatch(await page.evaluate(() => JSON.stringify(window.fixturePendingRequest.body.messages)), /你好呀/);
  await page.evaluate(async () => { await window.fixtureEmitToken("已按插话修改。"); await window.fixtureFinishStream(); });
  await queueDock.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  console.log("PASS Harness queue single/multiple layout, inline edit, remove, enabled selected-row steering, ordered drain and long reasoning width with workspace open/closed");

  // Keep two native streams alive so every session transition is observable.
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.evaluate(() => { window.fixtureStreamMode = true; window.fixturePendingRequest = null; window.fixtureSessionA = window.fixtureChat.getState().activeSessionId; });
  await input.fill("你好"); await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await page.evaluate(() => { window.fixtureRequestA = window.fixturePendingRequest.requestId; });
  await input.fill("你是谁"); await input.press("Enter");
  await input.fill("A任务未发送草稿");
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  assert.equal(await page.locator(".chat-run-status").count(), 0, "a new session has no inherited thinking status");
  assert.equal(await page.getByRole("button", { name: "停止生成", exact: true }).count(), 0);
  assert.equal(await queueDock.count(), 0);
  assert.equal(await input.inputValue(), "");
  await page.evaluate(() => { window.fixtureSessionB = window.fixtureChat.getState().activeSessionId; window.fixturePendingRequest = null; });
  await input.fill("你好啊"); await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await page.evaluate(async () => {
    window.fixtureRequestB = window.fixturePendingRequest.requestId;
    await window.fixtureEmitToken("A独立输出", window.fixtureRequestA);
    await window.fixtureEmitToken("B独立输出", window.fixtureRequestB);
  });
  await page.getByText("B独立输出", { exact: true }).waitFor();
  assert.equal(await page.getByText("A独立输出", { exact: true }).count(), 0);
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  await input.fill("B任务未发送草稿");
  await page.evaluate(() => window.fixtureChat.getState().setActiveSession(window.fixtureSessionA));
  await page.getByRole("button", { name: "停止生成", exact: true }).waitFor();
  assert.equal(await input.inputValue(), "A任务未发送草稿");
  await page.getByText("A独立输出", { exact: true }).waitFor();
  await page.evaluate(async () => {
    window.fixtureChat.getState().setActiveSession(window.fixtureSessionB);
    await window.fixtureFinishStream(window.fixtureRequestB, true);
    await window.fixtureFinishStream(window.fixtureRequestA, true);
  });
  await page.waitForFunction(() => ![window.fixtureRequestA, window.fixtureRequestB].includes(window.fixturePendingRequest.requestId));
  assert.equal(await input.inputValue(), "B任务未发送草稿");
  assert.equal(await page.getByRole("button", { name: "停止生成", exact: true }).count(), 0, "background queue does not make B busy");
  await page.evaluate(async () => { await window.fixtureEmitToken("A后台队列完成"); await window.fixtureFinishStream(); });
  await page.waitForFunction(() => window.fixtureChat.getState().sessions.find(s => s.id === window.fixtureSessionA).messages.some(m => m.content === "A后台队列完成" && !m.isStreaming));
  await page.evaluate(() => window.fixtureChat.getState().setActiveSession(window.fixtureSessionA));
  await queueDock.waitFor({ state: "hidden" });
  assert.equal(await input.inputValue(), "A任务未发送草稿");

  // Completing A must also leave a running B untouched.
  await page.evaluate(() => { window.fixtureStreamMode = true; window.fixturePendingRequest = null; });
  await input.fill("你好"); await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await page.evaluate(() => { window.fixtureRequestA = window.fixturePendingRequest.requestId; window.fixtureChat.getState().setActiveSession(window.fixtureSessionB); window.fixturePendingRequest = null; });
  await input.fill("你好"); await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await page.evaluate(async () => {
    window.fixtureRequestB = window.fixturePendingRequest.requestId;
    await window.fixtureEmitToken("A先完成", window.fixtureRequestA);
    await window.fixtureFinishStream(window.fixtureRequestA, true);
  });
  await page.waitForFunction(() => !window.fixtureChat.getState().sessions.find(s => s.id === window.fixtureSessionA).messages.at(-1).isStreaming);
  await page.getByRole("button", { name: "停止生成", exact: true }).waitFor();
  await page.evaluate(async () => { await window.fixtureEmitToken("B后完成", window.fixtureRequestB); await window.fixtureFinishStream(window.fixtureRequestB); });
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();

  await page.evaluate(() => { window.fixtureStreamMode = true; window.fixturePendingRequest = null; });
  await input.fill("你好"); await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await page.evaluate(() => { window.fixtureQueueRequest = window.fixturePendingRequest.requestId; });
  await input.fill("你好呀"); await input.press("Enter");
  await input.fill("你是谁"); await input.press("Enter");
  await input.press("Control+Enter");
  await queueDock.waitFor({ state: "hidden" });
  await page.evaluate(async () => { await window.fixtureEmitToken("旧答案"); await window.fixtureFinishStream(window.fixtureQueueRequest, true); });
  await page.waitForFunction(() => window.fixturePendingRequest.requestId !== window.fixtureQueueRequest);
  const allSteered = await page.evaluate(() => JSON.stringify(window.fixturePendingRequest.body.messages));
  assert.match(allSteered, /你好呀/); assert.match(allSteered, /你是谁/);
  await page.evaluate(async () => { await window.fixtureEmitToken("全部插话已接收"); await window.fixtureFinishStream(); });
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();

  await page.evaluate(() => { window.fixtureStreamMode = true; window.fixturePendingRequest = null; });
  await input.fill("你好"); await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await page.evaluate(() => { window.fixtureQueueRequest = window.fixturePendingRequest.requestId; });
  await input.fill("你好呀"); await input.press("Enter");
  await input.fill("你是谁"); await input.press("Enter");
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  await page.evaluate(() => window.fixtureFinishStream(window.fixtureQueueRequest, true));
  await queueDock.getByRole("button", { name: "2 条排队消息", exact: true }).click();
  await queueDock.getByRole("button", { name: "发送排队消息", exact: true }).nth(1).click();
  await page.waitForFunction(() => window.fixturePendingRequest.requestId !== window.fixtureQueueRequest);
  assert.match(await page.evaluate(() => JSON.stringify(window.fixturePendingRequest.body.messages.at(-1))), /你是谁/);
  assert.equal(await queueDock.locator(".composer-queue-row").count(), 1);
  assert.equal(await queueDock.getByRole("button", { name: "插话发送排队消息", exact: true }).isEnabled(), true, "manual admission releases queue actions before the run finishes");
  await page.evaluate(async () => { await window.fixtureEmitToken("指定消息完成"); await window.fixtureFinishStream(); });
  await queueDock.waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  await page.evaluate(() => { window.fixtureStreamMode = true; window.fixturePendingRequest = null; });
  await input.fill("你好"); await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await input.fill("你好呀"); await input.press("Enter");
  await input.fill("你是谁"); await input.press("Enter");
  assert.equal(await queueDock.getByRole("button", { name: "2 条排队消息", exact: true }).getAttribute("aria-expanded"), "false", "a new queue resets its collapsed state after the previous queue drained");
  await queueDock.getByRole("button", { name: "2 条排队消息", exact: true }).click();
  await queueDock.getByRole("button", { name: "取消排队消息", exact: true }).first().click();
  await queueDock.getByRole("button", { name: "取消排队消息", exact: true }).click();
  await page.getByRole("button", { name: "停止生成", exact: true }).click();
  await page.getByRole("button", { name: "发送消息", exact: true }).waitFor();
  await page.evaluate(() => window.fixtureFinishStream());
  console.log("PASS empty-input Ctrl+Enter steers all queued messages; stopped queue keeps rows and manually sends the selected item");

  // Configuration resolves after another empty conversation was created.
  await page.evaluate(() => {
    window.fixtureOriginalResolve = window.fixtureSettings.getState().resolveLLMConfig;
    window.fixtureSettings.setState({ resolveLLMConfig: () => new Promise(resolve => {
      window.fixtureResolveConfig = async () => resolve(await window.fixtureOriginalResolve());
    }) });
    window.fixtureStreamMode = true; window.fixturePendingRequest = null;
    window.fixtureConfigSession = window.fixtureChat.getState().createSession();
  });
  await input.fill("你好"); await input.press("Enter");
  await page.waitForFunction(() => Boolean(window.fixtureResolveConfig));
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await input.fill("新任务配置期间的草稿");
  await page.evaluate(async () => {
    window.fixtureSettings.setState({ resolveLLMConfig: window.fixtureOriginalResolve });
    await window.fixtureResolveConfig();
  });
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  assert.equal(await input.inputValue(), "新任务配置期间的草稿");
  assert.equal(await page.locator(".chat-run-status").count(), 0);
  assert.equal(await page.evaluate(() => window.fixtureChat.getState().sessions.some(s => s.id === window.fixtureConfigSession)), true);
  await page.evaluate(() => window.fixtureChat.getState().deleteSession(window.fixtureConfigSession));
  await page.waitForFunction(() => !window.fixtureChat.getState().sessions.some(s => s.messages.some(m => m.isStreaming)));
  await page.evaluate(async () => { await window.fixtureEmitToken("删除任务后的迟到数据"); await window.fixtureFinishStream(); });
  assert.equal(await input.inputValue(), "新任务配置期间的草稿");
  console.log("PASS async configuration/new-session race, retained new draft and deleted-session cancellation without late recreation");
  await page.evaluate(id => window.fixtureChat.getState().setActiveSession(id), originalSession);
  console.log("PASS independent concurrent sessions, per-session drafts/output/status/stop, background queue drain and either completion order");

  await page.evaluate(() => {
    const state = window.fixtureChat.getState();
    window.fixtureLongMessage = state.appendMessage(state.activeSessionId, {
      role: "assistant",
      content: Array.from(
        { length: 100 },
        (_, index) => "第 " + index + " 段：窗口、按钮与事件处理说明。",
      ).join("\n\n"),
    });
  });
  const viewport = page.locator(
    ".chat-message-scroll [data-radix-scroll-area-viewport]",
  );
  await page.waitForFunction(() => {
    const v = document.querySelector(
      ".chat-message-scroll [data-radix-scroll-area-viewport]",
    );
    return v.scrollHeight - v.clientHeight - v.scrollTop < 48;
  });
  await viewport.evaluate((element) => {
    element.scrollTop = 100;
  });
  await page.getByRole("button", { name: "回到最新", exact: true }).waitFor();
  const readerPosition = await viewport.evaluate(
    (element) => element.scrollTop,
  );
  await page.evaluate(() => {
    const state = window.fixtureChat.getState();
    const message = state.sessions
      .find((session) => session.id === state.activeSessionId)
      .messages.find((message) => message.id === window.fixtureLongMessage);
    state.updateMessage(state.activeSessionId, window.fixtureLongMessage, {
      content: message.content + "\n\n新增内容。".repeat(20),
    });
  });
  await page.waitForFunction(
    () =>
      document.querySelector(".assistant-message-content:last-of-type") !==
      null,
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert(
    Math.abs(
      (await viewport.evaluate((element) => element.scrollTop)) -
        readerPosition,
    ) < 2,
    "content growth must preserve the reader scroll position",
  );
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  assert(
    await viewport.evaluate(
      (element) =>
        element.scrollHeight - element.clientHeight - element.scrollTop < 48,
    ),
  );
  console.log(
    "PASS stream/layout follow, reader scroll preservation and jump to latest",
  );
  const streamLayout = await page.evaluate(async () => {
    const state = window.fixtureChat.getState(),
      sid = state.activeSessionId;
    const id = state.appendMessage(sid, {
      role: "assistant",
      content: "",
      isStreaming: true,
    });
    const viewport = document.querySelector(
      ".chat-message-scroll [data-radix-scroll-area-viewport]",
    );
    const samples = [];
    let frame,
      measuring = true;
    const sample = () => {
      samples.push({
        top: viewport.scrollTop,
        height: viewport.scrollHeight,
        gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      });
      if (measuring) frame = requestAnimationFrame(sample);
    };
    frame = requestAnimationFrame(sample);
    let code = Array.from(
      { length: 35 },
      (_, i) => "const value" + i + ' = "窗口与事件处理";',
    ).join("\n");
    let firstPre, firstLine;
    for (let i = 0; i < 12; i++) {
      code += "\nconst appended" + i + " = " + i + ";";
      state.updateMessage(sid, id, {
        content: "代码示例：\n\n```javascript\n" + code + "\n```",
      });
      await new Promise((resolve) => setTimeout(resolve, 240));
      const response = document.querySelectorAll(".assistant-response");
      const pre = response[response.length - 1].querySelector("pre");
      if (i === 0) {
        firstPre = pre;
        firstLine = pre.querySelector(".line");
      } else if (pre !== firstPre || pre.querySelector(".line") !== firstLine)
        throw new Error("streaming highlighting replaced existing code lines");
    }
    state.updateMessage(sid, id, { isStreaming: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    measuring = false;
    cancelAnimationFrame(frame);
    return {
      backwards: samples.filter(
        (sample, i) => i > 3 && sample.top < samples[i - 1].top - 1,
      ).length,
      shrinks: samples.filter(
        (sample, i) => i > 3 && sample.height < samples[i - 1].height - 1,
      ).length,
      maxGap: Math.max(...samples.slice(4).map((sample) => sample.gap)),
    };
  });
  assert.equal(
    streamLayout.backwards,
    0,
    "appending code must not pull the transcript backwards",
  );
  assert.equal(
    streamLayout.shrinks,
    0,
    "highlighting must keep code geometry stable",
  );
  assert(
    streamLayout.maxGap <= 1,
    "the displayed frame must already follow the new line: " +
      JSON.stringify(streamLayout),
  );
  await viewport.evaluate((element) => {
    element.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -24, bubbles: true }),
    );
    element.scrollTop -= 24;
  });
  await page.getByRole("button", { name: "回到最新", exact: true }).waitFor();
  const nearTailReaderPosition = await viewport.evaluate(
    (element) => element.scrollTop,
  );
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(),
      sid = state.activeSessionId;
    const message = state.sessions
      .find((session) => session.id === sid)
      .messages.at(-1);
    state.updateMessage(sid, message.id, {
      content: message.content + "\n\n新一段说明。",
    });
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  assert(
    Math.abs(
      (await viewport.evaluate((element) => element.scrollTop)) -
        nearTailReaderPosition,
    ) < 2,
    "even a small upward scroll must suspend following",
  );
  await page.getByRole("button", { name: "回到最新", exact: true }).click();
  console.log(
    "PASS streaming code: stable DOM and heights, pre-paint bottom alignment, small upward scroll retains reading position " +
      JSON.stringify(streamLayout),
  );
  const protocolExample =
    '下面是 JSON 协议示例：\n```json\n{"thought":"这是字段示例","tool_calls":[{"name":"save_text_file"}]}\n```';
  await page.evaluate((content) => {
    const state = window.fixtureChat.getState();
    state.appendMessage(state.activeSessionId, { role: "assistant", content });
  }, protocolExample);
  await page.locator(".source-card").last().waitFor();
  assert.match(
    await page.locator(".source-card").last().textContent(),
    /这是字段示例/,
  );
  assert.match(
    await page.locator(".source-card").last().textContent(),
    /save_text_file/,
  );

  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.getByRole("menuitem").filter({ hasText: /^模型/ }).click();
  await page
    .getByRole("menuitemradio")
    .filter({ hasText: "DeepSeek-V4.1-Flash" })
    .click();
  await input.fill("整理开发步骤");
  await input.press("Enter");
  await page.getByText("开发步骤已整理。", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.fixtureRequests.at(-1).model),
    "deepseek-flash",
    "Flash display name must send the production API ID",
  );
  const source =
    ".版本 2\n.程序集 窗口程序集_启动窗口\n\n.子程序 _按钮1_被单击\n编辑框1.内容 ＝ “你好，世界”\n" +
    "' 长注释 ".repeat(50);
  await page.evaluate((source) => {
    const state = window.fixtureChat.getState();
    state.appendMessage(state.activeSessionId, {
      role: "user",
      content: "帮我生成一个带按钮的窗口",
    });
    state.appendMessage(state.activeSessionId, {
      role: "assistant",
      content: "已生成窗口、按钮和事件代码。\n\n```易语言\n" + source + "\n```",
      agentTrace: {
        goal: "写窗口",
        outcome: "answer",
        startedAt: 0,
        endedAt: 1000,
        toolCallCount: 1,
        finalAnswer: "",
        steps: [
          {
            index: 1,
            assistantText: "先核对窗口事件接口。",
            finishReason: "tool_call",
            startedAt: 0,
            endedAt: 100,
            toolCalls: [
              {
                id: "search",
                name: "search_jingyi_module",
                arguments: { query: "窗口 按钮 事件" },
              },
            ],
            toolResults: [
              {
                toolCallId: "search",
                toolName: "search_jingyi_module",
                ok: true,
                durationMs: 100,
                content: { count: 2, success: true },
              },
            ],
          },
        ],
      },
    });
  }, source);
  const tracePanel = page.locator(".agent-trace-panel").last();
  assert.equal(
    await tracePanel.locator(".agent-step").count(),
    0,
    "tools stay compact until expanded",
  );
  await tracePanel.getByRole("button").first().click();
  assert.match(
    await tracePanel.locator(".agent-tool-line").textContent(),
    /查询精易模块.*窗口 按钮 事件/,
  );
  assert.equal(await tracePanel.locator(".agent-tool-details").count(), 0);
  await tracePanel.locator(".agent-tool-toggle").click();
  assert.equal(await tracePanel.locator(".agent-tool-details").count(), 1);
  await tracePanel.getByRole("button").first().click();
  console.log(
    "PASS native JSON examples stay intact and compact tool activity expands to readable arguments and details",
  );
  const card = page.locator(".source-card").first();
  await card.waitFor();
  assert.equal(await card.locator(".line").count(), 6);
  await card.getByRole("button", { name: "复制代码", exact: true }).click();
  // Windows clipboard normalizes LF to CRLF; all source characters must remain intact.
  assert.equal(
    (await page.evaluate(() => navigator.clipboard.readText())).replaceAll(
      "\r\n",
      "\n",
    ),
    source,
  );
  await card.getByRole("button", { name: "自动换行", exact: true }).click();
  assert.equal(await card.getAttribute("data-code-wrap"), "false");
  await card.getByRole("button", { name: "自动换行", exact: true }).click();
  await page.screenshot({
    path: path.join(screenshots, "chat-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await card.getByRole("button", { name: "易语言视图", exact: true }).click();
  await card.locator(".source-ide").waitFor();
  await card.getByRole("button", { name: "源码视图", exact: true }).click();
  await card.getByRole("button", { name: "在右侧预览", exact: true }).click();
  await page.getByRole("complementary", { name: "文件预览" }).waitFor();
  assert.equal(
    await page
      .getByRole("complementary", { name: "文件预览" })
      .locator(".line")
      .count(),
    6,
  );
  await page.getByRole("button", { name: "关闭预览", exact: true }).click();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false, "long lines must not overflow the app");
  await page.evaluate(() => window.fixtureSettings.getState().setTheme("dark"));
  await page.screenshot({
    path: path.join(screenshots, "chat-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "选择模型", exact: true }).click();
  await page.screenshot({
    path: path.join(screenshots, "composer-models-dark.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.fixtureSettings.getState().setTheme("light"),
  );
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(),
      now = Date.now();
    const calls = [
      {
        id: "plan",
        name: "update_plan",
        arguments: {
          items: [
            { id: 1, title: "生成登录窗口和事件", status: "in_progress" },
            { id: 2, title: "读取源码并编译验证", status: "pending" },
          ],
        },
      },
      {
        id: "gui",
        name: "generate_gui_project",
        arguments: {
          project: {
            windows: [
              {
                name: "_启动窗口",
                title: "登录窗口",
                controls: [{ type: "编辑框" }, { type: "按钮" }],
              },
            ],
          },
        },
      },
    ];
    window.fixtureComplexTrace = {
      goal: "制作登录窗口",
      startedAt: now - 1400,
      endedAt: now,
      toolCallCount: 2,
      outcome: "max_steps",
      finalAnswer: "",
      steps: [
        {
          index: 1,
          startedAt: now - 1400,
          endedAt: now,
          assistantText: "先生成窗口布局，再检查按钮事件。",
          toolCalls: calls,
          toolResults: [],
          finishReason: "tool_call",
        },
      ],
    };
    state.appendMessage(state.activeSessionId, {
      role: "user",
      content: "帮我制作一个登录窗口，自动写好事件并编译。",
    });
    state.appendMessage(state.activeSessionId, {
      role: "assistant",
      content: "",
      isStreaming: true,
      activeToolCallId: "plan",
      agentTrace: window.fixtureComplexTrace,
    });
    window.fixtureComplexId = window.fixtureChat
      .getState()
      .sessions.find((s) => s.id === state.activeSessionId)
      .messages.at(-1).id;
  });
  const executionPanel = page.locator(".agent-trace-panel").last();
  assert.equal(
    await executionPanel
      .locator(".agent-process-toggle")
      .getAttribute("aria-expanded"),
    "true",
  );
  assert.equal(
    await executionPanel.locator('[data-state="running"]').count(),
    1,
  );
  assert.equal(
    await executionPanel.locator('[data-state="queued"]').count(),
    1,
  );
  assert.equal(await executionPanel.locator(".agent-tool-details").count(), 0);
  assert(
    !(await executionPanel
      .textContent()
      .then((text) => text.includes('"items"') || text.includes('"project"'))),
    "collapsed tool rows must hide raw JSON",
  );
  await executionPanel.locator(".agent-tool-toggle").first().click();
  await executionPanel.locator(".agent-plan-checklist").waitFor();
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(),
      trace = structuredClone(window.fixtureComplexTrace);
    const result = (id, content) => ({
      toolCallId: id,
      toolName: id === "plan" ? "update_plan" : "generate_gui_project",
      ok: true,
      durationMs: 50,
      content,
    });
    trace.steps[0].toolResults = [result("plan", { success: true })];
    window.fixtureComplexTrace = trace;
    state.updateMessage(state.activeSessionId, window.fixtureComplexId, {
      agentTrace: trace,
      activeToolCallId: "gui",
    });
  });
  assert.equal(
    await executionPanel.locator(".agent-plan-checklist").count(),
    1,
    "live status updates must preserve manually expanded tool rows",
  );
  assert.equal(
    await executionPanel.locator(".agent-tool-diagnostics pre").count(),
    0,
    "raw data must mount only when explicitly requested",
  );
  await executionPanel.locator(".agent-tool-diagnostics summary").click();
  await executionPanel.locator(".agent-tool-diagnostics pre").waitFor();
  assert.match(
    await executionPanel.locator(".agent-tool-diagnostics pre").textContent(),
    /"items"/,
  );
  await executionPanel.locator(".agent-tool-toggle").first().click();
  await page.screenshot({
    path: path.join(screenshots, "execution-running.png"),
    animations: "disabled",
  });
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(),
      trace = structuredClone(window.fixtureComplexTrace),
      now = Date.now();
    window.fixtureLayoutPath =
      "C:/Users/Administrator/AppData/Local/com.eaicoding.desktop/generated-ecode/gui-example/窗口/_启动窗口.form.json";
    window.fixtureCodePath =
      "C:/Users/Administrator/AppData/Local/com.eaicoding.desktop/generated-ecode/gui-example/代码/窗口程序集_启动窗口.form.e.txt";
    window.fixtureJsonFirst = '{\n  "title": "登录窗口",\n  "controls": [\n';
    window.fixtureReadResponse = {
      content: '    { "type": "按钮", "text": "登录" }\n  ]\n}',
      start_char: window.fixtureJsonFirst.length,
      start_line: 4,
      truncated: false,
      next_start_char: null,
      code_hash: "fixture-layout-v1",
    };
    trace.steps[0].toolResults.push({
      toolCallId: "gui",
      toolName: "generate_gui_project",
      ok: true,
      durationMs: 580,
      content: {
        success: true,
        output_path: "D:/fixture/登录窗口.e",
        layout_path: window.fixtureLayoutPath,
      },
    });
    trace.steps.push({
      index: 2,
      startedAt: now,
      endedAt: now,
      assistantText: "工程骨架已生成，检查窗口定义和事件代码。",
      finishReason: "tool_call",
      toolCalls: [
        {
          id: "json",
          name: "read_file",
          arguments: { file_path: window.fixtureLayoutPath },
        },
        {
          id: "code",
          name: "read_file",
          arguments: { file_path: window.fixtureCodePath },
        },
        {
          id: "compile",
          name: "compile_efile",
          arguments: { target_path: "D:/fixture/登录窗口.e" },
        },
      ],
      toolResults: [
        {
          toolCallId: "code",
          toolName: "read_file",
          ok: true,
          durationMs: 5,
          content: {
            path: window.fixtureCodePath,
            content:
              ".版本 2\n.程序集 窗口程序集_启动窗口\n" +
              Array.from({ length: 170 }, (_, i) => "' 事件说明 " + i).join(
                "\n",
              ),
            encoding: "utf-8",
            truncated: false,
          },
        },
        {
          toolCallId: "json",
          toolName: "read_file",
          ok: true,
          durationMs: 19,
          content: {
            path: window.fixtureLayoutPath,
            content: window.fixtureJsonFirst,
            encoding: "utf-8",
            truncated: true,
            start_line: 1,
            start_char: 0,
            next_start_char: window.fixtureJsonFirst.length,
            code_hash: "fixture-layout-v1",
          },
        },
      ],
    });
    trace.toolCallCount = 5;
    window.fixtureComplexTrace = trace;
    state.updateMessage(state.activeSessionId, window.fixtureComplexId, {
      agentTrace: trace,
      activeToolCallId: "compile",
    });
  });
  assert.equal(
    await page.getByRole("complementary", { name: "文件预览" }).count(),
    0,
    "tool results must not open the pane automatically",
  );
  assert.equal(await executionPanel.locator(".agent-tool-row").count(), 5);
  await executionPanel
    .locator(".agent-tool-file")
    .filter({ hasText: "_启动窗口.form.json" })
    .click();
  const pane = page.getByRole("complementary", { name: "文件预览" });
  await pane.waitFor();
  assert.match(await pane.locator(".source-language").textContent(), /json/);
  await page.evaluate(() => {
    window.fixtureReadResponse.code_hash = "fixture-layout-v2";
  });
  await pane.getByRole("button", { name: "加载更多", exact: true }).click();
  await pane.getByRole("alert").filter({ hasText: "文件已更新" }).waitFor();
  assert(
    !(await pane
      .locator(".source-body")
      .textContent()
      .then((text) => text.includes('"按钮"'))),
    "pages from different file revisions must never be concatenated",
  );
  await page.evaluate(() => {
    window.fixtureReadResponse.code_hash = "fixture-layout-v1";
  });
  await pane.getByRole("button", { name: "加载更多", exact: true }).click();
  await pane
    .getByText("已加载部分文件", { exact: true })
    .waitFor({ state: "detached" });
  assert.match(
    await pane.locator(".source-body").textContent(),
    /登录窗口[\s\S]*按钮/,
  );
  assert.equal(
    await page.evaluate(() => window.fixtureReads.at(-1).startChar),
    await page.evaluate(() => window.fixtureJsonFirst.length),
  );
  await page.evaluate(() => {
    window.fixtureReadFailure = true;
  });
  await pane.getByRole("button", { name: "刷新文件", exact: true }).click();
  await pane.getByRole("alert").filter({ hasText: "暂时不可读" }).waitFor();
  assert.match(
    await pane.locator(".source-body").textContent(),
    /登录窗口[\s\S]*按钮/,
    "refresh failure must preserve loaded content",
  );
  await page.evaluate(() => {
    window.fixtureReadFailure = false;
    window.fixtureReadResponse = {
      ...window.fixtureReadResponse,
      content: window.fixtureJsonFirst + window.fixtureReadResponse.content,
      start_char: 0,
      start_line: 1,
    };
  });
  await pane.getByRole("button", { name: "重试", exact: true }).click();
  await pane.getByRole("alert").waitFor({ state: "detached" });
  await executionPanel
    .locator(".agent-tool-file")
    .filter({ hasText: "窗口程序集_启动窗口.form.e.txt" })
    .click();
  assert.equal(await pane.getByRole("tab").count(), 2);
  const documentBody = pane.locator(".document-body");
  await documentBody.evaluate((element) => {
    element.scrollTop = 500;
  });
  const filePosition = await documentBody.evaluate(
    (element) => element.scrollTop,
  );
  await openSettings();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  await settingsDialog.waitFor({ state: "hidden" });
  assert.equal(
    await pane.getByRole("tab", { selected: true }).textContent(),
    "窗口程序集_启动窗口.form.e.txt",
    "settings must preserve the active document",
  );
  assert(
    Math.abs(
      (await documentBody.evaluate((element) => element.scrollTop)) -
        filePosition,
    ) < 2,
    "settings must preserve the document reading position",
  );
  await pane
    .getByRole("tab", { name: "_启动窗口.form.json", exact: true })
    .click();
  await pane
    .getByRole("tab", { name: "_启动窗口.form.json", exact: true })
    .press("ArrowRight");
  assert.equal(
    await pane.getByRole("tab", { selected: true }).textContent(),
    "窗口程序集_启动窗口.form.e.txt",
  );
  assert.equal(
    await pane
      .getByRole("tab", { selected: true })
      .evaluate((node) => node === document.activeElement),
    true,
  );
  await pane.getByRole("tab", { selected: true }).press("Home");
  assert.equal(
    await pane.getByRole("tab", { selected: true }).textContent(),
    "_启动窗口.form.json",
  );
  await pane
    .getByRole("tab", { name: "窗口程序集_启动窗口.form.e.txt", exact: true })
    .click();
  assert(
    Math.abs(
      (await documentBody.evaluate((element) => element.scrollTop)) -
        filePosition,
    ) < 2,
    "each tab must restore its reading position",
  );
  await pane
    .getByRole("tab", { name: "_启动窗口.form.json", exact: true })
    .click();
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(),
      trace = structuredClone(window.fixtureComplexTrace);
    trace.steps[1].toolResults.push({
      toolCallId: "compile",
      toolName: "compile_efile",
      ok: true,
      durationMs: 400,
      content: { success: true, output_path: "D:/fixture/登录窗口.exe" },
    });
    trace.steps.push({
      index: 3,
      assistantText: "窗口和事件代码已完成，编译通过。",
      toolCalls: [],
      toolResults: [],
      finishReason: "answer",
      startedAt: Date.now(),
      endedAt: Date.now(),
    });
    trace.outcome = "answer";
    trace.finalAnswer = "窗口和事件代码已完成，编译通过。";
    trace.endedAt = Date.now();
    window.fixtureComplexTrace = trace;
    state.updateMessage(state.activeSessionId, window.fixtureComplexId, {
      content: trace.finalAnswer,
      isStreaming: false,
      agentTrace: trace,
      activeToolCallId: undefined,
    });
  });
  assert.equal(
    await executionPanel
      .locator(".agent-process-toggle")
      .getAttribute("aria-expanded"),
    "false",
    "settled process collapses",
  );
  assert.equal(
    await page.locator(".agent-artifacts button").count(),
    2,
    ".e and .exe stay directly accessible",
  );
  assert.equal(
    await pane.getByRole("tab", { selected: true }).textContent(),
    "_启动窗口.form.json",
    "finishing must not switch the selected file",
  );
  await executionPanel.locator(".agent-process-toggle").click();
  assert.equal(
    await executionPanel
      .getByText("窗口和事件代码已完成，编译通过。", { exact: true })
      .count(),
    0,
    "final answer must not be duplicated inside the process",
  );
  // A second edit of a previously read path must invalidate its disk cache.
  for (const edit of [1, 2]) {
    await page.evaluate((edit) => {
      const state = window.fixtureChat.getState(),
        trace = structuredClone(window.fixtureComplexTrace);
      const id = "edit-layout-" + edit;
      trace.steps.push({
        index: 10 + edit,
        assistantText: "",
        startedAt: Date.now(),
        endedAt: Date.now(),
        finishReason: "tool_call",
        toolCalls: [
          {
            id,
            name: "apply_search_replace",
            arguments: { file_path: window.fixtureLayoutPath },
          },
        ],
        toolResults: [
          {
            toolCallId: id,
            toolName: "apply_search_replace",
            ok: true,
            content: { success: true },
            durationMs: 1,
          },
        ],
      });
      trace.toolCallCount++;
      window.fixtureReadResponse = {
        content: JSON.stringify({
          title: "最新窗口版本 " + edit,
          controls: [],
        }),
        start_char: 0,
        start_line: 1,
        truncated: false,
        code_hash: "updated-layout-" + edit,
      };
      window.fixtureComplexTrace = trace;
      state.updateMessage(state.activeSessionId, window.fixtureComplexId, {
        agentTrace: trace,
      });
    }, edit);
    await pane
      .locator(".source-body")
      .getByText(new RegExp("最新窗口版本 " + edit))
      .waitFor();
    assert.equal(
      await page.evaluate(() => window.fixtureReads.at(-1).startChar),
      0,
    );
  }
  assert.match(
    await executionPanel.locator(".agent-process-summary").textContent(),
    /7 次工具调用/,
  );
  assert.equal(
    await executionPanel
      .locator(".agent-tool-file")
      .filter({ hasText: "_启动窗口.form.json" })
      .count(),
    3,
    "each edit must expose its file alongside reads",
  );
  await page.screenshot({
    path: path.join(screenshots, "execution-preview-light.png"),
    animations: "disabled",
  });
  await page.evaluate(() => window.fixtureSettings.getState().setTheme("dark"));
  await page.screenshot({
    path: path.join(screenshots, "execution-preview-dark.png"),
    animations: "disabled",
  });
  await page.evaluate(() =>
    window.fixtureSettings.getState().setTheme("light"),
  );
  await pane.getByRole("button", { name: "关闭预览", exact: true }).click();
  await page.evaluate(() => {
    const state = window.fixtureChat.getState();
    state.appendMessage(state.activeSessionId, {
      role: "assistant",
      content: "你好，可以继续修改窗口。",
    });
  });
  assert.equal(
    await pane.count(),
    0,
    "later replies must not reopen a closed pane",
  );
  await page.getByRole("button", { name: "代码预览", exact: true }).click();
  assert.equal(
    await pane.getByRole("tab").count(),
    2,
    "later greetings must preserve opened files",
  );
  assert.equal(
    await pane.getByRole("button", { name: "加载更多", exact: true }).count(),
    0,
    "closing/reopening must preserve loaded pages",
  );
  await page.setViewportSize({ width: 960, height: 600 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  assert((await pane.boundingBox()).width <= 960);
  await pane.getByRole("button", { name: "关闭预览", exact: true }).click();
  await page.setViewportSize({ width: 1366, height: 900 });
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(),
      trace = structuredClone(window.fixtureComplexTrace);
    trace.outcome = "aborted";
    trace.finalAnswer = "已停止。";
    trace.steps[1].toolResults = trace.steps[1].toolResults.filter(
      (result) => result.toolCallId !== "compile",
    );
    trace.steps[0].toolResults[1] = {
      ...trace.steps[0].toolResults[1],
      ok: false,
      error: "fixture 窗口文件不可写",
    };
    state.updateMessage(state.activeSessionId, window.fixtureComplexId, {
      content: "已停止。",
      agentTrace: trace,
    });
  });
  assert.equal(
    await executionPanel.locator('[data-state="failed"]').count(),
    1,
  );
  assert.equal(
    await executionPanel.locator('[data-state="stopped"]').count(),
    1,
  );
  assert.match(
    await executionPanel.locator(".agent-tool-error").textContent(),
    /窗口文件不可写/,
  );
  console.log(
    "PASS live multi-tool timeline, lazy details, completion collapse, failures/stops, keyboard file tabs, JSON paging, repeated-edit cache invalidation, scroll retention and narrow preview",
  );
  await page.evaluate(() => {
    const state = window.fixtureChat.getState(),
      trace = structuredClone(window.fixtureComplexTrace);
    const changes = [
      {
        path: "D:/fixture/review.epl",
        before: "首行\n旧代码\n",
        after: "首行\n中间代码\n",
      },
      {
        path: "D:/fixture/review.epl",
        before: "首行\n中间代码\n",
        after: "首行\n最终代码\n",
      },
      { path: "D:/fixture/new.epl", before: null, after: "新建源码\n" },
    ];
    trace.steps.push({
      index: 3,
      assistantText: "更新源码",
      toolCalls: changes.map((change, i) => ({
        id: "review-" + i,
        name: "save_text_file",
        arguments: { path: change.path, content: change.after },
      })),
      toolResults: changes.map((change, i) => ({
        toolCallId: "review-" + i,
        toolName: "save_text_file",
        ok: true,
        content: { path: change.path, bytes: change.after.length },
        sourceChange: change,
        durationMs: 3,
      })),
      finishReason: "tool_call",
      startedAt: 1,
      endedAt: 4,
    });
    state.updateMessage(state.activeSessionId, window.fixtureComplexId, {
      content: "改动已完成。",
      isStreaming: false,
      agentTrace: trace,
    });
  });
  await page.locator(".turn-changes-summary").last().click();
  const review = page.getByRole("region", {
    name: "本轮代码差异",
    exact: true,
  });
  await review.getByText("最终代码", { exact: true }).waitFor();
  await review.getByText("旧代码", { exact: true }).waitFor();
  assert.equal(
    await review.getByText("中间代码", { exact: true }).count(),
    0,
    "review compares turn start and end across repeated edits",
  );
  await review
    .getByRole("combobox", { name: "选择改动文件", exact: true })
    .click();
  assert.equal(await page.getByRole("option").count(), 2);
  await page
    .getByRole("option", { name: "D:/fixture/review.epl", exact: true })
    .click();
  await review.getByRole("button", { name: "并排对比", exact: true }).click();
  await review
    .getByRole("button", { name: "差异自动换行", exact: true })
    .click();
  assert.equal(
    await review.locator(".review-body").getAttribute("data-split"),
    "true",
  );
  await page.screenshot({
    path: path.join(screenshots, "turn-review.png"),
    animations: "disabled",
  });
  await review
    .getByRole("combobox", { name: "选择改动文件", exact: true })
    .click();
  await page
    .getByRole("option", { name: "D:/fixture/new.epl", exact: true })
    .click();
  await review.getByText("本轮新建的文件", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "轨迹", exact: true }).click();
  const trajectory = page.getByRole("region", {
    name: "轨迹视图",
    exact: true,
  });
  await trajectory
    .getByRole("textbox", { name: "搜索轨迹", exact: true })
    .fill("save_text_file");
  await trajectory
    .getByRole("button", { name: "检查 save_text_file", exact: true })
    .last()
    .click();
  const inspection = trajectory.getByRole("complementary", {
    name: "轨迹详情",
    exact: true,
  });
  await inspection
    .getByRole("button", { name: "复制轨迹详情", exact: true })
    .click();
  assert.match(
    await page.evaluate(() => navigator.clipboard.readText()),
    /save_text_file/,
  );
  assert.equal(
    await inspection
      .locator("pre")
      .textContent()
      .then((value) => value.includes("sourceChange")),
    false,
  );
  await page.screenshot({
    path: path.join(screenshots, "trajectory-view.png"),
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await openSettings();
  await page.getByRole("tab", { name: "通用", exact: true }).click();
  await page
    .getByRole("switch", { name: "显示代码工作视图", exact: true })
    .uncheck();
  await page.keyboard.press("Escape");
  assert.equal(
    await page.getByRole("tablist", { name: "会话视图", exact: true }).count(),
    0,
  );
  assert.equal(await review.isVisible(), false);
  await openSettings();
  await page.getByRole("tab", { name: "通用", exact: true }).click();
  await page
    .getByRole("switch", { name: "显示代码工作视图", exact: true })
    .check();
  await page.keyboard.press("Escape");
  console.log(
    "PASS trajectory ledger/search/inspection/copy, code-work toggle, multi-file turn-start/end diff, split/wrap and new-file review",
  );
  await page.evaluate(async () => {
    const state = window.fixtureChat.getState(),
      trace = structuredClone(window.fixtureComplexTrace);
    trace.outcome = "max_steps";
    trace.finalAnswer = "";
    trace.steps[1].toolResults = trace.steps[1].toolResults.filter(
      (result) => result.toolCallId !== "compile",
    );
    state.updateMessage(state.activeSessionId, window.fixtureComplexId, {
      content: "",
      isStreaming: true,
      activeToolCallId: "compile",
      agentTrace: trace,
    });
    await window.fixtureFlushChat();
    await window.fixtureChat.persist.rehydrate();
  });
  await page.waitForFunction(() => {
    const state = window.fixtureChat.getState();
    return (
      state.sessions
        .find((session) => session.id === state.activeSessionId)
        .messages.find((message) => message.id === window.fixtureComplexId)
        ?.isStreaming === false
    );
  });
  await executionPanel
    .locator(".agent-process-toggle")
    .filter({ hasText: "已停止" })
    .waitFor();
  if (
    (await executionPanel
      .locator(".agent-process-toggle")
      .getAttribute("aria-expanded")) === "false"
  )
    await executionPanel.locator(".agent-process-toggle").click();
  assert.equal(
    await executionPanel.locator('[data-state="running"]').count(),
    0,
    "saved native tool tasks must not look active after restoring a session",
  );
  assert.equal(
    await executionPanel.locator('[data-state="stopped"]').count(),
    1,
  );
  await page
    .getByText("上次执行已中断，可发送消息继续。", { exact: true })
    .waitFor();
  console.log(
    "PASS interrupted-session restoration retains results and clears stale running indicators",
  );
  // Test visible workbench controls and their native IPC contracts.
  await page.getByRole("button", { name: "会话菜单", exact: true }).click();
  await page.getByRole("menuitem", { name: "重命名会话", exact: true }).click();
  await page
    .getByRole("textbox", { name: "会话名称", exact: true })
    .fill("工作区回归");
  await page
    .getByRole("textbox", { name: "会话名称", exact: true })
    .press("Enter");
  await page
    .getByRole("heading", { name: "工作区回归", exact: true })
    .waitFor();
  await page.evaluate(() => {
    window.fixtureFailNativeClipboard = true;
  });
  await page.getByRole("button", { name: "会话菜单", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "复制整个会话", exact: true })
    .click();
  await page.waitForFunction(async () =>
    (await navigator.clipboard.readText()).startsWith("# 工作区回归"),
  );
  await page.getByRole("button", { name: "会话菜单", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "导出为 Markdown", exact: true })
    .click();
  await page.waitForFunction(() =>
    window.fixtureWrites?.some(
      (w) =>
        w.filePath === "D:/fixture/export.md" &&
        w.content.startsWith("# 工作区回归"),
    ),
  );
  await page.getByRole("button", { name: "会话工作区", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "在资源管理器打开", exact: true })
    .click();
  await page.waitForFunction(() =>
    window.fixtureNativeCalls?.some((c) => c.cmd === "plugin:opener|open_path"),
  );
  await page.getByRole("button", { name: "会话工作区", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "选择工作区文件夹", exact: true })
    .click();
  await page.waitForFunction(() => {
    const s = window.fixtureChat.getState();
    return (
      s.sessions.find((x) => x.id === s.activeSessionId)?.workspacePath ===
      "D:/fixture/selected-workspace"
    );
  });
  await page.keyboard.press("Control+p");
  const workbench = page.getByRole("complementary", {
    name: "工作区面板",
    exact: true,
  });
  await workbench
    .getByRole("tab", { name: "工作区文件", selected: true })
    .waitFor();
  await workbench.getByRole("button", { name: "代码", exact: true }).click();
  await workbench
    .getByRole("button", { name: "示例.epl", exact: true })
    .waitFor();
  await workbench
    .getByRole("button", { name: "上一级目录", exact: true })
    .click();
  await workbench
    .getByRole("button", { name: "说明.md", exact: true })
    .waitFor();
  await page.evaluate(() => {
    window.fixtureDirectoryFailure = true;
  });
  await workbench
    .getByRole("button", { name: "刷新工作区文件", exact: true })
    .click();
  await workbench
    .getByRole("alert")
    .filter({ hasText: "目录暂时不可读" })
    .waitFor();
  await page.evaluate(() => {
    window.fixtureDirectoryFailure = false;
  });
  await workbench.getByRole("button", { name: "重试", exact: true }).click();
  await workbench
    .getByRole("button", { name: "说明.md", exact: true })
    .waitFor();
  await page.keyboard.press("Control+Backquote");
  await workbench
    .getByRole("tab", { name: "终端 1", selected: true })
    .waitFor();
  await page.waitForFunction(() => window.fixtureTerminals?.length > 0);
  const terminalId = await page.evaluate(
    () => window.fixtureTerminals.at(-1).id,
  );
  assert.equal(
    await page.evaluate(() => window.fixtureTerminals.at(-1).root),
    "D:/fixture/selected-workspace",
  );
  await page.evaluate(async (id) => {
    await window.fixtureEmit("workspace-terminal-output", {
      id,
      data: [...new TextEncoder().encode("中文终端输出")],
      exited: false,
    });
  }, terminalId);
  await workbench.locator(".xterm-helper-textarea").fill("echo test");
  await page.waitForFunction(() => window.fixtureTerminalWrites?.length > 0);
  await workbench
    .getByRole("button", { name: "收起工作区", exact: true })
    .click();
  assert.equal(
    await page.evaluate(
      (id) => window.fixtureClosedTerminals?.includes(id) ?? false,
      terminalId,
    ),
    false,
    "collapsing retains the live shell",
  );
  await page.keyboard.press("Control+t");
  await workbench
    .getByRole("tab", { name: "浏览器", selected: true })
    .waitFor();
  await workbench
    .getByRole("textbox", { name: "网页地址", exact: true })
    .fill("https://user:pass@example.com");
  await workbench.getByRole("button", { name: "打开", exact: true }).click();
  await workbench
    .getByRole("alert")
    .filter({ hasText: "有效的 http/https" })
    .waitFor();
  await workbench
    .getByRole("textbox", { name: "网页地址", exact: true })
    .fill("https://example.com");
  await workbench.getByRole("button", { name: "打开", exact: true }).click();
  await page.waitForFunction(() =>
    window.fixtureNativeCalls.some((c) => c.cmd === "browser_open"),
  );
  const browserId = await page.evaluate(
    () =>
      window.fixtureNativeCalls.find((c) => c.cmd === "browser_open").args.id,
  );
  await accountTrigger.click();
  await page.waitForFunction(
    (id) =>
      window.fixtureNativeCalls
        .filter((c) => c.cmd === "browser_layout" && c.args.id === id)
        .at(-1)?.args.visible === false,
    browserId,
  );
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  await page
    .getByRole("dialog", { name: "退出登录", exact: true })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await page.waitForFunction(
    (id) =>
      window.fixtureNativeCalls
        .filter((c) => c.cmd === "browser_layout" && c.args.id === id)
        .at(-1)?.args.visible === true,
    browserId,
  );
  await openSettings();
  await page.waitForFunction(
    (id) =>
      window.fixtureNativeCalls.some(
        (c) =>
          c.cmd === "browser_layout" &&
          c.args.id === id &&
          c.args.visible === false,
      ),
    browserId,
  );
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    (id) =>
      window.fixtureNativeCalls
        .filter((c) => c.cmd === "browser_layout" && c.args.id === id)
        .at(-1)?.args.visible === true,
    browserId,
  );
  await workbench
    .getByRole("button", { name: "关闭浏览器", exact: true })
    .click();
  await page.waitForFunction(
    (id) =>
      window.fixtureNativeCalls.some(
        (c) => c.cmd === "browser_close" && c.args.id === id,
      ),
    browserId,
  );
  await workbench
    .getByRole("button", { name: "关闭终端 1", exact: true })
    .click();
  await page.waitForFunction(
    (id) => window.fixtureClosedTerminals.includes(id),
    terminalId,
  );
  await workbench.getByRole("tab", { name: "开始", exact: true }).click();
  await page.screenshot({
    path: path.join(screenshots, "workbench-start.png"),
  });
  console.log(
    "PASS conversation rename/export/copy fallback, workspace persistence/files/errors, terminal lifecycle and native browser visibility contracts",
  );
  await page.evaluate(() => {
    window.fixtureStreamMode = true;
    window.fixturePendingRequest = null;
  });
  await page
    .getByRole("textbox", { name: "消息输入框", exact: true })
    .fill("你好");
  await page
    .getByRole("textbox", { name: "消息输入框", exact: true })
    .press("Enter");
  await page.waitForFunction(() => Boolean(window.fixturePendingRequest));
  await page.evaluate(() => window.fixtureEmitToken("退出前的草稿"));
  await page
    .locator(".assistant-message-content")
    .last()
    .getByText("退出前的草稿", { exact: true })
    .waitFor();
  await page.evaluate(() => {
    window.fixtureDeferDetails = true;
    window.fixtureResolveDetails = null;
  });
  await openSettings();
  await page.waitForFunction(() => Boolean(window.fixtureResolveDetails));
  await page.keyboard.press("Escape");
  await accountTrigger.click();
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  const logoutDialog = page.getByRole("dialog", {
    name: "退出登录",
    exact: true,
  });
  await logoutDialog
    .getByText("当前有任务正在执行，退出登录将中断任务，是否退出登录？", {
      exact: true,
    })
    .waitFor();
  await logoutDialog.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(
    await page.getByRole("button", { name: "停止生成", exact: true }).count(),
    1,
    "cancel sign-out keeps the task running",
  );
  await accountTrigger.click();
  await page.getByRole("menuitem", { name: "退出登录", exact: true }).click();
  await logoutDialog
    .getByRole("button", { name: "退出登录", exact: true })
    .click();
  await page.getByTestId("deepseek-login").waitFor();
  assert.equal(
    await page
      .getByRole("textbox", { name: "消息输入框", exact: true })
      .count(),
    0,
  );
  assert.equal(await page.locator("#deepseek-key, #deepseek-url").count(), 0);
  await page.waitForFunction(() => {
    const state = window.fixtureChat.getState();
    return (
      state.sessions
        .find((session) => session.id === state.activeSessionId)
        .messages.at(-1).agentTrace?.outcome === "aborted"
    );
  });
  const afterLogout = await page.evaluate(() => {
    const state = window.fixtureChat.getState();
    return JSON.stringify(
      state.sessions
        .find((session) => session.id === state.activeSessionId)
        .messages.at(-1),
    );
  });
  await page.evaluate(async () => {
    await window.fixtureEmitToken("LATE_AFTER_LOGOUT");
    await window.fixtureFinishStream();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  assert.equal(
    await page.evaluate(() => {
      const state = window.fixtureChat.getState();
      return JSON.stringify(
        state.sessions
          .find((session) => session.id === state.activeSessionId)
          .messages.at(-1),
      );
    }),
    afterLogout,
    "logout must abort the agent and ignore late model output",
  );
  await page.evaluate(async () => {
    window.fixtureResolveDetails();
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve)),
    );
  });
  assert.equal(
    await page.evaluate(() => window.fixtureAccountStore.getState().details),
    null,
    "late account details cannot restore a signed-out profile",
  );
  console.log(
    "PASS logout confirmation/cancel, task interruption, late model/detail isolation and exclusive login window",
  );
  await page
    .getByRole("button", { name: "使用其他模型提供商", exact: true })
    .click();
  await settingsDialog.waitFor();
  await page
    .getByRole("button", { name: "添加模型提供商", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "提供商", exact: true })
    .selectOption("anthropic");
  await page
    .getByRole("textbox", { name: "API 密钥", exact: true })
    .fill("fixture-key-only");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page
    .getByRole("button", { name: "编辑 Anthropic", exact: true })
    .waitFor();
  await page.waitForFunction(
    () =>
      window.fixtureSettings
        .getState()
        .profiles.find(
          (p) => p.id === window.fixtureSettings.getState().activeProfileId,
        )?.authMode === "api-key",
  );
  assert.equal(
    await page.evaluate(
      async () =>
        !!(await window.fixtureSettings.getState().resolveLLMConfig())
          .profileId,
    ),
    true,
    "third-party route works without a DeepSeek account",
  );
  await page.getByRole("tab", { name: "个人中心", exact: true }).click();
  await page
    .getByRole("region", { name: "个人中心", exact: true })
    .getByRole("button", { name: "登录 DeepSeek", exact: true })
    .waitFor();
  console.log(
    "PASS provider-only welcome, automatic model activation and truthful signed-out personal center",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS Chinese fence, source copy, wrap toggle, IDE toggle, light/dark rendering and no page errors",
  );
  console.log(`Screenshots: ${screenshots}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}
