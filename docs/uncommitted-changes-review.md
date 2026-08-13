# 当前未提交改动审查

审查日期：2026-08-12

范围：消息时间与复制按钮布局、文件删除合理性、功能回归和测试遗漏。

## 中等严重程度

### 1. Electron 核心回归与新行为冲突

新实现将消息时间改为 `HH:mm:ss`，并让时间栏默认可见；现有回归仍断言完整日期时间，且断言整个工具栏默认透明。因此 Electron 核心回归会稳定失败，无法作为有效门禁。

- `src/renderer/messageTimestamp.ts:25`
- `src/renderer/styles.css:290`
- `scripts/electron-core-smoke.js:239`
- `scripts/electron-core-smoke.js:240`
- `scripts/electron-core-smoke.js:256`
- `scripts/electron-core-smoke.js:257`

同时缺少以下测试：

- 复制按钮默认隐藏、悬停或键盘聚焦后显示。
- 点击复制后写入消息正文，并切换为“已复制”状态。
- 短消息、长消息和窄窗口下，时间与复制按钮不会撑宽或错位。

### 2. 删除 Claude 插件隔离回归脚本会丢失关键覆盖

被删除的 `scripts/claude-plugin-isolated-smoke.js` 原本通过真实 Claude Worker 覆盖以下闭环：市场添加、插件安装、Worker 重启后的状态持久化、详情读取、更新、卸载、市场移除，以及用户真实 Claude 配置未被污染。

现有测试不能等价替代：

- `src/main/providers/claude/ClaudeBackend.test.ts:451` 只验证模拟 Worker 的请求转发。
- `scripts/electron-live-provider-smoke.js:49` 只验证插件市场空列表和 Provider 标签切换。

因此该脚本删除不合理，除非这些真实 Worker 和配置隔离检查已经迁移到其他测试入口。

## 低严重程度

### 3. 系统消息和缺失时间戳的历史消息上方会出现空白行

`MessageStack` 无条件渲染 `.message-toolbar`，但系统消息明确不显示时间；样式又固定保留 `21px` 最小高度和 `5px` 下边距。因此系统消息会在气泡上方多出约 `26px` 空白。历史消息没有有效时间戳时也会出现相同问题。

- `src/renderer/MessageStack.tsx:74`
- `src/renderer/MessageStack.tsx:75`
- `src/renderer/styles.css:290`
- `src/renderer/App.tsx:499`
- `src/renderer/providers/codex/codexEventAdapter.ts:461`

## 文件删除结论

以下两个文档没有被代码、脚本或工作流引用，属于阶段性调查记录；删除不会引起运行时功能回归，技术上可以接受，但会丢失历史排查证据：

- `docs/codex-tool-anomaly-timeline.md`
- `docs/codex-tool-availability-investigation.md`

`scripts/claude-plugin-isolated-smoke.js` 不建议直接删除，原因见问题 2。

## 验证说明

本次仅做只读代码审查，并执行了 `git diff --check`；未运行会生成构建产物的测试，也未修改被审查代码。
