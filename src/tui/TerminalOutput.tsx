import React from "react";
import { Box, Text, type TextProps } from "ink";
import type { TerminalLine, TerminalTextStyle } from "./terminal-screen.js";
import { displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export interface TerminalOutputProps {
  lines: TerminalLine[];
  width?: number;
}

export function TerminalOutput({ lines, width }: TerminalOutputProps) {
  if (lines.length === 0) {
    return <Text {...terminalOutputEmptyTheme()}>(no output yet)</Text>;
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

function terminalOutputLineDisplayWidth(line: TerminalLine): number {
  return line.chunks.reduce((sum, chunk) => sum + displayWidth(chunk.text), 0);
}

function terminalOutputBlankLineWidth(width: number | undefined): number {
  return Math.max(1, width ?? 1);
}
