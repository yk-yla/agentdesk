import assert from "node:assert/strict";
import test from "node:test";

import { applyImeAnchorPlacement, resolveImeAnchorCell, resolveImeAnchorFromTerminal, resolveImeAnchorPlacement } from "./terminalImeAnchor";

test("光标可见时使用真实光标格", () => {
  const anchor = resolveImeAnchorCell({
    cursorColumn: 2,
    cursorRow: 48,
    cursorHidden: false,
    contentEndColumn: 26,
    columns: 82,
    rows: 51,
  });
  assert.deepEqual(anchor, { column: 2, row: 48, derivedColumn: false });
});

test("光标被隐藏时按行内容推算列，不用停在行尾的真实光标", () => {
  const anchor = resolveImeAnchorCell({
    cursorColumn: 79,
    cursorRow: 13,
    cursorHidden: true,
    contentEndColumn: 2,
    columns: 80,
    rows: 24,
  });
  assert.deepEqual(anchor, { column: 2, row: 13, derivedColumn: true });
});

test("无法推算行内容时退回真实光标列", () => {
  const anchor = resolveImeAnchorCell({
    cursorColumn: 40,
    cursorRow: 5,
    cursorHidden: true,
    contentEndColumn: null,
    columns: 80,
    rows: 24,
  });
  assert.deepEqual(anchor, { column: 40, row: 5, derivedColumn: false });
});

test("锚点越界时收敛到终端范围内", () => {
  const anchor = resolveImeAnchorCell({
    cursorColumn: 999,
    cursorRow: -4,
    cursorHidden: false,
    contentEndColumn: null,
    columns: 80,
    rows: 24,
  });
  assert.deepEqual(anchor, { column: 79, row: 0, derivedColumn: false });
});

// 按实测的 Claude Code 帧构造：80x24，真实光标被隐藏并停在输入行最后一列，
// 输入行是 "❯" 加一个背景色非默认的光标块。
const buildClaudeLine = (text: string, caretColumn: number | null, columns = 80) => ({
  getCell: (column: number) => {
    const chars = text[column] ?? " ";
    const isCaret = caretColumn !== null && column === caretColumn;
    if (column >= columns) return undefined;
    return {
      getChars: () => chars,
      getWidth: () => 1,
      isBgDefault: () => !isCaret,
      isInverse: () => false,
    };
  },
});

test("Claude 帧：拼音锚点落在自绘光标块上，而不是行尾的真实光标", () => {
  const anchor = resolveImeAnchorFromTerminal({
    columns: 80,
    rows: 24,
    cursorColumn: 79,
    cursorRow: 13,
    baseRow: 0,
    viewportRow: 0,
    cursorHidden: true,
    getLine: (absoluteRow) => (absoluteRow === 13 ? buildClaudeLine("❯", 2) : buildClaudeLine("", null)),
  });
  assert.deepEqual(anchor, { column: 2, row: 13, derivedColumn: true });
});

test("真实光标停在状态栏那一行时，仍按自绘光标块回到输入行", () => {
  // 复现截图里的情况：Claude 最后重绘的是状态栏，真实光标留在第 16 行。
  const frame = new Map([
    [13, buildClaudeLine("❯", 2)],
    [15, buildClaudeLine("  [tool/agentdesk | ctx:0k]", null)],
    [16, buildClaudeLine("  ⏸ manual mode on", null)],
  ]);
  const anchor = resolveImeAnchorFromTerminal({
    columns: 80,
    rows: 24,
    cursorColumn: 49,
    cursorRow: 16,
    baseRow: 0,
    viewportRow: 0,
    cursorHidden: true,
    getLine: (absoluteRow) => frame.get(absoluteRow) ?? buildClaudeLine("", null),
  });
  assert.deepEqual(anchor, { column: 2, row: 13, derivedColumn: true });
});

test("顶部 ANSI 图标的色块不会被当成光标", () => {
  // 实测图标是连续 5~6 格非默认背景，光标最多 2 格，靠长度区分。
  const logo = { getCell: (column: number) => (column < 8 ? { getChars: () => "█", getWidth: () => 1, isBgDefault: () => false, isInverse: () => false } : { getChars: () => " ", getWidth: () => 1, isBgDefault: () => true, isInverse: () => false }) };
  const anchor = resolveImeAnchorFromTerminal({
    columns: 80,
    rows: 24,
    cursorColumn: 79,
    cursorRow: 0,
    baseRow: 0,
    viewportRow: 0,
    cursorHidden: true,
    getLine: (absoluteRow) => (absoluteRow <= 2 ? logo : buildClaudeLine("", null)),
  });
  // 找不到自绘光标块，退回按行内容推算，行仍是真实光标行。
  assert.equal(anchor.row, 0);
  assert.equal(anchor.column, 8);
});

