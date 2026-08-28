# AgentDesk

**一个窗口，同时管理 Codex 和 Claude Code。**

AgentDesk 是面向 Windows x64 的本地桌面工作台。它把项目目录、AI 会话、历史记录和任务进度集中到一个界面中，让你可以在 Codex 与 Claude Code 之间快速切换、并排工作和交接任务。

[下载最新版](https://github.com/yk-yla/agentdesk/releases/latest) · [查看更新记录](https://github.com/yk-yla/agentdesk/releases)

## AgentDesk 的优势

- **一个工作台管理两个工具**：Codex 和 Claude Code 的会话分开管理，互不污染；可以在同一个项目里快速切换 Provider。
- **以项目目录组织工作**：固定目录、当前目录、标签页和左右分栏结合使用，适合同时处理多个项目和多个任务。
- **历史会话容易找回**：按当前目录、收藏或全部最近会话浏览，也可以搜索标题和会话正文。
- **任务过程更清楚**：查看命令、文件变化、工具调用、计划、目标、子 Agent 和原始事件；需要时可以展开详细输出。
- **两个工具可以互相交接**：把当前任务导出为 Markdown，或将会话上下文交给 Codex / Claude Code 继续处理。
- **更新方式统一**：设置中可以查看 AgentDesk、Codex CLI 和 Claude Code 的版本与安装来源，并按对应来源更新。
- **本地优先**：偏好、草稿和会话界面状态保存在本机；AgentDesk 不内置新的模型服务，也不替代原有 CLI。Provider 是否把任务内容发送到自己的服务，取决于 Provider 本身。

## 主要功能

### 项目和会话

- 添加、切换和固定多个本地项目目录。
- 在标签页中管理多个会话，并支持左右分栏。
- 会话支持重命名、置顶、收藏、创建分支、导出 Markdown 和永久删除本机会话。
- 普通重启会恢复标签页、分栏、草稿、附件和排队消息；上次退出时仍在执行的任务会标记为已停止，需要手动继续。

### Codex

- 通过本机 `codex app-server` 在工作台内运行。
- 使用 Codex 支持的模型、思考等级、执行模式和计划模式。
- 支持图片输入、技能、MCP、代码审查、上下文压缩、任务目标、计划、子 Agent、停止和继续引导。
- 从 Codex 的本地历史中读取会话，并合并显示 AgentDesk 工作区与用户原有 Codex 历史。

### Claude Code

- 通过 Windows Terminal、PowerShell 或自定义终端启动电脑上已安装的 `claude` CLI。
- 在 AgentDesk 中读取和搜索 Claude Code 历史，并可以恢复、重命名、创建分支、收藏或删除会话。
- Claude Code 会话由外部终端控制，在工作台中以只读方式查看状态和历史。
- 模型和思考等级等 Claude Code 原生命令，继续在外部终端中调整。

### 附件、交接和诊断

- 支持发送本地图片和剪贴板图片，并在发送前预览或移除附件。
- 可以把未完成任务交接给另一个 Provider，保留必要的工作目录和上下文说明。
- 可以导出诊断信息用于排查问题；日志会限制容量并避免写入完整会话长文本和敏感凭据。

### 更新和安装来源

- AgentDesk 自身从 GitHub Releases 检查、下载和安装更新。
- Codex 和 Claude Code 在软件启动时各检测一次安装来源、实际路径、版本和更新方式，运行期间不反复搜索或切换路径。
- 根据各 Provider 支持的安装来源处理 npm、winget、官方安装和自定义路径；更新前会检查对应 CLI 是否正在被会话使用，使用中或无法确认时会取消更新。
- 启动会话前只确认启动时记录的程序文件仍然存在。更换 CLI 安装方式后，重启 AgentDesk 即可刷新记录。

## 使用前准备

### 电脑

- 64 位 Windows 电脑。
- 安装版普通使用不需要 Node.js 或开发环境。

### Codex

- 先在电脑上安装 Codex CLI，并完成登录。
- AgentDesk 使用电脑上现有的 Codex，不负责替代首次安装和登录。

### Claude Code

- 先在电脑上安装 Claude Code CLI，并完成登录。
- AgentDesk 不打包 `claude.exe`，会调用电脑上已安装的 Claude Code。
- 需要配置一个可用的 Windows Terminal、PowerShell 或自定义终端。

两个 Provider 可以单独使用，不要求同时安装。

## 安装和开始使用

1. 准备好要使用的 Codex 或 Claude Code，并完成登录。
2. 打开[最新版下载页面](https://github.com/yk-yla/agentdesk/releases/latest)，下载 Windows 安装包。
3. 安装并启动 AgentDesk，选择一个本地项目目录。
4. 点击 Codex 图标，在工作台中新建 Codex 会话；点击 Claude Code 图标，在外部终端中新建 Claude Code 会话。
5. 打开设置可以检查三个组件的版本、查看更新说明和执行更新。

## 数据和权限

- 项目文件仍由你电脑上的 Provider 直接读写，AgentDesk 不额外提供项目上传服务；Provider 自身是否访问远程服务，以其产品规则为准。
- 工作区、附件和本地会话界面状态保存在 Electron 用户数据目录中。
- 访问项目、附件和本地图片前会经过主进程路径授权；不能访问未授权的本地路径。
- 具体能执行哪些命令，取决于 Provider 的登录状态、当前工作目录和本机配置。

## 参与开发

开发环境要求以 [package.json](./package.json) 为准，目前使用 Node.js 24 和 npm 11。

```powershell
npm install
npm run dev
```

完整构建、类型检查和测试：

```powershell
npm run build
```

生成 Windows 安装包但不发布：

```powershell
npm run package
```

开发版和打包版回归入口见 [`scripts`](./scripts) 目录及 [AGENTS.md](./AGENTS.md)。

## 版本发布

- 发布由 GitHub Actions 根据 `v*` 标签触发。
- 每个版本的说明放在 `.github/release-notes`，文件名必须与版本标签一致，例如 `vX.Y.Z.md`。
- 发布前必须通过构建、测试、安装包检查和 Provider 回归；未明确授权时不要运行发布命令。
