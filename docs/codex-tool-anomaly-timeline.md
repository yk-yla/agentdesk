# Codex 工具异常时间线

> 调查日期：2026-08-12
> 时区：表格同时给出北京时间（UTC+8）和 UTC。
> 目的：把个人电脑上可交给中转站同事核对的异常时间、Turn、证据和结论集中记录。

## 结论先说

- AgentDesk 日志中发现 **24 条原始路由错误记录**，按同一毫秒的重复输出合并后是 **19 个独立时间点**。
- 能确认模型在某一轮没有产生终端/文件工具调用的记录，主要集中在长会话、多次压缩之后；其中有一次是 **Turn 中途工具入口消失**，所以不能只按“该 Turn 是否出现过命令”判断。
- Codex CLI 线级捕获显示：异常请求仍带完整的 `exec`、`functions` 工具目录；异常来自中转响应没有返回函数调用，或返回了错误的 `list_agents` 调用。
- 因此目前最强结论是：**不是 Windows 权限，也不是 Codex 出站请求普遍漏发工具；主要嫌疑在自定义中转站的转换链路或其背后的模型。** 仍不能仅凭客户端证据区分这两者。
- 原始 `<thinking>` 泄漏与工具异常都出现过，但日志没有证明二者是同一条因果链。

## 证据范围和限制

扫描了：

- `C:\Users\11871\AppData\Roaming\AgentDesk\logs\agentdesk-2026-08-10.ndjson`
- `C:\Users\11871\AppData\Roaming\AgentDesk\logs\agentdesk-2026-08-11.ndjson`
- `C:\Users\11871\.codex\sessions\2026\08\10`、`2026\08\11` 下的非 SQLite rollout JSONL
- `build/logs/codex-provider-wire-*.json`
- 飞书历史和桥接日志

