const readline = require("node:readline");

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function resultFor(method) {
  if (method === "initialize") return { userAgent: "agentdesk-package-fixture/1.0" };
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
  process.stdout.write(`${JSON.stringify({ id: message.id, result: resultFor(message.method) })}\n`);
});
