import type { EngineName, RouteDecision } from "../domain/schemas.js";
import type { RouteStartInfo } from "../orchestrator/orchestrator.js";
import { classifyRouterFailure } from "../core/router-audit.js";
import { compactEndByDisplayWidth } from "./display-width.js";

export interface StatusLineState {
  taskId: string;
  main?: string;
  mainEngine?: EngineName;
  mainProgress?: {
    phase: string;
    elapsedMs: number;
    firstOutputTimeoutMs?: number;
    idleTimeoutMs?: number;
  };
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

export function effectiveWorkerWatchdog(
  watchdogMs: number | undefined,
  totalTimeoutMs: number | undefined
): number | undefined {
  if (!watchdogMs || watchdogMs <= 0) {
    return undefined;
  }
  if (totalTimeoutMs && totalTimeoutMs > 0 && watchdogMs >= totalTimeoutMs) {
    return undefined;
  }
  return watchdogMs;
}

export function formatStatusLine(state: StatusLineState | null): string {
  if (!state) {
    return "idle";
  }

  const parts = [compactTaskId(state.taskId)];
  if (state.main) {
    const mainIdentity = state.mainEngine ? `main/${state.mainEngine}` : "main";
    parts.push(`${mainIdentity} ${formatMainStatus(state.main, state.mainProgress)}`);
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

function formatMainStatus(
  status: string,
  progress: StatusLineState["mainProgress"]
): string {
  const state = compactStatus(status);
  if (!progress || state === "done" || state === "fail" || state === "stop") {
    return state;
  }

  if (progress.phase === "initialized") {
    return "starting";
  }
  if (progress.phase === "process-starting" || progress.phase === "native-resume-fallback") {
    return formatMainWaitProgress(
      "waiting output",
      progress.elapsedMs,
      progress.firstOutputTimeoutMs,
      "first"
    );
  }
  if (progress.phase === "process-output") {
    return formatMainWaitProgress(
      "responding",
      progress.elapsedMs,
      progress.idleTimeoutMs,
      "idle"
    );
  }
  if (progress.phase === "process-stopping") {
    return "stopping";
  }
  return state;
}

function formatMainWaitProgress(
  label: string,
  elapsedMs: number,
  budgetMs: number | undefined,
  budgetLabel: "first" | "idle"
): string {
  if (!budgetMs || budgetMs <= 0) {
    return label;
  }
  const elapsed = Math.min(Math.max(0, elapsedMs), budgetMs);
  return `${label} · ${formatMainElapsed(elapsed)} / ${formatMainBudget(budgetMs)} ${budgetLabel}`;
}

function formatMainElapsed(durationMs: number): string {
  return `${Math.floor(durationMs / 1000)}s`;
}

function formatMainBudget(durationMs: number): string {
  if (durationMs >= 60_000 && durationMs % 60_000 === 0) {
    return `${durationMs / 60_000}m`;
  }
  return formatRouteDuration(durationMs);
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
  } else if (route.router_fallback_resolution === "auto-retry") {
    details.push("auto retry");
  }
  const recovery = routeRecoveryLabel(route);
  if (recovery) {
    details.push(recovery);
  }
  if (typeof route.router_attempt === "number" && route.router_attempt > 1) {
    details.push(`try ${route.router_attempt}`);
  }
  if (route.source === "fallback") {
    const cause = route.router_failure_kind && route.router_failure_kind !== "unknown"
      ? route.router_failure_kind
      : classifyRouterFailure(route.reason) ?? "unknown";
    details.push(routeFailureKindLabel(cause, route));
    const proxy = routeProxyStatus(route, cause);
    if (proxy) {
      details.push(proxy);
    }
  } else if (route.proxy_configured && route.proxy_endpoint) {
    details.push(`via ${route.proxy_endpoint}`);
  }
  if (
    typeof route.router_total_duration_ms === "number"
    && typeof route.router_attempt === "number"
    && route.router_attempt > 1
  ) {
    details.push(`${formatRouteDuration(route.router_total_duration_ms)} total`);
  } else if (
    typeof route.duration_ms === "number"
    && (route.source !== "forced" || route.duration_ms > 0)
  ) {
    details.push(formatRouteDuration(route.duration_ms));
  }
  return `route ${details.join(" · ")}`;
}

function routeRecoveryLabel(route: RouteDecision): string | null {
  if (!route.router_recovered_from) {
    return null;
  }
  const prefix = route.router_recovered_via === "auto-retry" ? "auto recovered" : "recovered";
  if (route.router_recovered_from !== "timeout") {
    return `${prefix} ${route.router_recovered_from.replaceAll("-", " ")}`;
  }
  const timeout = route.router_recovered_timeout_kind === "first-output"
    ? "first output timeout"
    : route.router_recovered_timeout_kind === "idle"
      ? "idle timeout"
      : route.router_recovered_timeout_kind === "total"
        ? "total timeout"
        : "timeout";
  return `${prefix} ${timeout}`;
}

export function formatRoutePendingStatus(state: RouteStartInfo | null, elapsedMs?: number): string {
  if (!state) {
    return "";
  }
  if (state.mode !== "auto") {
    return `route ${state.mode} · forced`;
  }
  const path = routePendingPathLabel(state);
  if (state.phase === "retrying") {
    const details = [
      `retry ${state.attempt}/${state.maxAttempts}`,
      ...(state.command && state.command !== "codex" ? [`runner ${state.command}`] : []),
      ...(path ? [path] : []),
      `${formatRouteDuration(state.retryDelayMs ?? 0)} backoff`
    ];
    return `route ${details.join(" · ")}`;
  }
  const label = routePendingPhaseLabel(state);
  const details = [
    label,
    ...(state.attempt > 1 ? [`try ${state.attempt}`] : []),
    ...(state.command && state.command !== "codex" ? [`runner ${state.command}`] : []),
    ...(path ? [path] : [])
  ];
  details.push(...routePendingBudgetDetails(state, elapsedMs));
  return `route ${details.join(" · ")}`;
}

function routePendingBudgetDetails(state: RouteStartInfo, elapsedMs?: number): string[] {
  const firstOutputActive = state.phase === "dispatching"
    || state.phase === "starting"
    || state.phase === "waiting-output";
  const idleActive = state.phase === "receiving-stderr" || state.phase === "receiving-response";
  const firstOutputIsSeparate = firstOutputActive
    && typeof state.firstOutputTimeoutMs === "number"
    && state.firstOutputTimeoutMs < state.timeoutMs;
  const idleIsSeparate = idleActive
    && typeof state.idleTimeoutMs === "number"
    && state.idleTimeoutMs < state.timeoutMs;

  if (typeof elapsedMs === "number") {
    if (firstOutputIsSeparate) {
      const boundedElapsedMs = Math.min(state.firstOutputTimeoutMs, Math.max(0, elapsedMs));
      return [
        `${formatRouteElapsed(boundedElapsedMs)} / ${formatRouteDuration(state.firstOutputTimeoutMs)} first`,
        `${formatRouteDuration(state.timeoutMs)} total`
      ];
    }
    const boundedElapsedMs = Math.min(state.timeoutMs, Math.max(0, elapsedMs));
    if (idleIsSeparate) {
      return [
        `${formatRouteElapsed(boundedElapsedMs)} / ${formatRouteDuration(state.timeoutMs)} total`,
        `${formatRouteDuration(state.idleTimeoutMs)} idle`
      ];
    }
    return [`${formatRouteElapsed(boundedElapsedMs)} / ${formatRouteDuration(state.timeoutMs)}`];
  }

  if (firstOutputIsSeparate) {
    return [
      `${formatRouteDuration(state.firstOutputTimeoutMs)} first`,
      `${formatRouteDuration(state.timeoutMs)} total`
    ];
  }
  if (idleIsSeparate) {
    return [
      `${formatRouteDuration(state.timeoutMs)} total`,
      `${formatRouteDuration(state.idleTimeoutMs)} idle`
    ];
  }
  return [`${formatRouteDuration(state.timeoutMs)} max`];
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
  if (kind === "unknown") {
    return "unknown failure";
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
  if (state.phase === "stopping") {
    return "stopping";
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
  if (state === "paused") {
    return "wait";
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
  const match = label.match(/^\s*([^(]+?)\s*\(([^)]+)\)/);
  if (match) {
    return `${match[1].trim().toLowerCase()}/${match[2].trim().toLowerCase()}`;
  }
  return label.trim().toLowerCase().replace(/\s+/g, "/");
}