test("大片选中色块不会被当成光标", () => {
  const wide = { getCell: (column: number) => ({ getChars: () => " ", getWidth: () => 1, isBgDefault: () => column >= 40, isInverse: () => false }) };
  const anchor = resolveImeAnchorFromTerminal({
    columns: 80,
    rows: 24,
    cursorColumn: 10,
    cursorRow: 5,
    baseRow: 0,
    viewportRow: 0,
    cursorHidden: true,
    getLine: () => wide,
  });
  assert.equal(anchor.derivedColumn, true);
  assert.equal(anchor.column, 40);
});

// 实测：Claude 的光标是一格反显，停在已输入文字中间时那一格带着被盖住的字符。
const buildCaretOnCharLine = (text: string, caretColumn: number, columns = 80) => ({
  getCell: (column: number) => {
    if (column >= columns) return undefined;
    const chars = text[column] ?? " ";
    return {
      getChars: () => chars,
      getWidth: () => 1,
      isBgDefault: () => column !== caretColumn,
      isInverse: () => false,
    };
  },
});

test("光标停在已输入文字中间时，锚点跟到光标处而不是行尾", () => {
  // 输入框内容 "❯abcddef"，光标反显盖在第 5 列的 d 上（实测帧）。
  const anchor = resolveImeAnchorFromTerminal({
    columns: 80,
    rows: 24,
    cursorColumn: 79,
    cursorRow: 6,
    baseRow: 0,
    viewportRow: 0,
    cursorHidden: true,
    getLine: (absoluteRow) => (absoluteRow === 6 ? buildCaretOnCharLine("❯abcddef", 5) : buildCaretOnCharLine("", -1)),
  });
  assert.deepEqual(anchor, { column: 5, row: 6, derivedColumn: true });
});

test("光标盖在宽字符上时按整格宽度判定，不会被当成色块", () => {
  const line = {
    getCell: (column: number) => {
      if (column >= 80) return undefined;
      // 第 3 列是一个被光标盖住的宽字符（占 2 格）
      if (column === 3) return { getChars: () => "好", getWidth: () => 2, isBgDefault: () => false, isInverse: () => false };
      return { getChars: () => " ", getWidth: () => 1, isBgDefault: () => true, isInverse: () => false };
    },
  };
  const anchor = resolveImeAnchorFromTerminal({
    columns: 80,
    rows: 24,
    cursorColumn: 79,
    cursorRow: 6,
    baseRow: 0,
    viewportRow: 0,
    cursorHidden: true,
    getLine: () => line,
  });
  assert.equal(anchor.column, 3);
  assert.equal(anchor.derivedColumn, true);
});

test("光标盖在中文上、旁边还连着一格色块时仍能识别", () => {
  // 实测中文场景连片长度到 3，这里再加一格模拟更极端的情况。
  const line = {
    getCell: (column: number) => {
      if (column >= 80) return undefined;
      if (column === 6) return { getChars: () => "世", getWidth: () => 2, isBgDefault: () => false, isInverse: () => false };
      if (column === 8) return { getChars: () => "界", getWidth: () => 2, isBgDefault: () => false, isInverse: () => false };
      return { getChars: () => " ", getWidth: () => 1, isBgDefault: () => true, isInverse: () => false };
    },
  };
  const anchor = resolveImeAnchorFromTerminal({
    columns: 80,
    rows: 24,
    cursorColumn: 79,
    cursorRow: 6,
    baseRow: 0,
    viewportRow: 0,
    cursorHidden: true,
    getLine: () => line,
  });
  assert.equal(anchor.column, 6);
  assert.equal(anchor.derivedColumn, true);
});

test("反显但背景是默认色的光标也能识别", () => {
  const line = {
    getCell: (column: number) => {
      if (column >= 80) return undefined;
      if (column === 4) return { getChars: () => "x", getWidth: () => 1, isBgDefault: () => true, isInverse: () => true };
      return { getChars: () => " ", getWidth: () => 1, isBgDefault: () => true, isInverse: () => false };
    },
  };
  const anchor = resolveImeAnchorFromTerminal({
    columns: 80,
    rows: 24,
    cursorColumn: 79,
    cursorRow: 6,
    baseRow: 0,
    viewportRow: 0,
    cursorHidden: true,
    getLine: () => line,
  });
  assert.equal(anchor.column, 4);
});

test("Claude 帧：已输入中文时锚点跟到文字末尾", () => {
  const typed = "❯ 你好";
  const anchor = resolveImeAnchorFromTerminal({
    columns: 80,
    rows: 24,
    cursorColumn: 79,
    cursorRow: 13,
    baseRow: 0,
    viewportRow: 0,
    cursorHidden: true,
    getLine: () => buildClaudeLine(typed, null),
  });
  assert.equal(anchor.column, typed.length);
});

