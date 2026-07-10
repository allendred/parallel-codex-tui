import React from "react";
import { Box, Text, type TextProps } from "ink";
import type { TerminalLine, TerminalTextStyle } from "./terminal-screen.js";
import { displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

const TERMINAL_OUTPUT_EMPTY_TEXT = "waiting for native output";

export interface TerminalOutputProps {
  lines: TerminalLine[];
  minLines?: number;
  width?: number;
}

export function TerminalOutput({ lines, minLines, width }: TerminalOutputProps) {
  const blankTailLineCount = terminalOutputBlankTailLineCount(lines.length === 0 ? 1 : lines.length, minLines);

  if (lines.length === 0) {
    return (
      <Box flexDirection="column">
        <Text>
          <Text {...terminalOutputEmptyTheme()}>{TERMINAL_OUTPUT_EMPTY_TEXT}</Text>
          <TerminalOutputEmptyTrailingFill width={width} />
        </Text>
        <TerminalOutputBlankTailLines count={blankTailLineCount} width={width} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index}>
          {line.chunks.length === 0
            ? <Text {...terminalOutputBlankLineTheme()}>{" ".repeat(terminalOutputBlankLineWidth(width))}</Text>
            : <>
              {line.chunks.map((chunk, chunkIndex) => (
                <Text key={chunkIndex} {...terminalOutputTextProps(chunk.style)}>
                  {chunk.text}
                </Text>
              ))}
              <TerminalOutputTrailingFill line={line} width={width} />
            </>}
        </Text>
      ))}
      <TerminalOutputBlankTailLines count={blankTailLineCount} width={width} />
    </Box>
  );
}

type TerminalOutputTheme = Pick<TextProps, "backgroundColor" | "bold" | "color" | "dimColor" | "inverse" | "italic" | "strikethrough" | "underline">;

export function terminalOutputEmptyTheme(): TerminalOutputTheme {
  return {
    backgroundColor: TUI_THEME.surface,
    color: TUI_THEME.muted,
    dimColor: true
  };
}

export function terminalOutputEmptyText(): string {
  return TERMINAL_OUTPUT_EMPTY_TEXT;
}

export function terminalOutputBlankLineTheme(): TerminalOutputTheme {
  return {
    backgroundColor: TUI_THEME.surface
  };
}

export function terminalOutputTextProps(style: TerminalTextStyle): TerminalOutputTheme {
  return {
    backgroundColor: style.backgroundColor ?? TUI_THEME.surface,
    bold: style.bold,
    color: style.color ?? TUI_THEME.text,
    dimColor: style.dimColor,
    inverse: style.inverse || style.cursor,
    italic: style.italic,
    strikethrough: style.strikethrough,
    underline: style.underline
  };
}

export function terminalOutputTrailingFillWidth(line: TerminalLine, width: number | undefined): number {
  if (width === undefined) {
    return 0;
  }
  return Math.max(0, width - terminalOutputLineDisplayWidth(line));
}

function TerminalOutputTrailingFill({ line, width }: { line: TerminalLine; width: number | undefined }) {
  const fillWidth = terminalOutputTrailingFillWidth(line, width);
  return fillWidth > 0 ? <Text {...terminalOutputBlankLineTheme()}>{" ".repeat(fillWidth)}</Text> : null;
}

function TerminalOutputEmptyTrailingFill({ width }: { width: number | undefined }) {
  const fillWidth = width === undefined ? 0 : Math.max(0, width - displayWidth(TERMINAL_OUTPUT_EMPTY_TEXT));
  return fillWidth > 0 ? <Text {...terminalOutputBlankLineTheme()}>{" ".repeat(fillWidth)}</Text> : null;
}

function TerminalOutputBlankTailLines({ count, width }: { count: number; width: number | undefined }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <Text key={`blank-tail-${index}`} {...terminalOutputBlankLineTheme()}>
          {" ".repeat(terminalOutputBlankLineWidth(width))}
        </Text>
      ))}
    </>
  );
}

function terminalOutputBlankTailLineCount(lineCount: number, minLines: number | undefined): number {
  return minLines === undefined ? 0 : Math.max(0, minLines - lineCount);
}

function terminalOutputLineDisplayWidth(line: TerminalLine): number {
  return line.chunks.reduce((sum, chunk) => sum + displayWidth(chunk.text), 0);
}

function terminalOutputBlankLineWidth(width: number | undefined): number {
  return Math.max(1, width ?? 1);
}
