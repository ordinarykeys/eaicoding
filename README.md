# EAiCoding 桌面端

<p align="center">
  <img src="./assets/star-note.svg" width="100%" alt="开源不易，觉得项目有帮助的话，记得点个 Star。" />
</p>

EAiCoding 桌面端是一款面向易语言开发者的本地 AI Coding Agent。它把大模型对话、易语言源码解析、精易模块知识库、代码展示、`.e/.ec` 工程处理和编译验证整合到一个 Windows 桌面应用中，目标是让易语言项目也能拥有类似现代 AI Coding 工具的工作流。

桌面端基于 Tauri 2、React、TypeScript 和 Rust 构建。应用不依赖项目自带后端服务，模型配置、对话记录、用户模块索引和生成文件目录都保存在本机。模型推理使用 DeepSeek API，本地向量模型仅用于知识检索。

文档入口：[架构与执行流程](docs/architecture.md) · [开发与验证](docs/development.md) · [更新记录](CHANGELOG.md) · [问题诊断与修复](项目诊断报告.md)

当前版本：**0.1.2**。[发布说明](docs/releases/v0.1.2.md)包含本次改动、附件用途和升级注意事项。

## 功能特性

- AI 对话：仅接入 DeepSeek，预置 DeepSeek-V4.1-Flash（`deepseek-flash`）和 DeepSeek-V4-Pro（`deepseek-v4-pro`）。
- 本地配置：API 配置、模型参数、对话记录和生成目录保存在本机。
- 易语言文件处理：支持解析 `.e/.ec`，导出 ecode 文本工程，回编生成 `.e`。
- 原生窗口生成：可生成含窗口、控件布局、初始化和事件的易语言 GUI 工程，输出可编辑 ecode、`.e` 和编译后的 `.exe`；目前支持按钮、编辑框、标签、选择框、单选框。
- 编译验证：内置易语言命令行编译相关工具，可对生成或修改后的 `.e` 做编译检查。
- 精易模块知识库：内置精易模块 API 数据，支持精确检索、BM25、向量检索和融合排序。
- 用户模块库：在设置中上传 `.ec` 模块，解析公开接口并建立本地索引；支持搜索、分页和导入进度显示。
- 代码展示：参照 DeepSeek Harness 的代码卡片，提供行号、复制、自动换行、保存、深浅色主题，并保留易语言 IDE 视图切换。
- 自动编程：AI 自主选择技术方案并读写文件，完成修改后继续回编和编译验证；桌面入口没有固定总步数上限，可随时停止。
- 回复与预览：流式 Markdown、独立推理区域、可展开工具记录、右侧文件页签和分页预览；上翻暂停跟随，点击“回到最新”恢复。
- 设置弹窗：分为通用、模型、易语言环境、模块库，保留 Claude 暖色主题与紧凑输入区。
- 手机模式：桌面端可开启局域网桥接，手机 App 扫码后继续对话。
- 单实例运行：重复打开应用时会聚焦已有窗口，避免多开造成状态混乱。

## 技术栈

- 前端：React 19、TypeScript、Vite、Radix UI、Phosphor Icons、React Markdown、Shiki
- 桌面壳：Tauri 2
- 后端能力：Rust、Tauri Commands、Tokio、Reqwest
- 本地数据：IndexedDB、Tauri Store、本地文件系统
- 知识库：精确检索、BM25、向量检索、RRF 融合排序
- 易语言工具链：`e2txt`、`ECodeParser`、`eparser32`、`EBuild`、`ecl`

## 目录结构

```text
eaicoding/
  src/                         前端源码
    components/                页面和 UI 组件
    services/                  LLM、Agent、知识库、移动桥接等服务
    stores/                    本地状态管理
    styles/                    易语言代码展示和全局样式
  src-tauri/                   Tauri / Rust 侧代码
    src/                       Tauri Commands 和本地能力实现
    resources/eagent-tools/    随应用打包的易语言工具链
    tauri.conf.json            Tauri 打包配置
  scripts/                     知识库构建、便携版打包等脚本
  public/                      静态资源
  docs/                        架构、开发与验证文档
```

## 环境要求

- Windows 10/11
- Node.js 22（建议使用与验证环境一致的版本）和 npm
- Rust 稳定版
- Microsoft WebView2 Runtime
- 从源码构建桌面端还需要 Visual Studio Build Tools 的 C++ 桌面开发组件和 Windows SDK

Android App 不是桌面端运行必需项；手机端项目在 `mobile-app` 目录。

## 开发运行

安装依赖：

