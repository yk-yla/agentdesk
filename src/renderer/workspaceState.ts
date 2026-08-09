import type { AgentBridge, JsonObject } from "../shared/protocol";
import {
  asRecord, emptySession, numberValue, sameDirectory, stringValue,
  type ImageAttachment, type LayoutState, type PaneState, type PendingSteerMessage, type QueuedMessage, type SessionState, type SkillOption,
} from "./domain";

const UPDATE_WORKSPACE_STATE_VERSION = 1;
const UPDATE_WORKSPACE_STATE_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_RESTORED_SESSIONS = 60;
const MAX_SAVED_TEXT_BYTES = 2_500_000;
const MAX_SAVED_IMAGES = 256;
const MAX_SAVED_QUEUED_MESSAGES = 500;
function takeUtf8Prefix(value: string, maxBytes: number) {
  let byteLength = 0;
  let index = 0;
  while (index < value.length) {
    const codePoint = value.codePointAt(index) || 0;
    const characterBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    if (byteLength + characterBytes > maxBytes) break;
    byteLength += characterBytes;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return { text: value.slice(0, index), byteLength };
}

export interface SavedImageReference {
  path: string;
  name: string;
}

export interface SavedQueuedMessage {
  id: string;
  text: string;
  inputText?: string;
  images: SavedImageReference[];
  skills?: Array<Pick<SkillOption, "name" | "path">>;
  clientUserMessageId?: string;
  queueKind?: "explicit" | "rejectedSteer";
  sequence?: number;
}

export interface RestoredWorkspaceState {
  sessions: Record<string, SessionState>;
  layout: LayoutState;
  drafts: Map<string, string>;
  attachments: Record<string, SavedImageReference[]>;
  queuedMessages: Record<string, SavedQueuedMessage[]>;
  sidebarCollapsed: boolean;
  threadSessionIds: string[];
  truncated: boolean;
}

function stateId(value: unknown) {
  const id = stringValue(value).slice(0, 240);
  return /^[a-z0-9][a-z0-9_-]{0,239}$/i.test(id) ? id : "";
}

export function createUpdateWorkspaceState(input: {
  workspace: string;
  layout: LayoutState;
  sessions: Record<string, SessionState>;
  drafts: Map<string, string>;
  attachments: Record<string, ImageAttachment[]>;
  queuedMessages: Record<string, QueuedMessage[]>;
  pendingSteers: Record<string, PendingSteerMessage[]>;
  sidebarCollapsed: boolean;
}): JsonObject {
  let remainingTextBytes = MAX_SAVED_TEXT_BYTES;
  let remainingImages = MAX_SAVED_IMAGES;
  let remainingQueuedMessages = MAX_SAVED_QUEUED_MESSAGES;
  let truncated = false;
  const takeText = (value: string, fieldLimit: number) => {
    const allowedBytes = Math.max(0, Math.min(fieldLimit * 4, remainingTextBytes));
    const taken = takeUtf8Prefix(value, allowedBytes);
    const next = taken.text;
    if (next.length < value.length) truncated = true;
    remainingTextBytes -= taken.byteLength;
    return next;
  };
  const takeImages = (images: ImageAttachment[]) => {
    const allowed = Math.max(0, Math.min(images.length, remainingImages));
    if (allowed < images.length) truncated = true;
    remainingImages -= allowed;
    return images.slice(0, allowed).map((image) => ({ path: image.path.slice(0, 2_000), name: image.name.slice(0, 500) }));
  };
  const sessionIds = [...new Set(input.layout.panes.flatMap((pane) => pane.tabIds))]
    .filter((sessionId) => Boolean(input.sessions[sessionId]))
    .slice(0, MAX_RESTORED_SESSIONS);
  const allowedSessionIds = new Set(sessionIds);
  const panes = input.layout.panes.slice(0, 3).map((pane) => {
    const tabIds = pane.tabIds.filter((sessionId) => allowedSessionIds.has(sessionId));
    return { id: pane.id, tabIds, activeTabId: tabIds.includes(pane.activeTabId) ? pane.activeTabId : tabIds[0] };
  }).filter((pane) => pane.tabIds.length);
  const activePaneId = panes.some((pane) => pane.id === input.layout.activePaneId) ? input.layout.activePaneId : panes[0]?.id || "";
  const queuedMessages = Object.fromEntries(sessionIds.map((sessionId) => {
    const pending = (input.pendingSteers[sessionId] || []).map((message) => ({ ...message, queueKind: "rejectedSteer" as const }));
    const sourceQueue = [...(input.queuedMessages[sessionId] || []), ...pending];
    const allowed = Math.max(0, Math.min(sourceQueue.length, remainingQueuedMessages, 100));
    if (allowed < sourceQueue.length) truncated = true;
    remainingQueuedMessages -= allowed;
    const queue = sourceQueue.slice(0, allowed).map((message) => {
      const text = takeText(message.text, 200_000);
      const inputText = message.inputText ? takeText(message.inputText, 200_000) : "";
      const images = takeImages(message.images);
      const skills = (message.skills || []).slice(0, 16).map((skill) => ({
        name: takeText(skill.name, 200),
        path: takeText(skill.path, 2_000),
      })).filter((skill) => skill.name && skill.path);
      return {
        id: message.id.slice(0, 240),
        text,
        ...(inputText ? { inputText } : {}),
        images,
        ...(skills.length ? { skills } : {}),
        ...(message.clientUserMessageId ? { clientUserMessageId: message.clientUserMessageId.slice(0, 240) } : {}),
        ...(message.queueKind ? { queueKind: message.queueKind } : {}),
        ...(typeof message.sequence === "number" ? { sequence: message.sequence } : {}),
      };
    }).filter((message) => message.id && (message.text || message.images.length));
    return [sessionId, queue];
  }).filter(([, queue]) => (queue as SavedQueuedMessage[]).length));
  const drafts = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, takeText(input.drafts.get(sessionId) || "", 200_000)]).filter(([, draft]) => draft));
  const attachments = Object.fromEntries(sessionIds.map((sessionId) => [sessionId, takeImages(input.attachments[sessionId] || [])]).filter(([, images]) => (images as SavedImageReference[]).length));
  return {
    version: UPDATE_WORKSPACE_STATE_VERSION,
    savedAt: Date.now(),
    workspace: input.workspace,
    layout: { panes, activePaneId },
    sessions: sessionIds.map((sessionId) => {
      const session = input.sessions[sessionId];
      return {
        id: session.id,
        threadId: session.threadId || "",
        cwd: session.cwd.slice(0, 2_000),
        title: session.title.slice(0, 500),
        updatedAt: session.updatedAt,
        model: session.model,
        effort: session.effort,
        collaborationMode: session.collaborationMode,
        detailsOpen: session.detailsOpen,
        detailView: session.detailView,
        wasWorking: session.status === "working",
      };
    }),
    drafts,
    attachments,
    queuedMessages,
    sidebarCollapsed: input.sidebarCollapsed,
    truncated,
  } as unknown as JsonObject;
}

