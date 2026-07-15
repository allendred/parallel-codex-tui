import React from "react";
import { Box, Text, type TextProps } from "ink";
import type { TaskIndexSummary } from "../core/session-index.js";
import type { TaskState } from "../domain/schemas.js";
import { compactEndByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export type TaskSessionLineTone = "heading" | "muted" | "active" | "success" | "warning" | "danger";

export interface TaskSessionDisplayLine {
  text: string;
  tone: TaskSessionLineTone;
  taskIndex?: number;
}

export interface TaskSessionsViewProps {
  tasks: TaskIndexSummary[];
  activeTaskId: string | null;
  selectedIndex: number;
  includeArchived?: boolean;
  notice?: string | null;
  action?: TaskSessionViewAction | null;
  loading?: boolean;
  error?: string | null;
  height?: number;
  terminalWidth?: number;
}

export type TaskSessionViewAction =
  | { type: "rename"; title: string }
  | { type: "delete"; title: string };

export function TaskSessionsView({
  tasks,
  activeTaskId,
  selectedIndex,
  includeArchived = false,
  notice = null,
  action = null,
  loading = false,
  error = null,
  height = 20,
  terminalWidth = process.stdout.columns || 120
}: TaskSessionsViewProps) {
  const viewportHeight = Math.max(1, height);
  const width = taskSessionsContentWidth(terminalWidth);
  const lines = taskSessionsDisplayLines(tasks, activeTaskId, selectedIndex, viewportHeight, terminalWidth, {
    loading,
    error,
    includeArchived,
    notice,
    action
  });
  const blankRows = Math.max(0, viewportHeight - lines.length);

  return (
    <Box flexDirection="column" height={viewportHeight}>
      {lines.map((line, index) => (
        <TaskSessionRow key={`${line.taskIndex ?? line.tone}-${index}`} line={line} width={width} />
      ))}
      {Array.from({ length: blankRows }, (_, index) => (
        <Text key={`task-session-fill-${index}`} backgroundColor={TUI_THEME.surface}>
          {" ".repeat(width)}
        </Text>
      ))}
    </Box>
  );
}

export function taskSessionsDisplayLines(
  tasks: TaskIndexSummary[],
  activeTaskId: string | null,
  selectedIndex: number,
  height: number,
  terminalWidth: number,
  state: {
    loading?: boolean;
    error?: string | null;
    includeArchived?: boolean;
    notice?: string | null;
    action?: TaskSessionViewAction | null;
  } = {}
): TaskSessionDisplayLine[] {
  const viewportHeight = Math.max(1, Math.trunc(height));
  const width = taskSessionsContentWidth(terminalWidth);
  const lines: TaskSessionDisplayLine[] = [
    {
      text: fitTaskSessionCandidates([
        state.includeArchived ? "Task sessions · archived shown" : "Task sessions",
        state.includeArchived ? "Sessions · all" : "Sessions",
        "Tasks",
        "T"
      ], width),
      tone: "heading"
    }
  ];

  if (viewportHeight >= 3) {
    lines.push({ text: taskSessionSummary(tasks, width), tone: "muted" });
  }

  if (viewportHeight >= 4 && state.action) {
    lines.push({
      text: fitTaskSessionText(
        state.action.type === "rename"
          ? `rename · ${safeTaskSessionText(state.action.title)} · Enter save · Esc cancel`
          : `delete · ${safeTaskSessionText(state.action.title)} · press D again · Esc cancel`,
        width
      ),
      tone: state.action.type === "delete" ? "danger" : "active"
    });
  } else if (viewportHeight >= 4 && state.notice) {
    lines.push({ text: fitTaskSessionText(state.notice, width), tone: "success" });
  }

  const slots = Math.max(0, viewportHeight - lines.length);
  if (state.loading) {
    if (slots > 0) {
      lines.push({ text: fitTaskSessionText("loading task sessions", width), tone: "muted" });
    }
    return lines;
  }
  if (state.error) {
    if (slots > 0) {
      lines.push({ text: fitTaskSessionText(`error · ${safeTaskSessionText(state.error)}`, width), tone: "danger" });
    }
    return lines;
  }
  if (tasks.length === 0) {
    if (slots > 0) {
      lines.push({ text: fitTaskSessionText("No saved task sessions", width), tone: "muted" });
    }
    return lines;
  }

  const selected = clampTaskIndex(selectedIndex, tasks.length);
  const visibleCount = Math.min(slots, tasks.length);
  const start = taskSessionWindowStart(selected, tasks.length, visibleCount);
  for (let index = start; index < start + visibleCount; index += 1) {
    const task = tasks[index];
    if (!task) {
      continue;
    }
    lines.push({
      text: taskSessionRowText(task, index === selected, task.id === activeTaskId, width),
      tone: taskSessionStatusTone(task),
      taskIndex: index
    });
  }
  return lines;
}

export function moveTaskSessionSelection(current: number, delta: number, taskCount: number, wrap = false): number {
  if (taskCount <= 0) {
    return 0;
  }
  const normalizedCurrent = clampTaskIndex(current, taskCount);
  const next = normalizedCurrent + Math.trunc(delta);
  if (wrap) {
    return ((next % taskCount) + taskCount) % taskCount;
  }
  return Math.min(taskCount - 1, Math.max(0, next));
}

function TaskSessionRow({ line, width }: { line: TaskSessionDisplayLine; width: number }) {
  const trailingWidth = Math.max(0, width - displayWidth(line.text));
  const theme = taskSessionLineTheme(line.tone);
  return (
    <Text>
      <Text {...theme}>{line.text}</Text>
      {trailingWidth > 0 ? <Text backgroundColor={TUI_THEME.surface}>{" ".repeat(trailingWidth)}</Text> : null}
    </Text>
  );
}

function taskSessionSummary(tasks: TaskIndexSummary[], width: number): string {
  const counts = new Map<"running" | "done" | "failed" | "cancelled", number>();
  let archived = 0;
  for (const task of tasks) {
    if (task.archived_at) {
      archived += 1;
      continue;
    }
    const group = taskSessionStatusGroup(task.status);
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  const parts = ["running", "done", "failed", "cancelled"].flatMap((group) => {
    const count = counts.get(group as "running" | "done" | "failed" | "cancelled") ?? 0;
    return count > 0 ? [`${count} ${group}`] : [];
  });
  if (archived > 0) {
    parts.push(`${archived} archived`);
  }
  return fitTaskSessionCandidates([
    [`${tasks.length} ${tasks.length === 1 ? "task" : "tasks"}`, ...parts].join(" · "),
    `${tasks.length} tasks · ${counts.get("running") ?? 0} active · ${counts.get("failed") ?? 0} failed`,
    `${tasks.length} tasks`,
    `${tasks.length}t`
  ], width);
}

function taskSessionRowText(task: TaskIndexSummary, selected: boolean, active: boolean, width: number): string {
  const marker = `${selected ? ">" : " "} ${active ? "*" : " "} `;
  const title = safeTaskSessionText(task.title);
  const status = task.archived_at
    ? `archived · ${humanizeTaskSessionStatus(task.status)}`
    : humanizeTaskSessionStatus(task.status);
  const date = task.created_at.slice(5, 16).replace("T", " ");
  const turns = `${task.turnCount} ${task.turnCount === 1 ? "turn" : "turns"}`;
  const workers = `${task.workerCount} ${task.workerCount === 1 ? "worker" : "workers"}`;
  const native = `${task.nativeSessionCount} native`;
  const compactId = task.id.replace(/^task-/, "#");
  return fitTaskSessionCandidates([
    [marker + title, status, turns, workers, native, date].join(" · "),
    [marker + title, status, turns, workers, native].join(" · "),
    [marker + title, status, turns, workers].join(" · "),
    [marker + title, status].join(" · "),
    [marker + compactId, status].join(" · "),
    marker.trimEnd()
  ], width);
}

function taskSessionWindowStart(selected: number, count: number, visibleCount: number): number {
  if (visibleCount <= 0 || count <= visibleCount) {
    return 0;
  }
  return Math.min(count - visibleCount, Math.max(0, selected - Math.floor(visibleCount / 2)));
}

function clampTaskIndex(index: number, count: number): number {
  return Math.min(Math.max(0, count - 1), Math.max(0, Math.trunc(index)));
}

function taskSessionStatusGroup(status: TaskState): "running" | "done" | "failed" | "cancelled" {
  if (status === "done" || status === "failed" || status === "cancelled") {
    return status;
  }
  return "running";
}

function humanizeTaskSessionStatus(status: TaskState): string {
  return status.replace(/_/g, " ");
}

function taskSessionStatusTone(task: TaskIndexSummary): TaskSessionLineTone {
  if (task.archived_at) {
    return "muted";
  }
  const status = task.status;
  if (status === "done") {
    return "success";
  }
  if (status === "failed") {
    return "danger";
  }
  if (status === "cancelled") {
    return "warning";
  }
  return "active";
}

function fitTaskSessionCandidates(candidates: string[], width: number): string {
  return candidates.find((candidate) => displayWidth(candidate) <= width)
    ?? fitTaskSessionText(candidates.at(-1) ?? "", width);
}

function fitTaskSessionText(text: string, width: number): string {
  return compactEndByDisplayWidth(text, Math.max(1, width));
}

function safeTaskSessionText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function taskSessionLineTheme(tone: TaskSessionLineTone): Pick<TextProps, "backgroundColor" | "bold" | "color"> {
  return {
    backgroundColor: TUI_THEME.surface,
    color: tone === "heading" || tone === "active"
      ? TUI_THEME.accent
      : tone === "success"
        ? TUI_THEME.success
        : tone === "warning"
          ? TUI_THEME.warning
          : tone === "danger"
            ? TUI_THEME.danger
            : TUI_THEME.muted,
    ...(tone === "heading" || tone === "danger" ? { bold: true } : {})
  };
}

function taskSessionsContentWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth - 2);
}