```powershell
git clone https://github.com/ordinarykeys/eaicoding.git
cd eaicoding
npm ci
```

安装、开发启动和生产构建会自动将锁定依赖中的 ONNX JS/WASM 配对文件复制到 `public/ort/`，供本地向量检索使用，无需手动下载或依赖 CDN。如果使用了 `npm ci --ignore-scripts`，可手动运行 `node scripts/prepare-ort.mjs`；`npm run dev` 和 `npm run build` 也会准备这些文件。

启动桌面端开发环境：

```powershell
npm run tauri -- dev
```

只启动前端页面：

```powershell
npm run dev
```

前端构建检查：

```powershell
npm run build
```

Rust 检查：

```powershell
cd src-tauri
cargo fmt --check
cargo check
```

## 易语言运行环境包

仓库不会直接提交 `src-tauri/resources/eagent-tools/eroot/e.zip`。这个文件约 204 MB，超过 GitHub 单文件 100 MB 限制，也更适合通过 Release 附件单独分发。

如果需要在本地使用解析、回编和编译验证能力，请先从项目 Release 页面下载 `e.zip`，并放到下面的位置：

```text
src-tauri/resources/eagent-tools/eroot/e.zip
```

目录不存在时可以手动创建：

```powershell
mkdir src-tauri\resources\eagent-tools\eroot
```

应用启动后会在需要易语言运行环境时自动解压该压缩包到本机应用数据目录。解压后的目录会提供 `e.exe`、`el.exe`、`tools/link.dll`、`VC98linker/bin/link.exe`、`static_lib` 等编译和解析所需文件。

如果缺少 `e.zip`，AI 对话和知识库仍可使用，但 `.e/.ec` 解析、回编、命令行编译验证等闭环能力会不可用。

### 上传 e.zip 到 GitHub Release

推荐把 `e.zip` 作为 Release 附件上传，而不是提交到 Git 仓库。

网页上传步骤：

1. 先把源码推送到 GitHub。
2. 打开仓库页面，进入 `Releases`。
3. 点击 `Draft a new release`。
4. 新建标签，例如 `v0.1.2`，目标选择对应的发布提交。
5. 标题填写 `EAiCoding v0.1.2`。
6. 在附件区域上传：

```text
src-tauri/resources/eagent-tools/eroot/e.zip
```

7. 发布 Release。
8. 在 Release 说明中写明：下载 `e.zip` 后放到 `src-tauri/resources/eagent-tools/eroot/e.zip`。

也可以使用 GitHub CLI 上传：

```powershell
gh release create v0.1.2 `
  src-tauri/resources/eagent-tools/eroot/e.zip `
  --title "EAiCoding v0.1.2" `
  --notes "e.zip 为易语言运行环境包。下载后请放到 src-tauri/resources/eagent-tools/eroot/e.zip。"
```

如果 Release 已经存在，可以追加上传：

```powershell
gh release upload v0.1.2 src-tauri/resources/eagent-tools/eroot/e.zip
```

建议同时提供 `e.zip` 的 SHA256，方便用户校验文件完整性：

```powershell
Get-FileHash src-tauri\resources\eagent-tools\eroot\e.zip -Algorithm SHA256
```

## 模型配置

打开设置弹窗，进入「模型」，填写 DeepSeek API Key。展开「自定义设置」可修改连接地址、检测连接、选择默认模型及编辑高级参数。修改后点击「应用」保存，「取消」撤回编辑；输入区右下角可随时切换实际请求使用的模型。

| 配置 | 默认值 |
| --- | --- |
| 接口地址 | `https://api.deepseek.com` |
| 请求协议 | OpenAI Chat Completions，`/chat/completions` |
| 默认模型 | DeepSeek-V4.1-Flash，`deepseek-flash` |
| 另一个可选模型 | DeepSeek-V4-Pro，`deepseek-v4-pro` |
| 最大输出 Token | `256000`，输出上限而非固定生成长度 |
| 生成随机性 | `0.2` |

密钥在本机加密保存；重新打开配置时不会回填明文，留空保留原密钥。旧版本的 DeepSeek 配置继续保留；其他厂商配置会重置为 DeepSeek 默认值并清空旧密钥，需要重新填写。

设置 v7 会将旧版官方接口的默认 `8192` 输出额度升级为 `256000`；其他自定义额度及代理配置保留。代理地址需要自行确认支持这两个模型及所设输出额度。输出被截断时会丢弃该轮不完整内容，并自动要求模型拆小操作，最多重试两次；已成功执行的工具不会重做。恢复仍失败会明确报告任务未完成。

