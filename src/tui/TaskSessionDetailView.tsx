import React from "react";
import { Box, Text, type TextProps } from "ink";
import type {
  TaskSessionDetails,
  TaskSessionWorkerDetail
} from "../core/task-session-details.js";
import { compactEndByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export type TaskSessionDetailLineTone = "heading" | "muted" | "active" | "success" | "warning" | "danger";

export interface TaskSessionDetailDisplayLine {
  text: string;
  tone: TaskSessionDetailLineTone;
  workerIndex?: number;
  kind: "heading" | "project" | "task" | "turn" | "worker" | "native" | "empty" | "error";
}

export interface TaskSessionDetailViewProps {
  details: TaskSessionDetails | null;
  selectedWorkerIndex: number;
  loading?: boolean;
  error?: string | null;
  notice?: string | null;
  height?: number;
  terminalWidth?: number;
}

export function TaskSessionDetailView({
  details,
  selectedWorkerIndex,
  loading = false,
  error = null,
  notice = null,
  height = 20,
  terminalWidth = process.stdout.columns || 120
}: TaskSessionDetailViewProps) {
  const viewportHeight = Math.max(1, Math.trunc(height));
  const width = taskSessionDetailContentWidth(terminalWidth);
  const lines = taskSessionDetailDisplayLines(details, selectedWorkerIndex, viewportHeight, terminalWidth, {
    loading,
    error,
    notice
  });
  const blankRows = Math.max(0, viewportHeight - lines.length);
  return (
    <Box flexDirection="column" height={viewportHeight}>
      {lines.map((line, index) => (
        <TaskSessionDetailRow key={`${line.kind}-${line.workerIndex ?? index}-${index}`} line={line} width={width} />
      ))}
      {Array.from({ length: blankRows }, (_, index) => (
        <Text key={`task-session-detail-fill-${index}`} backgroundColor={TUI_THEME.surface}>
          {" ".repeat(width)}
        </Text>
      ))}
    </Box>
  );
}

export function taskSessionDetailDisplayLines(
  details: TaskSessionDetails | null,
  selectedWorkerIndex: number,
  height: number,
  terminalWidth: number,
  state: { loading?: boolean; error?: string | null; notice?: string | null } = {}
): TaskSessionDetailDisplayLine[] {
  const viewportHeight = Math.max(1, Math.trunc(height));
  const width = taskSessionDetailContentWidth(terminalWidth);
  const header: TaskSessionDetailDisplayLine[] = [
    { text: fitDetailCandidates(["Session hierarchy", "Session detail", "Session", "S"], width), tone: "heading", kind: "heading" }
  ];
  if (details && viewportHeight >= 3) {
    header.push({
      text: fitDetailCandidates([
        `project · ${safeDetailText(details.projectName)} · ${safeDetailText(details.projectPath)}`,
        `project · ${safeDetailText(details.projectName)}`,
        safeDetailText(details.projectName)
      ], width),
      tone: "muted",
      kind: "project"
    });
  }
  if (details && viewportHeight >= 4) {
    header.push({
      text: fitDetailCandidates([
        `task · ${safeDetailText(details.task.title)} · ${humanizeDetailState(details.task.status)} · ${details.turns.length} turns · ${details.workers.length} workers`,
        `task · ${safeDetailText(details.task.title)} · ${humanizeDetailState(details.task.status)}`,
        safeDetailText(details.task.title)
      ], width),
      tone: detailTaskTone(details.task.status),
      kind: "task"
    });
  }
  if (state.notice && header.length < viewportHeight) {
    header.push({ text: fitDetailText(safeDetailText(state.notice), width), tone: "active", kind: "heading" });
  }
  const bodySlots = Math.max(0, viewportHeight - header.length);
  if (bodySlots === 0) {
    return header;
  }
  if (state.loading) {
    return [...header, { text: fitDetailText("loading session hierarchy", width), tone: "muted", kind: "empty" }];
  }
  if (state.error) {
    return [...header, {
      text: fitDetailText(`error · ${safeDetailText(state.error)}`, width),
      tone: "danger",
      kind: "error"
    }];
  }
  if (!details) {
    return [...header, { text: fitDetailText("No task selected", width), tone: "muted", kind: "empty" }];
  }
  if (details.turns.length === 0) {
    return [...header, { text: fitDetailText("No persisted turns", width), tone: "muted", kind: "empty" }];
  }

  const selected = clampDetailWorkerIndex(selectedWorkerIndex, details.workers.length);
  const body = taskSessionDetailBodyLines(details, selected, width);
  const selectedLine = Math.max(0, body.findIndex((line) => line.workerIndex === selected && line.kind === "worker"));
  let start = Math.min(
    Math.max(0, body.length - bodySlots),
    Math.max(0, selectedLine - Math.floor(bodySlots / 2))
  );
  if (start > 0) {
    for (let index = selectedLine; index >= start; index -= 1) {
      if (body[index]?.kind === "turn" && selectedLine - index < bodySlots) {
        start = index;
        break;
      }
    }
  }
  return [...header, ...body.slice(start, start + bodySlots)];
}

export function moveTaskSessionDetailSelection(
  current: number,
  delta: number,
  workerCount: number,
  wrap = false
): number {
  if (workerCount <= 0) {
    return 0;
  }
  const normalized = clampDetailWorkerIndex(current, workerCount);
  const next = normalized + Math.trunc(delta);
  if (wrap) {
    return ((next % workerCount) + workerCount) % workerCount;
  }
  return Math.min(workerCount - 1, Math.max(0, next));
}

function taskSessionDetailBodyLines(
  details: TaskSessionDetails,
  selectedWorkerIndex: number,
  width: number
): TaskSessionDetailDisplayLine[] {
  const workerIndexById = new Map(details.workers.map((worker, index) => [worker.id, index]));
  return details.turns.flatMap((turn) => {
    const turnNumber = Number(turn.turnId);
    const turnLabel = Number.isInteger(turnNumber) ? `Turn ${turnNumber}` : `Turn ${turn.turnId}`;
    const lines: TaskSessionDetailDisplayLine[] = [{
      text: fitDetailCandidates([
        `${turnLabel} · ${formatDetailTime(turn.createdAt)} · ${safeDetailText(turn.request) || "request unavailable"}`,
        `${turnLabel} · ${safeDetailText(turn.request) || "request unavailable"}`,
        turnLabel
      ], width),
      tone: "active",
      kind: "turn"
    }];
    if (turn.workers.length === 0) {
      lines.push({ text: fitDetailText("    no workers", width), tone: "muted", kind: "empty" });
      return lines;
    }
    for (const worker of turn.workers) {
      const workerIndex = workerIndexById.get(worker.id) ?? 0;
      lines.push({
        text: detailWorkerText(worker, workerIndex === selectedWorkerIndex, width),
        tone: detailWorkerTone(worker),
        workerIndex,
        kind: "worker"
      });
      lines.push({
        text: detailNativeText(worker, width),
        tone: "muted",
        workerIndex,
        kind: "native"
      });
    }
    return lines;
  });
}

function detailWorkerText(worker: TaskSessionWorkerDetail, selected: boolean, width: number): string {
  const marker = selected ? "> " : "  ";
  const role = `${worker.role.slice(0, 1).toUpperCase()}${worker.role.slice(1)}`;
  const engine = [worker.engine, worker.model, worker.modelProvider].filter(Boolean).join("/");
  const feature = worker.featureTitle ?? worker.featureId ?? "";
  return fitDetailCandidates([
    `${marker}${role} · ${engine} · ${feature ? `${safeDetailText(feature)} · ` : ""}${worker.state} · ${formatDetailTime(worker.lastActivityAt)}`,
    `${marker}${role} · ${engine} · ${worker.state}`,
    `${marker}${role} · ${worker.engine}`,
    `${marker}${safeDetailText(worker.id)}`,
    marker.trimEnd()
  ], width);
}

function detailNativeText(worker: TaskSessionWorkerDetail, width: number): string {
  const session = worker.nativeSession;
  const cwd = safeDetailText(session?.cwd ?? worker.dir);
  if (!session) {
    return fitDetailCandidates([
      `    native · none · cwd ${cwd}`,
      `    native · none`,
      "    no native session"
    ], width);
  }
  return fitDetailCandidates([
    `    native · ${safeDetailText(session.sessionId)} · cwd ${cwd} · used ${formatDetailTime(session.lastUsedAt)}`,
    `    native · ${safeDetailText(session.sessionId)} · used ${formatDetailTime(session.lastUsedAt)}`,
    `    native · ${safeDetailText(session.sessionId)}`,
    `    session ${safeDetailText(session.sessionId)}`
  ], width);
}

function TaskSessionDetailRow({ line, width }: { line: TaskSessionDetailDisplayLine; width: number }) {
  const fill = Math.max(0, width - displayWidth(line.text));
  return (
    <Text>
      <Text {...detailLineTheme(line.tone)}>{line.text}</Text>
      {fill > 0 ? <Text backgroundColor={TUI_THEME.surface}>{" ".repeat(fill)}</Text> : null}
    </Text>
  );
}

function detailTaskTone(status: TaskSessionDetails["task"]["status"]): TaskSessionDetailLineTone {
  if (status === "done") return "success";
  if (status === "failed") return "danger";
  if (status === "paused" || status === "cancelled") return "warning";
  return "active";
}

function detailWorkerTone(worker: TaskSessionWorkerDetail): TaskSessionDetailLineTone {
  if (worker.state === "done") return "success";
  if (worker.state === "failed") return "danger";
  if (worker.state === "cancelled") return "warning";
  if (worker.state === "running" || worker.state === "starting") return "active";
  return "muted";
}

function detailLineTheme(tone: TaskSessionDetailLineTone): Pick<TextProps, "backgroundColor" | "bold" | "color"> {
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

function clampDetailWorkerIndex(index: number, count: number): number {
  return Math.min(Math.max(0, count - 1), Math.max(0, Math.trunc(index)));
}

function humanizeDetailState(value: string): string {
  return value.replaceAll("_", " ");
}

function formatDetailTime(value: string): string {
  return value.slice(5, 16).replace("T", " ");
}

function fitDetailCandidates(candidates: string[], width: number): string {
  return candidates.find((candidate) => displayWidth(candidate) <= width)
    ?? fitDetailText(candidates.at(-1) ?? "", width);
}

function fitDetailText(text: string, width: number): string {
  return compactEndByDisplayWidth(text, Math.max(1, width));
}

function safeDetailText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function taskSessionDetailContentWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth - 2);
}
