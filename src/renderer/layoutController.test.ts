import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySession, type LayoutState, type SessionState } from "./domain";
import { LayoutController } from "./layoutController";

function createHarness(initialLayout: LayoutState = { panes: [{ id: "pane-1", tabIds: ["s1"], activeTabId: "s1" }], activePaneId: "pane-1" }) {
  let layout = initialLayout;
  const sessions: Record<string, SessionState> = {
    s1: emptySession("s1", "D:\\one"),
    s2: emptySession("s2", "D:\\two"),
    s3: emptySession("s3", "D:\\three"),
  };
  const released: string[] = [];
  const closeFailures = new Set<string>();
  let created = 0;
  let contextClosed = 0;
  const controller = new LayoutController({
    getLayout: () => layout,
    updateLayout: (updater) => { layout = updater(layout); },
    getSession: (sessionId) => sessions[sessionId],
  }, {
    createSession: (cwd, options) => {
      created += 1;
      const id = `created-${created}`;
      sessions[id] = emptySession(id, cwd, "", "", options?.provider);
      return id;
    },
    confirmClose: () => true,
    closeSession: async (sessionId) => { if (closeFailures.has(sessionId)) throw new Error("close failed"); },
    releaseSession: (sessionId) => { released.push(sessionId); delete sessions[sessionId]; },
    closeContextMenu: () => { contextClosed += 1; },
    now: () => 100,
  });
  return {
    controller,
    sessions,
    released,
    closeFailures,
    get layout() { return layout; },
    get contextClosed() { return contextClosed; },
  };
}

