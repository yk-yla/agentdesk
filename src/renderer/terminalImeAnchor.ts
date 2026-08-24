// IME 组合输入定位。
//
// xterm 把输入法组合层和隐藏 textarea 都锚定在真实光标格上。Ink 类 TUI
// （Claude Code）会隐藏真实光标并自己画光标块，真实光标只停在“最后一次重绘那
// 一行的末尾”，于是拼音层和 Windows 候选框会跑到终端右边或状态栏那一行。
// 这里只做纯计算：选出锚点单元格，并把组合框限制在绘制区域内。

export interface ImeAnchorCellInput {
  /** 真实光标列（buffer.x）。 */
  cursorColumn: number;
  /** 真实光标所在可视行（已按滚动位置换算）。 */
  cursorRow: number;
  /** 终端应用是否隐藏了真实光标（自己绘制光标）。 */
  cursorHidden: boolean;
  /** 锚点行上内容结束后的列；无法判断时为 null。 */
  contentEndColumn: number | null;
  columns: number;
  rows: number;
}

export interface ImeAnchorCell {
  column: number;
  row: number;
  /** true 表示列来自行内容推算，而不是真实光标。 */
  derivedColumn: boolean;
}

const clampInt = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
};

export function resolveImeAnchorCell(input: ImeAnchorCellInput): ImeAnchorCell {
  const maxColumn = Math.max(0, input.columns - 1);
  const maxRow = Math.max(0, input.rows - 1);
  const row = clampInt(input.cursorRow, 0, maxRow);
  if (!input.cursorHidden) {
    return { column: clampInt(input.cursorColumn, 0, maxColumn), row, derivedColumn: false };
  }
  // 光标被隐藏时真实光标列没有意义，用行内容末尾推算可见光标位置。
  const derived = input.contentEndColumn;
  if (derived === null || !Number.isFinite(derived)) {
    return { column: clampInt(input.cursorColumn, 0, maxColumn), row, derivedColumn: false };
  }
  return { column: clampInt(derived, 0, maxColumn), row, derivedColumn: true };
}

/** xterm 单元格中本模块需要的最小信息。 */
export interface ImeAnchorBufferCell {
  getChars(): string;
  getWidth(): number;
  isBgDefault(): boolean;
  isInverse(): number | boolean;
}

export interface ImeAnchorBufferLine {
  getCell(column: number): ImeAnchorBufferCell | undefined;
}

export interface ImeAnchorTerminalState {
  columns: number;
  rows: number;
  /** 光标列（buffer.x）。 */
  cursorColumn: number;
  /** 光标行，相对回滚缓冲区顶部（buffer.y）。 */
  cursorRow: number;
  /** 回滚缓冲区基线（baseY）。 */
  baseRow: number;
  /** 当前显示位置（viewportY）。 */
  viewportRow: number;
  cursorHidden: boolean;
  getLine(absoluteRow: number): ImeAnchorBufferLine | undefined;
}

/**
 * 找出某一行“可见内容”结束后的列。终端应用自己绘制的光标块是一个背景色不
 * 是默认色的空格，所以背景色非默认的单元格也算内容。
 */
export function findRowContentEndColumn(line: ImeAnchorBufferLine | undefined, columns: number): number | null {
  if (!line) return null;
  for (let column = columns - 1; column >= 0; column -= 1) {
    const cell = line.getCell(column);
    if (!cell) continue;
    const painted = cell.getChars().trim().length > 0 || !cell.isBgDefault();
    if (painted) return Math.min(columns - 1, column + Math.max(1, cell.getWidth()));
  }
  return 0;
}

/**
 * 自绘光标块的最大宽度（单元格数），超过就当成选中条或装饰色块。
 *
 * 实测：光标本身 1 格，盖在中文（宽字符）上时连片长度到 3；顶部 ANSI 图标是
 * 连续 5~6 格。留 4 是为了给宽字符再多一格余量，同时仍然把图标挡在外面。
 * 判错的代价不对称：漏检会让拼音退回行尾（就是用户报的问题），误检只是把拼音
 * 放到另一个色块处，所以这里宁可偏向检出。
 */
const MAX_PAINTED_CARET_RUN = 4;

/**
 * 自下往上找终端应用自己画的光标块。
 *
 * 实测 Claude Code 的光标是一格反显（背景 p7 / 前景 p0）：输入框为空时那一格
 * 是空格，光标停在已输入文字中间时那一格带着被盖住的字符。所以判定只看“背景
 * 非默认或反显”，不能要求内容是空白，否则中间插入时会漏检并退回行尾。
 *
 * 靠长度把光标和装饰区分开：实测顶部 ANSI 图标的色块是连续 5~6 格，光标最多
 * 2 格（宽字符）。自下往上扫描保证先命中输入框里的光标。
 */
export function findPaintedCaretCell(
  state: Pick<ImeAnchorTerminalState, "columns" | "rows" | "baseRow" | "viewportRow" | "getLine">,
): { column: number; row: number } | null {
  for (let row = state.rows - 1; row >= 0; row -= 1) {
    const line = state.getLine(state.viewportRow + row);
    if (!line) continue;
    let runStart = -1;
    let runLength = 0;
    for (let column = 0; column < state.columns; column += 1) {
      const cell = line.getCell(column);
      const painted = !!cell && (!cell.isBgDefault() || cell.isInverse());
      if (painted) {
        if (runStart < 0) {
          runStart = column;
          runLength = 0;
        }
        runLength += Math.max(1, cell.getWidth());
        continue;
      }
      if (runStart >= 0) {
        if (runLength <= MAX_PAINTED_CARET_RUN) return { column: runStart, row };
        runStart = -1;
        runLength = 0;
      }
    }
    if (runStart >= 0 && runLength <= MAX_PAINTED_CARET_RUN) return { column: runStart, row };
  }
  return null;
}