function parseSavedImageReferences(value: unknown): SavedImageReference[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).map((item) => {
    const image = asRecord(item);
    return { path: stringValue(image.path).slice(0, 32_000), name: stringValue(image.name, "图片").slice(0, 500) };
  }).filter((image) => image.path.length > 0);
}

function parseSavedQueuedMessages(value: unknown): SavedQueuedMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((item) => {
    const message = asRecord(item);
    const rawSkills = Array.isArray(message.skills) ? message.skills : [];
    const skills = rawSkills.slice(0, 16).map((rawSkill) => {
      const skill = asRecord(rawSkill);
      return { name: stringValue(skill.name).slice(0, 200), path: stringValue(skill.path).slice(0, 32_000) };
    }).filter((skill) => skill.name && skill.path);
    const queueKind: SavedQueuedMessage["queueKind"] = message.queueKind === "explicit" || message.queueKind === "rejectedSteer" ? message.queueKind : undefined;
    const sequence = typeof message.sequence === "number" && Number.isFinite(message.sequence) ? message.sequence : undefined;
    return {
      id: stateId(message.id),
      text: stringValue(message.text).slice(0, 200_000),
      ...(typeof message.inputText === "string" ? { inputText: message.inputText.slice(0, 200_000) } : {}),
      images: parseSavedImageReferences(message.images),
      ...(skills.length ? { skills } : {}),
      ...(typeof message.clientUserMessageId === "string" ? { clientUserMessageId: message.clientUserMessageId.slice(0, 240) } : {}),
      ...(queueKind ? { queueKind } : {}),
      ...(sequence !== undefined ? { sequence } : {}),
    };
  }).filter((message) => message.id && (message.text || message.images.length));
}

