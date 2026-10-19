# 模型认证

对照 DeepSeek Harness `687f282`（0.2.1-rc.2）的 `llm-pi-ai/src/login.ts`、`auth.ts` 和 `provider-data.generated.ts`，使用同版本 `@earendil-works/pi-ai 1.1.0`。

## 使用方式

在设置 → 模型 → 添加模型提供商中选择内置提供商。可以直接保存 API Key，也可以在「其他认证方式」中选择并连接。弹窗根据提供商显示授权页面链接、设备码、选择项或输入框；秘密输入使用密码框。关闭弹窗会取消当前认证。登录成功后更新账号可用的模型列表，在输入框右下角选择使用。

已有连接可编辑、重新连接或断开。断开清除本机保存的授权及密钥，保留模型配置；提供商的系统环境凭据仍可能生效。删除提供商同时清除其本机授权与密钥。此操作不等同于在厂商网站吊销授权。

| 提供商 | 与 Harness 一致的认证入口 |
| --- | --- |
| DeepSeek 官方账号 | 官方浏览器 PKCE 登录，保持独立账号管理 |
| Anthropic | API Key、Claude Pro/Max OAuth、环境 Auth Token、WIF |
| GitHub Copilot | GitHub 设备码 OAuth、Enterprise 域名、已有 Token |
| Kimi For Coding | API Key、Kimi Code OAuth |
| Meta | API Key、Meta OAuth |
| OpenAI Codex (legacy) | ChatGPT Plus/Pro OAuth，浏览器/设备码按 SDK 提示选择 |
| OpenRouter | API Key、PKCE 浏览器/授权码回填 |
| Radius | API Key、OAuth |
| xAI | API Key、SuperGrok/X Premium OAuth |
| Amazon Bedrock | Bearer Token、AWS Profile、已有 AWS 凭据链；模型请求使用 SDK 签名与流式协议 |
| Google Vertex AI | Google Cloud API Key、ADC、服务账号文件及项目/区域 |
| Azure | API Key，端点由自定义设置或 Azure 环境变量提供 |
| Cloudflare Gateway/Workers | API Key、Account ID，以及 Gateway ID（如需要） |
| 其他内置提供商 | SDK 声明的 API Key/环境凭据 |
| 自定义中转 | API Key 或免鉴权；Chat Completions、Responses、Anthropic、Gemini |

目录包括全部 42 个内置提供商，个别提供商只提供分类等非对话模型，因此可能没有代码生成模型列表。OAuth 列表按 Harness 的同一规则生成：SDK 的新版 OpenAI ChatGPT 登录需要额外安装身份，Harness 当前以 `UNSERVED_OAUTH = new Set(['openai'])` 排除，EAiCoding 也不单独展示；其 Codex 登录入口仍可用。

## 存储与执行

内置第三方模型使用随包的 Node 本地运行时，直接复用 SDK 的认证、刷新与协议实现。Rust 从已保存的 profile 读取提供商、模型及端点，通过子进程 stdin 传入凭据；前端不能用本轮请求覆盖认证端点。OAuth 刷新或登录产生的新凭据先经 Rust 加密落盘并确认，再向用户报告成功或发起模型请求。

本机文件分别为 `model-providers-v1.json`（API 配置和加密密钥）、`model-grants-v1.json`（加密授权及结构化云配置）。账号 Token、refresh token、密钥不写入 IndexedDB、会话或前端日志。Google/AWS 的凭据文件由官方 SDK 按配置使用，不复制到项目。第三方失败不会注销 DeepSeek 账号。

同一 profile 的认证、刷新、保存、删除和请求串行执行，避免旧刷新覆盖新登录。取消关闭本次运行时及回调服务器；相互独立的 profile 可以并发。原有非运行时 API 配置继续兼容，编辑并保存内置提供商后采用完整运行时。

## 验证范围

`npm run test:model-auth` 使用真实 SDK、模拟授权响应及本地 AWS HTTP 服务验证所有 API/配置登录、Copilot 设备码和模型筛选、OpenRouter PKCE 回填、Claude 过期刷新、ADC/WIF、写入失败、随包运行时与取消、AWS SigV4。界面回归验证认证方式、密码/文本提示、设备码复制、取消、连接后的模型列表与断开。

这些测试不读取真实凭据，也不调用付费接口；厂商的真实账号权限、订阅资格和外网连通性由实际登录结果决定。
