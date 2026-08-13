# AgentDesk 开发规则

## 回复与执行边界

- 使用简短、易懂的中文回复；先说结论，再说明影响、验证结果和未完成事项。
- “为什么、怎么看、评估、分析、检查”默认只读；只有用户明确要求“改、修、实现、执行、提交或发布”时才改变状态。
- 进入执行模式后完成：查明原因、修改、验证、交付说明。不要只给方案，也不要在中途把下一步交回用户。
- 修改前先检查 `git status` 和相关 diff。保留用户或其他 AI 的现有改动，不擅自回滚、覆盖、删除或清理。
- `git reset --hard`、`git checkout --`、强制推送、批量删除、覆盖安装和其他不可逆操作必须先取得明确授权。
- 未经明确授权，不执行 `git add`、`git commit`、`git push`、切分支、改写历史、升版本、创建 Tag/Release 或发布正式版。
- 本项目不使用 mini-ide；开发、启停、编译、测试、日志、回归、Git 和打包直接使用项目脚本与原生工具。

## 事实来源

- 已实现行为以当前工作区的 `src`、测试、`package.json`、`package-lock.json`、脚本和 `.github/workflows` 为准。
- 设计稿、路线图、审查文档和交接文档不能证明功能已实现；文档中的一次性结果不能当作长期规则。
- 依赖、命令、打包入口和版本以 `package.json` 与锁文件为准；不要在本文件复制容易过期的版本号或完整功能清单。
- 外部 Provider 的协议、能力和错误以运行时响应及适配器为准；不要凭记忆假定某个 Provider 支持某项能力。

## 项目边界

AgentDesk 是 Windows x64 Electron 桌面客户端。Electron 主进程负责窗口、文件、进程、更新和受控 IPC；Renderer 负责会话状态与界面；Codex 和 Claude Code 是彼此隔离的 Provider。

- Codex 通过本机 `codex app-server` 的 JSONL 协议通信。
- Claude Code 通过独立 Worker 使用 Agent SDK；Claude 历史、图片、插件/市场和受管更新也经过该 Worker 或主进程受控路径。
- Provider 的进程、凭据、会话、Query 代次、交互请求、事件和关闭清理必须隔离；一个 Provider 退出不得清理另一个 Provider 的会话。

## 分层与代码地图

- `src/main/main.ts`：主进程组装、工作区与本地路径授权、附件、外部能力和退出流程。
- `src/main/agent`：Provider 无关的 Backend 接口、注册表、请求适配、会话登记和交互归属校验。
- `src/main/providers/codex`：Codex app-server 子进程、RPC 请求登记、超时和事件转换。
- `src/main/providers/claude`：Claude Backend、Worker、凭据、信任、历史、图片、插件、进程树和更新完整性检查。
- `src/main/ipc/registerDesktopIpc.ts`：桌面 IPC 注册、操作白名单、参数归一化和输入边界；`main.ts` 只负责注入真实服务。
- `src/preload/preload.ts`：通过 `contextBridge` 暴露最小 Bridge，不暴露 Node、文件系统或子进程 API。
- `src/shared`：Bridge、Provider 操作/事件、偏好、更新和共享 JSON 类型。
- `src/renderer/App.tsx`：顶层状态、依赖组装和页面编排；新的会话/事件/历史/布局生命周期逻辑应放入已有 Controller 或独立模块。
- `src/renderer/agent`、`src/renderer/providers`：Provider 注册、能力、请求错误和事件适配。
- `src/renderer/*Controller.ts`：会话、消息、事件、历史、布局、设置和生命周期协调。
- `src/renderer` 中的 `.tsx`：展示和交互；具体组件不得绕过统一请求路径直接调用 Provider Bridge。
- `scripts`：开发版、真实 Provider、打包版和隔离配置回归入口；脚本启动的进程只能由脚本自己清理。

## 关键架构约束

