import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { findQuestionAnchorIndex, questionNavigationDirection } from "./questionNavigation";

describe("question navigation", () => {
  it("recognizes only Alt + Page Up or Page Down", () => {
    const key = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
    assert.equal(questionNavigationDirection({ ...key, key: "PageUp" }), "previous");
    assert.equal(questionNavigationDirection({ ...key, key: "PageDown" }), "next");
    assert.equal(questionNavigationDirection({ ...key, altKey: false, key: "PageUp" }), null);
    assert.equal(questionNavigationDirection({ ...key, ctrlKey: true, key: "PageUp" }), null);
    assert.equal(questionNavigationDirection({ ...key, shiftKey: true, key: "PageDown" }), null);
  });

  it("moves past the currently aligned question in either direction", () => {
    const anchors = [100, 400, 900];
    assert.equal(findQuestionAnchorIndex(anchors, 400, "previous"), 0);
    assert.equal(findQuestionAnchorIndex(anchors, 400, "next"), 2);
    assert.equal(findQuestionAnchorIndex(anchors, 650, "previous"), 1);
    assert.equal(findQuestionAnchorIndex(anchors, 650, "next"), 2);
  });

  it("selects the latest question from the bottom and stops at both ends", () => {
    const anchors = [100, 400, 900];
    assert.equal(findQuestionAnchorIndex(anchors, 1600, "previous"), 2);
    assert.equal(findQuestionAnchorIndex(anchors, 100, "previous"), -1);
    assert.equal(findQuestionAnchorIndex(anchors, 900, "next"), -1);
  });
});
