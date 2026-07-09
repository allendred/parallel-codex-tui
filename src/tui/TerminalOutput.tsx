import React from "react";
import { Box, Text, type TextProps } from "ink";
import type { TerminalLine, TerminalTextStyle } from "./terminal-screen.js";
import { TUI_THEME } from "./theme.js";

export interface TerminalOutputProps {
  lines: TerminalLine[];
}

export function TerminalOutput({ lines }: TerminalOutputProps) {
  if (lines.length === 0) {
    return <Text {...terminalOutputEmptyTheme()}>(no output yet)</Text>;
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index}>
          {line.chunks.length === 0
            ? <Text {...terminalOutputBlankLineTheme()}> </Text>
            : line.chunks.map((chunk, chunkIndex) => (
                <Text key={chunkIndex} {...terminalOutputTextProps(chunk.style)}>
                  {chunk.text}
                </Text>
              ))}
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
