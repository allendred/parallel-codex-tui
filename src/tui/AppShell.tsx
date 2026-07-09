import React from "react";
import { basename } from "node:path";
import { Box, Text } from "ink";
import type { TextProps } from "ink";
import { StatusBar } from "./StatusBar.js";
import { compactEndByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export type AppView = "chat" | "worker" | "native";
type AppShellErrorLineTheme = Pick<TextProps, "backgroundColor" | "color">;
type AppShellContentGutterTheme = Pick<TextProps, "backgroundColor">;
const APP_HEADER_ROOMY_SEPARATOR = " · ";
const APP_HEADER_COMPACT_SEPARATOR = "  ";

export interface AppShellProps {
  view: AppView;
  cwd: string;
  taskId: string | null;
  statusText: string;
  contentHeight?: number;
  terminalWidth?: number;
  showStatusBar?: boolean;
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
  showStatusBar = true,
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
  const errorRow = error ? appShellErrorRow(error, terminalWidth) : null;
  const errorTheme = appShellErrorLineTheme();

  return (
    <Box flexDirection="column">
      <Box>
        {headerLeadingWidth > 0 ? <Text backgroundColor={TUI_THEME.chrome}>{" ".repeat(headerLeadingWidth)}</Text> : null}
        {headerSegments.map((segment, index) => (
          <Box key={`${segment.kind}-${index}`} flexShrink={0}>
            {index > 0 ? <Text backgroundColor={TUI_THEME.chrome} color={TUI_THEME.muted} dimColor>{headerSeparatorText}</Text> : null}
            <Text
              backgroundColor={TUI_THEME.chrome}
              color={segment.kind === "brand" ? TUI_THEME.accent : segment.kind === "view" ? TUI_THEME.text : TUI_THEME.muted}
              bold={segment.kind === "brand"}
              dimColor={segment.kind !== "brand" && segment.kind !== "view"}
            >
              {segment.text}
            </Text>
          </Box>
        ))}
        {headerTrailingWidth > 0 ? <Text backgroundColor={TUI_THEME.chrome}>{" ".repeat(headerTrailingWidth)}</Text> : null}
      </Box>

      <AppShellContentFrame contentHeight={contentHeight} terminalWidth={terminalWidth}>
        {children}
      </AppShellContentFrame>

      {input}

      {showStatusBar ? <StatusBar text={statusText} terminalWidth={terminalWidth} /> : null}
      {errorRow ? (
        <Box>
          <Text {...errorTheme}> </Text>
          <Text {...errorTheme}>{errorRow.text}</Text>
          <Text {...errorTheme}>{" ".repeat(errorRow.trailingWidth)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function AppShellContentFrame({
  contentHeight,
  terminalWidth,
  children
}: {
  contentHeight: number;
  terminalWidth: number;
  children: React.ReactNode;
}) {
  const layout = appShellContentFrameLayout(contentHeight, terminalWidth);
  const gutterTheme = appShellContentGutterTheme();

  return (
    <Box height={layout.height}>
      {layout.leadingWidth > 0 ? <Text {...gutterTheme}>{appShellContentGutterText(layout.height, layout.leadingWidth)}</Text> : null}
      <Box flexDirection="column" height={layout.height} width={layout.contentWidth}>
        {children}
      </Box>
    </Box>
  );
}

export function appShellErrorLineTheme(): AppShellErrorLineTheme {
  return {
    backgroundColor: TUI_THEME.dangerSurface,
    color: TUI_THEME.danger
  };
}

export function appShellContentGutterTheme(): AppShellContentGutterTheme {
  return {
    backgroundColor: TUI_THEME.surface
  };
}

export function appShellContentFrameLayout(contentHeight: number, terminalWidth: number): {
  height: number;
  leadingWidth: number;
  contentWidth: number;
} {
  const height = Math.max(1, contentHeight);
  const renderWidth = typeof process.stdout.columns === "number"
    ? Math.max(1, Math.min(terminalWidth, process.stdout.columns))
    : Math.max(1, terminalWidth);
  const leadingWidth = renderWidth > 1 ? 1 : 0;
  const reservedWrapColumnWidth = renderWidth > 2 ? 1 : 0;

  return {
    height,
    leadingWidth,
    contentWidth: Math.max(1, renderWidth - leadingWidth - reservedWrapColumnWidth)
  };
}

export function appShellContentGutterText(contentHeight: number, gutterWidth: number): string {
  const height = Math.max(1, contentHeight);
  const width = Math.max(0, gutterWidth);
  return Array.from({ length: height }, () => " ".repeat(width)).join("\n");
}

function appShellErrorRow(error: string, terminalWidth: number): { text: string; trailingWidth: number } {
  const renderWidth = typeof process.stdout.columns === "number"
    ? Math.max(1, Math.min(terminalWidth, process.stdout.columns))
    : terminalWidth;
  const contentWidth = Math.max(1, renderWidth - 2);
  const text = compactEndByDisplayWidth(error, contentWidth);

  return {
    text,
    trailingWidth: Math.max(0, contentWidth - displayWidth(text))
  };
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
