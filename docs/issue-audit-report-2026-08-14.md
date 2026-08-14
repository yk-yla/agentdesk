# AgentDesk 问题排查报告

审查日期：2026-08-14
执行分支：`develop`（含当前未提交改动）
审查方式：4 个并行子代理分区域只读审查（主进程/安全、渲染器状态与会话、UI 与渲染性能、Provider 与协议适配）+ 主代理交叉验证关键路径
审查范围：`src/main`、`src/renderer`、`src/preload`、`src/shared`、`scripts` 中的回归脚本与测试基础设施

**结论摘要**：共发现 **高 7 项、中 12 项、低 20+ 项**。全部为只读审查，未修改任何文件。另有若干"看似问题、实际正确"的项已甄别排除，避免误修。

---

## 一、高优先级问题（建议优先处理）

### H1. 启动恢复无兜底：取消授权弹窗导致空窗口 + unhandled rejection

- **文件**：`src/renderer/App.tsx:1617-1661`
- **描述**：软件更新安装重启后，若 `workspaceState` 存在恢复数据，启动流程会对每个恢复会话的工作区调用 `bridge.registerWorkspace(cwd)`；用户取消授权弹窗（返回 null）时第 1660 行 `throw new Error("工作区未获授权")`，该异常发生在 `setSessions(restoredSessions)`（1667 行）之前，且外层 `.then()` 链（1619 行）没有 `.catch()`。
- **影响**：unhandled promise rejection；`sessions` 保持初始 `{}`（App.tsx:168），整个恢复中断——连已授权工作区的会话也不恢复；界面出现无分栏、无会话、无错误提示的空窗口，只能重启应用。
- **修复建议**：给 `.then` 链补 `.catch`，把失败工作区的会话标记 error 并展示提示，不中断整体恢复；或把授权失败改为仅跳过对应会话。

### H2. 渲染器可被 Ctrl+R 刷新（打包版默认菜单未禁用）

- **文件**：`src/main/windowLifecycle.ts:121-172`、`src/main/agent/agentSessionRegistry.ts:112-119`
- **描述**：应用未设置自定义应用菜单，也未禁用默认菜单。Electron 默认菜单包含 View > Reload（Ctrl+R / F5）和 Toggle Developer Tools（Ctrl+Shift+I）；`autoHideMenuBar` 只是隐藏菜单栏。`before-input-event` 只拦截了 Ctrl+W。
- **影响**：打包版用户误按 Ctrl+R 后渲染器整体刷新：UI 状态（活动 Query、草稿、Tab 布局）全部丢失；主进程 `AgentSessionRegistry` 中的会话登记残留，渲染器重建后新会话 `startSession` 报"客户端会话已登记，不能重复启动"；运行中的 Provider Query 变成孤儿进程（资源泄漏，直到应用退出）。
- **修复建议**：在 `before-input-event` 拦截 F5/Ctrl+R（与 Ctrl+W 同处），或 `Menu.setApplicationMenu(null)`；渲染器刷新/重建时提供清理主进程会话登记的 IPC 路径。

### H3. ThreadStartCoordinator 超时后 Promise 永悬挂，会话假死

- **文件**：`src/renderer/threadStartCoordinator.ts:38-45`
- **描述**：`start()` 请求超时分支只调用 `onTimeout()` 后 `return`，既不 resolve/reject，也不删除 `attempts` 中的登记。该 session 的 attempt 永久留在 Map 中，Promise 永不落定。
- **影响**：后续对该会话的 `ensureThread` 命中同一永悬挂 Promise（17-18 行），`runMessage` 的 `await ensureThread` 永远挂起；会话永久停在"正在提交 / 创建超时，等待后台确认"。只有 `client/late-response` 触发 `resolveLate` 或关闭会话触发 `reject` 才能解冻。
- **修复建议**：超时后保留"后台等待中"状态，但对 `resolveLate` 设置更长上限，超限则 reject（提示用户重新创建），避免无限等待。

