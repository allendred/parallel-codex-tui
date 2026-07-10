import type { RouteDecision } from "../domain/schemas.js";
import { compactEndByDisplayWidth } from "./display-width.js";

export interface StatusLineState {
  taskId: string;
  main?: string;
  judge?: string;
  actor?: string;
  critic?: string;
  featureProgress?: {
    wave: number;
    waves: number;
    phase: "actor" | "critic" | "revision";
    completed: number;
    total: number;
  };
  workers?: Array<{
    label: string;
    status: string;
  }>;
}

export interface RuntimeWorkerStatus {
  state: string;
  phase: string;
  summary: string;
  native_session_id?: string;
}

export type FooterHelpMode = "chat" | "worker" | "native";

export function formatStatusLine(state: StatusLineState | null): string {
  if (!state) {
    return "idle";
  }

  const parts = [compactTaskId(state.taskId)];
  if (state.featureProgress) {
    parts.push(formatFeatureProgress(state.featureProgress));
  }
  if (state.workers?.length) {
    parts.push(formatWorkerSummary(state.workers));
    return parts.join(" | ");
  }

  if (state.main) {
    parts.push(`main ${compactStatus(state.main)}`);
  }
  if (state.judge) {
    parts.push(`judge ${compactStatus(state.judge)}`);
  }
  if (state.actor) {
    parts.push(`actor ${compactStatus(state.actor)}`);
  }
  if (state.critic) {
    parts.push(`critic ${compactStatus(state.critic)}`);
  }

  return parts.join(" | ");
}

function formatFeatureProgress(progress: NonNullable<StatusLineState["featureProgress"]>): string {
  return `wave ${progress.wave}/${progress.waves} · ${progress.phase} ${progress.completed}/${progress.total}`;
}

export function formatRouteStatus(route: RouteDecision | null): string {
  if (!route) {
    return "";
  }
  const details: string[] = [route.mode];
  if (route.source === "forced" || route.source === "fallback") {
    details.push(route.source);
  }
  if (typeof route.duration_ms === "number") {
    details.push(formatRouteDuration(route.duration_ms));
  }
  return `route ${details.join(" · ")}`;
}

export function formatSelectedWorkerStatus(state: StatusLineState | null, selectedIndex: number): string {
  const worker = state?.workers?.[selectedIndex];
  if (!worker) {
    return "";
  }
  return `${compactWorkerLabel(worker.label)} ${compactStatus(worker.status)}`;
}

export function formatWorkerRuntimeStatus(status: RuntimeWorkerStatus): string {
  const detail = [
    status.state.trim() || "idle",
    humanizeWorkerPhase(status.phase),
    status.native_session_id ? `session ${compactNativeSessionId(status.native_session_id)}` : "",
    status.summary.trim() || "no summary"
  ].filter(Boolean).join(" · ");
  return compactEndByDisplayWidth(detail, 96);
}

export function formatFooterHelp(mode: FooterHelpMode = "chat"): string {
  if (mode === "native") {
    return "scroll · ^] logs";
  }
  if (mode === "worker") {
    return "scroll · Tab · ^O attach · Esc chat";
  }
  return "^W logs · Tab · ^O attach";
}

function compactNativeSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}...` : sessionId;
}

function formatRouteDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  if (durationMs < 10000) {
    return `${(durationMs / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  }
  return `${Math.round(durationMs / 1000)}s`;
}

function humanizeWorkerPhase(phase: string): string {
  const normalized = phase.trim().toLowerCase();
  if (!normalized) {
    return "";
  }
  if (normalized === "process-idle-timeout") {
    return "idle timeout";
  }
  if (normalized === "process-exited") {
    return "exited";
  }
  if (normalized === "native-resume-failed") {
    return "resume failed";
  }
  return normalized.replace(/[-_]+/g, " ");
}

function formatWorkerSummary(workers: NonNullable<StatusLineState["workers"]>): string {
  const counts = new Map<string, number>();
  for (const worker of workers) {
    const state = compactStatus(worker.status);
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }

  const priority = ["fail", "stop", "run", "wait", "done"];
  const orderedStates = [
    ...priority.filter((state) => counts.has(state)),
    ...Array.from(counts.keys()).filter((state) => !priority.includes(state)).sort()
  ];
  const summary = orderedStates.map((state) => `${state} ${counts.get(state)}`).join(" ");
  return `workers ${workers.length}${summary ? ` | ${summary}` : ""}`;
}

function compactStatus(status: string): string {
  const trimmed = status.trim();
  if (!trimmed) {
    return "idle";
  }
  const state = trimmed.split(/[/: ]/, 1)[0]?.trim().toLowerCase();
  if (state === "running") {
    return "run";
  }
  if (state === "failed" || state === "error") {
    return "fail";
  }
  if (state === "cancelled" || state === "canceled") {
    return "stop";
  }
  if (state === "waiting" || state === "queued") {
    return "wait";
  }
  return state || "idle";
}

function compactTaskId(taskId: string): string {
  const withoutPrefix = taskId.startsWith("task-") ? taskId.slice("task-".length) : taskId;
  const dated = withoutPrefix.match(/^\d{8}-(.+)$/);
  return dated?.[1] ?? withoutPrefix;
}

function compactWorkerLabel(label: string): string {
  const match = label.match(/^\s*([^(]+?)\s*\(([^)]+)\)\s*$/);
  if (match) {
    return `${match[1].trim().toLowerCase()}/${match[2].trim().toLowerCase()}`;
  }
  return label.trim().toLowerCase().replace(/\s+/g, "/");
}