/** 由终端状态解析组合输入锚点单元格。 */
export function resolveImeAnchorFromTerminal(state: ImeAnchorTerminalState): ImeAnchorCell {
  const absoluteCursorRow = state.baseRow + state.cursorRow;
  if (state.cursorHidden) {
    // 光标被隐藏时，真实光标只停在“最后一次重绘那一行的末尾”，行和列都不可
    // 信；优先用应用自己画的光标块定位。
    const painted = findPaintedCaretCell(state);
    if (painted) {
      return {
        column: clampInt(painted.column, 0, Math.max(0, state.columns - 1)),
        row: clampInt(painted.row, 0, Math.max(0, state.rows - 1)),
        derivedColumn: true,
      };
    }
  }
  return resolveImeAnchorCell({
    cursorColumn: state.cursorColumn,
    // xterm 自己的组合层只用 buffer.y，滚动后会偏行；这里按显示位置换算。
    cursorRow: absoluteCursorRow - state.viewportRow,
    cursorHidden: state.cursorHidden,
    contentEndColumn: state.cursorHidden ? findRowContentEndColumn(state.getLine(absoluteCursorRow), state.columns) : null,
    columns: state.columns,
    rows: state.rows,
  });
}

export interface ImeAnchorPlacementInput {
  /** 锚点单元格左边界（相对绘制区域左上角，像素）。 */
  cellLeft: number;
  /** 锚点单元格上边界（相对绘制区域左上角，像素）。 */
  cellTop: number;
  /** 组合框实测宽度；窗口被节流时可能还没排版，会偏小。 */
  compositionWidth: number;
  /** 组合框里的字符数，用来在实测宽度失效时估算宽度。 */
  compositionTextLength?: number;
  /** 单元格宽度，配合字符数估算宽度。 */
  cellWidth?: number;
  /** xterm 实际绘制区域宽度（不含滚动条）。 */
  screenWidth: number;
  /** xterm 实际绘制区域高度。 */
  screenHeight: number;
  cellHeight: number;
  /** 隐藏 textarea 的宽度，用于让候选框跟随。 */
  textareaWidth: number;
  /** 距绘制区域边缘保留的间距。 */
  edgeGap?: number;
}

export interface ImeAnchorPlacement {
  compositionLeft: number;
  compositionTop: number;
  compositionMaxWidth: number;
  textareaLeft: number;
  textareaTop: number;
}

/** 只写入定位需要的样式字段，便于在 Node 测试里用假对象覆盖。 */
export interface ImeAnchorStyleTarget {
  left: string;
  top: string;
  maxWidth?: string;
  transform?: string;
}

export function applyImeAnchorPlacement(
  placement: ImeAnchorPlacement,
  composition: ImeAnchorStyleTarget,
  textarea: ImeAnchorStyleTarget | null,
): void {
  // 之前的实现用 transform 平移，测量时必须先清掉，否则每帧都会叠加。
  composition.transform = "";
  composition.maxWidth = `${placement.compositionMaxWidth}px`;
  composition.left = `${placement.compositionLeft}px`;
  composition.top = `${placement.compositionTop}px`;
  // Windows 输入法候选框锚定在隐藏 textarea 上，不是可见的拼音层，
  // 两者必须一起修正，否则候选框会飘出当前分栏。
  if (textarea) {
    textarea.left = `${placement.textareaLeft}px`;
    textarea.top = `${placement.textareaTop}px`;
  }
}

export function resolveImeAnchorPlacement(input: ImeAnchorPlacementInput): ImeAnchorPlacement {
  const gap = input.edgeGap ?? 3;
  const usableWidth = Math.max(1, input.screenWidth - gap * 2);
  const maxWidth = Math.min(usableWidth, Math.max(1, input.screenWidth - gap));
  // 实测宽度在窗口被节流、还没重新排版时会退化成只有内边距那么宽，导致这里
  // 以为不会越界。用字符数估算兜底，取两者较大值。
  const estimatedWidth = (input.compositionTextLength ?? 0) * (input.cellWidth ?? 0);
  const width = Math.min(Math.max(1, input.compositionWidth, estimatedWidth), maxWidth);
  // 组合框超出右边界时整体左移，保证拼音和候选框都留在本分栏内。
  const maxLeft = Math.max(0, input.screenWidth - gap - width);
  const compositionLeft = Math.max(0, Math.min(maxLeft, input.cellLeft));
  const maxTop = Math.max(0, input.screenHeight - Math.max(1, input.cellHeight));
  const compositionTop = Math.max(0, Math.min(maxTop, input.cellTop));
  const textareaWidth = Math.max(1, input.textareaWidth);
  const textareaLeft = Math.max(0, Math.min(Math.max(0, input.screenWidth - gap - textareaWidth), compositionLeft));
  return {
    compositionLeft,
    compositionTop,
    compositionMaxWidth: maxWidth,
    textareaLeft,
    textareaTop: compositionTop,
  };
}
