import React from "react";
import { Box, Text, type TextProps } from "ink";
import type { WorkerLogRef } from "../orchestrator/orchestrator.js";
import type { WorkerState } from "../domain/schemas.js";
import { compactEndByDisplayWidth, displayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export type WorkerOverviewLineTone = "heading" | "muted" | "text" | "active" | "success" | "warning" | "danger";

export interface WorkerOverviewLine {
  text: string;
  tone: WorkerOverviewLineTone;
  workerIndex?: number;
}

export interface WorkerOverviewViewProps {
  workers: WorkerLogRef[];
  selectedIndex: number;
  height?: number;
  terminalWidth?: number;
}

export function WorkerOverviewView({
  workers,
  selectedIndex,
  height = 20,
  terminalWidth = process.stdout.columns || 120
}: WorkerOverviewViewProps) {
  const viewportHeight = Math.max(1, height);
  const width = workerOverviewContentWidth(terminalWidth);
  const lines = workerOverviewDisplayLines(workers, selectedIndex, viewportHeight, terminalWidth);
  const blankRows = Math.max(0, viewportHeight - lines.length);

  return (
    <Box flexDirection="column" height={viewportHeight}>
      {lines.map((line, index) => (
        <WorkerOverviewRow key={`${line.workerIndex ?? line.tone}-${index}`} line={line} width={width} />
      ))}
      {Array.from({ length: blankRows }, (_, index) => (
        <Text key={`worker-overview-fill-${index}`} backgroundColor={TUI_THEME.surface}>
          {" ".repeat(width)}
        </Text>
      ))}
    </Box>
  );
}

export function workerOverviewDisplayLines(
  workers: WorkerLogRef[],
  selectedIndex: number,
  height: number,
  terminalWidth: number
): WorkerOverviewLine[] {
  const viewportHeight = Math.max(1, Math.trunc(height));
  const width = workerOverviewContentWidth(terminalWidth);
  const lines: WorkerOverviewLine[] = [
    { text: fitWorkerOverviewCandidates(["Workers", "Work", "W"], width), tone: "heading" }
  ];

  if (viewportHeight >= 3) {
    lines.push({ text: workerOverviewSummary(workers, width), tone: "muted" });
  }

  const slots = Math.max(0, viewportHeight - lines.length);
  if (workers.length === 0) {
    if (slots > 0) {
      lines.push({ text: fitWorkerOverviewText("No workers yet", width), tone: "muted" });
    }
    return lines;
  }

  const selected = clampWorkerIndex(selectedIndex, workers.length);
  const visibleCount = Math.min(slots, workers.length);
  const start = workerOverviewWindowStart(selected, workers.length, visibleCount);
  for (let index = start; index < start + visibleCount; index += 1) {
    const worker = workers[index];
    if (!worker) {
      continue;
    }
    const state = worker.runtimeStatus?.state ?? "waiting";
    lines.push({
      text: workerOverviewWorkerText(worker, index === selected, width),
      tone: workerOverviewStateTone(state),
      workerIndex: index
    });
  }

  return lines;
}

export function moveWorkerSelection(current: number, delta: number, workerCount: number, wrap = false): number {
  if (workerCount <= 0) {
    return 0;
  }
  const normalizedCurrent = clampWorkerIndex(current, workerCount);
  const next = normalizedCurrent + Math.trunc(delta);
  if (wrap) {
    return ((next % workerCount) + workerCount) % workerCount;
  }
  return Math.min(workerCount - 1, Math.max(0, next));
}

function WorkerOverviewRow({ line, width }: { line: WorkerOverviewLine; width: number }) {
  const trailingWidth = Math.max(0, width - displayWidth(line.text));
  const theme = workerOverviewLineTheme(line.tone);
  return (
    <Text>
      <Text {...theme}>{line.text}</Text>
      {trailingWidth > 0 ? <Text backgroundColor={TUI_THEME.surface}>{" ".repeat(trailingWidth)}</Text> : null}
    </Text>
  );
}

function workerOverviewSummary(workers: WorkerLogRef[], width: number): string {
  const counts = new Map<WorkerState, number>();
  let sessions = 0;
  for (const worker of workers) {
    const state = worker.runtimeStatus?.state ?? "waiting";
    counts.set(state, (counts.get(state) ?? 0) + 1);
    if (worker.runtimeStatus?.native_session_id) {
      sessions += 1;
    }
  }
  const stateParts = (["running", "starting", "done", "failed", "waiting", "cancelled", "idle"] as WorkerState[])
    .flatMap((state) => {
      const count = counts.get(state) ?? 0;
      return count > 0 ? [`${count} ${state}`] : [];
    });
  const full = [
    `${workers.length} ${workers.length === 1 ? "worker" : "workers"}`,
    ...stateParts,
    ...(sessions > 0 ? [`${sessions} ${sessions === 1 ? "session" : "sessions"}`] : [])
  ].join(" · ");
  const active = (counts.get("running") ?? 0) + (counts.get("starting") ?? 0);
  const failed = counts.get("failed") ?? 0;
  const candidates = [
    full,
    `${workers.length} workers · ${active} active · ${failed} failed`,
    `${workers.length} workers`,
    `${workers.length}w`
  ];
  return fitWorkerOverviewCandidates(candidates, width);
}

function workerOverviewWorkerText(worker: WorkerLogRef, selected: boolean, width: number): string {
  const marker = selected ? "> " : "  ";
  const label = safeWorkerOverviewText(worker.label);
  const state = worker.runtimeStatus?.state ?? "waiting";
  const phase = humanizeWorkerOverviewPhase(worker.runtimeStatus?.phase ?? "status pending");
  const session = worker.runtimeStatus?.native_session_id ? "session" : "";
  const summary = safeWorkerOverviewText(worker.runtimeStatus?.summary ?? "");
  const identity = `${worker.role}/${worker.engine}`;
  return fitWorkerOverviewCandidates([
    [marker + label, state, phase, session, summary].filter(Boolean).join(" · "),
    [marker + label, state, phase, session].filter(Boolean).join(" · "),
    [marker + label, state, session].filter(Boolean).join(" · "),
    [marker + identity, state].join(" · "),
    marker.trimEnd()
  ], width);
}

function workerOverviewWindowStart(selected: number, count: number, visibleCount: number): number {
  if (visibleCount <= 0 || count <= visibleCount) {
    return 0;
  }
  return Math.min(count - visibleCount, Math.max(0, selected - Math.floor(visibleCount / 2)));
}

function clampWorkerIndex(index: number, count: number): number {
  return Math.min(Math.max(0, count - 1), Math.max(0, Math.trunc(index)));
}

function fitWorkerOverviewCandidates(candidates: string[], width: number): string {
  const fitted = candidates.find((candidate) => displayWidth(candidate) <= width);
  return fitted ?? fitWorkerOverviewText(candidates.at(-1) ?? "", width);
}

function fitWorkerOverviewText(text: string, width: number): string {
  return compactEndByDisplayWidth(text, Math.max(1, width));
}

function safeWorkerOverviewText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeWorkerOverviewPhase(phase: string): string {
  return safeWorkerOverviewText(phase).replace(/[_-]+/g, " ");
}

function workerOverviewStateTone(state: WorkerState): WorkerOverviewLineTone {
  if (state === "done") {
    return "success";
  }
  if (state === "failed") {
    return "danger";
  }
  if (state === "running" || state === "starting") {
    return "active";
  }
  if (state === "waiting") {
    return "warning";
  }
  return "muted";
}

function workerOverviewLineTheme(tone: WorkerOverviewLineTone): Pick<TextProps, "backgroundColor" | "bold" | "color"> {
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
            : tone === "muted"
              ? TUI_THEME.muted
              : TUI_THEME.text,
    ...(tone === "heading" || tone === "danger" ? { bold: true } : {})
  };
}

function workerOverviewContentWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth - 2);
}
