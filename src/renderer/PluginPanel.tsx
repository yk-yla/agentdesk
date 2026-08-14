import { Check, Download, FolderOpen, Package, RefreshCw, Search, Trash2, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import type { AgentOperation, AgentProvider } from "../shared/agentProtocol";
import { providerDisplayName } from "../shared/providerMetadata";
import type { JsonObject } from "../shared/protocol";
import { asRecord, stringValue } from "./domain";

interface PluginRequest {
  (provider: AgentProvider, operation: AgentOperation, params: JsonObject): Promise<unknown>;
}

interface Props {
  cwd: string;
  initialProvider: AgentProvider;
  request: PluginRequest;
  chooseClaudeMarketplaceDirectory: (defaultPath?: string) => Promise<string | null>;
  onClose: () => void;
}

interface PluginEntry {
  id: string;
  name: string;
  marketplace: string;
  marketplacePath: string;
  installed: boolean;
  enabled: boolean;
  version: string;
  localVersion: string;
  shortDescription: string;
  longDescription: string;
  category: string;
  capabilities: string[];
  websiteUrl: string;
  updateAvailable: boolean;
}

interface MarketplaceEntry {
  name: string;
  path: string;
  plugins: PluginEntry[];
}

function isGitMarketplace(marketplace: MarketplaceEntry) {
  // 官方 curated 市场可能带有缓存路径，但不是可通过 marketplace/upgrade 管理的 Git 市场。
  return Boolean(marketplace.path && marketplace.name.trim().toLowerCase() !== "openai-api-curated");
}

interface PluginDetailData {
  plugin: PluginEntry;
  description: string;
  skills: string[];
  apps: string[];
  hooks: string[];
  mcpServers: string[];
  scheduledTasks: string[];
}

function parsePluginSummary(value: unknown, marketplace: string, marketplacePath: string): PluginEntry {
  const plugin = asRecord(value);
  const info = asRecord(plugin.interface);
  return {
    id: stringValue(plugin.id, stringValue(plugin.name)), name: stringValue(plugin.name, "未命名插件"), marketplace, marketplacePath,
    installed: plugin.installed === true, enabled: plugin.enabled !== false, version: stringValue(plugin.version), localVersion: stringValue(plugin.localVersion),
    shortDescription: stringValue(info.shortDescription, "可复用 Codex 工作流"), longDescription: stringValue(info.longDescription), category: stringValue(info.category),
    capabilities: Array.isArray(info.capabilities) ? info.capabilities.map((entry) => stringValue(entry)).filter(Boolean) : [], websiteUrl: stringValue(info.websiteUrl),
    updateAvailable: plugin.updateAvailable === true || Boolean(stringValue(plugin.version) && stringValue(plugin.localVersion) && stringValue(plugin.version) !== stringValue(plugin.localVersion)),
  };
}

function parseMarketplaces(value: unknown): MarketplaceEntry[] {
  const data = asRecord(value);
  return (Array.isArray(data.marketplaces) ? data.marketplaces : []).map((entry) => {
    const marketplace = asRecord(entry);
    const name = stringValue(marketplace.name, "未命名市场");
    const path = stringValue(marketplace.path);
    return { name, path, plugins: (Array.isArray(marketplace.plugins) ? marketplace.plugins : []).map((plugin) => parsePluginSummary(plugin, name, path)) };
  });
}

function namesFrom(value: unknown, field = "name") {
  return Array.isArray(value) ? value.map((entry) => stringValue(asRecord(entry)[field])).filter(Boolean) : [];
}

function parsePluginDetail(value: unknown, fallback: PluginEntry): PluginDetailData {
  const plugin = asRecord(asRecord(value).plugin);
  const summary = asRecord(plugin.summary);
  const marketplace = stringValue(plugin.marketplaceName, fallback.marketplace);
  const marketplacePath = stringValue(plugin.marketplacePath, fallback.marketplacePath);
  const parsedSummary = Object.keys(summary).length ? parsePluginSummary(summary, marketplace, marketplacePath) : fallback;
  const hooks = Array.isArray(plugin.hooks) ? plugin.hooks.map((entry) => {
    const hook = asRecord(entry);
    return [stringValue(hook.eventName), stringValue(hook.key)].filter(Boolean).join(" · ");
  }).filter(Boolean) : [];
  return {
    plugin: { ...fallback, ...parsedSummary, longDescription: stringValue(plugin.description, parsedSummary.longDescription || fallback.longDescription) },
    description: stringValue(plugin.description, parsedSummary.longDescription || fallback.longDescription || fallback.shortDescription),
    skills: namesFrom(plugin.skills),
    apps: namesFrom(plugin.apps),
    hooks,
    mcpServers: Array.isArray(plugin.mcpServers) ? plugin.mcpServers.map((entry) => stringValue(entry)).filter(Boolean) : [],
    scheduledTasks: namesFrom(plugin.scheduledTasks),
  };
}

function PluginPanel({ cwd, initialProvider, request, chooseClaudeMarketplaceDirectory, onClose }: Props) {
  const [provider, setProvider] = useState<AgentProvider>(initialProvider);
  const [marketplaces, setMarketplaces] = useState<MarketplaceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("");
  const [sourceOpen, setSourceOpen] = useState(false);
  const [selected, setSelected] = useState<PluginEntry | null>(null);
  const [detail, setDetail] = useState<PluginDetailData | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState("");

  const load = useCallback(async (forceRefetch = false) => {
    setLoading(true);
    setError("");
    try {
      const value = await request(provider, "listPlugins", { cwd, cwds: cwd ? [cwd] : null, forceRefetch, marketplaceKinds: null });
      setMarketplaces(parseMarketplaces(value));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "插件市场加载失败");
    } finally {
      setLoading(false);
    }
  }, [cwd, provider, request]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!sourceOpen) return undefined;
    const closeSourceOnOutsideMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && (target.closest(".marketplace-add") || target.closest(".marketplace-add-trigger"))) return;
      setSourceOpen(false);
    };
    window.addEventListener("mousedown", closeSourceOnOutsideMouseDown);
    return () => window.removeEventListener("mousedown", closeSourceOnOutsideMouseDown);
  }, [sourceOpen]);

  const plugins = useMemo(() => marketplaces.flatMap((marketplace) => marketplace.plugins), [marketplaces]);
  const gitMarketplaces = useMemo(() => marketplaces.filter(isGitMarketplace), [marketplaces]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? plugins.filter((plugin) => `${plugin.name} ${plugin.shortDescription} ${plugin.category} ${plugin.marketplace}`.toLowerCase().includes(needle)) : plugins;
  }, [plugins, query]);

  const install = async (plugin: PluginEntry) => {
    setBusyId(plugin.id); setError("");
    try {
      await request(provider, "installPlugin", { cwd, pluginName: plugin.name, marketplacePath: plugin.marketplacePath || null, remoteMarketplaceName: provider === "claude" ? plugin.marketplace : plugin.marketplacePath ? null : plugin.marketplace });
      await load(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "插件安装失败"); } finally { setBusyId(""); }
  };

  const uninstall = async (plugin: PluginEntry) => {
    if (!window.confirm(`卸载插件“${plugin.name}”？`)) return;
    setBusyId(plugin.id); setError("");
    try { await request(provider, "uninstallPlugin", { cwd, pluginId: plugin.id }); await load(true); setSelected(null); setDetail(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "插件卸载失败"); }
    finally { setBusyId(""); }
  };

  const addMarketplace = async () => {
    const value = source.trim();
    if (!value) return;
    setBusyId("marketplace"); setError("");
    try { await request(provider, "addMarketplace", { cwd, source: value, refName: null, sparsePaths: null }); setSource(""); setSourceOpen(false); await load(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "添加市场失败"); }
    finally { setBusyId(""); }
  };

  const chooseMarketplaceDirectory = async () => {
    const selected = await chooseClaudeMarketplaceDirectory(source || cwd);
    if (selected) setSource(selected);
  };

  const upgradeMarketplace = async (name?: string) => {
    setBusyId(`upgrade:${name || "all"}`); setError("");
    try { await request(provider, "updateMarketplace", { cwd, marketplaceName: name || null }); await load(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "市场更新失败"); }
    finally { setBusyId(""); }
  };

  const removeMarketplace = async (name: string) => {
    if (!window.confirm(`移除插件市场“${name}”？`)) return;
    setBusyId(`remove:${name}`); setError("");
    try { await request(provider, "removeMarketplace", { cwd, marketplaceName: name }); await load(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "移除市场失败"); }
    finally { setBusyId(""); }
  };

  const closeDetail = () => {
    setSelected(null);
    setDetail(null);
    setDetailError("");
  };

  const readDetail = async (plugin: PluginEntry) => {
    setSelected(plugin);
    setDetail(null);
    setDetailError("");
    setDetailLoading(true);
    try {
      const value = await request(provider, "readPlugin", { cwd, pluginName: plugin.name, marketplacePath: plugin.marketplacePath || null, remoteMarketplaceName: provider === "claude" ? plugin.marketplace : plugin.marketplacePath ? null : plugin.marketplace });
      setDetail(parsePluginDetail(value, plugin));
    } catch (reason) {
      setDetailError(reason instanceof Error ? reason.message : "插件详情读取失败");
    } finally {
      setDetailLoading(false);
    }
  };

  const update = async (plugin: PluginEntry) => {
    setBusyId(plugin.id); setError("");
    try { await request(provider, "updatePlugin", { cwd, pluginId: plugin.id, pluginName: plugin.name, remoteMarketplaceName: plugin.marketplace }); await load(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "插件更新失败"); }
    finally { setBusyId(""); }
  };

  const selectedPlugin = detail?.plugin || selected;
  const detailGroups = detail ? [
    { label: "Skills", items: detail.skills },
    { label: "Apps", items: detail.apps },
    { label: "MCP", items: detail.mcpServers },
    { label: "Hooks", items: detail.hooks },
    { label: "定时任务", items: detail.scheduledTasks },
  ].filter((group) => group.items.length) : [];

  return (
    <div className="plugin-overlay" role="dialog" aria-modal="true" aria-label="插件市场" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="plugin-panel">
        <header className="plugin-header"><div><span className="context-kicker">EXTENSIONS</span><h2><Package size={17} />插件市场</h2></div><button className="icon-button" onClick={onClose} title="关闭插件市场" aria-label="关闭插件市场"><X size={17} /></button></header>
        <div className="plugin-provider-tabs" role="tablist" aria-label="插件 Provider">{(["codex", "claude"] as AgentProvider[]).map((value) => <button key={value} role="tab" aria-selected={provider === value} className={provider === value ? "active" : ""} onClick={() => { setProvider(value); setQuery(""); closeDetail(); }}>{providerDisplayName(value)}</button>)}</div>
        <div className="plugin-toolbar"><label className="history-search"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索插件" /></label><button className="icon-button" onClick={() => void load(true)} disabled={loading} title="刷新插件市场" aria-label="刷新插件市场"><RefreshCw size={14} /></button><button className="request-button secondary marketplace-add-trigger" onClick={() => setSourceOpen((open) => !open)}>添加市场</button></div>
        {sourceOpen ? <div className="marketplace-add"><input value={source} onChange={(event) => setSource(event.target.value)} placeholder="本地路径或 Git URL" />{provider === "claude" ? <button className="icon-button" type="button" onClick={() => void chooseMarketplaceDirectory()} title="选择本地市场目录" aria-label="选择本地市场目录"><FolderOpen size={14} /></button> : null}<button className="request-button primary" disabled={!source.trim() || busyId === "marketplace"} onClick={() => void addMarketplace()}>{busyId === "marketplace" ? "添加中" : "添加"}</button></div> : null}
        {error ? <div className="plugin-error" role="alert">{error}</div> : null}
        <div className="plugin-scroll">{loading ? <div className="plugin-empty">正在加载插件市场</div> : filtered.length ? filtered.map((plugin) => <article className="plugin-card" key={`${plugin.marketplace}:${plugin.id}`}>
          <div className="plugin-card-heading"><div className="plugin-mark"><Package size={16} /></div><div className="plugin-copy"><strong>{plugin.name}</strong><span>{plugin.shortDescription}</span></div><span className={`plugin-state ${plugin.installed ? "installed" : ""}`}>{plugin.installed ? <><Check size={11} />已安装</> : "可安装"}</span></div>
          <div className="plugin-meta"><span>{plugin.marketplace}</span>{plugin.category ? <span>{plugin.category}</span> : null}{plugin.version ? <span>v{plugin.version}</span> : null}</div>
          {plugin.capabilities.length ? <div className="plugin-capabilities">{plugin.capabilities.slice(0, 5).map((capability) => <span key={capability}>{capability}</span>)}</div> : null}
          <div className="plugin-actions"><button className="request-button secondary" onClick={() => void readDetail(plugin)}>详情</button>{plugin.installed ? <>{provider === "claude" ? <button className="request-button secondary" disabled={busyId === plugin.id} onClick={() => void update(plugin)}><RefreshCw size={12} />更新</button> : null}<button className="request-button secondary danger-button" disabled={busyId === plugin.id} onClick={() => void uninstall(plugin)}><Trash2 size={12} />卸载</button></> : <button className="request-button primary" disabled={busyId === plugin.id} onClick={() => void install(plugin)}><Download size={12} />{busyId === plugin.id ? "安装中" : "安装"}</button>}</div>
        </article>) : <div className="plugin-empty">没有匹配的插件</div>}</div>
        <footer className="marketplace-footer"><span>{marketplaces.length} 个市场 · {plugins.length} 个插件</span>{gitMarketplaces.length ? <div>{gitMarketplaces.map((marketplace) => <button className="bare-button" key={marketplace.name} onClick={() => void upgradeMarketplace(marketplace.name)} disabled={busyId === `upgrade:${marketplace.name}`}>更新 {marketplace.name}</button>)}<button className="bare-button" onClick={() => void upgradeMarketplace()} disabled={busyId === "upgrade:all"}>全部更新</button>{gitMarketplaces.map((marketplace) => <button className="bare-button danger-button" key={`remove-${marketplace.name}`} onClick={() => void removeMarketplace(marketplace.name)} disabled={busyId === `remove:${marketplace.name}`}>移除 {marketplace.name}</button>)}</div> : null}</footer>
      </section>
      {selectedPlugin ? <div className="plugin-detail-overlay" onMouseDown={closeDetail}><article className="plugin-detail" onMouseDown={(event) => event.stopPropagation()}><button className="icon-button plugin-detail-close" onClick={closeDetail} title="关闭详情" aria-label="关闭详情"><X size={15} /></button><div className="plugin-mark large"><Package size={20} /></div><h3>{selectedPlugin.name}</h3><p>{detail?.description || selectedPlugin.longDescription || selectedPlugin.shortDescription}</p><div className="plugin-meta"><span>{selectedPlugin.marketplace}</span>{selectedPlugin.localVersion ? <span>本地 v{selectedPlugin.localVersion}</span> : selectedPlugin.version ? <span>v{selectedPlugin.version}</span> : null}</div>{detailLoading ? <div className="plugin-detail-loading">正在读取完整详情</div> : null}{detailError ? <div className="plugin-error" role="alert">{detailError}</div> : null}{detailGroups.length ? <div className="plugin-detail-groups">{detailGroups.map((group) => <section key={group.label}><strong>{group.label}</strong><div>{group.items.map((item) => <span key={item}>{item}</span>)}</div></section>)}</div> : null}{selectedPlugin.capabilities.length ? <div className="plugin-capabilities">{selectedPlugin.capabilities.map((capability) => <span key={capability}>{capability}</span>)}</div> : null}<div className="plugin-actions">{selectedPlugin.installed && provider === "claude" ? <button className="request-button secondary" disabled={busyId === selectedPlugin.id} onClick={() => void update(selectedPlugin)}><RefreshCw size={12} />更新</button> : null}{selectedPlugin.installed ? <button className="request-button secondary danger-button" disabled={busyId === selectedPlugin.id} onClick={() => void uninstall(selectedPlugin)}><Trash2 size={12} />卸载</button> : <button className="request-button primary" disabled={busyId === selectedPlugin.id} onClick={() => void install(selectedPlugin)}><Download size={12} />{busyId === selectedPlugin.id ? "安装中" : "安装"}</button>}</div></article></div> : null}
    </div>
  );
}

export default memo(PluginPanel);