export function parseUpdateWorkspaceState(value: unknown, currentWorkspace: string): RestoredWorkspaceState | null {
  const state = asRecord(value);
  const savedAt = numberValue(state.savedAt);
  if (numberValue(state.version) !== UPDATE_WORKSPACE_STATE_VERSION || !savedAt || Date.now() - savedAt > UPDATE_WORKSPACE_STATE_MAX_AGE_MS || savedAt > Date.now() + 60_000) return null;
  const savedWorkspace = stringValue(state.workspace);
  if (savedWorkspace && currentWorkspace && !sameDirectory(savedWorkspace, currentWorkspace)) return null;

  const sessionValues = Array.isArray(state.sessions) ? state.sessions.slice(0, MAX_RESTORED_SESSIONS) : [];
  const sessions: Record<string, SessionState> = {};
  for (const value of sessionValues) {
    const saved = asRecord(value);
    const id = stateId(saved.id);
    const cwd = stringValue(saved.cwd, currentWorkspace).slice(0, 32_000);
    if (!id || !cwd || sessions[id]) continue;
    const session = emptySession(id, cwd, stringValue(saved.model).slice(0, 240), stringValue(saved.effort, "medium").slice(0, 80));
    session.threadId = stringValue(saved.threadId).slice(0, 240) || null;
    session.title = stringValue(saved.title, "新会话").slice(0, 500);
    const savedUpdatedAt = numberValue(saved.updatedAt);
    if (savedUpdatedAt > 0 && savedUpdatedAt <= Date.now() + 60_000) session.updatedAt = savedUpdatedAt;
    session.collaborationMode = saved.collaborationMode === "plan" ? "plan" : "default";
    session.detailsOpen = saved.detailsOpen === true;
    if (["activity", "raw", "goal", "plan", "agents"].includes(stringValue(saved.detailView))) session.detailView = stringValue(saved.detailView) as SessionState["detailView"];
    session.resumed = false;
    if (saved.wasWorking === true) {
      session.status = "error";
      session.statusLabel = "任务已停止";
      session.errorText = "软件更新已完成，上次正在执行的任务已停止。";
    }
    sessions[id] = session;
  }

  const layoutValue = asRecord(state.layout);
  const paneValues = Array.isArray(layoutValue.panes) ? layoutValue.panes.slice(0, 3) : [];
  const usedSessionIds = new Set<string>();
  const usedPaneIds = new Set<string>();
  const panes: PaneState[] = [];
  for (const value of paneValues) {
    const saved = asRecord(value);
    const id = stateId(saved.id);
    if (!id || usedPaneIds.has(id)) continue;
    const rawTabIds = Array.isArray(saved.tabIds) ? saved.tabIds : [];
    const tabIds = rawTabIds.map(stateId).filter((tabId) => sessions[tabId] && !usedSessionIds.has(tabId));
    if (!tabIds.length) continue;
    tabIds.forEach((tabId) => usedSessionIds.add(tabId));
    usedPaneIds.add(id);
    const savedActiveTabId = stateId(saved.activeTabId);
    panes.push({ id, tabIds, activeTabId: tabIds.includes(savedActiveTabId) ? savedActiveTabId : tabIds[0] });
  }
  if (!panes.length) return null;
  for (const sessionId of Object.keys(sessions)) if (!usedSessionIds.has(sessionId)) delete sessions[sessionId];
  const savedActivePaneId = stateId(layoutValue.activePaneId);
  const layout = { panes, activePaneId: panes.some((pane) => pane.id === savedActivePaneId) ? savedActivePaneId : panes[0].id };
  const draftsValue = asRecord(state.drafts);
  const drafts = new Map<string, string>();
  for (const sessionId of usedSessionIds) {
    const draft = typeof draftsValue[sessionId] === "string" ? draftsValue[sessionId].slice(0, 200_000) : "";
    if (draft) drafts.set(sessionId, draft);
  }
  const attachmentsValue = asRecord(state.attachments);
  const queuedMessagesValue = asRecord(state.queuedMessages);
  const attachments = Object.fromEntries([...usedSessionIds].map((sessionId) => [sessionId, parseSavedImageReferences(attachmentsValue[sessionId])]).filter(([, images]) => (images as SavedImageReference[]).length));
  const queuedMessages = Object.fromEntries([...usedSessionIds].map((sessionId) => [sessionId, parseSavedQueuedMessages(queuedMessagesValue[sessionId])]).filter(([, queue]) => (queue as SavedQueuedMessage[]).length));
  return {
    sessions,
    layout,
    drafts,
    attachments,
    queuedMessages,
    sidebarCollapsed: state.sidebarCollapsed === true,
    threadSessionIds: [...usedSessionIds].filter((sessionId) => Boolean(sessions[sessionId]?.threadId)),
    truncated: state.truncated === true,
  };
}

export async function loadSavedImages(bridge: AgentBridge, images: SavedImageReference[]): Promise<ImageAttachment[]> {
  const restored = await Promise.all(images.map(async (image) => {
    const dataUrl = await bridge.readLocalImage(image.path).catch(() => null);
    return dataUrl ? { ...image, dataUrl } : null;
  }));
  return restored.filter((image): image is ImageAttachment => Boolean(image));
}