没有读取、修改或重建 Codex SQLite，也没有记录 URL、Key 或完整聊天正文。CLI 交互式诊断的明文 TUI 日志只有在事先配置 `log_dir` 时才会产生；因此这里以 rollout、AgentDesk NDJSON 和线级脱敏报告为准。官方说明见 [Codex diagnostics](https://learn.chatgpt.com/docs/config-file/environment-variables#diagnostics)。

## A. AgentDesk 路由参数错误

原文格式统一为：

```text
codex_core::tools::router: failed to parse function arguments: missing field `<字段>` at line 1 column 2
```

同一毫秒内的多条 `commandExecution/outputDelta` 只算一次。下面的行号来自对应 AgentDesk NDJSON 文件。

| 北京时间 | UTC | 缺少字段 | 证据 |
| --- | --- | --- | --- |
| 2026-08-10 17:58:52.178 | 2026-08-10 09:58:52.178 | `command` | `agentdesk-2026-08-10.ndjson:323211-323213` |
| 2026-08-10 18:00:16.365 | 2026-08-10 10:00:16.365 | `command` | `agentdesk-2026-08-10.ndjson:323954-323957` |
| 2026-08-11 11:19:54.827 | 2026-08-11 03:19:54.827 | `message` | `agentdesk-2026-08-11.ndjson:33027` |
| 2026-08-11 11:27:54.760 | 2026-08-11 03:27:54.760 | `message` | `agentdesk-2026-08-11.ndjson:38040` |
| 2026-08-11 11:34:34.898 | 2026-08-11 03:34:34.898 | `message` | `agentdesk-2026-08-11.ndjson:40380` |
| 2026-08-11 12:32:47.088 | 2026-08-11 04:32:47.088 | `message` | `agentdesk-2026-08-11.ndjson:60747` |
| 2026-08-11 12:33:05.567 | 2026-08-11 04:33:05.567 | `message` | `agentdesk-2026-08-11.ndjson:60914` |
| 2026-08-11 12:34:34.110 | 2026-08-11 04:34:34.110 | `message` | `agentdesk-2026-08-11.ndjson:62311` |
| 2026-08-11 12:46:16.848 | 2026-08-11 04:46:16.848 | `message` | `agentdesk-2026-08-11.ndjson:72545` |
| 2026-08-11 12:58:21.313 | 2026-08-11 04:58:21.313 | `message` | `agentdesk-2026-08-11.ndjson:75984` |
| 2026-08-11 13:01:15.318 | 2026-08-11 05:01:15.318 | `message` | `agentdesk-2026-08-11.ndjson:77009` |
| 2026-08-11 13:08:11.870 | 2026-08-11 05:08:11.870 | `target` | `agentdesk-2026-08-11.ndjson:81765` |
| 2026-08-11 14:10:07.709 | 2026-08-11 06:10:07.709 | `target` | `agentdesk-2026-08-11.ndjson:99628` |
| 2026-08-11 14:10:52.825 | 2026-08-11 06:10:52.825 | `message` | `agentdesk-2026-08-11.ndjson:99649` |
| 2026-08-11 14:42:21.860 | 2026-08-11 06:42:21.860 | `message` | `agentdesk-2026-08-11.ndjson:113341` |
| 2026-08-11 16:43:10.807 | 2026-08-11 08:43:10.807 | `target` | `agentdesk-2026-08-11.ndjson:214616` |
| 2026-08-11 16:46:59.732 | 2026-08-11 08:46:59.732 | `target` | `agentdesk-2026-08-11.ndjson:216213` |
| 2026-08-11 16:47:15.653 | 2026-08-11 08:47:15.653 | `message` | `agentdesk-2026-08-11.ndjson:216273` |
| 2026-08-11 16:47:41.278 | 2026-08-11 08:47:41.278 | `message` | `agentdesk-2026-08-11.ndjson:216365` |

其中 2026-08-11 11:27 至 11:34 的两条 `message` 错误与另一条线程的工具/压缩活动时间相邻；日志没有给 router 错误附带 `threadId`，所以不能做协议级归属。错误前后仍有成功命令，不能解释为工具进程永久死亡。

## B. 确认的工具缺失或未调用

“工具缺失”这里按证据强度分层：

- **强证据**：该 Turn 没有任何 `commandExecution`/`fileChange`，同时出现“没有终端/工具”的模型消息。
- **中强证据**：同一 Turn 先有一次成功读取，随后模型明确说工具入口消失；属于 Turn 中途消失。
- **弱证据**：后续消息只是复述历史异常，不能算新故障。

| 北京时间 | UTC | Thread / Turn | 现象和证据 | 强度 |
| --- | --- | --- | --- | --- |
| 2026-08-11 11:34:52.838 | 03:34:52.838 | `019feb1d-aace-71a3-b3d7-167a96ba935f` / `019feee2-4d8c-7d72-adc3-d9c3a3e63c8f` | 第 3 次压缩完成后，推理摘要为 `Confirming lack of execution capabilities`；无命令/文件修改 Item。NDJSON 第 40402 行；明确中文拒绝从 11:35:04.104 开始（约第 40513 行）。 | 强 |
| 2026-08-11 11:39:29.569-11:39:58.371 | 03:39:29.569-03:39:58.371 | 同上 / `019feee6-ca0e-7a81-a192-b43979f0e3b4` | 下一 Turn 再次明确说没有终端执行工具；没有命令/文件修改 Item。rollout：`rollout-2026-08-10T18-00-17-019feb1d-aace-71a3-b3d7-167a96ba935f.jsonl:1703-1705`。 | 强 |
| 2026-08-11 11:43:37.179 | 03:43:37.179 | 同上 / `019feee9-3798-7cc3-aff0-396f2d4fc237` | 继续该线程时仍说没有终端入口；无工具调用。rollout：同文件 `:1714-1716`。 | 强 |
| 2026-08-11 14:20:31.803 | 06:20:31.803 | `019fef6e-cf6e-7ff2-8f9e-dd29d5320704` / `019fef79-e4ec-7c23-a6af-9eacedf396c2` | 开发请求的第一轮就出现 `Confirming development tools unavailability`，随后回复没有终端或文件编辑工具；无工具 Item。NDJSON 约 `104758-104805`，rollout：`rollout-2026-08-11T14-07-24-019fef6e-cf6e-7ff2-8f9e-dd29d5320704.jsonl:42-44`。 | 强 |
| 2026-08-11 16:48:22.222 | 08:48:22.222 | `019fefc2-08a8-7203-bc6f-7c4e0233cba4` / `019fefff-3a07-7863-9f58-f0d9b99305aa` | 明确说没有本地命令或文件编辑工具；无该 Turn 的命令调用。rollout：`rollout-2026-08-11T15-38-19-019fefc2-08a8-7203-bc6f-7c4e0233cba4.jsonl:555-557`。 | 强 |
| 2026-08-11 16:50:37.916 | 08:50:37.916 | 同上 / 同上 | 同一 Turn 第二次以相近内容拒绝；这是同一异常 Turn 的重复输出，不另计独立故障。rollout：同文件 `:555-557`。 | 强，重复 |
| 2026-08-11 17:00:54.157 | 09:00:54.157 | `019fef6e-cf6e-7ff2-8f9e-dd29d5320704` / `019ff00b-7c7d-7353-8c38-3f46cbdcd5b1` | 回复当前只剩协作/等待工具，找不到终端和文件编辑；该 Turn 只有 `list_agents` 等协作调用，未出现终端/文件调用。rollout：`rollout-2026-08-11T14-07-24-019fef6e-cf6e-7ff2-8f9e-dd29d5320704.jsonl:1329-1338`。 | 强 |
| 2026-08-11 17:16:27.914 | 09:16:27.914 | 同上 / `019ff01b-9a70-7fa1-b59d-4c37736007ca` | 回复没有文件编辑入口；无工具调用。NDJSON 约 `224475-224746`；rollout：同文件 `:1369-1371`。 | 强 |
| 2026-08-11 17:31:50.787 | 09:31:50.787 | 同上 / `019ff028-b57f-7bb3-85fc-aa1e4f7782e4` | 该 Turn 先成功读文件，随后同一轮报告终端入口消失；这是中途消失，不应按“该 Turn 有命令”判为正常。rollout：同文件 `:1406-1415`。 | 中强 |
| 2026-08-11 17:33:24.521 | 09:33:24.521 | 同上 / `019ff02a-f4ff-7611-ba9c-d576cca72914` | 下一 Turn 明确说当前工具已缺失，无法恢复；无本地命令调用。NDJSON 约 `228552-228802`；rollout：同文件 `:1435`。 | 强 |
| 2026-08-11 18:12:35.545 | 10:12:35.545 | 同上 / `019ff04e-6d69-7013-9283-8b29e643efa8` | 再次说没有终端入口，且无法读取日志或修改文档；无工具调用。NDJSON 约 `234691-235164`；rollout：同文件 `:1479-1488`。 | 强 |

注意：`11:39` 和 `11:43` 是同一长线程连续失败；`16:50:37` 是 `16:48:22` 同一 Turn 的重复文本。后续调查命令输出中引用这些旧句子的内容，不再计为新异常。

## C. CLI 线级捕获

### 调整前

报告：`build/logs/codex-provider-wire-2026-08-11T11-14-40-617Z.json`。

- Thread：`019ff085-0c30-7291-ac56-f43af897420d`
- 基准 Turn：`019ff085-1252-7610-bcdf-371296074575`，北京时间约 19:11:20 开始，工具调用成功。
- 第 1、2 次自动压缩后的用户 Turn 仍有 `commandExecution`。
- 第 3 次自动压缩后的 Turn：`019ff087-608e-7d52-9302-33dca7ed22d8`，北京时间约 19:13:51-19:14:40；请求摘要仍含完整 `exec`、`functions`，上游响应只有普通 `message`，没有函数调用，最终没有 `commandExecution`。
- 请求中 `additional_tools` 的工具定义来自 Codex 出站；压缩专用请求出现空的 `additional_tools` 不代表后续用户 Turn 丢工具。

### 中转站调整后

报告：`build/logs/codex-provider-wire-2026-08-11T12-35-41-849Z.json`。

- Thread：`019ff0cf-b2b1-73e3-b56d-2bdeabab9d94`
- 基准 Turn：`019ff0cf-b8a1-7320-becc-36aeaa4ca6a0`，北京时间约 20:32:53-20:33:39。
- 第 3 组基准响应错调 `list_agents`，没有执行要求的 `Get-Location`。
- 第 3 次自动压缩后 Turn：`019ff0d1-95e9-78c2-8ee0-23eea916fd8d`，北京时间约 20:34:55-20:35:41；请求仍含完整工具目录，但上游只返回普通 `message`，没有函数调用。
- 3 组复测共 12 个明确要求执行终端的用户 Turn：10 次成功，2 次失败；9 个自动压缩后的用户 Turn：8 次成功，1 次失败。
- 本次 3 组均未观察到 `<thinking>` 标签。

这些报告是脱敏摘要，不保存 URL、Key 或完整请求/回复正文；详细字段只保留工具名称、事件类型、时间和哈希。

## D. 飞书同类案例

- 用户请求：北京时间 **2026-08-11 17:36:26.708**。
- 模型回复工具不可用：**17:36:56.116**。
- Thread：`019fe70c-96ac-7ef0-9035-a554567ea715`。
- 历史：`D:\me\project\help\.bot\data\history\oc_0010da382c178bc0acd2c361e54cb391.jsonl`。
- `reminders.json` 没有新增提醒，也没有提醒业务执行失败日志；所以当时是工具未调用，不是提醒业务执行失败。

## E. 原始 thinking 泄漏

- 首次确认时间：北京时间 **2026-08-11 11:32:03.378**，UTC `03:32:03.378`。
- Thread：`019feb3d-0b9d-7112-a51d-e62646fd2968`。
- Turn：`019fee93-0852-7902-a8f2-a8be90757b9b`。
- AgentDesk：`agentdesk-2026-08-11.ndjson:38555` 起；完整内容是 `<thinking>**Executing concurrency benchmark**</thinking>`，却被标记成普通 `agentMessage`。
- 该线程在泄漏后仍成功执行命令，说明它不是共享工具进程永久退出。

## F. 根因定位边界

| 假设 | 目前判断 |
| --- | --- |
| Windows 权限、工作目录或 `danger-full-access` 导致 | 基本排除；同一配置下有大量成功命令 |
| AgentDesk Renderer 把工具事件吃掉 | 证据不足且 CLI、飞书、旧版 AgentDesk 也复现；不是主要嫌疑 |
| 多线程共用 app-server 必然导致 | 未证实；普通双线程和并发压缩测试通过 |
| 长上下文、多次自动压缩是触发条件 | 高度相关；真实故障和隔离复现均出现在多次自动压缩后，但不是每次必现 |
| Codex app-server 在异常用户 Turn 漏发工具 | 线级捕获已反证；异常请求仍有完整工具目录 |
| 自定义中转站转换或其背后模型 | 当前最高嫌疑；需要中转站服务端确认其转发给实际模型的工具目录 |

## 交给中转站同事的核对项

请按以下时间和 Turn 查服务端日志，不需要用户提供 Key：

1. 调整前：`019ff087-608e-7d52-9302-33dca7ed22d8`，约北京时间 19:13:51-19:14:40。
2. 调整后错调工具：第 3 组基准 Turn `019ff0cf-b8a1-7320-becc-36aeaa4ca6a0`，约北京时间 20:32:53-20:33:39。
3. 调整后无工具调用：`019ff0d1-95e9-78c2-8ee0-23eea916fd8d`，约北京时间 20:34:55-20:35:41。

每条请求请核对：

- 中转站收到的 `additional_tools` 是否包含 `exec`、`functions`；
- 实际发给后端模型的工具 schema 是否仍完整；
- `tool_choice`、`parallel_tool_calls` 是否被改写；
- 后端原始响应是“无工具调用”还是工具调用被转换器丢弃；
- 若后端确实返回了 `list_agents`，它是否来自模型原始响应。

## 复现与缓解记录

- `scripts/codex-tool-availability-diagnostic.mjs`：T0/T1/T2/T3/T4/T4R/T1R 对照脚本。
- `scripts/codex-provider-wire-diagnostic.mjs`：通过本机透明代理记录 Codex 出站工具摘要和中转响应类型，不保存凭据和正文。
- `T1R` 连续三次预压缩后再发独立用户 Turn，三次均成功执行 `Get-Location`。
- `T4R` 连续自动压缩已复现“某一轮没有工具 Item、后续恢复”的同类异常。

预压缩是当前客户端缓解措施，不是根因修复；根因修复仍需要中转站服务端日志或官方 Provider 对照。

## 不应计入的新异常

- 调查文档、命令输出和后续总结中引用旧错误时间的文字。
- `skills/list` 成功或普通命令 `exitCode=1/124`；它们不等于工具目录消失。
- 同一毫秒重复的 router 输出。
- 同一 Turn 内重复显示的“没有工具”回复。

## 官方依据

- [OpenAI Codex diagnostics](https://learn.chatgpt.com/docs/config-file/environment-variables#diagnostics)：`RUST_LOG` 控制 CLI/app-server 日志；交互式 CLI 的明文 `codex-tui.log` 需要显式设置 `log_dir`。
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)：工具调用以结构化 Item 事件出现，压缩以 `contextCompaction` 事件出现。
