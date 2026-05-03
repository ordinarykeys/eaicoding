# EAiCoding 桌面端

<h3 align="center">开源不易，觉得项目有帮助的话，记得点个 Star。</h3>

EAiCoding 桌面端是一款面向易语言开发者的本地 AI Coding Agent。它把大模型对话、易语言源码解析、精易模块知识库、代码展示、`.e/.ec` 工程处理和编译验证整合到一个 Windows 桌面应用中，目标是让易语言项目也能拥有类似现代 AI Coding 工具的工作流。

桌面端基于 Tauri 2、React、TypeScript 和 Rust 构建。应用不依赖项目自带后端服务，模型配置、对话记录、用户知识库和生成文件目录都保存在本机。

## 功能特性

- AI 对话：支持 OpenAI 兼容接口、Anthropic、Gemini 等模型服务。
- 本地配置：API 配置、模型参数、对话记录和生成目录保存在本机。
- 易语言文件处理：支持解析 `.e/.ec`，导出 ecode 文本工程，回编生成 `.e`。
- 编译验证：内置易语言命令行编译相关工具，可对生成或修改后的 `.e` 做编译检查。
- 精易模块知识库：内置精易模块 API 数据，支持精确检索、BM25、向量检索和融合排序。
- 用户知识库：支持用户上传自己的模块说明、项目规范、团队经验文档。
- 易语言代码展示：尽量按易语言 IDE 的代码结构展示变量、子程序和代码块。
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
tauri-app/
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
```

## 环境要求

- Windows 10/11
- Node.js 20 或更高版本
- Rust 稳定版
- Microsoft WebView2 Runtime
- 可选：Visual Studio Build Tools，用于 Rust/Tauri 依赖编译

Android App 不是桌面端运行必需项；手机端项目在 `mobile-app` 目录。

## 开发运行

安装依赖：

```powershell
cd D:\pingfan\Downloads\eaicoding\tauri-app
npm install
```

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
4. 新建标签，例如 `v0.1.1`。
5. 标题填写 `EAiCoding v0.1.1`。
6. 在附件区域上传：

```text
src-tauri/resources/eagent-tools/eroot/e.zip
```

7. 发布 Release。
8. 在 Release 说明中写明：下载 `e.zip` 后放到 `src-tauri/resources/eagent-tools/eroot/e.zip`。

也可以使用 GitHub CLI 上传：

```powershell
gh release create v0.1.1 `
  src-tauri/resources/eagent-tools/eroot/e.zip `
  --title "EAiCoding v0.1.1" `
  --notes "e.zip 为易语言运行环境包。下载后请放到 src-tauri/resources/eagent-tools/eroot/e.zip。"
```

如果 Release 已经存在，可以追加上传：

```powershell
gh release upload v0.1.1 src-tauri/resources/eagent-tools/eroot/e.zip
```

建议同时提供 `e.zip` 的 SHA256，方便用户校验文件完整性：

```powershell
Get-FileHash src-tauri\resources\eagent-tools\eroot\e.zip -Algorithm SHA256
```

## 模型配置

进入应用设置后添加 API 配置：

- OpenAI 兼容接口：填写 Base URL、API Key、模型名。
- Anthropic：填写 API Key 和模型名。
- Gemini：填写 API Key 和模型名。

应用不会内置任何商业模型密钥。开源仓库中也不应提交真实 API Key、私有 Base URL、测试密钥或个人账号信息。

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

用户知识库用于补充私有模块、项目规范、团队经验和常见问题。建议使用 Markdown 编写，按“标题、用途、参数、返回值、示例、注意事项”的结构整理。

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
cd D:\pingfan\Downloads\eaicoding\tauri-app
npm run tauri -- build
```

NSIS 安装包通常输出到：

```text
src-tauri\target\release\bundle\nsis\
```

生成便携版：

```powershell
npm run package:portable
```

便携版输出：

```text
release\易语言AI助手-portable\
release\易语言AI助手-portable.zip
```

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

## 常见问题

### 模型列表获取失败

确认 Base URL 是否是标准模型接口地址，例如 OpenAI 兼容服务通常应以 `/v1` 结尾。部分服务商不支持 `/models`，这种情况下可以手动输入模型名。

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
