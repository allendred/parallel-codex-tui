import React from "react";
import { basename } from "node:path";
import { Box, Text } from "ink";
import { StatusBar } from "./StatusBar.js";
import { compactEndByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export type AppView = "chat" | "worker" | "native";
const APP_HEADER_ROOMY_SEPARATOR = " · ";
const APP_HEADER_COMPACT_SEPARATOR = "  ";

export interface AppShellProps {
  view: AppView;
  cwd: string;
  taskId: string | null;
  statusText: string;
  contentHeight?: number;
  terminalWidth?: number;
  children: React.ReactNode;
  input: React.ReactNode;
  error?: string | null;
}

export function AppShell({
  view,
  cwd,
  taskId,
  statusText,
  contentHeight = 20,
  terminalWidth = process.stdout.columns || 120,
  children,
  input,
  error = null
}: AppShellProps) {
  const header = headerParts({ view, cwd, taskId, terminalWidth });
  const headerSegments = headerDisplaySegments(header);
  const headerSeparatorText = headerSeparator(terminalWidth);
  const headerLeadingWidth = terminalWidth > 1 ? 1 : 0;
  const headerRenderWidth = typeof process.stdout.columns === "number"
    ? Math.max(1, Math.min(terminalWidth, process.stdout.columns))
    : null;
  const headerBarWidth = headerRenderWidth === null ? null : Math.max(1, headerRenderWidth - 1);
  const headerTrailingWidth = headerBarWidth === null
    ? 0
    : Math.max(0, headerBarWidth - headerLeadingWidth - headerSegmentsDisplayWidth(headerSegments, headerSeparatorText));

  return (
    <Box flexDirection="column">
      <Box>
        {headerLeadingWidth > 0 ? <Text backgroundColor={TUI_THEME.chrome}>{" ".repeat(headerLeadingWidth)}</Text> : null}
        {headerSegments.map((segment, index) => (
          <Box key={`${segment.kind}-${index}`} flexShrink={0}>
            {index > 0 ? <Text backgroundColor={TUI_THEME.chrome} dimColor>{headerSeparatorText}</Text> : null}
            <Text
              backgroundColor={TUI_THEME.chrome}
              color={segment.kind === "brand" ? TUI_THEME.accent : segment.kind === "view" ? TUI_THEME.text : undefined}
              bold={segment.kind === "brand"}
              dimColor={segment.kind !== "brand" && segment.kind !== "view"}
            >
              {segment.text}
            </Text>
          </Box>
        ))}
        {headerTrailingWidth > 0 ? <Text backgroundColor={TUI_THEME.chrome}>{" ".repeat(headerTrailingWidth)}</Text> : null}
      </Box>

      <Box flexDirection="column" height={contentHeight} paddingX={1}>
        {children}
      </Box>

      {input}

      <StatusBar text={statusText} terminalWidth={terminalWidth} />
      {error ? (
        <Box paddingX={1}>
          <Text color={TUI_THEME.danger}>{error}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function headerSegmentsDisplayWidth(segments: Array<{ text: string }>, separator: string): number {
  return segments.reduce((sum, segment, index) => sum + displayWidth(segment.text) + (index > 0 ? displayWidth(separator) : 0), 0);
}

function headerDisplaySegments(parts: { brand: string; view: string; task: string; project: string; shortcut: string }): Array<{
  kind: keyof typeof parts;
  text: string;
}> {
  return (Object.entries(parts) as Array<[keyof typeof parts, string]>)
    .filter(([, text]) => Boolean(text))
    .map(([kind, text]) => ({ kind, text }));
}

function headerParts(input: { view: AppView; cwd: string; taskId: string | null; terminalWidth: number }): {
  brand: string;
  view: string;
  task: string;
  project: string;
  shortcut: string;
} {
  const nano = input.terminalWidth < 16;
  const tiny = input.terminalWidth < 24;
  const narrow = input.terminalWidth < 72;
  const veryNarrow = input.terminalWidth < 56;
  const ultraNarrow = input.terminalWidth < 40;
  const task = compactHeaderTaskId(input.taskId);
  const showTask = input.terminalWidth >= 24 && !(task === "none" && input.terminalWidth < 32);
  const contentWidth = Math.max(1, input.terminalWidth - 2);
  const separator = headerSeparator(input.terminalWidth);

  return fitHeaderParts({
    brand: narrow ? "pct" : "parallel-codex-tui",
    view: nano ? "" : input.terminalWidth <= 24 && input.view === "native" ? "nat" : narrow ? shortViewLabel(input.view) : viewLabel(input.view),
    task: showTask ? ultraNarrow ? ultraCompactTaskId(task) : narrow ? task : `task ${task}` : "",
    project: tiny || ultraNarrow ? "" : compactHeaderProject(input.cwd, veryNarrow ? 10 : narrow ? 16 : 40),
    shortcut: narrow ? shortShortcutHint(input.view) : shortcutHint(input.view)
  }, contentWidth, separator);
}

function fitHeaderParts(
  parts: { brand: string; view: string; task: string; project: string; shortcut: string },
  contentWidth: number,
  separator: string
): { brand: string; view: string; task: string; project: string; shortcut: string } {
  const fitted = { ...parts };
  if (headerLineLength(fitted, separator) <= contentWidth) {
    return fitted;
  }

  fitted.project = "";
  if (headerLineLength(fitted, separator) <= contentWidth) {
    return fitted;
  }

  const taskBudget = Math.max(3, contentWidth - headerLineLength({ ...fitted, task: "" }, separator) - displayWidth(separator));
  fitted.task = compactHeaderText(fitted.task, taskBudget);
  if (headerLineLength(fitted, separator) <= contentWidth) {
    return fitted;
  }

  const viewBudget = Math.max(3, contentWidth - headerLineLength({ ...fitted, view: "" }, separator) - displayWidth(separator));
  fitted.view = compactHeaderText(fitted.view, viewBudget);
  if (headerLineLength(fitted, separator) <= contentWidth) {
    return fitted;
  }

  fitted.shortcut = "";
  if (headerLineLength(fitted, separator) <= contentWidth) {
    return fitted;
  }

  fitted.task = "";
  if (headerLineLength(fitted, separator) <= contentWidth) {
    return fitted;
  }

  fitted.view = "";
  if (headerLineLength(fitted, separator) <= contentWidth) {
    return fitted;
  }

  fitted.brand = compactHeaderText(fitted.brand, contentWidth);
  return fitted;
}

function headerLineLength(parts: { brand: string; view: string; task: string; project: string; shortcut: string }, separator: string): number {
  return displayWidth(headerPartList(parts).join(separator));
}

function headerPartList(parts: { brand: string; view: string; task: string; project: string; shortcut: string }): string[] {
  return [parts.brand, parts.view, parts.task, parts.project, parts.shortcut].filter(Boolean);
}

function headerSeparator(terminalWidth: number): string {
  return terminalWidth >= 56 ? APP_HEADER_ROOMY_SEPARATOR : APP_HEADER_COMPACT_SEPARATOR;
}

function viewLabel(view: AppView): string {
  return shortViewLabel(view);
}

function shortcutHint(view: AppView): string {
  if (view === "native") {
    return "^] detach";
  }
  return "^C exit";
}

function shortViewLabel(view: AppView): string {
  if (view === "worker") {
    return "logs";
  }
  if (view === "native") {
    return "native";
  }
  return "chat";
}

function shortShortcutHint(view: AppView): string {
  return view === "native" ? "^]" : "^C";
}

function compactHeaderProject(cwd: string, maxLength: number): string {
  const project = basename(cwd) || cwd;
  return compactHeaderText(project, maxLength);
}

function compactHeaderText(text: string, maxLength: number): string {
  if (maxLength <= 4) {
    return compactEndByDisplayWidth(text, Math.min(maxLength, 3));
  }
  return compactEndByDisplayWidth(text, maxLength);
}

function ultraCompactTaskId(taskId: string): string {
  const first = taskId.split("-", 1)[0];
  return first || taskId.slice(0, 6);
}

function compactHeaderTaskId(taskId: string | null): string {
  if (!taskId) {
    return "none";
  }
  const match = taskId.match(/^task-\d{8}-(.+)$/);
  if (match) {
    return match[1] ?? taskId;
  }
  return taskId.startsWith("task-") ? taskId.slice("task-".length) : taskId;
}
