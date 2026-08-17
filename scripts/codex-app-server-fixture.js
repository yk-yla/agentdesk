const readline = require("node:readline");

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

const restartFixtureEnabled = process.env.AGENTDESK_RESTART_CONTENT_FIXTURE === "1";
const restartThreadId = "agentdesk-restart-content-fixture";

function restartThread(cwd) {
  return {
    id: restartThreadId,
    cwd,
    name: "AgentDesk restart content fixture",
    updatedAt: Date.now() / 1000,
    createdAt: Date.now() / 1000 - 60,
    source: "appServer",
    turns: [{
      id: "restart-turn",
      status: "completed",
      startedAt: Date.now() / 1000 - 30,
      completedAt: Date.now() / 1000 - 20,
      items: [
        { id: "restart-user", type: "userMessage", content: [{ type: "text", text: "AgentDesk restart history request" }] },
        { id: "restart-agent", type: "agentMessage", text: "AgentDesk restart restored content" },
      ],
    }],
  };
}

function resultFor(method, params = {}) {
  if (method === "initialize") return { userAgent: "agentdesk-package-fixture/1.0" };
  if (method === "thread/list" && restartFixtureEnabled) {
    return { data: [restartThread(params.cwd || process.cwd())], nextCursor: null };
  }
  if ((method === "thread/read" || method === "thread/resume") && restartFixtureEnabled && params.threadId === restartThreadId) {
    return { thread: restartThread(params.cwd || process.cwd()), model: "", reasoningEffort: "medium" };
  }
  if (["model/list", "skills/list", "collaborationMode/list", "thread/list"].includes(method)) {
    return { data: [], nextCursor: null };
  }
  if (method === "mcpServerStatus/list") return { data: [] };
  return {};
}

input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || typeof message.method !== "string") return;
  process.stdout.write(`${JSON.stringify({ id: message.id, result: resultFor(message.method, message.params) })}\n`);
});