### H4. 渲染进程崩溃只记日志，无自动恢复

- **文件**：`src/main/main.ts:763-765`
- **描述**：`render-process-gone` 事件只写一条日志，不 reload 也不提示。
- **影响**：渲染器崩溃后窗口白屏，用户只能手动重启应用；会话状态停留在崩溃前。
- **修复建议**：监听 `render-process-gone`，对非退出场景自动 `webContents.reload()`（配合 H2 的清理路径），或弹出可恢复的错误页。

### H5. Codex 事件缺代次防护（与 Claude 不对称）

- **文件**：`src/renderer/providerEventController.ts:281-282`、`:152-177`、`src/renderer/providers/codex/codexEventAdapter.ts`
- **描述**：Claude 在 `claudeEventAdapter.ts:264-266` 内部对 `incomingGeneration < source.queryGeneration` 做了拦截；Codex 的 `applyServerMessage` 没有任何代次判断，路由层只在 `generation >= applied.queryGeneration` 时上调代次，从不丢弃迟到事件。批处理事件（如 `item/agentMessage/delta`）入队等待 rAF `flush` 期间，若有非批处理的 `turn/started`（新代次）到达会立即 flush，把积压的旧代次 delta 一并应用。
- **影响**：`/compact`、interrupt 后紧接发送、快速切换代次时，旧流式片段可能污染新回合的消息流；行为与 Claude 不对称。
- **修复建议**：在 `applyAgentEvent`/`applyCodexEvent` 顶层补与 Claude 相同的代次防护，或在 `flush` 应用前对每个事件再次执行 `isStale`。

### H6. Codex 请求超时不发取消，可能双执行

- **文件**：`src/main/providers/codex/codexAppServer.ts:170-175`、`src/main/rpcRequestRegistry.ts:31-45`、`src/main/agent/agentSessionRegistry.ts:197-203`
- **描述**：请求超时后只 reject Promise（挂起登记移入 timedOut），不向 app-server 发送取消/中断；`backgroundMayContinue: true` 标记使会话登记不释放。`startTurn`/`turn/start` 超时后服务器仍可能在后台执行并产出副作用（写文件、执行命令），而 UI 已把请求标为失败/超时。
- **影响**：命中 60s/120s 超时的长 turn、compact 或网络卡顿，可能形成后台仍在跑但前台已放弃的双执行竞态；用户重试会造成重复副作用。
- **修复建议**：超时后按方法主动发送 `turn/interrupt` 等取消；无法取消时至少在 UI 明确"后台仍在执行"并禁用重复提交；不要把 `backgroundMayContinue` 当作默认安全态。

### H7. 主进程 `atomicFile` 用 `Atomics.wait` 同步阻塞事件循环

- **文件**：`src/main/atomicFile.ts:22-25`
- **描述**：`waitForRenameRetry` 用 `Atomics.wait(signal, 0, 0, delayMs)` 在同步 `writeTextFileAtomic` 内重试临时文件 rename。`Atomics.wait` 在主线程（Electron 主进程）真实阻塞事件循环；每次失败最多重试 12 次、单次最长 200ms（指数退避，累计最坏约 1.7s）。
- **影响**：Windows 上 rename 遇 EPERM/EACCES/EBUSY（杀毒软件扫描、文件占用）时，偏好、授权、日志、交接文件的所有写入路径都会让 UI 冻结。
- **修复建议**：rename 重试改为异步（`fs.promises.rename` + `setTimeout`），避免 `Atomics.wait` 阻塞主线程。

---

## 二、中优先级问题

### M1. 提交追加（steer）超时后消息滞留

