import React from "react";
import { basename } from "node:path";
import { Box, Text } from "ink";
import type { TextProps } from "ink";
import { StatusBar } from "./StatusBar.js";
import { compactEndByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export type AppView = "chat" | "worker" | "native" | "router";
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
            {index > 0 ? <Text backgroundColor={TUI_THEME.chrome} color={TUI_THEME.muted}>{headerSeparatorText}</Text> : null}
            <Text
              backgroundColor={TUI_THEME.chrome}
              color={segment.kind === "brand" ? TUI_THEME.accent : segment.kind === "view" ? TUI_THEME.text : TUI_THEME.muted}
              bold={segment.kind === "brand"}
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

      {showStatusBar ? (
        <StatusBar
          text={statusText}
          terminalWidth={terminalWidth}
          fillRail={typeof process.stdout.columns === "number"}
        />
      ) : null}
      {errorRow ? (
        <Box>
          <Text {...errorTheme}> </Text>
          <Text {...errorTheme}>{errorRow.text}{" ".repeat(errorRow.trailingWidth)}</Text>
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

export function appShellErrorRow(error: string, terminalWidth: number): { text: string; trailingWidth: number } {
  const renderWidth = typeof process.stdout.columns === "number"
    ? Math.max(1, Math.min(terminalWidth, process.stdout.columns))
    : terminalWidth;
  const contentWidth = Math.max(1, renderWidth - 2);
  const text = appShellErrorDisplayText(error, contentWidth);

  return {
    text,
    trailingWidth: Math.max(0, contentWidth - displayWidth(text))
  };
}

function appShellErrorDisplayText(error: string, maxWidth: number): string {
  const normalized = normalizeAppShellError(error);
  const message = normalized.replace(/^(?:ERROR|Error|error):\s*/, "").trim();
  const full = `error · ${message || "unknown"}`;
  if (displayWidth(full) <= maxWidth) {
    return full;
  }

  for (const summary of appShellErrorSummaries(message)) {
    const prefixed = `error · ${summary}`;
    if (displayWidth(prefixed) <= maxWidth) {
      return prefixed;
    }
    if (displayWidth(summary) <= maxWidth) {
      return summary;
    }
  }

  return ["error", "err", "!"]
    .find((candidate) => displayWidth(candidate) <= maxWidth)
    ?? "";
}

function normalizeAppShellError(error: string): string {
  return error
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function appShellErrorSummaries(message: string): string[] {
  if (/permission denied|\bEACCES\b|\bEPERM\b/i.test(message)) {
    return ["permission denied", "denied"];
  }

  const nativeSession = message.match(/no native session for\s+(.+?)(?:\s+·|$)/i);
  if (nativeSession) {
    const identity = compactErrorIdentity(nativeSession[1] ?? "");
    const role = identity.split("/", 1)[0] ?? "";
    return [
      identity ? `no native session · ${identity}` : "no native session",
      role ? `no session · ${role}` : "no session",
      "no session",
      "no sid"
    ];
  }

  if (/router.*(?:timed out|timeout)|(?:timed out|timeout).*router/i.test(message)) {
    const duration = compactErrorDuration(message);
    const proxy = /\bproxy\b|代理/i.test(message);
    return [
      proxy
        ? ["router timeout", duration, "proxy"].filter(Boolean).join(" · ")
        : ["router timeout", duration].filter(Boolean).join(" · "),
      duration ? `router timeout · ${duration}` : "router timeout",
      duration ? `timeout · ${duration}` : "timeout",
      "timeout",
      "time"
    ];
  }

  if (/\bproxy\b|代理/i.test(message)) {
    return ["proxy error", "proxy"];
  }
  if (/\bnetwork\b|\bECONNREFUSED\b|\bECONNRESET\b|\bENETUNREACH\b|\bEHOSTUNREACH\b/i.test(message)) {
    return ["network error", "network", "net"];
  }
  if (/no workers?/i.test(message)) {
    return ["no workers · start task", "no workers", "workers"];
  }
  if (/command not found|\bENOENT\b/i.test(message)) {
    return ["command missing", "command"];
  }
  if (/not a directory|workspace.*(?:missing|not found|does not exist)/i.test(message)) {
    return ["workspace missing", "bad path", "path"];
  }

  const words = message.split(/\s+/).filter(Boolean);
  const summaries: string[] = [];
  for (let count = Math.min(4, words.length); count >= 1; count -= 1) {
    summaries.push(words.slice(0, count).join(" "));
  }
  return summaries;
}

function compactErrorIdentity(label: string): string {
  const match = label.trim().match(/^([^()]+?)\s*\(([^)]+)\)$/);
  if (!match) {
    return label.trim().toLowerCase();
  }
  return `${(match[1] ?? "").trim().toLowerCase()}/${(match[2] ?? "").trim().toLowerCase()}`;
}

function compactErrorDuration(message: string): string | null {
  const milliseconds = message.match(/\b(\d+(?:\.\d+)?)\s*ms\b/i);
  if (milliseconds) {
    const value = Number(milliseconds[1]);
    if (Number.isFinite(value) && value >= 1000) {
      return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}s`;
    }
    return `${milliseconds[1]}ms`;
  }
  return message.match(/\b\d+(?:\.\d+)?s\b/i)?.[0] ?? null;
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
  const showTask = Boolean(task) && input.terminalWidth >= 24;
  const contentWidth = Math.max(1, input.terminalWidth - 2);
  const separator = headerSeparator(input.terminalWidth);

  return fitHeaderParts({
    brand: narrow ? "pct" : "parallel-codex-tui",
    view: nano ? "" : input.terminalWidth <= 24 && input.view === "native" ? "nat" : narrow ? shortViewLabel(input.view) : viewLabel(input.view),
    task: showTask ? ultraNarrow ? ultraCompactTaskId(task) : narrow ? task : `#${task}` : "",
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
    return "^] logs";
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
  if (view === "router") {
    return "routes";
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
    return "";
  }
  const match = taskId.match(/^task-\d{8}-(.+)$/);
  if (match) {
    return match[1] ?? taskId;
  }
  return taskId.startsWith("task-") ? taskId.slice("task-".length) : taskId;
}