应用不会内置任何商业模型密钥。开源仓库中也不应提交真实 API Key、私有 Base URL、测试密钥或个人账号信息。

### 改动验证

```powershell
npm run build
npm run test:agent-runtime
npm run test:code-highlight
npm run test:agent-choice
npm run test:agent-epl
npm run test:agent-retrieval
cargo test --offline --lib --manifest-path src-tauri/Cargo.toml
```

浏览器界面测试使用 Playwright：安装后执行 `npm run test:ui`；也可通过 `EAICODING_PLAYWRIGHT_MODULE` 指定已安装的 Playwright 模块路径，通过 `EAICODING_BROWSER_CHANNEL=msedge` 使用本机 Edge。测试使用模拟 IPC 和临时浏览器数据，截图位于 `.tmp/ui-validation`。

详细依赖、测试分类、运行步骤及结果边界见[开发与验证](docs/development.md)。

安装易语言后，可执行 `npm run test:native-gui -- -EasyLanguageRoot D:\e`。该测试实际生成并编译窗口程序，检查控件与按钮事件，最后关闭测试程序。模型请求测试使用模拟传输，不代表真实 DeepSeek 接口已联网验证。

## 易语言工作流

典型流程：

1. 用户上传或选择 `.e/.ec` 文件。
2. Agent 调用解析工具读取工程结构。
3. 如需修改完整项目，先导出 ecode 文本工程。
4. 读取关键源码文件、项目地图和静态质量分析结果。
5. 修改文本工程中的 `.e.txt` 源码。
6. 回编生成新的 `.e`。
7. 调用命令行编译工具做编译验证。
8. 将编译结果、错误日志和生成路径反馈给用户。

工具链大致如下：

```text
.e/.ec
  -> 解析 / 导出 ecode 文本工程
  -> AI 读取和修改文本源码
  -> 回编生成 .e
  -> ecl 编译验证
  -> 输出 exe 或返回错误日志
```

## 知识库

桌面端内置精易模块知识库，主要用于回答易语言 API、类、子程序、参数和示例相关问题。

检索策略不是单纯关键词匹配，会组合：

- 精确名称匹配
- 中文分词和 n-gram
- BM25 词法检索
- 本地向量检索
- RRF 融合排序
- 功能候选重排

用户模块库接收 `.ec` 文件，应用保存本地副本并解析公开子程序、类和参数，按需建立量化向量索引。元数据与完整索引分开存储，列表每页仅挂载 20 条。Agent 优先遵从用户指定的模块，基于检索证据自主选择接口；Markdown 文档上传不是当前模块库功能。

## 手机模式

桌面端可以开启手机模式，生成局域网二维码。Android App 扫码后，会连接到桌面端提供的本地桥接接口。

手机模式只用于同一局域网内继续对话，不提供外网远程访问能力。

常见注意事项：

- 手机和电脑需要连接同一个局域网。
- Windows 防火墙需要允许桌面端监听的端口。
- 公司网络、校园网、访客 Wi-Fi 可能会隔离设备，导致手机无法访问电脑。
- 如果二维码过期，重新在桌面端打开手机二维码即可。

## 打包

打包完整版前，请确认下面的文件已经存在：

```text
src-tauri/resources/eagent-tools/eroot/e.zip
```

构建前端和 Tauri 安装包：

```powershell
cd D:\pingfan\eaicoding
npm run tauri -- build
```

NSIS 安装包通常输出到：

```text
src-tauri\target\release\bundle\nsis\
```

生成便携版（使用 Tauri 生产构建，并校验主程序版本）：

```powershell
npm run package:portable
```

便携版输出（以 0.1.2 为例）：

```text
release\v0.1.2\EAiCoding_0.1.2_x64-portable\EAiCoding.exe
release\v0.1.2\EAiCoding_0.1.2_x64-portable.zip
```

一次性构建安装包、便携版并整理发布附件：

```powershell
npm run package:release
```

该命令将安装包、便携归档、独立 `e.zip`、`RELEASE_NOTES.md` 和 `SHA256SUMS.txt` 集中到 `release/v0.1.2/`。若刚完成同版本的安装包构建，可运行 `npm run package:release -- --skip-build` 复用它；便携版仍会核对生产主程序版本。命令只准备本地附件，不自动创建标签或发布 GitHub Release。

安装版升级前先退出旧程序，再运行新安装包；应用标识保持不变。便携版需完整解压并保留 `eagent-tools`，应用设置仍存于本机用户目录，不随便携目录移动。

## 安全与误报说明

