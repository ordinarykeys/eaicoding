# 开发与验证

更新于 2026-10-19。命令默认从仓库根目录执行，目标平台为 Windows。

## 安装与运行

建议使用 Node.js 22、npm、Rust stable、WebView2，以及包含 C++ 桌面开发组件和 Windows SDK 的 Visual Studio Build Tools。使用桌面工程能力时，还需准备 README 说明的 `e.zip`，或在设置中选择可用的本机易语言环境。

```powershell
npm ci
npm run tauri -- dev
```

`npm run dev` 仅启动前端，无法独立提供真实的 Tauri 文件、加密和编译能力。界面测试会模拟这些能力。

`postinstall`、`predev` 和 `prebuild` 调用 `scripts/prepare-ort.mjs`，从锁定的 `onnxruntime-web` 依赖复制匹配的 JS/WASM 到 `public/ort/`。这些文件不提交 Git。若禁用安装脚本，可手动运行：

```powershell
node scripts/prepare-ort.mjs
```

更新 ONNX 依赖时应同时核对所需的 threaded/asyncify 文件名，避免 JS 与 WASM 版本不一致。本地嵌入模型与预建索引在 `public/models/`，不是 DeepSeek 模型权重。

## 常规检查

```powershell
npm run build
npm run test:agent-runtime
npm run test:module-parser
npm run test:code-highlight
npm run test:agent-choice
npm run test:agent-epl
npm run test:agent-retrieval
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo test --offline --lib --manifest-path src-tauri/Cargo.toml
```

Rust 离线命令要求依赖已缓存。新环境首次安装依赖时，可先运行 `cargo fetch --manifest-path src-tauri/Cargo.toml`，或去掉 `--offline` 完成首次构建。

| 检查 | 覆盖内容 |
| --- | --- |
| 生产构建 | TypeScript、Vite 打包与本地运行时准备 |
| Agent runtime | 原生工具分片、推理重放、模型限制、配置迁移、截断恢复、网络重试、取消、最新修改构建约束及无固定总步数 |
| 代码高亮 | 逐字符追加与全量分词一致，覆盖 CRLF、多行语法、替换、语言和主题切换 |
| 实现选择 | 历史待选择兼容、明确选择的延续，以及模型自主选型策略 |
| EPL 诊断 | 易语言声明、完整示例、控制结构及机械重复源码 |
| 检索 | 7 组查询的接口证据、线程/HTTP 组合与候选分类 |
| Rust 单元测试 | 文件范围/哈希、取消、工程生成、编码、依赖准备、转换器日志、构建暂存及环境统计/Windows junction 循环 |

Agent runtime 使用虚构密钥及模拟 Tauri IPC，不会访问真实模型或编译用户工程。显式 `maxSteps` 测试与超过 70 轮的用例共同检查桌面默认循环和集成约束。

## 浏览器界面回归

浏览器回归需要 Playwright，可使用独立目录安装，避免改变项目锁文件：

```powershell
npm install --prefix .tmp/browser-tools --no-save --package-lock=false playwright
node .tmp/browser-tools/node_modules/playwright/cli.js install chromium
$env:EAICODING_PLAYWRIGHT_MODULE = (Resolve-Path .tmp/browser-tools/node_modules/playwright/index.mjs).Path
npm run test:ui
```

也可以使用已有 Playwright 模块，并指定系统浏览器，例如：

```powershell
$env:EAICODING_PLAYWRIGHT_MODULE = 'C:\tools\browser-tests\node_modules\playwright\index.mjs'
$env:EAICODING_BROWSER_CHANNEL = 'msedge'
npm run test:ui
```

脚本依赖当前 `dist/`，请先完成 `npm run build`。它启动本地测试服务器和临时浏览器上下文，模拟账号授权状态、文件、模型流和工具结果，不使用个人会话或密钥。截图写入 `.tmp/ui-validation/`，不提交 Git。

覆盖首次登录、浏览器等待/取消/失败重试/退出、账号与工作区切换、设置弹窗、存储失败回滚、模型选择及持久化、输入法与草稿、10,000 条模拟模块分页、Markdown/推理分离、工具过程、文件页签/分页/哈希、停止和中断恢复、窄窗口、主题及代码卡片。环境页验证进页不扫描、扫描期间切页与关闭、防重复调用及过时结果隔离。持续流还会断言 DOM 与行高稳定、底部对齐及上翻阅读保持。

## 原生工作区验证

`npm run test:native-workbench` 会构建独立标识的调试程序，使用隔离的 WebView2 用户目录和本地测试网页，验证打开路径 ACL、剪贴板、真实 PowerShell 终端的目录/中文/缩放/关闭，以及内嵌网页的导航和桌面权限隔离。环境扫描使用临时目录核对真实嵌套文件计数与并发目录 IPC；还检查托盘注册、关闭后窗口隐藏但 IPC 仍可用、再次启动恢复已有窗口。需要 Playwright（同界面回归的环境变量）。只结束测试自己的进程，不读取用户密钥、不请求模型。`-SkipBuild` 仅用于已完成同配置调试构建时。

界面测试同时运行生产 Worker 的 5000 接口解析，确认结果完整且主线程定时器继续响应。内置/导入模块详情测试使用构造数据，不把本机解析文本和会话复制进仓库。

## 原生 GUI 验证

```powershell
npm run test:native-gui -- -EasyLanguageRoot D:\e
```

该脚本调用默认忽略的 Rust 原生窗口 fixture，使用仓库工具链回编 `.e` 并编译 `.exe`，启动隔离的测试程序，核对中文窗口标题、五类控件和按钮更新编辑框的事件，最后关闭它自己的进程。产物位于 `.tmp/native-gui-*`。需要可用的易语言安装与 Windows 桌面会话，不要把它当作无桌面的单元测试。

