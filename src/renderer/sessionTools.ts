import type { Activity, Message, SessionState } from "./domain";

const MAX_MESSAGE_CHARS = 24_000;
const MAX_ACTIVITY_CHARS = 8_000;

function clip(value: string, limit: number) {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 40).trimEnd()}\n\n[内容过长，已截断]`;
}

function messageBody(message: Message) {
  const text = clip(message.text || "", MAX_MESSAGE_CHARS);
  const imageCount = message.images.length;
  if (!imageCount) return text;
  const images = `[图片：${imageCount} 张，详情请回到原会话查看]`;
  return text ? `${text}\n\n${images}` : images;
}

function roleLabel(role: Message["role"]) {
  return role === "user" ? "用户" : role === "assistant" ? "助手" : "系统";
}

function activityBody(activity: Activity) {
  const detail = clip(activity.detail || "", MAX_ACTIVITY_CHARS);
  const output = activity.output ? `\n\n\`\`\`text\n${clip(activity.output, MAX_ACTIVITY_CHARS)}\n\`\`\`` : "";
  return `${detail}${output}`;
}

export function sessionMarkdown(session: SessionState) {
  const lines = [
    `# ${session.title || "Codex 会话"}`,
    "",
    `- 目录：\`${session.cwd || "无目录"}\``,
    `- 会话 ID：\`${session.threadId || "未创建"}\``,
    `- 导出时间：${new Date().toLocaleString("zh-CN")}`,
    "",
    "## 对话",
    "",
  ];
  for (const message of session.messages) {
    lines.push(`### ${roleLabel(message.role)}`, "", messageBody(message) || "（空消息）", "");
  }
  if (session.activities.length) {
    lines.push("## 活动摘要", "");
    for (const activity of session.activities) {
      lines.push(`### ${activity.title} · ${activity.status}`, "", activityBody(activity) || "（无详情）", "");
    }
  }
  return lines.join("\n").trim();
}

export function handoffMarkdown(session: SessionState) {
  const conversation = sessionMarkdown(session);
  return [
    "# AgentDesk 会话交接",
    "",
    "请先阅读这份交接材料，再根据当前本地代码和 Git 状态继续工作。旧会话内容只作为参考，本地代码优先。",
    "",
    `- 原会话：${session.title || "Codex 会话"}`,
    `- 原目录：\`${session.cwd || "无目录"}\``,
    `- 原会话 ID：\`${session.threadId || "未创建"}\``,
    "",
    "## 原始对话和活动",
    "",
    conversation,
  ].join("\n").trim();
}
