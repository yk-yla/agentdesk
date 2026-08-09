import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { captureBossKey, displayBossKey, normalizeBossKeyAccelerator } from "../shared/bossKey";

describe("boss key accelerators", () => {
  it("accepts function keys and canonical modifier combinations", () => {
    assert.equal(normalizeBossKeyAccelerator("f2"), "F2");
    assert.equal(normalizeBossKeyAccelerator("ctrl+alt+space"), "Control+Alt+Space");
    assert.equal(displayBossKey("Control+Super+A"), "Ctrl+Win+A");
  });

  it("rejects unsafe plain keys, modifier-only input, and F12", () => {
    assert.equal(normalizeBossKeyAccelerator("A"), null);
    assert.equal(normalizeBossKeyAccelerator("Ctrl"), null);
    assert.equal(normalizeBossKeyAccelerator("F12"), null);
  });

  it("captures a Windows keyboard chord", () => {
    assert.deepEqual(captureBossKey({ key: " ", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }), {
      accelerator: "Control+Alt+Space",
    });
    assert.deepEqual(captureBossKey({ key: "Escape", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }), {
      canceled: true,
    });
  });
});
