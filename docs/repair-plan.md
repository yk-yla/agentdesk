# AgentDesk 维修执行文档

更新时间：2026-08-13
执行分支：`develop`
当前版本：`1.0.7`
状态：维修完成；批次 A、B、C、D、E 及对应验证均已完成

## 1. 执行原则

本轮代码修改严格按本文档执行。上下文压缩或任务恢复后，先重新读取本文档和 `git status --short`，再继续未完成批次。

- 保留用户和其他 AI 已有改动，不回滚、不覆盖、不顺手清理。
- 按批次修改、测试和记录；前一批通过最小验证后再进入下一批。
- 新发现的问题先补入本文档，说明证据、优先级和验收标准，再决定是否纳入本轮。
- 不提交、不推送、不升版本、不创建 Tag/Release，除非用户另行明确授权。
- 不使用 mini-ide；使用项目规定的原生命令。
- 不引入新依赖。若修复被迫需要新依赖，先暂停并说明原因。
- 同一问题连续失败两次，停止继续打补丁，重新分析设计。

## 2. 当前工作区基线

开始维修前已有以下未提交改动，均视为需要保留的工作：

- 消息布局：`src/renderer/MessageStack.tsx`、`messageTimestamp.ts`、`messageTimestamp.test.ts`、`styles.css`。
- 已删除的两份过期 Codex 调查文档：`docs/codex-tool-anomaly-timeline.md`、`docs/codex-tool-availability-investigation.md`。
- 被误删、需要恢复的 Claude 插件隔离回归：`scripts/claude-plugin-isolated-smoke.js`。
- 三份只读审查报告：`docs/maintainability-review.md`、`docs/provider-ipc-update-packaging-review.md`、`docs/uncommitted-changes-review.md`。

消息布局的产品目标已经确认：气泡内只显示消息正文；时间常显在气泡上方；复制按钮为纯图标，悬停或键盘聚焦时显示，并与气泡最右边对齐。

三份审查报告属于本轮输入材料。维修完成并确认问题已迁移到测试或代码后，是否删除这些过程报告需再次取得用户授权，不能在维修中自行删除。

## 3. 本轮范围与顺序

### 批次 A：恢复回归覆盖并完成消息布局

状态：已完成（2026-08-12；`npm run build:renderer`、时间单测、`npm run test:claude-plugin-isolated`、Electron 核心回归通过）

#### A1. 恢复 Claude 插件隔离回归

目标文件：

- `scripts/claude-plugin-isolated-smoke.js`
- `package.json` 或现有回归入口脚本

执行要求：

- 从当前 `HEAD` 恢复脚本内容，保留真实 Worker、隔离配置、安装、重启持久化、详情、更新、卸载、移除市场和真实用户配置不被污染的覆盖。
- 给脚本增加明确、可发现的 npm 或回归入口，不能只恢复为无人调用的孤立脚本。
- 不接触用户真实 Claude 配置；临时目录必须在 `finally` 中清理。

验收：编译主进程后，专项脚本成功；用户真实 Claude 配置前后指纹一致。

#### A2. 消除空时间栏并更新 Electron 回归

目标文件：

- `src/renderer/MessageStack.tsx`
- `src/renderer/styles.css`
- `src/renderer/messageTimestamp.ts`
- `src/renderer/messageTimestamp.test.ts`
- `scripts/electron-core-smoke.js`

执行要求：

- 只有存在可显示时间的普通消息才渲染时间区域；系统消息或无有效时间戳消息不能保留约 26px 空白。
- 时间格式固定为 `HH:mm:ss`，气泡正文中不出现时间和复制控件。
- 复制按钮只显示图标；默认隐藏；鼠标悬停或键盘聚焦时可见；可访问名称和提示保留。
- 复制内容必须是消息正文，成功后短暂切换为已复制图标状态。
- 更新 Electron 旧断言：不再断言完整日期时间，也不再断言整个时间栏默认隐藏。
- 回归覆盖短消息、长消息、窄窗口、用户/助手消息、系统/缺时间消息、复制和右边缘对齐。