- **文件**：`src/renderer/sessionMessageController.ts:233-237`
- **描述**：`steerTurn` 超时（`isCodexRequestTimeout`）时 `setError` 后直接 `return`，未从 `pendingSteers` 删除该 steer 也未转队列/草稿。该消息一直显示为"待追加"却永不真正发送，直到 `turnCompleted` 才统一回收。
- **影响**：用户点击追加后看到"请求超时"，消息处于不确定态；回合较长时 steers 累积。
- **修复建议**：超时分支把 steer 移回排队或草稿并移除 pending（与 `isMissingActiveTurn` 分支一致）。

### M2. 工作区授权并发丢更新（读-改-写非原子）

- **文件**：`src/main/workspaceGrantStore.ts:38-44`（未提交新文件）
- **描述**：`grant()` 的 `read()` + `writeTextFileAtomic` 之间无互斥。调用方 `grantAuthorizedWorkspacePath`（main.ts:145-151）会在多条异步路径触发：授权弹窗队列、第二实例 `--cwd`、`choose-workspace` 对话框。弹窗队列只串行化弹窗本身，第二实例授权与 choose 对话框可与队列中的 pending 弹窗并发。
- **影响**：并发授权时 `workspace-grants.json` 丢失其中一条授权记录；重启后该工作区需重新授权。非越权，属持久化状态丢失。
- **修复建议**：store 内部对 read-modify-write 加互斥（SingleFlight/锁）。

### M3. 交接包在主进程同步跑 6 次 git，UI 冻结

- **文件**：`src/main/main.ts:436-459`
- **描述**：`collectHandoffGitState` 用 `spawnSync` 同步执行 `git rev-parse`、`branch`、`status --short --branch`、`diff --stat`、`diff --cached --stat`、`log`，单次超时 5 秒（`runLocalCommand` 424 行）。
- **影响**：大型 Git 仓库或慢文件系统下，主进程事件循环被阻塞最长约 30 秒，UI 完全无响应。
- **修复建议**：改为异步 `spawn`/`execFile`，或限制命令数量与总超时。

### M4. 图片复制同步编码大图，渲染线程卡顿

- **文件**：`src/renderer/ImageLightbox.tsx:12-24, 36-47`（未提交新文件）
- **描述**：非 `data:image/png|jpeg` 源（WebP/GIF）在渲染线程同步执行 `canvas.drawImage` + `toDataURL("image/png")`，按完整自然分辨率编码，无降采样；无"复制中"状态、按钮可重复点击。
- **影响**：大图（4K 截图等）复制时 UI 阻塞数百毫秒以上。
- **修复建议**：编码移入主进程/Worker 或 `OffscreenCanvas`；超大图先降采样（长边 ≤4096）；编码期间禁用按钮并提示。

### M5. 退出失败无用户提示，快捷键不回滚

- **文件**：`src/main/windowLifecycle.ts:287-300`
- **描述**：`handleBeforeQuit` 先 `dispose()`（`unregisterAll` 注销全部全局快捷键），`closeBackends` 失败时只向（可能已隐藏的）窗口 publish `client/error`，随后 `quitting=false` 但不恢复快捷键。
- **影响**：用户从托盘点"退出"后应用不退也无可见反馈；老板键失效直到下次重新注册。
- **修复建议**：失败时恢复快捷键并弹出可见错误提示（窗口 show + 通知）。

### M6. 工作区授权弹窗无父窗口

- **文件**：`src/main/main.ts:258-268`
- **描述**：`dialog.showMessageBox` 未传 `parent`/`window`，与主窗口无绑定。
- **影响**：弹窗可能落在主窗口后方，用户无感知地悬置会话创建。
- **修复建议**：传入主窗口引用。

### M7. `item/commandExecution/outputDelta` 在父活动未建立时静默丢弃

