import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trustedThreadWorkspaces } from "./threadWorkspaceAuthorization";

describe("trustedThreadWorkspaces", () => {
  it("extracts cwd only from known thread result shapes", () => {
    assert.deepEqual(trustedThreadWorkspaces("thread/list", { data: [{ cwd: "C:\\one" }, { cwd: "D:\\two" }] }), ["C:\\one", "D:\\two"]);
    assert.deepEqual(trustedThreadWorkspaces("thread/search", { data: [{ thread: { cwd: "E:\\three" } }] }), ["E:\\three"]);
    assert.deepEqual(trustedThreadWorkspaces("thread/read", { thread: { cwd: "F:\\four" } }), ["F:\\four"]);
    assert.deepEqual(trustedThreadWorkspaces("thread/started", { thread: { cwd: "G:\\five" } }), ["G:\\five"]);
  });

  it("does not trust arbitrary nested cwd fields", () => {
    const payload = { data: [{ content: { cwd: "C:\\untrusted" } }], cwd: "D:\\also-untrusted" };
    assert.deepEqual(trustedThreadWorkspaces("item/completed", payload), []);
    assert.deepEqual(trustedThreadWorkspaces("thread/list", payload), []);
  });
});