test("Codex 帧：光标可见时按真实光标定位，不受占位文字影响", () => {
  const anchor = resolveImeAnchorFromTerminal({
    columns: 82,
    rows: 51,
    cursorColumn: 2,
    cursorRow: 48,
    baseRow: 46,
    viewportRow: 46,
    cursorHidden: false,
    getLine: () => buildClaudeLine("› Ask Codex to do anything", null, 82),
  });
  assert.deepEqual(anchor, { column: 2, row: 48, derivedColumn: false });
});

test("向上滚动后锚点按显示位置换算，不再偏行", () => {
  const anchor = resolveImeAnchorFromTerminal({
    columns: 82,
    rows: 51,
    cursorColumn: 2,
    cursorRow: 48,
    baseRow: 46,
    viewportRow: 30,
    cursorHidden: false,
    getLine: () => buildClaudeLine("", null, 82),
  });
  // 46 + 48 - 30 = 64 超出 51 行，收敛到最后一行而不是画到屏幕外。
  assert.equal(anchor.row, 50);
});

// 797px / 80 列 ≈ 9.96px，20px 行高，对应实测的 Claude 分栏。
const CELL_WIDTH = 797 / 80;
const SCREEN = { screenWidth: 797, screenHeight: 480, cellHeight: 20 };

test("拼音层不会越过绘制区域右边界", () => {
  const placement = resolveImeAnchorPlacement({
    ...SCREEN,
    cellLeft: 79 * CELL_WIDTH,
    cellTop: 13 * 20,
    compositionWidth: 84,
    textareaWidth: 84,
  });
  assert.ok(placement.compositionLeft + 84 <= 797 - 3, "组合框右边界必须留在绘制区域内");
  assert.ok(placement.textareaLeft + 84 <= 797 - 3, "隐藏 textarea 右边界必须留在绘制区域内");
  assert.equal(placement.textareaLeft, placement.compositionLeft);
});

test("锚点在输入行左侧时保持原位不左移", () => {
  const placement = resolveImeAnchorPlacement({
    ...SCREEN,
    cellLeft: 2 * CELL_WIDTH,
    cellTop: 13 * 20,
    compositionWidth: 84,
    textareaWidth: 84,
  });
  assert.equal(Math.round(placement.compositionLeft), Math.round(2 * CELL_WIDTH));
  assert.equal(placement.compositionTop, 260);
  assert.equal(placement.textareaTop, 260);
});

test("Claude 帧全链路：拼音层和候选框都落在输入行光标处且不越界", () => {
  const columns = 80;
  const rows = 24;
  const screenWidth = 797;
  const cellWidth = screenWidth / columns;
  const cellHeight = 20;
  const anchor = resolveImeAnchorFromTerminal({
    columns,
    rows,
    // 实测：Claude 隐藏光标，真实光标停在输入行最后一列。
    cursorColumn: 79,
    cursorRow: 13,
    baseRow: 0,
    viewportRow: 0,
    cursorHidden: true,
    getLine: (absoluteRow) => (absoluteRow === 13 ? buildClaudeLine("❯", 2) : buildClaudeLine("", null)),
  });
  const placement = resolveImeAnchorPlacement({
    cellLeft: anchor.column * cellWidth,
    cellTop: anchor.row * cellHeight,
    compositionWidth: 96,
    screenWidth,
    screenHeight: rows * cellHeight,
    cellHeight,
    textareaWidth: 96,
  });
  const composition: Record<string, string> = { left: "787px", top: "260px", maxWidth: "", transform: "translateX(-77px)" };
  const textarea: Record<string, string> = { left: "787px", top: "260px" };
  applyImeAnchorPlacement(placement, composition as never, textarea as never);

  // 修正前 xterm 会放在第 79 列（约 787px）；修正后应回到输入行光标附近。
  const left = Number.parseFloat(composition.left);
  assert.ok(left < 60, `拼音层应回到输入行左侧，实际 ${composition.left}`);
  assert.equal(composition.top, "260px", "行位置仍是输入行");
  assert.equal(composition.transform, "", "不再依赖 transform 平移");
  assert.equal(textarea.left, composition.left, "候选框锚点必须和拼音层一致");
  assert.equal(textarea.top, composition.top);
  assert.ok(left + 96 <= screenWidth - 3, "拼音层右边界必须留在绘制区域内");
});

test("锚点行越界时把组合框压回可见区域", () => {
  const placement = resolveImeAnchorPlacement({
    ...SCREEN,
    cellLeft: 0,
    cellTop: 480,
    compositionWidth: 40,
    textareaWidth: 40,
  });
  assert.equal(placement.compositionTop, 460);
});
