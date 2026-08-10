# AgentDesk 项目规则

## 执行边界

- 回复使用简短、容易理解的中文；先说结论，再说明影响和未完成事项。
- 讨论、分析、检查默认只读；只有用户明确要求修改、执行、提交或发布时才改变状态。
- 进入执行后完成“查明原因、修改、分级验证、说明结果”，不要只给方案。
- 修改前检查工作区和现有改动；保留用户或其他 AI 的修改，不擅自回滚、覆盖、删除或清理。
- `git reset --hard`、`git checkout --`、强制推送、批量删除、覆盖安装和其他不可逆操作必须先取得明确授权。
- 未经明确授权，不提交、不推送、不升版本、不创建 Tag/Release、不安装或覆盖正式版。
- 本项目不依赖 mini-ide。开发、启停、编译、测试、日志、健康检查、Git、预检和打包均不得使用 mini-ide。

## 项目与事实来源

AgentDesk 是 Windows x64 桌面客户端，同时接入 Codex 和 Claude Code。Electron 主进程负责桌面能力和受控 IPC，Renderer 负责会话与界面；两个 Provider 的后端、事件和生命周期彼此隔离。

- 项目日常分支为 `develop`，远程私有仓库为 `yxb715/agentdesk`。
- 依赖版本、npm 命令和打包配置以 `package.json`、`package-lock.json` 为准；当前主技术栈为 Node 24、Electron 43、React 19、TypeScript 5.7、Vite 6 和 electron-builder。
- 已实现行为以 `src`、Provider 能力注册表、测试和真实 Electron 行为为准；设计稿和路线图中的规划不能写成已实现功能。
- CI 与 Release 行为以 `.github/workflows` 为准；版本和 Release 结果以 Git 与 GitHub 为准。
- 本文件只记录长期规则、架构边界和操作入口，不记录一次性测试结果、临时交接、精确测试数量或完整功能清单。

## 代码地图

- `src/main/main.ts`：主进程服务组装，以及工作区、附件、本地文件和外部能力的安全策略。
- `src/main/agent`：Provider 无关的 Backend 接口、注册表、请求适配和事件协议。
- `src/main/providers/codex`：Codex app-server、JSONL、请求登记和 Codex 能力。
- `src/main/providers/claude`：Claude Backend、Worker、凭据、工作区信任、历史、图片、进程树和更新校验。
- `src/main/windowLifecycle.ts`：窗口、托盘、单实例、老板键和安装前窗口生命周期。
- `src/main/preferencesStore.ts`、`atomicFile.ts`：偏好归一化、容量限制和原子持久化。
- `src/main/*UpdateManager.ts`、`processSupervisor.ts`：桌面端、Codex CLI、Claude Code 更新与受管进程。
- `src/main/ipc`：桌面 IPC 注册和输入边界；入口只负责注入依赖。
- `src/preload/preload.ts`：通过 `contextBridge` 暴露最小 Bridge，不暴露 Node、文件系统或子进程 API。
- `src/shared`：Bridge、Provider、更新、偏好和 JSON-RPC 共享类型。
- `src/renderer/App.tsx`：顶层状态和依赖组装、统一会话请求与页面编排，不继续堆入新的生命周期状态机。
- `src/renderer/*Controller.ts`、`agent`、`providers`：会话、消息、事件、历史、布局和 Provider 差异逻辑。
- `src/renderer` 中的具体 `.tsx` 组件：界面展示与交互；具体 UI 不回流到 `App.tsx`。
- 新增桌面能力必须同步更新 shared 类型、preload、主进程 IPC、请求白名单、超时配置和必要测试。

## 架构与产品边界

- Codex 只通过本机 `codex app-server` 通信；Claude Code 只通过 Agent SDK 和独立 Worker 通信。
- 两个 Provider 的进程、凭据、审批、Query 代次、事件和退出清理保持隔离；Provider 退出不得清理另一个 Provider 的会话。
- Provider 能力由注册表和运行时响应决定；通用组件不得伪造入口，也不得散落成片的 `provider === ...` 判断。
- 所有会话请求继续经过统一的 Provider 请求路径；具体组件不得绕过该路径直接调用 Bridge。
- 正式窗口使用无边框 BrowserWindow，加载后最大化；关闭默认隐藏到托盘，并支持 `--cwd` 与单实例唤醒。
- 偏好保存在 Electron `userData/preferences.json`，包括工作区、主题、展示模式、侧栏宽度、基础字号、老板键、会话元数据、模型缓存、Claude 信任和更新恢复状态。
- 普通重启不持久化运行中的 Tab/分栏；只有桌面更新安装前保存一次性恢复状态，并在恢复后清理。
- 软件、Codex CLI 和 Claude Code 更新只能由用户主动触发；软件不自动下载或退出安装，Claude 受管更新不得降低完整性和 Anthropic 官方签名校验。
- 新依赖必须说明用途、体积、Electron 兼容性和现有依赖能否完成；没有明确必要性时不引入状态管理、路由、UI 组件库或虚拟列表库。

## 安全与容量边界

- BrowserWindow 固定使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- IPC 只暴露明确方法；Provider 请求必须校验操作白名单、会话、工作区和 Query 归属，迟到响应不得污染新 Query。
- 外部链接只允许 HTTP(S) 并交给系统浏览器；窗口导航和新窗口必须拦截不安全地址。
- 本地路径必须经过真实路径、授权集合、工作区或附件根目录和文件类型校验；图片按内容校验，不信任扩展名。
- Claude 图片在主进程授权后仍由 Worker 二次校验；工作区未经明确信任、凭据冲突或字段不安全时拒绝继续。
- GitHub 访问令牌只通过进程环境变量或 Electron `safeStorage` 使用，不得写入普通偏好、日志、源码、构建产物、文档或回复。
- 不读取、修改、删除或重建 Codex SQLite 数据库；历史统一通过 Provider API 获取。
- JSON 对象和事件解析允许未知字段；Provider 差异集中在 Backend、事件适配器和能力注册表中。
- 不取消现有容量限制：原始事件每会话 20,000 条，Codex 消息和活动各 5,000 项、子 Agent 1,000 项，JSONL 16 MB，Claude Worker 消息 2 MB，单图 10 MB，附件目录 10,000 文件或 1 GB，偏好文件 4 MB。

