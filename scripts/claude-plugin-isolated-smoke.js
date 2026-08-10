const assert = require("node:assert/strict");
const {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ClaudeWorkerHost } = require(path.resolve("build/electron/main/providers/claude/claudeWorkerHost.js"));

const workspace = path.resolve(process.cwd());
const workerFile = path.resolve("build/electron/main/providers/claude/claudeWorker.mjs");
const executablePath = path.resolve("node_modules/@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe");
const pluginName = "agentdesk-b4-plugin";
const marketplaceName = "agentdesk-b4-market";

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createMarketplace(root, version) {
  const marketplace = path.join(root, "marketplace");
  const plugin = path.join(marketplace, "plugins", pluginName);
  writeJson(path.join(marketplace, ".claude-plugin", "marketplace.json"), {
    name: marketplaceName,
    owner: { name: "AgentDesk isolated tests" },
    plugins: [{
      name: pluginName,
      source: `./plugins/${pluginName}`,
      description: "AgentDesk isolated plugin fixture",
      version,
    }],
  });
  writeJson(path.join(plugin, ".claude-plugin", "plugin.json"), {
    name: pluginName,
    version,
    description: "AgentDesk isolated plugin fixture",
    author: { name: "AgentDesk isolated tests" },
  });
  mkdirSync(path.join(plugin, "commands"), { recursive: true });
  writeFileSync(path.join(plugin, "commands", "fixture.md"), "---\ndescription: AgentDesk isolated fixture command\n---\n\nFixture command.\n", "utf8");
  return marketplace;
}

function snapshotTree(root) {
  const result = [];
  const visit = (current) => {
    if (!existsSync(current)) return;
    const stat = statSync(current);
    const relative = path.relative(root, current);
    result.push(`${relative}\t${stat.isDirectory() ? "d" : "f"}\t${stat.size}\t${stat.mtimeMs}`);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(current)) visit(path.join(current, entry));
    }
  };
  visit(root);
  return result.sort();
}

function findMarketplace(value) {
  return value?.marketplaces?.find((entry) => entry.name === marketplaceName);
}

function findPlugin(value) {
  return findMarketplace(value)?.plugins?.find((entry) => entry.name === pluginName);
}

async function main() {
  assert(existsSync(workerFile), `找不到已编译 Claude Worker：${workerFile}`);
  assert(existsSync(executablePath), `找不到 Claude Code CLI：${executablePath}`);
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "agentdesk-claude-plugin-"));
  const configDir = path.join(tempRoot, "config");
  mkdirSync(configDir, { recursive: true });
  const realConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const realPluginState = path.join(realConfigDir, "plugins");
  const realBefore = [snapshotTree(path.join(realConfigDir, "settings.json")), snapshotTree(realPluginState)];
  let host = new ClaudeWorkerHost(() => workerFile);
  const request = (operation, extra = {}) => host.request({
    type: "plugin",
    operation,
    cwd: workspace,
    executablePath,
    configDir,
    ...extra,
  });

  try {
    const marketplace = createMarketplace(tempRoot, "1.0.0");
    const initial = await request("list");
    assert.equal(findMarketplace(initial), undefined, "隔离配置初始不应存在测试市场。");

    await request("marketplaceAdd", { source: marketplace });
    const added = await request("list");
    const addedMarket = findMarketplace(added);
    assert.ok(addedMarket, "添加本地测试市场后列表中没有该市场。");
    assert.equal(findPlugin(added)?.installed, false, "测试插件添加后不应被标记为已安装。");
    assert.equal(findPlugin(added)?.version, "1.0.0", "测试插件初始版本不正确。");

    const pluginId = `${pluginName}@${marketplaceName}`;
    await request("install", { plugin: pluginId });
    const installed = await request("list");
    assert.equal(findPlugin(installed)?.installed, true, `测试插件安装后没有显示已安装：${JSON.stringify(installed)}`);
    await host.close();
    host = new ClaudeWorkerHost(() => workerFile);
    const installedAfterRestart = await request("list");
    assert.equal(findPlugin(installedAfterRestart)?.installed, true, "重启 Claude Worker 后已安装插件状态没有保留。");
    const details = await request("details", { plugin: pluginId });
    assert.equal(details?.plugin?.name, pluginId, "插件详情名称不正确。");

    createMarketplace(tempRoot, "1.1.0");
    await request("update", { plugin: pluginId });
    const updated = await request("list");
    const updatedPlugin = findPlugin(updated);
    assert.equal(updatedPlugin?.installed, true, "测试插件更新后没有保持已安装。");
    assert.equal(updatedPlugin?.localVersion || updatedPlugin?.version, "1.1.0", "测试插件更新后版本没有变为 1.1.0。");

    await request("uninstall", { plugin: pluginId });
    const uninstalled = await request("list");
    assert.equal(findPlugin(uninstalled)?.installed, false, "测试插件卸载后仍显示已安装。");

    await request("marketplaceRemove", { marketplace: marketplaceName });
    const removed = await request("list");
    assert.equal(findMarketplace(removed), undefined, "移除测试市场后列表中仍有该市场。");
    assert(snapshotTree(configDir).length > 1, "隔离配置目录没有产生 Claude 插件管理状态。");

    const realAfter = [snapshotTree(path.join(realConfigDir, "settings.json")), snapshotTree(realPluginState)];
    assert.deepEqual(realAfter, realBefore, "插件专项回归修改了用户真实 Claude 配置。");
    console.log(JSON.stringify({ ok: true, results: ["隔离配置列表、安装、详情、更新、卸载和移除市场闭环通过", "用户真实 Claude 配置前后指纹一致"] }));
  } finally {
    await host.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