验收：`npm run build:renderer` 通过；相关时间单测通过；Electron 核心回归通过。

### 批次 B：主进程 Provider 与 IPC 安全边界

状态：已完成（2026-08-13；相关单测、`npm run build:main`、`npm run build:renderer`、Electron 核心回归通过）

这是本轮最高风险批次。安全状态必须由主进程维护，不能把 Renderer 自报字段当授权事实。

#### B1. 建立统一的主进程会话登记

目标区域：

- `src/main/agent`
- `src/main/ipc/registerDesktopIpc.ts`
- `src/main/providers/codex`
- `src/main/providers/claude/ClaudeBackend.ts`
- 对应测试

登记至少包含：Provider、`clientSessionId`、规范化工作区、原生会话 ID、当前 Query 代次和活动状态。规则如下：

- `startSession` 只能创建不存在的客户端会话；重复 ID 必须拒绝，不能覆盖活动会话。
- `resumeSession` 只能登记空闲或不存在的客户端会话；不能在活动 Query 上改写原生会话和目录。
- 会话内操作必须匹配已登记的 Provider、工作区和原生会话 ID。
- Query 操作必须匹配主进程记录的当前代次；迟到请求或响应必须拒绝。
- `closeSession`、Provider 退出和 Query 结束要清理或更新登记，不能留下可复用的陈旧授权。
- 历史列表、模型列表等无会话操作使用明确白名单，不伪造会话上下文。

不采用“只加强字段类型检查”的假修复；必须有跨请求的主进程状态比对。

#### B2. 修复 Codex 请求参数边界

执行要求：

- `canonicalCwd`、`nativeSessionId`、`queryGeneration` 与请求参数中的 `cwd`、`threadId` 必须和主进程登记一致。
- Renderer 不能借请求切换到任意目录或任意线程。
- 对 `approvalPolicy`、沙箱/危险访问等高风险覆盖使用操作级白名单和主进程策略；不能允许 Renderer 任意关闭审批或沙箱。
- 保持 Codex 与 Claude 的 Backend 隔离，不把 Provider 特例散落进 Renderer 组件。

验收测试至少覆盖：跨会话、跨目录、跨线程、旧 Query 代次、危险参数覆盖均被拒绝；合法请求仍成功。

#### B3. 修复 Codex 审批归属

执行要求：

- 主进程收到 Codex 审批、用户输入或 MCP elicitation 请求时，登记待处理交互。
- 登记至少绑定 Provider、会话、原生线程、Query 代次、`interactionId` 和 JSON-RPC `requestId`。
- 响应时必须完整匹配且状态为 pending；只允许响应一次。
- Query 结束、会话关闭、超时或 app-server 退出时使待处理交互失效。
- Renderer 自报的 `requestId` 不能单独构成授权。

验收测试至少覆盖：伪造、跨 Tab、旧代次、重复响应、过期响应均被拒绝；合法交互只转发一次。

#### B4. 把 Claude 信任确认移到可信 IPC

目标区域：shared 类型、preload、主进程 IPC、`App.tsx`、`ClaudeBackend.ts` 及测试。

执行要求：

- 删除通用 Agent 请求中的 `trustWorkspace: true` 授权能力，Backend 不再因 Renderer 参数直接写入信任集合。
- 增加专用“确认并信任工作区”IPC。主进程规范化路径、确认目录存在并登记信任；Renderer 只在用户确认后调用该 IPC，再重试原请求。
- 信任确认必须由主进程显示原生确认框并根据其结果登记；Renderer 的 `window.confirm` 只可用于界面提示，不能构成授权依据。
- 插件管理使用同一可信授权机制，不保留第二套可绕过路径。
- 主进程收到普通 Agent 请求时剥离或拒绝 `trustWorkspace` 字段。
- 信任状态继续持久化到现有偏好，但只由主进程信任服务写入。