- **文件**：`src/renderer/providers/codex/codexEventAdapter.ts:689-698`
- **描述**：该分支先检查 `session.activities.some(id === itemId)` 命中才追加，未命中时无 else 直接丢失；姊妹分支 `item/fileChange/outputDelta`、`item/mcpToolCall/progress`、`item/reasoning/summaryTextDelta`（699-716 行）未命中时会自动创建活动。行为不一致。
- **影响**：`outputDelta` 早于 `item/started` 到达（流式输出先行、或 start 事件被批处理/重连丢弃）时，命令输出片段永久丢失；`turn/completed` 无法收尾不存在的活动，UI 活动输出缺失。
- **修复建议**：未命中时用 `itemId` 创建 `commandExecution` 活动再追加，与姊妹分支合并处理。

### M8. 损坏的偏好/授权文件被静默清空并覆盖

- **文件**：`src/main/preferencesStore.ts:183-192, 194-201`、`src/main/workspaceGrantStore.ts:28-36`
- **描述**：`read()` 对超限/JSON 损坏返回空态，随后 `write()` 把空态写盘固化；`workspaceGrantStore` 超限/损坏时 `grant()` 会基于空态只写入单条新目录，覆盖原合法多目录文件。
- **影响**：杀毒截断/断电损坏后，用户偏好（工作区、主题、会话元数据）或授权记录被静默清空且不可恢复。
- **修复建议**：损坏时保留 `.corrupt=<ts>` 备份，仅返回默认值，不静默覆盖；grant 对超限/损坏文件 fail-closed 但不覆盖。

### M9. 图片授权收紧的回归风险（未提交改动）

- **文件**：`src/main/main.ts:189-206`
- **描述**：`registerAuthorizedImageReferences` 从无条件登记改为仅放行附件目录或已授权工作区内的图片（`isWithinDirectory` 子路径判断）。若 Codex 事件在工作区被授权**之前**携带图片路径（授权时序晚于首个图片引用），或 `imageGeneration.savedPath` 位于其他合法位置，路径不再被登记，渲染进程读图失败。
- **修复建议**：确认 Provider 图片引用时机相对工作区授权时序；若存在先于授权的合法引用，保留显式登记路径。

### M10. `copyImage` 边界不严且与 `saveClipboardImage` 格式不一致

- **文件**：`src/main/main.ts:364-376, 378-384`
- **描述**：`copyImageToClipboard` 的 56MB 上限按 `dataUrl.length`（字符串长度）计算，正则 `[a-z0-9+/=\s]+` 允许 base64 内嵌空白填充；仅接受 `png|jpeg`，而 `saveClipboardImage` 接受 `png|jpeg|gif|webp`，错误文案未区分。
- **影响**：可夹带空白填充绕过长度判断（只写剪贴板、无文件/命令面，风险有限）；GIF/WebP 复制行为不一致且报错误导。
- **修复建议**：用解码后字节数做上限并禁止内部空白；统一格式集合或明确文案。

### M11. 附件缩略图使用全尺寸 dataUrl

- **文件**：`src/renderer/Composer.tsx:142-144`、`styles.css:318-321`
- **描述**：54×54 缩略图 `<img src={image.dataUrl}>` 直接加载附件原始完整分辨率 dataUrl，无降采样。
- **影响**：多张附件 + 多分栏时内存/解码开销放大。
- **修复建议**：主进程在导入附件时生成小尺寸缩略图 dataUrl，缩略图仅用缩略图源。

### M12. 消息列表 200 条窗口非虚拟化

- **文件**：`src/renderer/MessageStack.tsx:12-13, 92-99`
- **描述**：`MESSAGE_WINDOW = 200`、`ACTIVITY_WINDOW = 100` 只做尾部切片，无视口虚拟化；窗口内条目首次挂载一次性执行全部 react-markdown/GFM 解析与图片解码。
- **影响**：长会话打开/切回 Tab 时首帧卡顿。
- **修复建议**：基于滚动位置的虚拟列表，或窗口内条目懒渲染。

---

## 三、低优先级问题

### 交互与可访问性

