import React from "react";
import { Box, Text } from "ink";
import type { TerminalLine, TerminalTextStyle } from "./terminal-screen.js";

export interface TerminalOutputProps {
  lines: TerminalLine[];
}

export function TerminalOutput({ lines }: TerminalOutputProps) {
  if (lines.length === 0) {
    return <Text>(no output yet)</Text>;
  }

  return (
    <Box flexDirection="column">
      {lines.map((line, index) => (
        <Text key={index}>
          {line.chunks.length === 0
            ? " "
            : line.chunks.map((chunk, chunkIndex) => (
                <Text key={chunkIndex} {...textProps(chunk.style)}>
                  {chunk.text}
                </Text>
              ))}
        </Text>
      ))}
    </Box>
  );
}

function textProps(style: TerminalTextStyle) {
  return {
    backgroundColor: style.backgroundColor,
    bold: style.bold,
    color: style.color,
    dimColor: style.dimColor,
    inverse: style.inverse || style.cursor,
    italic: style.italic,
    strikethrough: style.strikethrough,
    underline: style.underline
  };
}