验收测试至少覆盖：直接伪造 `trustWorkspace` 无效；专用 IPC 后合法启动/恢复/插件操作成功；路径不一致和不存在目录被拒绝。

#### B5. 修复偏好造成的本地文件授权扩大

执行要求：

- `lastWorkspace`、`recentWorkspaces`、`favoriteWorkspaces` 仍可保存 UI 偏好，但不能因此自动成为本地文件读取授权。
- 启动时只授权明确启动目录，以及本次运行由目录选择器或可信 Provider 结果登记的目录。
- 收藏目录不等于文件访问授权；需要访问时必须经过已有可信选择/Provider 路径。
- 保持 `readLocalImage` 的真实路径、根目录、类型和大小校验。

验收测试至少覆盖：伪造偏好并重启后不能读取任意目录图片；目录选择器授权的工作区仍可正常读取。

#### B6. 撤销 Claude 信任立即生效

执行要求：

- 撤销信任时关闭该工作区所有活动 Claude Query/会话，清理待处理交互，然后持久化新的信任集合。
- `startTurn` 及其他会执行项目代码的操作每次都重新检查当前工作区信任。
- 撤销完成后，旧 Tab 继续发消息必须得到明确的重新授权提示，不能继续执行。

验收测试覆盖撤销前活动 Query、撤销后的 `startTurn`、重新确认后的恢复。

#### B7. Provider 初始化故障隔离

目标文件：`src/renderer/App.tsx`，必要时抽出一个小型、可测试的启动协调器。

执行要求：

- Codex 模型、Codex 能力、Claude 能力分别结算失败。
- Claude 初始化失败不改变 Codex `serverState`，也不污染 Codex 会话。
- Codex 初始化失败只影响 Codex 启动状态和 Codex 会话。
- 错误文案准确标明 Provider，不再统一显示“Codex 模型列表加载失败”。

验收测试覆盖两个 Provider 分别失败和成功的组合。

批次 B 验收：相关单测、`npm run build:main`、`npm run build:renderer`、Electron 核心回归全部通过。

#### B8. 明确授权目录不能被 Provider 历史挤出

Electron 回归发现：Provider 历史返回大量不同目录时，单一 LRU 授权集合可能把启动目录或目录选择器明确授权的当前目录挤出，导致后续新会话被主进程错误拒绝。

执行要求：授权登记区分明确授权和 Provider 发现；容量满时优先淘汰 Provider 发现项，不能让历史列表挤掉明确授权目录；总容量限制保持 64。

验收：单测覆盖大量 Provider 发现目录不挤掉明确授权目录，且总容量不突破限制；Electron 核心回归通过。

### 批次 C：进程生命周期

状态：已完成（2026-08-13；Codex 更新、Claude Worker Host、进程树专项测试、`npm run build:main`、Electron 核心回归通过）

#### C1. 只关闭 AgentDesk 拥有的 Codex app-server

目标文件：

- `src/main/main.ts`
- `src/main/codexCliUpdateManager.ts`
- `src/main/providers/codex/codexAppServer.ts`
- 对应测试

执行要求：

- 普通退出只关闭当前 `CodexAppServer` 和 `ProcessSupervisor` 明确跟踪的进程，不再扫描并终止整机所有 Codex app-server。
- CLI 更新只处理 AgentDesk 自己启动的 app-server。若外部 Codex 进程会锁定更新目标，检测后给出明确错误，不擅自结束外部进程。
- 删除或收窄 `stopAllAppServers` 的全机扫描语义，测试明确证明无关 Codex 进程不被选择。

#### C2. 给 Claude Worker 足够的受控清理时间

目标文件：

- `src/main/providers/claude/ClaudeWorkerHost.ts`
- `src/main/providers/claude/claudeProcessTree.ts`
- 对应测试

执行要求：

