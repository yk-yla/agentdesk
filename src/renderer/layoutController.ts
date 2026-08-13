import type { AgentProvider } from "../shared/agentProtocol";
import type { LayoutState, SessionState } from "./domain";

export interface SessionCreationOptions {
  threadId?: string;
  title?: string;
  provider?: AgentProvider;
}

export type TabDropPosition = "before" | "after";

export interface TabDropTarget {
  paneId: string;
  sessionId: string;
  position: TabDropPosition;
}

export interface LayoutControllerState {
  getLayout(): LayoutState;
  updateLayout(updater: (current: LayoutState) => LayoutState): void;
  getSession(sessionId: string): SessionState | undefined;
}

export interface LayoutControllerServices {
  createSession(cwd: string, options?: SessionCreationOptions): string;
  confirmClose(sessionIds: string[]): boolean;
  closeSession(sessionId: string): Promise<void>;
  releaseSession(sessionId: string, reason?: string): void;
  closeContextMenu(): void;
  now?: () => number;
}

export class LayoutController {
  private paneSequence = 1;

  constructor(
    private readonly state: LayoutControllerState,
    private readonly services: LayoutControllerServices,
  ) {}

  private nextPaneId() {
    this.paneSequence += 1;
    return `pane-${this.services.now?.() ?? Date.now()}-${this.paneSequence}`;
  }

  readonly addSession = (cwd: string, options?: SessionCreationOptions) => {
    const sessionId = this.services.createSession(cwd, options);
    this.state.updateLayout((current) => {
      const pane = current.panes.find((entry) => entry.id === current.activePaneId) ?? current.panes[0];
      if (!pane) return current;
      return {
        ...current,
        panes: current.panes.map((entry) => entry.id === pane.id
          ? { ...entry, tabIds: [...entry.tabIds, sessionId], activeTabId: sessionId }
          : entry),
      };
    });
    return sessionId;
  };

  readonly addSessionToPane = (paneId: string, cwd: string, options?: SessionCreationOptions, afterSessionId?: string) => {
    const pane = this.state.getLayout().panes.find((entry) => entry.id === paneId);
    if (!pane) return this.addSession(cwd, options);
    const sessionId = this.services.createSession(cwd, options);
    this.state.updateLayout((current) => ({
      ...current,
      activePaneId: paneId,
      panes: current.panes.map((entry) => {
        if (entry.id !== paneId) return entry;
        const tabIds = [...entry.tabIds];
        const afterIndex = afterSessionId ? tabIds.indexOf(afterSessionId) : -1;
        tabIds.splice(afterIndex >= 0 ? afterIndex + 1 : tabIds.length, 0, sessionId);
        return { ...entry, tabIds, activeTabId: sessionId };
      }),
    }));
    return sessionId;
  };

  readonly activateSession = (sessionId: string) => {
    this.state.updateLayout((current) => {
      const pane = current.panes.find((candidate) => candidate.tabIds.includes(sessionId));
      return pane
        ? { ...current, activePaneId: pane.id, panes: current.panes.map((candidate) => candidate.id === pane.id ? { ...candidate, activeTabId: sessionId } : candidate) }
        : current;
    });
  };

  readonly focusPane = (paneId: string) => {
    this.state.updateLayout((current) => current.activePaneId === paneId ? current : { ...current, activePaneId: paneId });
  };

  readonly setActiveTab = (paneId: string, sessionId: string) => {
    this.state.updateLayout((current) => {
      const pane = current.panes.find((entry) => entry.id === paneId);
      if (!pane?.tabIds.includes(sessionId)) return current;
      return { ...current, activePaneId: paneId, panes: current.panes.map((entry) => entry.id === paneId ? { ...entry, activeTabId: sessionId } : entry) };
    });
  };

  readonly replaceSession = (sessionId: string, nextSessionId: string) => {
    this.state.updateLayout((current) => ({
      ...current,
      panes: current.panes.map((pane) => pane.tabIds.includes(sessionId)
        ? { ...pane, tabIds: pane.tabIds.map((id) => id === sessionId ? nextSessionId : id), activeTabId: pane.activeTabId === sessionId ? nextSessionId : pane.activeTabId }
        : pane),
    }));
  };