describe("LayoutController", () => {
  it("activates a target tab in a single pane", () => {
    const harness = createHarness({
      panes: [{ id: "pane-1", tabIds: ["s1", "s2"], activeTabId: "s1" }],
      activePaneId: "pane-1",
    });

    harness.controller.activateSession("s2");

    assert.equal(harness.layout.activePaneId, "pane-1");
    assert.equal(harness.layout.panes[0].activeTabId, "s2");
  });

  it("activates a target tab and its owning pane in a split layout", () => {
    const harness = createHarness({
      panes: [
        { id: "pane-1", tabIds: ["s1"], activeTabId: "s1" },
        { id: "pane-2", tabIds: ["s2", "s3"], activeTabId: "s2" },
      ],
      activePaneId: "pane-1",
    });

    harness.controller.activateSession("s3");

    assert.equal(harness.layout.activePaneId, "pane-2");
    assert.equal(harness.layout.panes[1].activeTabId, "s3");
    assert.equal(harness.layout.panes[0].activeTabId, "s1");
  });

  it("adds and activates tabs only inside their owning pane", () => {
    const harness = createHarness({
      panes: [
        { id: "pane-1", tabIds: ["s1", "s2"], activeTabId: "s1" },
        { id: "pane-2", tabIds: ["s3"], activeTabId: "s3" },
      ],
      activePaneId: "pane-1",
    });

    const created = harness.controller.addSession("D:\\new");
    harness.controller.activateSession("s3");
    harness.controller.setActiveTab("pane-1", "missing");

    assert.equal(harness.layout.panes[0].tabIds.at(-1), created);
    assert.equal(harness.layout.activePaneId, "pane-2");
    assert.equal(harness.layout.panes[0].activeTabId, created);
  });

  it("adds a same-directory session beside the source tab in its owning pane", () => {
    const harness = createHarness({
      panes: [
        { id: "pane-1", tabIds: ["s1"], activeTabId: "s1" },
        { id: "pane-2", tabIds: ["s2", "s3"], activeTabId: "s3" },
      ],
      activePaneId: "pane-1",
    });

    const created = harness.controller.addSessionToPane("pane-2", "D:\\two", { provider: "claude" }, "s2");

    assert.deepEqual(harness.layout.panes[1].tabIds, ["s2", created, "s3"]);
    assert.equal(harness.layout.panes[1].activeTabId, created);
    assert.equal(harness.layout.activePaneId, "pane-2");
    assert.equal(harness.sessions[created].cwd, "D:\\two");
    assert.equal(harness.sessions[created].provider, "claude");
  });

  it("reorders a tab and moves it across panes without duplication", () => {
    const harness = createHarness({
      panes: [
        { id: "pane-1", tabIds: ["s1", "s2"], activeTabId: "s2" },
        { id: "pane-2", tabIds: ["s3"], activeTabId: "s3" },
      ],
      activePaneId: "pane-1",
    });

    harness.controller.moveTab("s2", "pane-1", { paneId: "pane-1", sessionId: "s1", position: "before" });
    assert.deepEqual(harness.layout.panes[0].tabIds, ["s2", "s1"]);

    harness.controller.moveTab("s2", "pane-2", { paneId: "pane-2", sessionId: "s3", position: "after" });
    assert.deepEqual(harness.layout.panes.find((pane) => pane.id === "pane-1")?.tabIds, ["s1"]);
    assert.deepEqual(harness.layout.panes.find((pane) => pane.id === "pane-2")?.tabIds, ["s3", "s2"]);
    assert.equal(harness.layout.activePaneId, "pane-2");
  });

  it("creates an empty pane without creating a Provider session", () => {
    const harness = createHarness();

    harness.controller.splitPane("pane-1");
    assert.equal(harness.layout.panes.length, 2);
    assert.deepEqual(harness.layout.panes[1].tabIds, []);
    assert.equal(harness.layout.panes[1].activeTabId, "");
    assert.equal(Object.keys(harness.sessions).length, 3);
    harness.controller.splitPane("pane-1");
    assert.equal(harness.layout.panes.length, 2);
    assert.deepEqual(harness.layout.panes[1].tabIds, []);

    const closingPane = harness.layout.panes[1];
    harness.controller.closePane(closingPane.id);
    assert.equal(harness.layout.panes.length, 1);
    assert.equal(harness.layout.panes[0].activeTabId, "s1");
  });

  it("adds a chosen Provider to the empty pane", () => {
    const harness = createHarness();

    harness.controller.splitPane("pane-1");
    const created = harness.controller.addSessionToPane(harness.layout.panes[1].id, "D:\\claude", { provider: "claude" });

    assert.equal(harness.sessions[created].provider, "claude");
    assert.deepEqual(harness.layout.panes[1].tabIds, [created]);
    assert.equal(harness.layout.panes[1].activeTabId, created);
  });

  it("closes an active empty pane instead of doing nothing", async () => {
    const harness = createHarness();
    harness.controller.splitPane("pane-1");

    assert.equal(await harness.controller.closeActiveTab(), true);
    assert.equal(harness.layout.panes.length, 1);
    assert.equal(harness.layout.activePaneId, "pane-1");
  });

  it("does not create a third pane through split-drop", () => {
    const harness = createHarness({
      panes: [
        { id: "pane-1", tabIds: ["s1", "s2"], activeTabId: "s2" },
        { id: "pane-2", tabIds: ["s3"], activeTabId: "s3" },
      ],
      activePaneId: "pane-1",
    });

    harness.controller.moveTab("s2", "pane-2", undefined, "vertical");

    assert.equal(harness.layout.panes.length, 2);
    assert.deepEqual(harness.layout.panes[0].tabIds, ["s1", "s2"]);
  });

  it("keeps a tab whose backend close failed during a batch close", async () => {
    const harness = createHarness({ panes: [{ id: "pane-1", tabIds: ["s1", "s2", "s3"], activeTabId: "s2" }], activePaneId: "pane-1" });
    harness.closeFailures.add("s2");

    const closed = await harness.controller.closeTabIds("pane-1", ["s2", "s3"]);

    assert.deepEqual(closed, ["s3"]);
    assert.deepEqual(harness.layout.panes[0].tabIds, ["s1", "s2"]);
    assert.deepEqual(harness.released, ["s3"]);
    assert.equal(harness.contextClosed, 1);
  });

  it("replaces the final active tab so the window never has an empty layout", async () => {
    const harness = createHarness();

    assert.equal(await harness.controller.closeActiveTab(), true);

    assert.equal(harness.layout.panes.length, 1);
    assert.deepEqual(harness.layout.panes[0].tabIds, ["created-1"]);
    assert.deepEqual(harness.released, ["s1"]);
    assert.equal(harness.sessions["created-1"].cwd, "D:\\one");
  });

  it("inherits the closed final tab Provider for its replacement", async () => {
    const harness = createHarness();
    harness.sessions.s1.provider = "claude";

    assert.equal(await harness.controller.closeActiveTab(), true);

    assert.equal(harness.sessions["created-1"].provider, "claude");
  });

});