桌面端完整版会随包携带易语言解析、回编和编译工具链，例如 `e2txt.exe`、`EBuild.exe`、`ecl.exe`、`ECodeParser.dll` 以及单独分发的 `e.zip` 易语言运行环境包。这类工具具备源码解析、生成工程、调用编译器和生成可执行文件的能力，部分安全软件可能会按 HackTool、Riskware、FlyStudio 或 Trojan 类标签做启发式报毒。

这不等于应用一定是恶意软件，但也不应该只靠作者口头承诺判断。开源发布时建议同时提供：

- 源码仓库地址
- 安装包 SHA256
- 主程序 SHA256
- 内置工具链文件清单
- VirusTotal、腾讯哈勃、微步云沙箱等复查链接

如果希望降低误报，可以考虑拆分两个版本：

- 普通用户版：不内置编译/回编工具链，只保留 AI 对话、知识库和代码展示。
- 开发者完整版：内置完整工具链，明确标注可能触发安全软件误报。

## 隐私说明

- 对话记录和设置默认保存在本机。
- 应用不会内置作者的模型密钥。
- 调用 AI 时会发送用户输入、用户主动上传或选择的代码内容，以及模型接口所需参数。
- 手机模式只在局域网内提供桥接接口，并使用二维码中的 token 做访问校验。
- 开源发布前请检查 `.env`、日志、截图和测试配置，避免提交真实 API Key。

## 社区链接

本项目参与开源交流与推广，认可并感谢 [LINUX DO](https://linux.do/) 社区提供的开发者交流环境。

## 常见问题

### 模型列表获取失败

确认 Base URL 是否指向 DeepSeek 官方 API（默认 `https://api.deepseek.com`）或支持当前 DeepSeek 模型的兼容端点。连接检测通过 `/models` 验证模型，旧模型或其他服务商模型不会加入选择器。

### 提示输出达到 Token 上限

更新后的执行器会自动拆小本轮操作并重试，不会执行被截断的工具参数。若仍失败，在「模型 → 自定义设置 → 高级参数」检查最大输出 Token；旧代理或手动设置的小额度会保留。只需继续当前任务，之前成功的工具结果仍保存在对话中。提高额度前应确认接口支持的范围，额度本身不保证任务一定完成。

### 为什么任务还在继续执行

桌面入口按工具结果推进任务，最新修改完成验证后才交付，没有统一的 12/32 步上限。网络重试、截断恢复、重复无进展和自检各有独立处理；可使用停止按钮中断。普通问候正常情况下只发一次无工具请求。

### 手机扫码后一直连接中

优先检查三件事：

1. 手机和电脑是否在同一局域网。
2. 桌面端手机模式是否仍在运行。
3. Windows 防火墙是否拦截了手机模式端口。

### 编译失败但手动用易语言 IDE 可以运行

命令行编译和 IDE 编译环境可能不同。请检查：

- `src-tauri/resources/eagent-tools/eroot/e.zip` 是否已下载并放到正确位置。
- `.ec` 模块路径是否能被命令行编译器找到。
- 易语言根目录是否配置正确。
- 生成目录是否有写入权限。
- 编译日志中是否有缺少支持库、模块或资源文件。

## 授权说明

本项目采用源码公开、非商业授权的方式发布。源码仅限学习、交流、研究和个人非商业用途。

未经作者书面授权，禁止将本项目或基于本项目的修改版本用于以下用途：

- 商业销售、付费分发、软件代售或二次打包售卖。
- 作为商业产品、商业 SaaS、付费会员服务的一部分提供给第三方使用。
- 用于商业培训、商业课程、商业外包交付。
- 去除作者信息后重新发布。
- 使用本项目名称、图标、界面或说明材料进行商业宣传。

允许的用途：

- 个人学习和研究。
- 非商业项目中的测试和改造。
- 提交 issue、PR 或基于源码进行技术交流。
- 在保留作者信息和本说明的前提下进行非商业分享。

第三方依赖、易语言相关工具链、模型文件和其他外部资源分别遵循其自身许可证或授权条款。本项目的非商业限制不代表这些第三方组件授予了额外商业授权。

## 参考项目

界面布局、设置编辑、执行流程、滚动跟随和代码卡片参考 DeepSeek Harness 的本地只读源码；分页源码读取、哈希校验修改参考 [AutoLinker](https://github.com/aiqinxuancai/AutoLinker)。具体对照点与实现差异见[架构与执行流程](docs/architecture.md)。项目使用 React + Tauri + Rust，原生窗口生成由本项目实现。