## 可选的真实模型检查

真实服务验证通过应用的 DeepSeek 官方浏览器授权入口完成，再在工作区发送任务。应用不接受 API Key 或自定义服务地址；不要从账号文件提取令牌用于测试。真实授权与推理不属于离线回归，本轮没有使用真实账号执行。

## 打包与提交

安装包：`npm run tauri -- build`；便携版：`npm run package:portable`。完整工具链包 `e.zip` 需提前准备，分发步骤见 README。便携脚本使用 Tauri 生产构建，并验证 PE 产品版本与清单版本一致，避免普通 Cargo 构建或旧程序混入。

完整发布附件使用 `npm run package:release`，依次构建 NSIS 安装包、复用生产程序生成便携版、复制环境包及发布说明、计算 SHA256。输出位于 `release/v<版本>/`；`-- --skip-build` 仅用于已完成同版本安装包构建的情况。版本必须同时更新 `package.json`、`package-lock.json`、Cargo 清单/锁文件及 Tauri 配置，发布说明放在 `docs/releases/v<版本>.md`。

0.1.2 曾在本机构建 Windows x64 安装包和便携版，并检查版本、工具链、归档及校验值。脚本不创建标签、不上传附件、不发布 GitHub Release；发布页面状态以 GitHub 为准。

0.1.2 产物校验覆盖 x64 PE、0.1.2 产品版本、22 个工具链文件、安装器与 ZIP 归档完整性、SHA256 清单；另通过正常启动及 Windows UI Automation 确认便携版窗口响应并显示消息输入框，未发送模型请求。Tauri 会给安装版主程序写入包类型标记，因此安装包内与便携版的主程序整体哈希不同；本次二进制比对确认仅该三字节元数据存在差异。

提交源码、锁文件、回归脚本和文档。`node_modules/`、`dist/`、`.tmp/`、`public/ort/`、Rust `target/`、密钥环境文件、本地归档和 `e.zip` 不提交；运行时由依赖准备，环境包单独分发。

## 本轮验证记录

2026-10-17 已通过生产构建、Agent runtime、高亮、选择、EPL 与 7 组检索回归，以及 Edge 界面回归。Rust 单元测试为 20 项通过、1 项原生 fixture 默认忽略；原生 GUI 另按上述脚本执行。格式使用 `cargo fmt` 统一后检查。

浏览器持续流测试记录反向位移 0、高度收缩 0、底部最大间隙 0 像素，这是本机模拟数据的结果。Vite 仍提示部分产物超过 500 kB、部分模块混合静态/动态导入；不影响此次构建通过，仍需后续优化。

自动化通过不代表真实 DeepSeek 的延迟和生成质量、任意用户工程依赖或完整编译子进程树取消已经验收。

### 0.1.3 验证说明

生产构建、Agent runtime、模块结构解析、界面与生产 Worker 回归已覆盖本次改动。Rust 工作区单元测试在新增环境扫描回归后为 23 项通过、1 项原生 fixture 默认忽略；其中环境用例已实际创建 Windows junction 循环，确认遍历跳过并报告不完整统计。

2026-10-19 原生工作区脚本已完整通过：真实路径打开 ACL、剪贴板、目录读取、异步环境扫描与嵌套文件计数、PowerShell PTY 的工作目录/中文输出/缩放/关闭，以及实际子网页加载、隐藏/显示/刷新/关闭和桌面命令权限隔离。托盘注册、实际关闭后仍可调用 IPC、再次启动恢复原窗口也已通过。使用独立应用标识和临时 WebView2 用户目录，没有关闭安装版或读取用户密钥。

0.1.3 已完成 Windows x64 NSIS 安装包与便携版构建，附件位于 `release/v0.1.3/`。已验证产品版本、x64 PE、22 个工具链文件、安装器/ZIP 完整性和 SHA256 清单；安装版与便携版主程序仅有 Tauri 包类型标记的三字节差异。没有自动安装、上传附件或发布 GitHub Release，也没有执行真实模型请求。

Tauri JS API 固定在 2.10.x、剪贴板插件在 2.3.x，与 Rust 的同一 minor 版本一致。新增 Worker 使用 ES Module 格式以支持本地嵌入模型的动态加载。Vite 仍有大包与混合导入提示。

## 授权与安装器离线验证

`cargo test --offline --locked --lib deepseek_account::tests --manifest-path src-tauri/Cargo.toml` 使用随机回环端口和临时目录，验证 PKCE、重复/错 state 回调、真实 HTTP 交换、加密保存和重启恢复、退出清理及迟到结果隔离。模拟 token 不进入前端配置，不读取真实账号凭据。

`npm run prepare:installer` 需要 Visual Studio C++ Build Tools（x86/x64）和 Windows SDK；普通前端构建无需该步骤。`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-installer.ps1` 使用同一套原生安装界面，但只向 `.tmp` 写入无害文本文件；不安装产品、不写产品注册表、不启动实际程序。截图与测试产物均留在 `.tmp`。

首次启动以未登录窗口验证原生 600×700 尺寸和固定大小行为；账号网络只在用户点击登录后发生。真实官方账号授权和推理不属于无密钥回归。

2026-10-19 授权扩展验证已通过：5 项账号后端测试覆盖完整本地 HTTP 授权、PKCE、凭据恢复、取消竞态与后台鉴权头；Agent runtime 覆盖旧配置迁移后清除密钥及固定官方地址。Edge 界面回归验证退出登录会中止正在运行的 Agent，迟到输出不会覆盖已停止的记录。原生工作区测试验证登录窗口 600×700、不可调整大小、非官方地址与未登录推理均在发送网络请求前拒绝；安装器使用无害 fixture 完成欢迎页、展开路径、安装进度至 100% 和完成页验证。