- 所有 Provider 请求必须经过 `AgentBridge` -> IPC 校验 -> `BackendManager` -> `AgentSessionRegistry` -> Provider Backend；不得新增旁路调用。
- `AgentSessionRegistry` 是会话安全边界：校验 Provider、已授权工作区、客户端会话 ID、原生会话 ID、Query 代次、请求参数归属和交互响应归属。
- Provider 能力由注册表和运行时 `getCapabilities` 决定。通用代码不要散落大量 `provider === ...` 分支；Provider 差异集中在 Backend、请求适配器和事件适配器。
- 迟到响应和旧 Query 事件不能污染新会话或新 Query。新增异步状态必须定义代次、取消、关闭和异常退出行为。
- 会话关闭要分别处理“停止当前任务”和“释放 Provider 资源”；前一步失败或超时也必须尝试后一步。
- Renderer 恢复只用于软件更新安装前的一次性状态；普通重启不恢复运行中的 Tab、分栏、活动 Query 或排队任务。
- 无法从能力注册表确认的入口必须隐藏或禁用，不得伪造 Provider 能力。

## Electron 与安全边界

- 正式窗口保持 `frame: false`、`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`；Renderer 使用 CSP 和受控 preload。
- 单实例启动支持 `--cwd` 和 `--provider`；第二实例只通过主进程唤醒现有窗口并转发已校验的工作区/Provider。
- 关闭窗口默认隐藏到托盘；真正退出和更新安装必须先有序关闭 Provider、Worker、受管进程和测试网关。
- 外部链接只允许 `http:` 或 `https:`，交给系统浏览器；窗口导航和新窗口必须拦截其他协议。
- 本地路径先规范化/真实路径校验，再检查附件根目录、已授权工作区或显式授权文件；不得仅凭扩展名信任文件。
- 图片输入必须限制大小、拒绝符号链接，并在主进程和 Claude Worker 分别按内容签名校验 PNG/JPEG/GIF/WebP。
- 工作区授权和 Claude 信任必须由主进程确认；Renderer、Provider 返回值或偏好字段不得自行扩大授权范围。撤销信任后后续请求必须立即受阻。
- Claude 凭据按 Query 创建时读取，校验 URL 和凭据冲突；不得把凭据写入普通偏好、日志、源码、构建产物、文档或回复。
- GitHub 更新令牌只使用进程环境变量或 Electron `safeStorage`；日志对凭据、URL 敏感参数和用户长文本做脱敏/摘要。
- 不直接读取、修改、删除或重建 Codex SQLite 数据库；历史通过 Provider API 获取。
- JSON 对象和事件解析应允许未知字段，但必须对类型、大小、操作名和路径做边界校验。

## 偏好、文件和容量

- 偏好写入 Electron `userData/preferences.json`，通过归一化和原子写入保存；新增字段必须同步类型、归一化、IPC 白名单和测试。
- 偏好包含工作区、主题、展示模式、侧栏/字号、老板键、会话元数据、模型缓存、命令使用记录、压缩记录、Claude 信任和一次性更新恢复状态。
- 附件写入 `userData/attachments`；导出、交接文件、日志和更新缓存使用各自受控目录，不把用户内容写入源码或构建目录。
- 现有的事件、消息、活动、子 Agent、Worker/RPC、图片、附件、偏好和日志容量限制是安全不变量。修改限制时必须同时更新实现、测试和受影响的回归脚本，不得用无限增长替代截断/清理。

## Provider 特有规则

- Codex 请求使用 app-server 的方法映射和按方法超时；Renderer 不能覆盖审批、沙箱或其他危险安全参数。
- Codex app-server 只关闭 AgentDesk 自己启动并登记的进程；更新 CLI 前必须处理本地服务重启和外部 app-server 检查。
- Codex CLI 可在启动后按缓存和周期自动检查版本，但安装必须由用户触发；桌面软件和 Claude Code 的检查、下载、安装也必须由用户主动触发。
- Claude Worker 只接受协议中定义的命令和事件；Worker 异常退出必须拒绝挂起请求、清理其 Query 进程树并让 Renderer 只恢复 Claude 会话。
- Claude 插件/市场操作通过受控 Worker CLI 执行，必须校验名称、来源、工作区信任和输出大小；隔离测试不得改写用户真实 Claude 配置。
- Claude 受管更新必须限制下载地址、大小、ZIP 内容、Windows 可执行文件和 Authenticode 签名；未验证签名只能走显式二次确认，不能静默安装。
- Provider 的历史、模型、能力和事件格式只能在对应适配器中转换，通用 UI 使用统一的 `AgentOperation`、`AgentEventEnvelope` 和能力状态。

