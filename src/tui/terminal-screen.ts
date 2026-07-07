import * as xtermHeadless from "@xterm/headless";
import type { IBufferCell, Terminal as XtermTerminal } from "@xterm/headless";

type TerminalConstructor = new (...args: ConstructorParameters<typeof XtermTerminal>) => XtermTerminal;
type XtermHeadlessRuntime = {
  Terminal?: TerminalConstructor;
  default?: {
    Terminal?: TerminalConstructor;
  };
  "module.exports"?: {
    Terminal?: TerminalConstructor;
  };
};

const xtermRuntime = xtermHeadless as XtermHeadlessRuntime;
const Terminal = resolveTerminalConstructor(xtermRuntime);

export interface NativeTerminalScreenOptions {
  cols?: number;
  rows?: number;
  scrollback?: number;
}

export interface TerminalSnapshotOptions {
  showCursor?: boolean;
}

export interface TerminalTextStyle {
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  cursor?: boolean;
  dimColor?: boolean;
  inverse?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
}

export interface TerminalTextChunk {
  text: string;
  style: TerminalTextStyle;
}

export interface TerminalLine {
  chunks: TerminalTextChunk[];
}

export interface TerminalScrollState {
  offset: number;
  maxOffset: number;
}

export class NativeTerminalScreen {
  private readonly terminal: XtermTerminal;

  constructor(options: NativeTerminalScreenOptions = {}) {
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: options.cols ?? 120,
      rows: options.rows ?? 24,
      scrollback: options.scrollback ?? 1000
    });
  }

  write(chunk: string): Promise<void> {
    return new Promise((resolve) => {
      this.terminal.write(chunk, resolve);
    });
  }

  snapshot(): string {
    return this.snapshotLines().join("\n");
  }

  snapshotLines(): string[] {
    return this.styledSnapshotLines().map((line) => line.chunks.map((chunk) => chunk.text).join(""));
  }

  styledSnapshotLines(options: TerminalSnapshotOptions = {}): TerminalLine[] {
    const buffer = this.terminal.buffer.active;
    const lines: TerminalLine[] = [];
    const cursorY = options.showCursor ? buffer.baseY + buffer.cursorY : null;
    const cursorX = options.showCursor ? Math.min(buffer.cursorX, this.terminal.cols - 1) : null;
    for (let row = 0; row < this.terminal.rows; row += 1) {
      const absoluteY = buffer.viewportY + row;
      const line = buffer.getLine(absoluteY);
      lines.push(
        line
          ? styledLineFromBufferLine(line, buffer.getNullCell(), absoluteY === cursorY ? cursorX : null)
          : { chunks: [] }
      );
    }
    return trimTrailingBlankTerminalLines(lines);
  }

  scrollLines(amount: number): void {
    this.terminal.scrollLines(amount);
  }

  scrollPages(pageCount: number): void {
    this.terminal.scrollPages(pageCount);
  }

  scrollToBottom(): void {
    this.terminal.scrollToBottom();
  }

  scrollState(): TerminalScrollState {
    const buffer = this.terminal.buffer.active;
    return {
      offset: Math.max(0, buffer.baseY - buffer.viewportY),
      maxOffset: Math.max(0, buffer.baseY)
    };
  }
}

function styledLineFromBufferLine(
  line: NonNullable<ReturnType<XtermTerminal["buffer"]["active"]["getLine"]>>,
  reusableCell: IBufferCell,
  cursorColumn: number | null
): TerminalLine {
  const chunks: TerminalTextChunk[] = [];
  let pendingStyle: TerminalTextStyle | null = null;
  let pendingText = "";
  const trimmedText = line.translateToString(true);
  const cursorLimit = cursorColumn === null ? -1 : cursorColumn + 1;
  let visibleTextLength = 0;

  for (let column = 0; column < line.length && (visibleTextLength < trimmedText.length || column < cursorLimit); column += 1) {
    const cell = line.getCell(column, reusableCell);
    if (!cell || cell.getWidth() === 0) {
      continue;
    }

    const text = cell.getChars() || " ";
    visibleTextLength += text.length;
    const style = styleFromCell(cell);
    if (cursorColumn === column) {
      style.cursor = true;
      style.inverse = true;
    }
    if (pendingStyle && sameStyle(pendingStyle, style)) {
      pendingText += text;
      continue;
    }

    if (pendingStyle) {
      chunks.push({ text: pendingText, style: pendingStyle });
    }
    pendingStyle = style;
    pendingText = text;
  }

  if (pendingStyle) {
    chunks.push({ text: pendingText, style: pendingStyle });
  }

  return { chunks };
}

function styleFromCell(cell: IBufferCell): TerminalTextStyle {
  const style: TerminalTextStyle = {};
  const color = colorFromCell(cell, "fg");
  const backgroundColor = colorFromCell(cell, "bg");

  if (color) {
    style.color = color;
  }
  if (backgroundColor) {
    style.backgroundColor = backgroundColor;
  }
  if (cell.isBold()) {
    style.bold = true;
  }
  if (cell.isDim()) {
    style.dimColor = true;
  }
  if (cell.isInverse()) {
    style.inverse = true;
  }
  if (cell.isItalic()) {
    style.italic = true;
  }
  if (cell.isStrikethrough()) {
    style.strikethrough = true;
  }
  if (cell.isUnderline()) {
    style.underline = true;
  }

  return style;
}

function colorFromCell(cell: IBufferCell, kind: "fg" | "bg"): string | undefined {
  if (kind === "fg") {
    if (cell.isFgRGB()) {
      return rgbHex(cell.getFgColor());
    }
    if (cell.isFgPalette()) {
      return `ansi256(${cell.getFgColor()})`;
    }
    return undefined;
  }

  if (cell.isBgRGB()) {
    return rgbHex(cell.getBgColor());
  }
  if (cell.isBgPalette()) {
    return `ansi256(${cell.getBgColor()})`;
  }
  return undefined;
}

function rgbHex(value: number): string {
  return `#${value.toString(16).padStart(6, "0")}`;
}

function sameStyle(left: TerminalTextStyle, right: TerminalTextStyle): boolean {
  return (
    left.backgroundColor === right.backgroundColor &&
    left.bold === right.bold &&
    left.color === right.color &&
    left.cursor === right.cursor &&
    left.dimColor === right.dimColor &&
    left.inverse === right.inverse &&
    left.italic === right.italic &&
    left.strikethrough === right.strikethrough &&
    left.underline === right.underline
  );
}

function trimTrailingBlankTerminalLines(lines: TerminalLine[]): TerminalLine[] {
  let end = lines.length;
  while (end > 0 && terminalLineText(lines[end - 1]).trim() === "") {
    end -= 1;
  }
  return lines.slice(0, end);
}

function terminalLineText(line: TerminalLine): string {
  return line.chunks.map((chunk) => chunk.text).join("");
}

function resolveTerminalConstructor(runtime: XtermHeadlessRuntime): TerminalConstructor {
  const constructor = runtime.Terminal ?? runtime.default?.Terminal ?? runtime["module.exports"]?.Terminal;
  if (!constructor) {
    throw new Error("Unable to load @xterm/headless Terminal export.");
  }
  return constructor;
}
