import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyLocalLink } from "./localFileLink";

describe("local file links", () => {
  it("separates web links, anchors and unsupported schemes", () => {
    assert.deepEqual(classifyLocalLink("HTTPS://example.com/a", "C:\\work"), { kind: "external", value: "HTTPS://example.com/a" });
    assert.deepEqual(classifyLocalLink("#details", "C:\\work"), { kind: "anchor", value: "#details" });
    assert.deepEqual(classifyLocalLink("mailto:user@example.com", "C:\\work"), { kind: "unsupported", value: "mailto:user@example.com" });
  });

  it("resolves relative paths against the message workspace", () => {
    assert.deepEqual(classifyLocalLink("敏感配置说明.md", "E:\\whaty\\workspace"), {
      kind: "local",
      value: "E:\\whaty\\workspace\\敏感配置说明.md",
    });
    assert.deepEqual(classifyLocalLink("src/main.ts:42:3", "C:\\work"), {
      kind: "local",
      value: "C:\\work\\src/main.ts:42:3",
    });
  });

  it("keeps Windows, file URL and UNC paths local", () => {
    assert.deepEqual(classifyLocalLink("D:\\code\\app.ts", "C:\\work"), { kind: "local", value: "D:\\code\\app.ts" });
    assert.deepEqual(classifyLocalLink("file:///D:/code/My%20File.ts", "C:\\work"), { kind: "local", value: "D:/code/My File.ts" });
    assert.deepEqual(classifyLocalLink("file://server/share/file.txt", "C:\\work"), { kind: "local", value: "\\\\server/share/file.txt" });
  });
});