- **L1. 容器级 `aria-live` 噪音**：`PaneView.tsx:238` 滚动容器整体挂 `aria-live="polite"`，流式期间读屏反复朗读整个可见区。建议改为仅在关键节点（assistant 消息、错误 banner）播报。
- **L2. ImageLightbox 无焦点陷阱**：`ImageLightbox.tsx:30-34, 49-50` 打开/关闭不管理焦点，Tab 可移出 dialog。建议焦点移入 dialog、关闭后归还触发元素。
- **L3. 复制按钮仅 hover 显示**：`styles.css:266-267` `opacity:0; pointer-events:none`，键盘聚焦可见但触屏/读屏不可发现；复制失败/成功无 aria 播报（`ImageLightbox.tsx:52`）。
- **L4. 模型下拉空值可提交**：`PaneView.tsx:196` 模型未加载时出现 `value=""` 的"加载模型"选项，选中会把空字符串写入设置。建议用 `disabled` 选项或禁用 select。
- **L5. 详情面板 Tab 折行**：`styles.css:376` `.details-tabs { repeat(3, 1fr) }`，能力齐全时 5 个 Tab（活动/计划/Agent/目标/原始事件）折两行，视觉错乱。建议 `repeat(auto-fit, minmax(0,1fr))`。
- **L6. GoalPanel 重复启动**：`GoalPanel.tsx:47-48` 目标 active 但非 working 的间隙"开始/继续"仍可点，可能重复 `onStart`。
- **L7. Composer textarea 固定 134px**：`styles.css:324` 高度固定、不随内容增长，长草稿内部滚动。建议按内容自适应。
- **L8. Tab 键直接发送消息**：`Composer.tsx:93-98` 输入框按 Tab 即发送/排队，与常规焦点移动预期冲突（产品设计）。
- **L9. `plugin-detail-overlay` 无 CSS**：`PluginPanel.tsx:244` 存在该类名且在 `PaneView.tsx:16` 的 `NAVIGATION_BLOCKING_SELECTOR` 引用，但 `styles.css` 中无对应规则，详情"浮层"实为网格重叠、无遮罩。建议补样式或改用现有浮层方案。
- **L10. 空态/加载态覆盖不完整**：`ActivityOutput.tsx:11` 空输出返回 null 无占位；`GoalPanel`/`PlanPanel` 无"加载中 vs 没有"的视觉区分。

### 健壮性与资源