## 原生开发命令

- 安装或同步依赖：`npm install`。修改 `package.json` 后同步检查 `package-lock.json`；CI 或全新干净目录使用 `npm ci`。
- 主进程、preload、Worker 和 shared 编译：`npm run build:main`。
- Renderer 类型检查和产物构建：`npm run build:renderer`。
- 全部测试：`npm test`。
- 局部测试先编译测试：`npm exec -- tsc -p src/tsconfig.test.json`；再执行目标文件，例如 `node --test build/tests/renderer/layoutController.test.js`。
- 完整构建：`npm run build`。它已经包含主进程编译、Renderer 构建和全部测试。
- 开发模式：`npm run dev`；兼容入口为 `npm run start`。不要手工拼接 Vite、Electron 和端口参数。
- 浏览器 Mock 预览：`npm run preview`。它只能验证 Renderer 布局和交互，不能证明真实 Provider、IPC 或桌面能力可用。
- Electron 核心回归：`pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/electron-regression.ps1`。
- 核心加真实 Provider 回归：在上述命令后加 `-LiveProviders`；只跑真实 Provider 时使用 `-LiveProviders -SkipCore`。
- 本地打包：`npm run package`。该命令已经包含完整构建并固定 `--publish never`，不得用 `release:github` 代替本地验证。
- 打包版回归：打包完成后执行 `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/electron-package-regression.ps1`。
- `build/release` 是 electron-builder 输出目录，包含 `win-unpacked`、NSIS 安装包、blockmap、`latest.yml` 和构建辅助文件；正式 Release 资产只有安装包、blockmap 和 `latest.yml`。
- Electron 回归脚本使用项目入口启动和清理进程，Playwright wrapper 默认路径可由 `AGENTDESK_PLAYWRIGHT_WRAPPER` 覆盖；不要手工启动另一套回归流程。
- 停止服务优先在启动终端发送 `Ctrl+C`；自动化只结束自己记录的进程树，禁止按名称批量结束全部 Node、Electron 或浏览器进程。
- 日志优先读取命令输出；持久日志只写入 Git 忽略的 `build/logs`，不得记录凭据、完整环境变量或用户内容。
- 健康检查：开发页面为 `http://127.0.0.1:3000`，Electron CDP 为 `http://127.0.0.1:9223/json/version`；使用有上限的轮询。
- Git 检查：`git status --short`、`git diff --stat`、`git diff -- <path>`；Git 操作直接使用原生 Git。

## 分级与批量验证

- 只改文档：检查内容、链接和 Git diff，不运行代码构建、Electron 回归或打包。
- 纯逻辑或低风险重构：开发中运行相关测试；同一模块、行为链或验收范围内的小改动合并为一个批次。
- Renderer 批次：先执行 `npm run build:renderer`，再按真实依赖选择 Mock 预览或 Electron 回归；检查桌面布局、长文本、加载、空状态和错误状态。
- 主进程、preload、shared 批次：先执行相关测试和 `npm run build:main`；涉及真实桌面行为、Provider、IPC、审批、附件、更新、中断、进程或窗口生命周期时，批次结束后执行一次 Electron 回归。
- Electron 运行时、electron-builder、安装包或更新链路变更：批次结束后执行一次 `npm run package` 和打包版回归；若同时影响开发版桌面行为，再补一次 Electron 核心回归。
- 对 `npm test`、`npm run build`、`npm run package` 这条嵌套构建链，一个批次只选择最终需要的最高入口：`build` 已包含 `test`，`package` 又包含 `build`，代码未变化时不得连续重复执行。
- Electron 核心、真实 Provider 和打包版回归验证的是不同运行行为，不能因执行了更高构建入口就互相替代；只运行本批次实际影响的场景，并把同类场景集中回归一次。
- 多个改动覆盖同一套 Electron 场景时统一回归一次；只有失败后修复了相关代码或验收范围变化时才重跑。
- 测试失败后先定位根因并执行最小相关验证，确认修复后再运行批次最终门禁；不得反复运行整套流程碰运气。
- 验证结束后停止本轮开发服务、测试窗口和临时进程，确认 3000、9223、9224 及 Playwright 会话没有本轮残留；不得停止用户正在运行的正式版。

## Git 与发布

- 未经明确授权，不执行 `git add`、`git commit`、`git push`、切分支、清理、重置或改写历史。
- 正式发布前确认分支、远程、工作区、版本号和授权；版本号同步修改 `package.json` 与 `package-lock.json`。
- 正式发布前只执行一次本地 `npm run package` 及必要的打包版回归，不在代码未变化时额外重复 `npm run build`。
- 正式发布使用普通推送 `develop`，再在已推送提交上创建并推送对应 `vX.Y.Z` Tag，等待 `.github/workflows/release.yml` 完成。
- Release 必须同时包含 `AgentDesk-Setup-X.Y.Z.exe`、对应 blockmap 和 `latest.yml`，全部确认后才能报告发布完成。
- 发布失败时停在失败步骤；不重复创建 Tag、不修改旧 Tag、不强制推送，修复后重新取得发布授权。