## 新增或修改功能

- 新增桌面能力时同步更新：`src/shared` 类型、`preload` Bridge、主进程 IPC 注册与校验、请求白名单/超时、服务注入、Renderer 调用和必要测试。
- 新增 Provider 操作时同步更新：共享操作枚举、Backend、能力注册表、请求适配、事件适配、会话登记规则、UI 能力判断和 Provider 测试。
- 修改 Worker、子进程入口、`asar` 或 `asarUnpack` 时检查最终产物中的入口、相对导入和运行时依赖闭包；开发版能加载不能替代打包版检查。
- 新依赖必须说明用途、体积、Electron 兼容性和现有依赖为何不足；没有明确必要性时不引入新的状态管理、路由、UI 组件库或虚拟列表库。

## 原生命令

依赖和命令以 `package.json` 为准。常用入口如下：

- 安装依赖：`npm install`；干净 CI 或全新目录使用 `npm ci`。
- 主进程、preload、Worker、shared：`npm run build:main`；Renderer：`npm run build:renderer`。
- 全部构建、类型检查和测试：`npm run build`；仅测试：`npm test`。
- 局部测试：先 `npm exec -- tsc -p src/tsconfig.test.json`，再执行对应 `build/tests/**/*.test.js`。
- 开发 Electron：`npm run dev`；兼容入口：`npm run start`。不要手工拼接 Vite、Electron 或端口参数。
- Renderer 浏览器预览：`npm run preview`。它只能验证 Mock Renderer，不能证明真实 Provider、IPC 或桌面能力。
- Claude 插件隔离回归：`npm run test:claude-plugin-isolated`；它必须使用临时 Claude 配置并确认真实配置指纹不变。
- 开发版 Electron 回归：`pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/electron-regression.ps1`；按影响范围选择 `-LiveProviders`、`-ClaudeOnly` 或 `-SkipCore`。
- Windows 打包：`npm run package`，固定不发布；打包后运行 `scripts/electron-package-regression.ps1`。
- `release:github` 会发布，除非用户明确要求正式发布，否则不要运行。

## 分级验证

- 只改文档：检查内容、链接和 `git diff`，不运行构建、Electron 回归或打包。
- 纯逻辑或低风险重构：先跑直接相关测试；同一行为链的改动合并验证，失败后先定位根因再重跑。
- Renderer 改动：先 `npm run build:renderer`，再按风险运行 Mock 预览或开发版 Electron 回归；检查加载、空状态、错误、长文本和布局。
- 主进程、preload、shared、Provider、IPC、审批、附件、更新、进程或窗口生命周期改动：跑相关测试和 `npm run build:main`，批次末尾补开发版 Electron 回归。
- Electron 运行时、electron-builder、安装包、Worker 闭包或更新链路改动：批次末尾执行一次 `npm run package` 和打包版回归；不要用开发版回归替代打包版回归。
- 打包版回归必须真实启动 `build/release/win-unpacked/AgentDesk.exe`，通过正式 Bridge 验证隔离的 Claude `listSessions`、`readSession` 和 Codex `listSessions`，并确认 Worker/Provider 没有模块缺失。
- `npm run build` 已包含测试，`npm run package` 已包含完整构建；代码未变化时不要重复执行嵌套入口。
- 回归结束后停止本轮启动的服务、窗口和 Playwright 会话；只结束自己记录的进程树，不按名称批量结束用户进程。

## CI、Git 与发布

- CI 验证和 Release 规则以 `.github/workflows` 为唯一依据；修改工作流时同步检查触发分支、Node/npm、构建入口、产物校验和打包版 Provider 回归。
- 发布前确认当前分支、远程、工作区、版本号、`package-lock.json` 和授权；版本变更必须同步两个包文件。
- 发布应遵守“构建一次、验证同一份产物、发布同一份产物”。安装包、blockmap、`latest.yml` 和 Tag 必须与版本一致。
- Release 或发布步骤失败时停在失败点，不重复创建 Tag、不修改旧 Tag、不强制推送；修复后重新取得发布授权。