- **L11. 窗口大小/位置不记忆**：`windowLifecycle.ts:139-143` 每次启动无条件 `maximize()`，无状态持久化。
- **L12. 日志单文件可超 64MB**：`logger.ts:140-165` 按整文件粒度清理，单日超大文件无法缩小（单行已截断，但重复高频仍会撑大）。
- **L13. 附件清理未同步 `authorizedClaudeImagePaths`**：`main.ts:408` 只删除 `authorizedLocalPaths`，Claude 图片路径集合残留失效项（有界，无越权，属状态污染）。
- **L14. Codex 审批 5 分钟过期脱钩**：`agentSessionRegistry.ts:52, 205-218` 过期后 `prepareResponse` 拒收，app-server 端可能仍等待；`completeResponse` 失败分支把 status 置回 pending，可能允许重复响应。
- **L15. 复制按钮复制原始 Markdown 而非渲染文本**：`MessageStack.tsx:36-44`（产品设计权衡）；`navigator.clipboard.writeText` 失败静默无提示。
- **L16. 历史每 2 分钟 + 每次聚焦轮询**：`App.tsx:1848-1860`，Provider 未运行时产生告警日志。
- **L17. `Electron d.ts` 中 `agentDesk?` 可选声明**：`electron.d.ts:5` 掩盖无 preload 宿主问题，调用处散落 `!` 断言。
- **L18. worker 崩溃边缘的补充输入丢失**：`claudeWorker.mts:862-867` `send` 无 ack；worker 崩溃重启后新 worker 无 `states` 记录，`send` 抛"Query 已失效"，用户刚输入的补充消息丢失。
- **L19. Claude InputQueue 无界缓冲**：`claudeWorker.mts:37-89` `values.push` 无数量/字节上限（host 侧仅单条 2MB 限流），大 prompt 分块快速连发时内存增长。与 AGENTS.md 容量不变量不符。
- **L20. `thread/settings/update`、`plugin/update` 缺专门超时**：`codexAppServer.ts:13-45` 落入 60s 默认，大插件更新可能误杀。
- **L21. reasoning detail 截断后继续追加**：`codexEventAdapter.ts:705` 用 `limitActivityText` 而非 `appendActivityText`，截断标记出现后新 delta 拼出"…marker+新delta"错乱文本。改用 `appendActivityText`。
- **L22. 迟到 startTurn 对 idle 会话忽略**：`providerEventController.ts:229-232` 迟到结果仅在 working 且无 activeTurnId 时补登记。
- **L23. 回调 id 与请求 id 共用数字空间**：`codexAppServer.ts:186-211` 服务器回调 id 可能与已超时请求 id 撞车，产生错误语义的 `client/late-response`（`handleMessage` 先判 method 短路 + `takeResponse` child 校验已降低风险）。建议改 `(id, method)` 元组匹配。
- **L24. `agent:event` 单通道无背压**：`main.ts:578`、`windowLifecycle.ts:196-199` 高频 `stream_event` 逐条 IPC 推送，无队列上限；渲染器 250ms 节流缓解，但窗口销毁时消息丢弃。建议主进程合批/环形缓冲。
- **L25. 渲染层无匹配 session 事件静默丢弃**：`providerEventController.ts:279-282` 会话未加载/已关闭期间的 `turn/completed`、`result` 等关键事件被丢弃，重新打开后可能卡 working。建议对校平事件做最近值缓存。
- **L26. `ServerRequestPanel` decisions 死代码**：`ServerRequestPanel.tsx:63` fileApproval 两分支返回相同数组，内层三元无作用。
- **L27. ProviderIcon 用 .ico 做 mask**：`ProviderIcon.tsx:4-7, 23` 部分 GPU 设置/缩放比下可能空白。建议统一 PNG/SVG 源。
- **L28. `saveTextFile` 同步写 20MB**：`main.ts:461-474` `writeFileSync` 阻塞主进程（一次性、可接受）。
- **L29. claude 流式多块追加错位**：`claudeEventAdapter.ts:124-136` 按"最后一条 streaming 消息"定位追加，双流并发时可能错位（少见）。建议按 `message_start` 的 message id 精确追加。
- **L30. `pendingApprovals` 无数量上限**：`codexEventAdapter.ts:371-436` 单 turn 大量连续审批会堆积。
- **L31. `MessageStack` Fragment key 含 index**：`MessageStack.tsx:133` 消息中间插入时可能重挂载（轻微）。
- **L32. `updateSession` 双 ref/state 对非幂等 updater 二次调用**：`App.tsx:266-275` 同轮两次更新时第二个 updater 可能被再次调用。约定 updater 必须纯函数。
- **L33. ImageLightbox 复制成功定时器卸载未清理**：`ImageLightbox.tsx:42-46` React 18 卸载后 setState 为静默 no-op，无实际泄漏。
- **L34. `resolveWorkspace` 模块加载期调用 `app.getPath("home")`**：`main.ts:45, 510-514` 早于 `whenReady`，仅异常启动时用临时值。
- **L35. 桌面更新 100ms 调度边界**：`main.ts:242` `setTimeout(install, 100)`，若 prepareInstall 后、触发前被强杀则安装不执行。
- **L36. claudeUpdater 跨卷 rename 无 A/B 缓冲**：`claudeUpdater.ts:174-193` EXDEV 回滚时新 exe 已消失（同卷场景触发面低）。
- **L37. ZIP 只验前 4 字节签名**：`claudeUpdater.ts:70-77` 单条目 + 大小上限已基本防 ZIP 炸弹，整体损坏走到解压才报错。
- **L38. `check`/`update` 双通道状态可能短暂不一致**：`codexCliUpdateManager.ts:134-169, 171-226` 不影响安全，仅状态时序。
- **L39. 迟到响应只记 warn 日志**：`codexAppServer.ts:195-200` 非 thread/start 方法无渲染层可见兜底。
- **L40. `claudeUpdateManager.update` busy 时返回当前状态**：`claudeUpdateManager.ts:180-181` UI 可能短暂显示旧状态。