  readonly removeTab = async (paneId: string, sessionId: string) => {
    const pane = this.state.getLayout().panes.find((entry) => entry.id === paneId);
    if (!pane || pane.tabIds.length <= 1 || !pane.tabIds.includes(sessionId)) return false;
    if (!this.services.confirmClose([sessionId])) return false;
    try { await this.services.closeSession(sessionId); } catch { return false; }
    this.state.updateLayout((current) => {
      const target = current.panes.find((entry) => entry.id === paneId);
      if (!target || target.tabIds.length <= 1) return current;
      const tabIds = target.tabIds.filter((id) => id !== sessionId);
      return {
        ...current,
        panes: current.panes.map((entry) => entry.id === paneId
          ? { ...entry, tabIds, activeTabId: entry.activeTabId === sessionId ? tabIds[tabIds.length - 1] : entry.activeTabId }
          : entry),
      };
    });
    this.services.releaseSession(sessionId);
    return true;
  };

  readonly closeTabIds = async (paneId: string, sessionIds: string[]) => {
    const pane = this.state.getLayout().panes.find((entry) => entry.id === paneId);
    if (!pane) return [];
    const closing = new Set(pane.tabIds.filter((id) => sessionIds.includes(id)));
    const retained = pane.tabIds.filter((id) => !closing.has(id));
    if (!closing.size || !retained.length || !this.services.confirmClose([...closing])) return [];
    const closingIds = [...closing];
    const settled = await Promise.allSettled(closingIds.map((id) => this.services.closeSession(id)));
    const closed = new Set(closingIds.filter((_id, index) => settled[index]?.status === "fulfilled"));
    if (!closed.size) return [];
    this.state.updateLayout((current) => {
      const target = current.panes.find((entry) => entry.id === paneId);
      if (!target) return current;
      const tabIds = target.tabIds.filter((id) => !closed.has(id));
      if (!tabIds.length) return current;
      const activeTabId = closed.has(target.activeTabId) ? tabIds[tabIds.length - 1] : target.activeTabId;
      return { ...current, panes: current.panes.map((entry) => entry.id === paneId ? { ...entry, tabIds, activeTabId } : entry) };
    });
    closed.forEach((id) => this.services.releaseSession(id));
    this.services.closeContextMenu();
    return [...closed];
  };

  readonly splitPane = (paneId: string, targetCount: 2 | 3) => {
    const current = this.state.getLayout();
    if (current.panes.length >= targetCount) return;
    const pane = current.panes.find((entry) => entry.id === paneId);
    if (!pane) return;
    const sourceSession = this.state.getSession(pane.activeTabId);
    const cwd = sourceSession?.cwd || "";
    const provider = sourceSession?.provider;
    const additions = Array.from({ length: targetCount - current.panes.length }, () => {
      const sessionId = this.services.createSession(cwd, provider ? { provider } : undefined);
      return { id: this.nextPaneId(), tabIds: [sessionId], activeTabId: sessionId };
    });
    const lastPaneId = additions[additions.length - 1]?.id;
    this.state.updateLayout((layout) => ({ ...layout, panes: [...layout.panes, ...additions], activePaneId: lastPaneId || layout.activePaneId }));
  };

  readonly closePane = (paneId: string) => {
    this.state.updateLayout((current) => {
      if (current.panes.length <= 1) return current;
      const index = current.panes.findIndex((pane) => pane.id === paneId);
      if (index < 0) return current;
      const closing = current.panes[index];
      const receiver = current.panes[index > 0 ? index - 1 : index + 1];
      const mergedTabIds = [...receiver.tabIds, ...closing.tabIds.filter((id) => !receiver.tabIds.includes(id))];
      const closingWasActive = current.activePaneId === paneId;
      return {
        ...current,
        panes: current.panes
          .filter((pane) => pane.id !== paneId)
          .map((pane) => pane.id === receiver.id
            ? { ...pane, tabIds: mergedTabIds, activeTabId: closingWasActive ? closing.activeTabId : pane.activeTabId }
            : pane),
        activePaneId: closingWasActive ? receiver.id : current.activePaneId,
      };
    });
  };