- Host 等待时间必须覆盖 Worker 内部进程树清理的最坏路径并留有余量，不能 3 秒后先杀掉唯一掌握 PID 的 Worker。
- Worker 必须回报清理完成或失败；失败时记录明确错误，再执行有限的兜底终止。
- 不按名称批量结束系统中的 `claude.exe`，只处理本 Worker 跟踪的进程树。

批次 C 验收：相关进程测试、`npm run build:main`、Electron 核心回归通过，并确认 3000、9223、9224 无本轮残留。

### 批次 D：低风险清理

状态：已完成（2026-08-13；静态引用复查、测试 TypeScript 编译、`npm run build:renderer`、Electron 核心回归通过）

#### D1. 删除确定无用的 TypeScript

仅处理已确认的四处：

- `src/renderer/App.tsx` 未使用的 `AgentBridge` 类型导入。
- `src/renderer/App.tsx` 未调用的 `subagentThreadSource`。
- `src/renderer/providers/claude/claudeEventAdapter.ts` 未使用的 `subtype`。
- `src/renderer/providers/codex/codexEventAdapter.ts` 未使用的 `CollaborationMode` 类型。

#### D2. 清理确定重复或无引用 CSS

候选项：重复 `.spin` / `@keyframes spin`，以及 `.muted-icon`、`.history-limit-note`、`.without-context`、`.approval-*`、`.goal-form-row`、`.mode-switch`。

删除前必须再次执行全项目静态引用检查，并检查动态拼接类名；证据不充分的选择器保留。CSS 清理不能顺带格式化整个 `styles.css`。

批次 D 验收：未使用代码专项 TypeScript 检查、`npm run build:renderer`、Electron 核心回归通过。

## 4. 本轮明确不做

以下事项有价值，但会显著扩大范围或缺少外部条件，本轮不与安全维修混做：

- 不整体拆分约 2,000 行的 `App.tsx`。
- 不整体拆分或格式化约 70 KB 的 `styles.css`。
- 不重构渲染阶段同步 Ref；目前只有理论风险，没有已复现故障。后续应单独设计和回归。
- 不合并历史恢复、菜单、重命名弹窗等重复流程，除非某项是上述安全修复的最小必要改动。
- 不开启全项目 `noUnusedLocals` / `noUnusedParameters`，避免一次引入无关改动；本轮只清理已确认四处。
- 不在没有正式代码签名证书、私钥管理和 CI Secret 方案的情况下伪造 Authenticode 方案。
- 不修改版本号，不发布。

### 批次 E：状态一致性专项修复

状态：已完成（2026-08-13；71 项定向测试、247 项完整测试、`npm run build:main`、`npm run build:renderer`、Electron 核心回归通过）

#### E1. 更新恢复保留 Provider 并隔离恢复门禁

- 更新恢复数据必须保存并校验每个 Tab 的 `provider`；旧数据缺少该字段时仅为兼容旧版默认 Codex。
- Codex 和 Claude 会话分别等待自己的初始化结果，Codex 初始化失败不能阻塞 Claude 恢复。
- 测试覆盖 Claude Tab 往返恢复，以及 Codex 失败时 Claude 仍进入恢复流程。

#### E2. 持久化 Claude 压缩累计值

- 将现有 Codex 专用压缩缓存扩展为 Provider 维度的通用缓存，旧 `codexCompactionCounts` 数据继续兼容。
- Claude 实时压缩边界需要稳定事件 ID 并去重；历史恢复取“历史可见值、当前实时值、本地累计值”的最大值。
- 删除会话时同步删除对应 Provider 的压缩缓存。

#### E3. 布局 Provider 继承与超时状态收敛

- 拆分 Claude Tab 时新增分栏继承 Claude Provider；关闭最后一个 Claude Tab 后的替代空 Tab 也继承 Claude Provider。
- Codex 超时后若后台 Turn 最终成功或中断，清理临时超时提示；真实失败仍显示失败信息。

