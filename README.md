# AgentDesk

**把 Codex 和 Claude Code 放进同一个 Windows 工作台。**

不用同时开很多命令行窗口，也不用反复寻找目录和历史会话。你可以在一个界面里切换项目、并排处理任务，并在两个工具之间交接工作。

[下载最新版](https://github.com/yk-yla/agentdesk/releases/latest) · [查看每个版本的更新内容](https://github.com/yk-yla/agentdesk/releases)

## 为什么使用 AgentDesk

如果你已经在使用 Codex 或 Claude Code，AgentDesk 不会改变它们的能力，而是让日常操作更集中、更直观。

| 直接使用 Codex / Claude Code | 使用 AgentDesk |
| --- | --- |
| 两个工具分开打开、分开管理 | 在一个窗口中使用两个工具 |
| 多个项目容易开出很多窗口 | 按目录整理会话，并用标签快速切换 |
| 同一时间只能盯着一个任务 | 支持左右分栏，同时查看两个会话 |
| 历史会话需要分别寻找 | 可搜索、收藏并重新打开历史会话 |
| 换工具时需要手动整理上下文 | 可把当前任务和必要信息交接给另一个工具 |
| 软件和工具更新需要分别处理 | 可在设置中检查更新并查看更新内容 |

## 能做什么

- 同时管理 Codex 和 Claude Code 会话，两个工具互不干扰。
- 打开多个项目目录，用标签或左右分栏处理多个任务。
- 搜索、收藏、恢复历史会话，减少重复说明工作背景。
- Codex 在 AgentDesk 工作台中运行；Claude Code 通过配置的外部终端运行。
- 发送图片和附件，查看执行过程、用量和需要确认的操作。
- 导出会话，或把未完成的任务交接到另一个工具继续处理。
- 管理可用的插件，并检查 AgentDesk、Codex 和 Claude Code 的更新。
- 遇到问题时导出诊断信息，方便排查，同时避免带出完整会话内容。

## 使用前需要准备什么

### 电脑

- 64 位 Windows 电脑。
- 普通使用不需要安装 Node.js，也不需要配置开发环境。

### 使用 Codex

- 电脑上必须已经安装 Codex，并完成登录。
- AgentDesk 会使用你电脑上现有的 Codex；如果没有安装，只会提示缺少，不能代替你完成首次安装。

### 使用 Claude Code

- 必须先安装 Claude Code CLI，并完成登录。
- AgentDesk 不内置 `claude.exe`，会使用你电脑上已安装的 Claude Code。
- 必须有可用的 Claude 登录状态或认证信息，否则无法开始会话。

你可以只使用其中一个工具，不要求两个工具都准备好。

## 它是怎么工作的

AgentDesk 是一个本地桌面界面，不是新的人工智能模型，也不会替代 Codex 或 Claude Code。

当你发送任务时，它会在你选择的项目目录中调用对应工具，把工具返回的文字、执行过程和确认请求整理后显示在界面中。两个工具的会话和运行过程彼此分开，因此一个工具退出或报错时，不会顺带关闭另一个工具的会话。

项目文件仍保存在你的电脑上。工具能做哪些操作，取决于你的登录状态、所选目录和你授予的权限。

## 安装和开始使用

1. 根据上面的要求准备好要使用的工具和账号。
2. 打开[最新版下载页面](https://github.com/yk-yla/agentdesk/releases/latest)，下载 Windows 安装包。
3. 安装并启动 AgentDesk，选择一个本地项目目录。
4. 点击 Codex 图标在工作台中新建会话；点击 Claude Code 图标会打开配置的外部终端。

以后跳过了多个版本也没关系。检查更新时会直接提供最新版，不需要逐个版本安装；每次更新的具体内容可以在软件更新窗口或 [GitHub 更新记录](https://github.com/yk-yla/agentdesk/releases)中查看。

<details>
<summary><strong>参与开发</strong></summary>

需要 Node.js 24 和 npm 11。

```powershell
npm install
npm run dev
```

完整检查：

```powershell
npm run build
```

生成 Windows 安装包：

```powershell
npm run package
```

</details>

<details>
<summary><strong>版本发布说明</strong></summary>

每个版本的更新说明放在 `.github/release-notes`，文件名必须与版本标签一致，例如 `v1.1.0.md`。缺少更新说明时，自动发布会停止。

</details>
