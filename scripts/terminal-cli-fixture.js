const readline = require("node:readline");

process.stdout.write("\x1b[2J\x1b[HAgentDesk terminal fixture ready\r\n");
process.stdout.write("fixture> ");

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  const value = String(line);
  if (value === "AGENTDESK_TERMINAL_PING") {
    process.stdout.write("\r\nAGENTDESK_TERMINAL_PONG\r\nfixture> ");
    return;
  }
  process.stdout.write("\r\nfixture received: " + value.slice(0, 200) + "\r\nfixture> ");
});

process.on("SIGINT", () => {
  process.stdout.write("\r\nAGENTDESK_TERMINAL_INTERRUPTED\r\n");
  process.exit(130);
});
