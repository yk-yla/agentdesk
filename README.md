# AgentDesk

AgentDesk 是 Windows x64 桌面客户端，用于在同一个软件中使用 Codex 和 Claude Code。

## 主要功能

- Codex 与 Claude Code 会话彼此独立。
- 支持多标签、分栏、历史会话、图片和附件。
- 支持手动检查、下载和安装软件更新。
- 支持 Codex CLI 与 Claude Code 更新。

## 本地开发

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

## 发布说明

每个版本的更新说明放在 `.github/release-notes`，文件名必须与版本标签一致，例如 `v1.0.16.md`。缺少更新说明时，自动发布会停止。