批次 E 验收：相关单测通过；`npm run build:renderer` 通过；由于同时修改 shared 和偏好归一化，再执行 `npm run build:main`。若相关单测或构建表明桌面行为受影响，再补 Electron 核心回归。

批次 E 验证结果：71 项定向测试全部通过；完整测试 247 项中 246 项通过，1 项因当前 Windows 用户没有创建符号链接权限而跳过；主进程与 Renderer 构建通过；Electron 核心回归通过；`git diff --check` 通过；端口 3000、9223、9224 无本轮残留。

## 5. 外部阻塞项：Windows 代码签名

审查确认当前安装包没有 `publisherName`，Release CI 也不验证 Authenticode。完整修复需要正式 Windows 代码签名证书及私钥/云签名服务配置，不能仅靠代码完成。

取得证书方案后另开批次，至少完成：

- electron-builder Windows 签名和 `publisherName` 配置。
- CI 安全使用证书，不把密钥写入仓库、日志或构建产物。
- 发布前验证安装包 Authenticode 状态和发布者名称。
- 客户端更新验证发布者身份；签名失败禁止发布。

本轮只能保留风险说明，不能报告该问题已修复。

## 6. 最终验证门禁

所有代码批次完成后，只运行一次满足当前最高要求的最终链路，避免重复构建：

1. `npm run package`：包含主进程、Worker、Renderer、全部测试和本地打包。
2. `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/electron-regression.ps1`：真实开发版核心回归。
3. `pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/electron-package-regression.ps1`：启动同一份 `win-unpacked`，验证正式 Bridge 下 Claude `listSessions`、Claude `readSession`、Codex `listSessions`。
4. Claude 插件隔离专项入口：验证真实 Worker 插件闭环和用户配置不被污染。
5. 检查打包后的 Claude Worker 入口及相对导入均存在，未跨 `app.asar` / `app.asar.unpacked` 引用缺失文件。
6. 检查 `git diff --check`、`git status --short` 和最终 diff，只包含本文档范围内改动。
7. 停止本轮开发服务、测试窗口和 Playwright 会话，确认端口 3000、9223、9224 无本轮残留。

不运行真实 Provider 回归，除非修复或失败证据表明必须调用真实账号能力；如需运行，执行前说明原因，且不得输出凭据或用户内容。

最终验证结果（2026-08-13）：

- `npm run package` 通过；235 项测试中 234 项通过，1 项因当前 Windows 用户没有创建符号链接权限而跳过。
- Electron 开发版核心回归通过。
- 同一份 `win-unpacked` 打包版回归通过，正式 Bridge 下 Claude `listSessions`、Claude `readSession`、Codex `listSessions` 均成功。
- Claude 插件隔离专项通过，用户真实 Claude 配置前后指纹一致。
- 打包版 Claude Worker 的 6 个相对运行时导入均存在于 `app.asar.unpacked`，未发现跨包缺失。
- `git diff --check` 通过；端口 3000、9223、9224 及本轮 Electron、Playwright 进程无残留。
- `AgentDesk-Setup-1.0.7.exe`、blockmap、`latest.yml` 和 `win-unpacked` 已生成，仅用于本地验证，未发布。
- Windows 代码签名仍未解决：安装包和 `AgentDesk.exe` 的 Authenticode 状态均为 `NotSigned`。

## 7. 完成判定与记录方式

每完成一个批次，在本文档对应标题后追加一行：`状态：已完成（日期，验证命令）`。失败则记录失败原因和下一次采用的新方向，不能只写“未通过”。

只有同时满足以下条件，才能向用户报告本轮维修完成：

- A、B、C、D 四批全部达到各自验收标准。
- 最终验证门禁通过。
- 未擅自处理“本轮明确不做”和代码签名阻塞项。
- 工作区中的既有消息布局和文档删除改动得到保留。
- 清楚列出仍未解决的代码签名风险和任何测试环境限制。
