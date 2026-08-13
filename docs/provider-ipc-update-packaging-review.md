# Provider、会话、IPC、更新与打包链路审查

审查日期：2026-08-12

范围：Provider 隔离、会话生命周期、IPC 安全、桌面端/CLI 更新、Windows 打包与发布。以下只列有明确代码路径和实际影响的问题。

## 结论

共发现 9 个问题：5 个高风险、3 个中风险、1 个低风险。最严重的是 Codex 请求和审批没有主进程归属校验、Claude 信任可由 Renderer 自行授予，以及桌面更新未启用发布者签名校验。

## 发现

### 1. [高] Codex IPC 没有会话、工作区和 Query 归属校验

- `validateAgentRequest` 只校验 Provider/操作白名单和字段类型、长度，`sessionId`、`canonicalCwd`、`nativeSessionId`、`queryGeneration` 都由 Renderer 自报，没有与主进程登记状态比对：`src/main/ipc/registerDesktopIpc.ts:127-142`。
- Codex 适配器不改写任何参数，主进程随后直接调用 Backend：`src/main/agent/requestAdapterRegistry.ts:10-16`、`src/main/main.ts:635-641`。
- Codex Backend 将参数原样发给 app-server；测试还明确允许任意 `cwd`、`approvalPolicy: never` 和 `dangerFullAccess`：`src/main/providers/codex/CodexBackend.ts:57-66`、`src/main/providers/codex/CodexBackend.test.ts:25-35`。

因此，Renderer 一旦被利用，可绕过 UI Tab/工作区边界，向任意线程或目录发请求，并关闭审批和沙箱。

### 2. [高] Codex 审批响应没有校验所属会话和 Query 代次

- IPC 仅检查 Provider 存在且 `result` 是对象：`src/main/ipc/registerDesktopIpc.ts:145-152`。
- Codex Backend 只检查 Provider 和 `requestId`，随后直接向 app-server 写 JSON-RPC 响应：`src/main/providers/codex/CodexBackend.ts:74-76`、`src/main/providers/codex/codexAppServer.ts:99-103`。
- 现有测试传入虚构的 `sessionId`、`queryGeneration` 和 `interactionId` 仍成功：`src/main/providers/codex/CodexBackend.test.ts:47-60`。Claude 对照实现会校验会话、代次、活动状态、交互 ID、请求 ID 和工具 ID：`src/main/providers/claude/ClaudeBackend.ts:159-180`。

因此，伪造、跨 Tab 或迟到的审批响应可批准错误的命令、文件修改或权限请求。

### 3. [高] Claude 工作区信任由 Renderer 自行授予，主进程没有可信确认

- 用户确认发生在 Renderer，确认后只是重发 `trustWorkspace: true`：`src/renderer/App.tsx:294-315`。
- IPC 对 `params` 只要求为普通对象，不剥离该字段：`src/main/ipc/registerDesktopIpc.ts:127-142`。
- Claude Backend 收到该布尔值后直接把目录加入信任集合，`startSession`、`resumeSession` 和插件操作均如此：`src/main/providers/claude/ClaudeBackend.ts:230-240`、`src/main/providers/claude/ClaudeBackend.ts:302-313`、`src/main/providers/claude/ClaudeBackend.ts:487-517`。

因此，受控 Renderer 无需用户确认即可永久信任任意存在目录，随后加载该目录的 Hooks、MCP、项目设置或执行插件操作。

### 4. [高] 本地文件授权可通过偏好 IPC 持久化伪造

- Renderer 可直接写 `lastWorkspace` 和 `favoriteWorkspaces`，IPC 只做字符串/数量过滤：`src/main/ipc/registerDesktopIpc.ts:101-109`、`src/main/ipc/registerDesktopIpc.ts:194-198`。
- 重启后主进程把这些偏好目录加入授权集合：`src/main/main.ts:514-524`。
- `readLocalImage` 允许读取任何已授权工作区内、扩展名匹配且不超过 10 MB 的文件，并以 data URL 返回 Renderer：`src/main/main.ts:159-163`、`src/main/main.ts:273-284`、`src/main/main.ts:566-575`。

因此，受控 Renderer 可先把任意现有目录写入偏好，诱导重启后读取其中图片内容，绕过“用户选择或 Provider 返回后才授权路径”的边界。

### 5. [高] 桌面更新缺失发布者签名校验，CI 也不验证 Authenticode