---

## 四、甄别为"非问题"的项（避免误修）

以下项经交叉验证确认行为正确或已有防护，**不应**按问题处理：

1. **`registerWorkspace` 返回 null 的调用方处理**：`App.tsx:766/777` 用 `if (!registered) return;`；`App.tsx:1653` 与 `historicalSessionRestore.ts:10` 用 `!registeredCwd && throw`；preload/shared 类型与 IPC handler 同步。无遗漏。
2. **`fatalError` 语义与 UI 标签**：`sessionLifecycle.ts:49` 的 `closeError ?? (shouldClose ? undefined : interruptError)` 与 `App.tsx:442` 的标签逐情况一致；仅缺一条 interrupt 失败的 warn 日志（可观测性缺口，非 bug）。
3. **工作区授权持久化启动加载**：`main.ts:596` 启动时 `workspaceGrantStore.read()` 加载进内存注册表，重启不会重复弹窗。
4. **弹窗并发去重**：`main.ts:254-276` `pendingWorkspaceAuthorizationRequests` + `workspaceAuthorizationPromptQueue` 已串行化。
5. **Codex 迟到响应的进程隔离**：`rpcRequestRegistry.ts:55-66` `takeResponse` 校验 `waiting.child === child`，配合 `stopChild` 的 `requests.reject` 兜底，跨进程误配属被阻断。
6. **z-index 层级**：lightbox `z-index: 200` 高于 `.dialog-backdrop`(90)、`.tab-context-menu`(80)、`.plugin-overlay`(20)，无冲突；Escape 收敛到 ImageLightbox 单一监听。
7. **IPC/preload/协议三处一致**：`registerDesktopIpc.ts` 的 handler、`preload.ts` 的 bridge、`shared/protocol.ts` 的类型同步，无遗漏通道。
8. **容量上限完备**：事件 2 万/消息 24KB/活动 8KB/附件 1GB/偏好 4MB/授权 64 条/Worker 消息 2MB/JSONL 行 16MB 等均有边界；`rawEventStore` 有 250ms 节流 + 快照引用复用 + WeakMap 缓存。
9. **Provider 隔离正确**：`agentSessionRegistry.observeEvent` 只对引发事件的 provider `clearProvider`；`clearProvider` 按 provider 过滤；Claude 更新只关 Claude 会话；Codex 审批 id 与请求 id 通过 `handleMessage` 的 method 短路隔离。
10. **Claude Worker 事故恢复路径完整**：`uncaughtException → fatal → cleanup → 进程树清理`；凭据按 Query 读取、不入日志。

---

## 五、建议处理顺序

1. **第一批（可用性）**：H1 启动恢复兜底、H3 线程启动悬挂、H2 防 Ctrl+R 刷新。
2. **第二批（可靠性）**：H4 渲染进程崩溃恢复、H5 Codex 事件代次防护、H6 超时取消语义。
3. **第三批（性能/安全）**：H7 Atomics.wait、M3 git 同步阻塞、M4 图片复制编码、M7 outputDelta 丢弃、M2 授权并发。
4. **发布前**：未提交改动（工作区授权 + 图片复制）至少覆盖 H1、M9、M10 的边界测试。

> 说明：涉及修改时按项目规则执行——先检查 `git status` 与相关 diff，保留现有未提交改动；修改后跑相关测试与 `npm run build`；不擅自提交、推送或升版本。
