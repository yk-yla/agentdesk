import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fitClipboardImageSize, isClipboardImageSizeAllowed } from "../shared/imagePolicy";

describe("clipboard image sizing", () => {
  it("keeps normal screenshots at their original size", () => {
    assert.deepEqual(fitClipboardImageSize(1_920, 1_080), { width: 1_920, height: 1_080 });
  });

  it("scales large images into the clipboard pixel budget", () => {
    const fitted = fitClipboardImageSize(20_000, 10_000);
    assert.equal(isClipboardImageSizeAllowed(fitted.width, fitted.height), true);
    assert.ok(fitted.width / fitted.height > 1.99 && fitted.width / fitted.height < 2.01);
  });
});