- Windows/NSIS 构建没有证书或 `publisherName` 配置：`package.json:54-97`。
- Release CI 只检查文件存在、版本一致和 Provider 冒烟，然后上传资产，没有签名或发布者检查：`.github/workflows/release.yml:22-62`。
- 桌面端直接使用 `electron-updater` 下载并安装：`src/main/desktopUpdateManager.ts:103-141`。锁定版本为 6.8.9：`package-lock.json:3572-3573`。
- 该版本在 `publisherName` 缺失时直接返回成功、跳过 Authenticode 校验：`node_modules/electron-updater/out/NsisUpdater.js:84-99`。

虽然更新元数据的 SHA-512 能发现传输损坏，但资产和元数据若一起被错误发布或仓库发布权限被滥用，客户端没有独立的发布者身份校验，仍会安装该 EXE。

### 6. [中] 退出和 Codex CLI 更新会终止整机所有匹配的 Codex app-server

- 进程筛选只看命令行是否像 Codex `app-server`，没有父进程、启动令牌或 AgentDesk 所有权校验：`src/main/codexCliUpdateManager.ts:55-79`。
- `stopAllAppServers` 扫描整机并逐个 `taskkill` 所有匹配根进程：`src/main/codexCliUpdateManager.ts:467-476`。
- 该操作既用于 CLI 更新，也用于普通退出：`src/main/codexCliUpdateManager.ts:195-202`、`src/main/main.ts:166-175`。

因此，退出 AgentDesk 或更新 Codex CLI 会中断 VS Code、终端中的 Codex、其他用户数据目录实例等不属于本实例的任务。

### 7. [中] 撤销 Claude 工作区信任不会停止现有会话，且后续仍可继续执行

- 撤销 IPC 只删除信任集合并保存偏好：`src/main/main.ts:623-632`、`src/main/providers/claude/claudeWorkspaceTrust.ts:23-25`。
- 活动会话仍留在 `ClaudeBackend.sessions`；后续 `startTurn` 只要求会话存在，不重新检查 `isTrustedWorkspace`：`src/main/providers/claude/ClaudeBackend.ts:365-416`、`src/main/providers/claude/ClaudeBackend.ts:830-833`。

因此，用户点击撤销后，已打开会话仍能继续使用该目录的 Hooks、MCP、工具和子进程，直到显式关闭会话或 Worker。

### 8. [中] Claude 可用同一 clientSessionId 覆盖活动会话，造成旧 Query 失去归属

- `startSession` 不检查同 ID 会话是否已存在，直接 `sessions.set`：`src/main/providers/claude/ClaudeBackend.ts:230-256`。
- `resumeSession` 若命中已有会话，会直接改写其原生会话 ID、目录和模式，也不检查或关闭活动 Query：`src/main/providers/claude/ClaudeBackend.ts:302-334`。
- Worker 同时仍按 `clientSessionId` 保存旧 Query，并拒绝重复启动：`src/main/providers/claude/claudeWorker.mts:467-468`。
- 主进程之后按已被改写的代次关闭；Worker 遇到代次不匹配会直接返回而不清理：`src/main/providers/claude/ClaudeBackend.ts:196-207`、`src/main/providers/claude/claudeWorker.mts:782-794`。

因此，重复或竞态的 start/resume 可让主进程失去旧 Query 归属，后续关闭无法保证清理旧 Query 及其进程树。

### 9. [低] Claude Worker 正常关闭超时会被强杀，可能遗留子进程树

- Worker 收到关闭后要逐个关闭 Query；单个进程树清理本身可等待约 5.75 秒：`src/main/providers/claude/claudeWorker.mts:849-852`、`src/main/providers/claude/claudeProcessTree.ts:34-49`。
- Host 只等 3 秒就调用 `worker.terminate()`，随后忘记 Worker：`src/main/providers/claude/ClaudeWorkerHost.ts:92-104`。
- 子进程 PID/代次映射只保存在 Worker 内：`src/main/providers/claude/claudeProcessTree.ts:56-94`。

因此，Claude 进程树在 3 秒内未退出时，Host 会先强杀唯一掌握 PID 的 Worker；主进程此后没有兜底清理路径，可能遗留 `claude.exe` 或其后代进程。

## 审查说明

- 本次为静态只读审查，未运行构建、测试或打包。
- 除新增本报告外，未修改源码；工作区原有改动保持不变。
