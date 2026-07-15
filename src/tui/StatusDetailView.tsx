import React from "react";
import { basename } from "node:path";
import { Box, Text, type TextProps } from "ink";
import type { WorkerLogRef } from "../orchestrator/orchestrator.js";
import { compactEndByDisplayWidth, displayWidth, wrapByDisplayWidth } from "./display-width.js";
import { TUI_THEME } from "./theme.js";

export type StatusDetailTone = "heading" | "muted" | "text" | "active" | "success" | "warning" | "danger";

export interface StatusDetailLine {
  text: string;
  tone: StatusDetailTone;
}

export interface StatusDetailViewProps {
  cwd: string;
  taskId: string | null;
  mode: "simple" | "complex" | null;
  busy: boolean;
  canRetry: boolean;
  taskStatus: string;
  routeStatus: string;
  routeReason?: string;
  workers: WorkerLogRef[];
  selectedWorkerIndex: number;
  height?: number;
  terminalWidth?: number;
}

export function StatusDetailView({
  height = 20,
  terminalWidth = process.stdout.columns || 120,
  ...input
}: StatusDetailViewProps) {
  const viewportHeight = Math.max(1, Math.trunc(height));
  const width = Math.max(1, terminalWidth - 2);
  const lines = statusDetailDisplayLines(input, width, viewportHeight);
  const blankRows = Math.max(0, viewportHeight - lines.length);

  return (
    <Box flexDirection="column" height={viewportHeight}>
      {lines.map((line, index) => (
        <StatusDetailRow key={`${line.tone}-${index}`} line={line} width={width} />
      ))}
      {Array.from({ length: blankRows }, (_, index) => (
        <Text key={`status-detail-fill-${index}`} backgroundColor={TUI_THEME.surface}>
          {" ".repeat(width)}
        </Text>
      ))}
    </Box>
  );
}

export function statusDetailDisplayLines(
  input: Omit<StatusDetailViewProps, "height" | "terminalWidth">,
  width: number,
  height: number
): StatusDetailLine[] {
  const safeWidth = Math.max(1, Math.trunc(width));
  const maxLines = Math.max(1, Math.trunc(height));
  const selected = input.workers[clampWorkerIndex(input.selectedWorkerIndex, input.workers.length)];
  const lines: StatusDetailLine[] = [
    { text: "Status", tone: "heading" },
    {
      text: fitStatusDetailText(taskDetail(input), safeWidth),
      tone: input.busy ? "active" : input.canRetry ? "warning" : "text"
    },
    {
      text: fitStatusDetailText(`workspace · ${basename(input.cwd) || input.cwd} · ${input.cwd}`, safeWidth),
      tone: "muted"
    }
  ];

  if (input.routeStatus.trim()) {
    lines.push({
      text: fitStatusDetailText(input.routeStatus.trim(), safeWidth),
      tone: /fallback|failed|error|timeout/i.test(input.routeStatus) ? "danger" : "text"
    });
  }
  lines.push({
    text: fitStatusDetailText(workerSummary(input.workers, input.taskStatus), safeWidth),
    tone: input.workers.some((worker) => worker.runtimeStatus?.state === "failed") ? "danger" : "text"
  });

  if (selected) {
    lines.push(...selectedWorkerLines(selected, safeWidth));
  }

  const reason = sanitizeStatusDetailText(input.routeReason ?? "");
  if (reason) {
    const prefix = "reason · ";
    const wrapped = wrapByDisplayWidth(reason, Math.max(1, safeWidth - displayWidth(prefix))).slice(0, 2);
    wrapped.forEach((part, index) => lines.push({
      text: fitStatusDetailText(`${index === 0 ? prefix : "         "}${part}`, safeWidth),
      tone: "muted"
    }));
  }

  return lines.slice(0, maxLines);
}

function taskDetail(input: Omit<StatusDetailViewProps, "height" | "terminalWidth">): string {
  if (!input.taskId) {
    return "task · none";
  }
  const state = input.busy ? "running" : input.canRetry ? "retryable" : "ready";
  return ["task", compactTaskId(input.taskId), input.mode, state].filter(Boolean).join(" · ");
}

function workerSummary(workers: WorkerLogRef[], taskStatus: string): string {
  if (workers.length === 0) {
    return "workers · none";
  }
  const summary = taskStatus
    .split("|")
    .map((part) => part.trim())
    .filter((part) => /^workers\s+\d+$|^(?:fail|stop|run|wait|done|idle)\s+\d+/i.test(part))
    .join(" · ");
  return summary || `workers · ${workers.length}`;
}

function selectedWorkerLines(worker: WorkerLogRef, width: number): StatusDetailLine[] {
  const status = worker.runtimeStatus;
  const state = status?.state ?? "waiting";
  const identity = [
    "selected",
    `${worker.role}/${worker.engine}`,
    state,
    status?.feature_title ?? worker.featureId ?? ""
  ].filter(Boolean).join(" · ");
  const model = [status?.model_provider, status?.model_name].filter(Boolean).join("/");
  const phase = status
    ? ["phase", humanizeStatusDetail(status.phase), `updated ${formatStatusDetailTime(status.last_event_at)}`].join(" · ")
    : "phase · status pending";
  const lines: StatusDetailLine[] = [
    { text: fitStatusDetailText(identity, width), tone: workerStateTone(state) },
    ...(model ? [{ text: fitStatusDetailText(`model · ${model}`, width), tone: "muted" as const }] : []),
    { text: fitStatusDetailText(phase, width), tone: "muted" }
  ];
  if (status?.native_session_id) {
    lines.push({
      text: fitStatusDetailText(`session · ${status.native_session_id}`, width),
      tone: "muted"
    });
  }
  const summary = sanitizeStatusDetailText(status?.summary ?? "");
  if (summary) {
    lines.push({ text: fitStatusDetailText(`summary · ${summary}`, width), tone: "text" });
  }
  return lines;
}

function StatusDetailRow({ line, width }: { line: StatusDetailLine; width: number }) {
  const text = fitStatusDetailText(line.text, width);
  const trailingWidth = Math.max(0, width - displayWidth(text));
  const theme = statusDetailLineTheme(line.tone);
  return (
    <Text>
      <Text {...theme}>{text}</Text>
      {trailingWidth > 0 ? <Text backgroundColor={TUI_THEME.surface}>{" ".repeat(trailingWidth)}</Text> : null}
    </Text>
  );
}

export function statusDetailLineTheme(tone: StatusDetailTone): Pick<TextProps, "backgroundColor" | "bold" | "color"> {
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

function workerStateTone(state: string): StatusDetailTone {
  if (state === "done") {
    return "success";
  }
  if (state === "failed") {
    return "danger";
  }
  if (state === "running" || state === "starting") {
    return "active";
  }
  if (state === "waiting" || state === "cancelled") {
    return "warning";
  }
  return "muted";
}

function fitStatusDetailText(text: string, width: number): string {
  return compactEndByDisplayWidth(sanitizeStatusDetailText(text), Math.max(1, width));
}

function sanitizeStatusDetailText(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function humanizeStatusDetail(value: string): string {
  return sanitizeStatusDetailText(value).replace(/[-_]+/g, " ");
}

function formatStatusDetailTime(value: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    return "unknown";
  }
  return parsed.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "Z");
}

function compactTaskId(taskId: string): string {
  const withoutPrefix = taskId.startsWith("task-") ? taskId.slice("task-".length) : taskId;
  return withoutPrefix.replace(/^\d{8}-/, "");
}

function clampWorkerIndex(index: number, count: number): number {
  return Math.min(Math.max(0, count - 1), Math.max(0, Math.trunc(index)));
}