  readonly closeActiveTab = async () => {
    const current = this.state.getLayout();
    const pane = current.panes.find((entry) => entry.id === current.activePaneId) ?? current.panes[0];
    if (!pane) return false;
    const sessionId = pane.activeTabId;
    const session = this.state.getSession(sessionId);
    if (!session) return false;
    if (pane.tabIds.length > 1) return this.removeTab(pane.id, sessionId);
    if (!this.services.confirmClose([sessionId])) return false;
    try { await this.services.closeSession(sessionId); } catch { return false; }
    if (current.panes.length > 1) {
      this.state.updateLayout((layout) => {
        const index = layout.panes.findIndex((entry) => entry.id === pane.id);
        if (index < 0 || layout.panes.length <= 1) return layout;
        const receiver = layout.panes[index > 0 ? index - 1 : index + 1];
        return { ...layout, panes: layout.panes.filter((entry) => entry.id !== pane.id), activePaneId: receiver.id };
      });
    } else {
      const nextSessionId = this.services.createSession(session.cwd, { provider: session.provider });
      this.replaceSession(sessionId, nextSessionId);
    }
    this.services.releaseSession(sessionId);
    return true;
  };

  readonly moveTab = (sessionId: string, targetPaneId: string, target?: TabDropTarget, split?: "horizontal" | "vertical") => {
    this.state.updateLayout((current) => {
      const sourcePane = current.panes.find((pane) => pane.tabIds.includes(sessionId));
      const targetPane = current.panes.find((pane) => pane.id === targetPaneId);
      if (!sourcePane || !targetPane || (target?.paneId && target.paneId !== targetPaneId)) return current;
      if (sourcePane.id === targetPane.id && !split) {
        const tabIds = sourcePane.tabIds.filter((id) => id !== sessionId);
        let insertAt = tabIds.length;
        if (target?.sessionId && target.sessionId !== sessionId) {
          const targetIndex = tabIds.indexOf(target.sessionId);
          if (targetIndex >= 0) insertAt = targetIndex + (target.position === "after" ? 1 : 0);
        }
        tabIds.splice(Math.max(0, Math.min(insertAt, tabIds.length)), 0, sessionId);
        if (tabIds.every((id, index) => id === sourcePane.tabIds[index])) return current;
        return { ...current, panes: current.panes.map((pane) => pane.id === sourcePane.id ? { ...pane, tabIds } : pane) };
      }
      const without = current.panes
        .map((pane) => pane.id === sourcePane.id
          ? { ...pane, tabIds: pane.tabIds.filter((id) => id !== sessionId), activeTabId: pane.activeTabId === sessionId ? pane.tabIds.find((id) => id !== sessionId) || pane.activeTabId : pane.activeTabId }
          : pane)
        .filter((pane) => pane.tabIds.length);
      if (!split) {
        return {
          ...current,
          panes: without.map((pane) => {
            if (pane.id !== targetPaneId) return pane;
            const tabIds = [...pane.tabIds];
            const targetIndex = target?.sessionId ? tabIds.indexOf(target.sessionId) : -1;
            const insertAt = targetIndex >= 0 ? targetIndex + (target?.position === "after" ? 1 : 0) : tabIds.length;
            tabIds.splice(insertAt, 0, sessionId);
            return { ...pane, tabIds, activeTabId: sessionId };
          }),
          activePaneId: targetPaneId,
        };
      }
      if (without.length >= 3) return current;
      const newPaneId = this.nextPaneId();
      return { ...current, panes: [...without, { id: newPaneId, tabIds: [sessionId], activeTabId: sessionId }], activePaneId: newPaneId, direction: split } as LayoutState;
    });
  };
}
