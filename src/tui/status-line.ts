import type { RouteDecision } from "../domain/schemas.js";
import type { RouteStartInfo } from "../orchestrator/orchestrator.js";
import { classifyRouterFailure } from "../core/router-audit.js";
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
    phase: "actor" | "critic" | "revision" | "integration" | "verification";
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
  if (state.main) {
    parts.push(`main ${compactStatus(state.main)}`);
    return parts.join(" | ");
  }
  if (state.featureProgress) {
    parts.push(formatFeatureProgress(state.featureProgress));
  }
  if (state.workers?.length) {
    parts.push(formatWorkerSummary(state.workers));
    return parts.join(" | ");
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
  if (route.router_fallback_resolution === "main") {
    details.push("user Main");
  } else if (route.router_fallback_resolution === "parallel") {
    details.push("user Parallel");
  } else if (route.router_fallback_resolution === "cancelled") {
    details.push("user cancelled");
  } else if (route.router_fallback_resolution === "retry") {
    details.push("Router retry");
  }
  if (route.source === "fallback") {
    const cause = classifyRouterFailure(route.reason);
    if (cause) {
      details.push(routeFailureKindLabel(cause, route));
    }
    const proxy = routeProxyStatus(route, cause);
    if (proxy) {
      details.push(proxy);
    }
  } else if (route.proxy_configured && route.proxy_endpoint) {
    details.push(`via ${route.proxy_endpoint}`);
  }
  if (typeof route.duration_ms === "number") {
    details.push(formatRouteDuration(route.duration_ms));
  }
  return `route ${details.join(" · ")}`;
}

export function formatRoutePendingStatus(state: RouteStartInfo | null, elapsedMs?: number): string {
  if (!state) {
    return "";
  }
  if (state.mode !== "auto") {
    return `route ${state.mode} · forced`;
  }
  const label = routePendingPhaseLabel(state);
  const path = routePendingPathLabel(state);
  const details = [label, ...(path ? [path] : [])];
  if (typeof elapsedMs === "number") {
    const boundedElapsedMs = Math.min(state.timeoutMs, Math.max(0, elapsedMs));
    details.push(`${formatRouteElapsed(boundedElapsedMs)} / ${formatRouteDuration(state.timeoutMs)}`);
    return `route ${details.join(" · ")}`;
  }
  details.push(`${formatRouteDuration(state.timeoutMs)} max`);
  return `route ${details.join(" · ")}`;
}

function routeFailureKindLabel(
  kind: NonNullable<ReturnType<typeof classifyRouterFailure>>,
  route: RouteDecision
): string {
  if (kind === "timeout") {
    const stage = routeTimeoutStageSuffix(route);
    if (route.router_timeout_kind === "first-output") {
      return "first output timeout";
    }
    if (route.router_timeout_kind === "idle") {
      return `idle timeout${stage}`;
    }
    if (route.router_timeout_kind === "total") {
      return `total timeout${stage}`;
    }
    return `timeout${stage}`;
  }
  return kind.replaceAll("-", " ");
}

function routeTimeoutStageSuffix(route: RouteDecision): string {
  if (route.router_failure_stage === "waiting-output") {
    return " waiting output";
  }
  if (route.router_failure_stage !== "streaming") {
    return "";
  }
  if (route.router_stdout_bytes && route.router_stdout_bytes > 0) {
    return " after stdout";
  }
  if (route.router_stderr_bytes && route.router_stderr_bytes > 0) {
    return " after stderr";
  }
  return " after output";
}

function routeProxyStatus(
  route: RouteDecision,
  cause: ReturnType<typeof classifyRouterFailure>
): string | null {
  if (route.proxy_configured === true) {
    return route.proxy_endpoint ? `via ${route.proxy_endpoint}` : "via proxy";
  }
  if (route.proxy_configured === false) {
    return "direct";
  }
  return cause === "timeout" && /\bproxy\b|代理/i.test(route.reason) ? "proxy set" : null;
}

function routePendingPhaseLabel(state: RouteStartInfo): string {
  if (state.phase === "dispatching" || state.phase === "starting") {
    return "starting";
  }
  if (state.phase === "waiting-output") {
    return "waiting output";
  }
  if (state.phase === "receiving-stderr") {
    return "diagnostics";
  }
  if (state.phase === "receiving-response") {
    return "receiving";
  }
  if (state.phase === "parsing") {
    return "parsing";
  }
  return state.scope === "follow-up" ? "follow-up" : "checking";
}

function routePendingPathLabel(state: RouteStartInfo): string | null {
  if (state.proxyConfigured === true) {
    return state.proxyEndpoint ? `via ${state.proxyEndpoint}` : "via proxy";
  }
  return state.proxyConfigured === false ? "direct" : null;
}

export function formatSelectedWorkerStatus(state: StatusLineState | null, selectedIndex: number): string {
  const worker = state?.workers?.[selectedIndex];
  if (!worker) {
    return "";
  }
  return `${compactWorkerLabel(worker.label)} ${compactStatus(worker.status)}`;
}

export function selectedWorkerStatusIsRedundant(state: StatusLineState | null): boolean {
  const workers = state?.workers;
  if (!workers?.length) {
    return false;
  }
  const first = compactStatus(workers[0]?.status ?? "");
  return workers.every((worker) => compactStatus(worker.status) === first);
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

function formatRouteElapsed(durationMs: number): string {
  return `${Math.floor(durationMs / 1000)}s`;
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
