import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AppLogger } from "../../logger";

const TITLE_TIMEOUT_MS = 90_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_ACTIVE_GENERATORS = 2;
const MAX_TITLE_LENGTH = 80;

export interface CodexTitleGeneratorOptions {
  command(): string;
  terminateTree(child: ChildProcessWithoutNullStreams): Promise<void>;
  track?(child: ChildProcessWithoutNullStreams): void;
  isRequestBlocked?(): boolean;
  isQuitting?(): boolean;
  logger?: AppLogger;
}

export interface CodexTitleRequest {
  sessionId: string;
  cwd: string;
  conversation: string;
}

function spawnSpec(command: string) {
  const args = ["exec", "--ephemeral", "--sandbox", "read-only", "--json", "--color", "never", "--skip-git-repo-check", "--ignore-rules"];
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", `""${command}" ${args.join(" ")}"`],
      windowsVerbatimArguments: true,
    };
  }
  return { command, args, windowsVerbatimArguments: false };
}

function titlePrompt(conversation: string) {
  return [
    "你是会话标题生成器。请根据下面的会话内容生成一个适合显示在会话列表中的中文标题。",
    "只输出标题本身，不要解释、引号、Markdown 或换行。标题应概括主要任务，12 到 24 个汉字为宜，最多 30 个字符。",
    "如果内容包含多个主题，优先概括最早且最核心的任务。",
    "",
    "会话内容：",
    conversation,
  ].join("\n");
}

function normalizeTitle(value: string) {
  const firstLine = value.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  const withoutMarkdown = firstLine.replace(/^```(?:text|json)?\s*/i, "").replace(/```$/g, "").trim();
  const withoutQuotes = withoutMarkdown.replace(/^["“”'‘’]+|["“”'‘’]+$/g, "").trim();
  const oneLine = withoutQuotes.replace(/\s+/g, " ").trim();
  return oneLine.slice(0, MAX_TITLE_LENGTH);
}

function titleFromJsonLine(line: string) {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const item = value.item && typeof value.item === "object" && !Array.isArray(value.item) ? value.item as Record<string, unknown> : {};
    if (value.type === "item.completed" && item.type === "agent_message") return typeof item.text === "string" ? item.text : "";
    if (value.type === "agent_message") return typeof value.text === "string" ? value.text : "";
    return "";
  } catch {
    return "";
  }
}

function titleFromOutput(stdout: string) {
  let title = "";
  for (const line of stdout.split(/\r?\n/)) {
    const candidate = titleFromJsonLine(line.trim());
    if (candidate) title = candidate;
  }
  return normalizeTitle(title);
}

export function normalizeCodexGeneratedTitle(value: string) {
  return normalizeTitle(value);
}

export class CodexTitleGenerator {
  private readonly active = new Map<string, ChildProcessWithoutNullStreams>();

  constructor(private readonly options: CodexTitleGeneratorOptions) {}

  get processIds() {
    return [...this.active.values()].flatMap((child) => child.pid ? [child.pid] : []);
  }

  async generate(request: CodexTitleRequest) {
    if (this.options.isRequestBlocked?.()) throw new Error("Codex CLI 正在更新，请稍后重试。");
    if (this.options.isQuitting?.()) throw new Error("AgentDesk 正在退出，无法生成会话标题。");
    if (!request.sessionId || !request.cwd || !request.conversation.trim()) throw new Error("Codex 标题请求内容为空。");
    if (this.active.has(request.sessionId)) throw new Error("该会话已有标题请求正在执行。");
    if (this.active.size >= MAX_ACTIVE_GENERATORS) throw new Error("标题生成请求过多，请稍后重试。");

    const command = this.options.command().trim();
    if (!command) throw new Error("未找到 Codex CLI，无法生成会话标题。");
    const spec = spawnSpec(command);
    const child = spawn(spec.command, spec.args, {
      cwd: request.cwd,
      env: { ...process.env },
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    this.active.set(request.sessionId, child);
    this.options.track?.(child);

    return await new Promise<string>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let terminating = false;
      const finish = (error?: Error, title?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.active.get(request.sessionId) === child) this.active.delete(request.sessionId);
        if (error) reject(error);
        else if (title) resolve(title);
        else reject(new Error("Codex 没有返回有效的会话标题。"));
      };
      const terminate = () => {
        if (terminating || child.exitCode !== null || child.killed) return;
        terminating = true;
        void this.options.terminateTree(child).catch(() => undefined);
      };
      const timer = setTimeout(() => {
        terminate();
        finish(new Error("Codex 会话标题生成超时。"));
      }, TITLE_TIMEOUT_MS);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout, "utf8") > MAX_STDOUT_BYTES) {
          terminate();
          finish(new Error("Codex 会话标题输出过大。"));
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_BYTES);
      });
      child.once("error", (error) => finish(error instanceof Error ? error : new Error("Codex 标题进程启动失败。")));
      child.once("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          this.options.logger?.log("warn", "codex.title_generator.failed", { sessionId: request.sessionId, exitCode: code, stderrBytes: Buffer.byteLength(stderr, "utf8") });
          finish(new Error("Codex 会话标题生成失败。"));
          return;
        }
        finish(undefined, titleFromOutput(stdout));
      });
      try {
        child.stdin.end(titlePrompt(request.conversation));
      } catch (error) {
        finish(error instanceof Error ? error : new Error("Codex 标题请求发送失败。"));
      }
    });
  }

  cancel(sessionId: string) {
    const child = this.active.get(sessionId);
    if (!child) return;
    void this.options.terminateTree(child).catch(() => undefined);
  }

  async close() {
    const children = [...this.active.values()];
    await Promise.all(children.map((child) => this.options.terminateTree(child).catch(() => undefined)));
  }
}
