import React, { useEffect, useMemo } from "react";
import { basename, resolve } from "node:path";
import { Box, Text, type TextProps } from "ink";
import type { AppConfig } from "../core/config.js";
import {
  classifyRouterFailure,
  diagnoseRouterFailure,
  type RouterAuditRecord,
  type RouterFailureKind
} from "../core/router-audit.js";
import { routerProxyContext } from "../core/router.js";
import { displayWidth, wrapByDisplayWidth } from "./display-width.js";
import { formatRouteStatus } from "./status-line.js";
import { TUI_THEME } from "./theme.js";

export interface RouterDiagnosticsPolicy {
  mode: "auto" | "simple" | "complex";
  timeoutMs: number;
  followUpTimeoutMs: number;
  fallback: "simple" | "complex";
  proxyConfigured: boolean;
  proxySource: "router-config" | "environment" | null;
  proxyVariable: string | null;
  proxyEndpoint: string | null;
}

export type RouterDiagnosticsScope = "all" | "workspace";

export function routerDiagnosticsPolicy(
  router: AppConfig["router"],
  env: NodeJS.ProcessEnv = process.env
): RouterDiagnosticsPolicy {
  const proxy = routerProxyContext(router.codex.env, env);
  return {
    mode: router.defaultMode,
    timeoutMs: router.codex.timeoutMs,
    followUpTimeoutMs: router.codex.followUpTimeoutMs,
    fallback: router.codex.fallback,
    proxyConfigured: proxy.configured,
    proxySource: proxy.configured ? proxy.source : null,
    proxyVariable: proxy.configured ? proxy.variable : null,
    proxyEndpoint: proxy.configured ? proxy.endpoint : null
  };
}

export type RouterDiagnosticLineTone = "heading" | "text" | "muted" | "success" | "warning" | "danger";

export interface RouterDiagnosticLine {
  text: string;
  tone: RouterDiagnosticLineTone;
}

export interface RouterDiagnosticsViewProps {
  records: RouterAuditRecord[];
  policy: RouterDiagnosticsPolicy;
  loading?: boolean;
  error?: string | null;
  currentWorkspace?: string;
  scope?: RouterDiagnosticsScope;
  scrollOffset?: number;
  height?: number;
  terminalWidth?: number;
  onViewportChange?: (viewport: { offset: number; maxOffset: number }) => void;
}

export function RouterDiagnosticsView({
  records,
  policy,
  loading = false,
  error = null,
  currentWorkspace = "",
  scope = "all",
  scrollOffset = 0,
  height = 20,
  terminalWidth = process.stdout.columns || 120,
  onViewportChange
}: RouterDiagnosticsViewProps) {
  const lines = useMemo(
    () => routerDiagnosticsDisplayLines(records, policy, terminalWidth, {
      loading,
      error,
      currentWorkspace,
      scope
    }),
    [currentWorkspace, error, loading, policy, records, scope, terminalWidth]
  );
  const viewportHeight = Math.max(1, height);
  const maxOffset = Math.max(0, lines.length - viewportHeight);
  const clampedOffset = Math.min(maxOffset, Math.max(0, Math.trunc(scrollOffset)));
  const visible = lines.slice(clampedOffset, clampedOffset + viewportHeight);
  const blankRows = Math.max(0, viewportHeight - visible.length);
  const contentWidth = routerDiagnosticsContentWidth(terminalWidth);

  useEffect(() => {
    onViewportChange?.({ offset: clampedOffset, maxOffset });
  }, [clampedOffset, maxOffset, onViewportChange]);

  return (
    <Box flexDirection="column" height={viewportHeight}>
      {visible.map((line, index) => (
        <RouterDiagnosticRow key={`${clampedOffset + index}-${line.tone}`} line={line} width={contentWidth} />
      ))}
      {Array.from({ length: blankRows }, (_, index) => (
        <Text key={`router-diagnostic-fill-${index}`} backgroundColor={TUI_THEME.surface}>
          {" ".repeat(contentWidth)}
        </Text>
      ))}
    </Box>
  );
}

export function routerDiagnosticsDisplayLines(
  records: RouterAuditRecord[],
  policy: RouterDiagnosticsPolicy,
  terminalWidth: number,
  state: {
    loading?: boolean;
    error?: string | null;
    currentWorkspace?: string;
    scope?: RouterDiagnosticsScope;
  } = {}
): RouterDiagnosticLine[] {
  const width = routerDiagnosticsContentWidth(terminalWidth);
  const scope = state.scope ?? "all";
  const currentWorkspace = state.currentWorkspace ?? "";
  const visibleRecords = filterRouterAuditRecords(records, currentWorkspace, scope);
  const codexCount = visibleRecords.filter((record) => record.source === "codex").length;
  const fallbackCount = visibleRecords.filter((record) => record.source === "fallback").length;
  const forcedCount = visibleRecords.filter((record) => record.source === "forced").length;
  const timeoutCount = visibleRecords.filter((record) => routerAuditFailureKind(record) === "timeout").length;
  const workspaceCount = new Set(records.map((record) => normalizedWorkspace(record.workspace))).size;
  const proxyRecordCount = visibleRecords.filter(routerAuditHasProxyContext).length;
  const budget = routerDiagnosticsBudget(visibleRecords, policy);
  const health = [
    `health · codex ${codexCount}`,
    `fallback ${fallbackCount}`,
    ...(forcedCount > 0 ? [`forced ${forcedCount}`] : []),
    ...(timeoutCount > 0 ? [`timeout ${timeoutCount}`] : [])
  ].join(" · ");
  const logical: RouterDiagnosticLine[] = [
    { text: "Router diagnostics", tone: "heading" },
    {
      text: routerDiagnosticsScopeText(scope, currentWorkspace, visibleRecords.length, records.length, workspaceCount),
      tone: "text"
    },
    { text: health, tone: fallbackCount > 0 ? "warning" : "success" },
    { text: routerDiagnosticsLatencyText(visibleRecords), tone: "muted" },
    budget,
    {
      text: `policy · ${policy.mode} · ${formatDiagnosticDuration(policy.timeoutMs)} / ${formatDiagnosticDuration(policy.followUpTimeoutMs)} · fallback ${policy.fallback}`,
      tone: "muted"
    },
    {
      text: routerDiagnosticsProxyPolicy(policy, proxyRecordCount),
      tone: policy.proxyConfigured || proxyRecordCount > 0 ? "warning" : "muted"
    },
    { text: "Recent routes", tone: "heading" }
  ];

  if (state.loading) {
    logical.push({ text: "loading route audit", tone: "muted" });
  } else if (state.error) {
    logical.push({ text: `error · ${safeDiagnosticText(state.error)}`, tone: "danger" });
  } else if (visibleRecords.length === 0) {
    logical.push({
      text: scope === "workspace" ? "no route records for current workspace" : "no route records",
      tone: "muted"
    });
  } else {
    for (const record of [...visibleRecords].reverse()) {
      const workspace = basename(record.workspace) || record.workspace;
      logical.push({
        text: `${record.time.slice(11, 19)} · ${safeDiagnosticText(workspace)} · ${record.scope} · ${routerAuditStatus(record)}`,
        tone: record.source === "fallback" ? "warning" : record.source === "codex" ? "success" : "muted"
      });
      logical.push({ text: `request · ${boundedDiagnosticText(record.request)}`, tone: "text" });
      const evidence = routerAuditEvidence(record);
      if (evidence) {
        logical.push({ text: evidence, tone: "warning" });
      }
      const trace = routerAuditTraceLines(record);
      if (record.source === "fallback") {
        const diagnosis = diagnoseRouterFailure(record);
        logical.push({ text: `diagnosis · ${diagnosis.summary}`, tone: "danger" });
        logical.push({ text: `next · ${diagnosis.action}`, tone: "warning" });
      }
      for (const line of trace) {
        logical.push({ text: line, tone: "muted" });
      }
      logical.push({ text: `reason · ${boundedDiagnosticText(record.reason)}`, tone: "muted" });
    }
  }

  return logical.flatMap((line) => wrapDiagnosticLine(line, width));
}

export function filterRouterAuditRecords(
  records: RouterAuditRecord[],
  currentWorkspace: string,
  scope: RouterDiagnosticsScope
): RouterAuditRecord[] {
  if (scope === "all" || !currentWorkspace.trim()) {
    return records;
  }
  const current = normalizedWorkspace(currentWorkspace);
  return records.filter((record) => normalizedWorkspace(record.workspace) === current);
}

function RouterDiagnosticRow({ line, width }: { line: RouterDiagnosticLine; width: number }) {
  const fill = Math.max(0, width - displayWidth(line.text));
  return (
    <Text>
      <Text {...routerDiagnosticLineTheme(line.tone)}>{line.text}</Text>
      {fill > 0 ? <Text backgroundColor={TUI_THEME.surface}>{" ".repeat(fill)}</Text> : null}
    </Text>
  );
}

function routerDiagnosticLineTheme(tone: RouterDiagnosticLineTone): Pick<TextProps, "backgroundColor" | "bold" | "color"> {
  return {
    backgroundColor: TUI_THEME.surface,
    color: tone === "heading"
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

function routerAuditStatus(record: RouterAuditRecord): string {
  const formatted = formatRouteStatus(record).replace(/^route\s+/, "");
  let status = formatted;
  if (record.source === "codex") {
    const parts = formatted.split(/\s+·\s+/);
    parts.splice(1, 0, "codex");
    status = parts.join(" · ");
  }
  return record.router_attempt && record.router_attempt > 1
    ? `${status} · attempt ${record.router_attempt}`
    : status;
}

function routerDiagnosticsScopeText(
  scope: RouterDiagnosticsScope,
  currentWorkspace: string,
  visibleCount: number,
  totalCount: number,
  workspaceCount: number
): string {
  if (scope === "workspace") {
    const workspace = basename(currentWorkspace) || currentWorkspace || "unknown";
    return `scope · current · ${safeDiagnosticText(workspace)} · ${visibleCount}/${totalCount} routes`;
  }
  return `scope · all · ${visibleCount}/${totalCount} routes · ${workspaceCount} ${workspaceCount === 1 ? "workspace" : "workspaces"}`;
}

function routerDiagnosticsLatencyText(records: RouterAuditRecord[]): string {
  const durations = successfulRouterDurations(records);
  if (durations.length === 0) {
    return "latency · no successful Codex routes";
  }
  return [
    `latency · success p50 ${formatDiagnosticDuration(routerDurationPercentile(durations, 0.5))}`,
    `p95 ${formatDiagnosticDuration(routerDurationPercentile(durations, 0.95))}`,
    `max ${formatDiagnosticDuration(durations.at(-1) ?? 0)}`,
    `n ${durations.length}`
  ].join(" · ");
}

export function routerDiagnosticsBudget(
  records: RouterAuditRecord[],
  policy: RouterDiagnosticsPolicy
): RouterDiagnosticLine {
  const initial = routerBudgetSegment(
    "initial",
    policy.timeoutMs,
    successfulRouterDurations(records, "initial"),
    20000,
    60000
  );
  const followUp = routerBudgetSegment(
    "follow-up",
    policy.followUpTimeoutMs,
    successfulRouterDurations(records, "follow-up"),
    15000,
    45000
  );
  const states = [initial.state, followUp.state];
  return {
    text: `budget · ${initial.text} · ${followUp.text}`,
    tone: states.some((state) => state === "tight" || state === "high")
      ? "warning"
      : states.every((state) => state === "no-data" || state === "learning")
        ? "muted"
        : "success"
  };
}

function successfulRouterDurations(
  records: RouterAuditRecord[],
  scope?: RouterAuditRecord["scope"]
): number[] {
  return records
    .filter((record) => record.source === "codex" && (!scope || record.scope === scope))
    .map((record) => record.duration_ms)
    .filter((duration): duration is number => (
      typeof duration === "number" && Number.isFinite(duration) && duration > 0
    ))
    .sort((left, right) => left - right);
}

function routerBudgetSegment(
  label: string,
  configuredMs: number,
  durations: number[],
  minimumMs: number,
  maximumMs: number
): { text: string; state: "healthy" | "tight" | "high" | "learning" | "no-data" } {
  if (durations.length === 0) {
    return {
      text: `${label} no data · ${formatDiagnosticDuration(configuredMs)}`,
      state: "no-data"
    };
  }
  const p95 = routerDurationPercentile(durations, 0.95);
  const recommendedMs = Math.min(
    maximumMs,
    Math.max(minimumMs, Math.ceil((p95 * 2) / 1000) * 1000)
  );
  const state = durations.length < 3
    ? "learning"
    : configuredMs < p95 * 1.5
      ? "tight"
      : configuredMs > recommendedMs * 2
        ? "high"
        : "healthy";
  return {
    text: [
      `${label} ${state}`,
      `${formatDiagnosticDuration(configuredMs)} / p95 ${formatDiagnosticDuration(p95)}`,
      `n ${durations.length}`,
      ...(state === "tight" || state === "high" ? [`consider ${formatDiagnosticDuration(recommendedMs)}`] : [])
    ].join(" · "),
    state
  };
}

function routerDurationPercentile(sortedDurations: number[], percentile: number): number {
  const index = Math.max(0, Math.ceil(sortedDurations.length * percentile) - 1);
  return sortedDurations[Math.min(sortedDurations.length - 1, index)] ?? 0;
}

function routerAuditEvidence(record: RouterAuditRecord): string | null {
  if (record.source !== "fallback") {
    return null;
  }
  const kind = routerAuditFailureKind(record) ?? "unknown";
  const parts = [`evidence · ${routerFailureKindLabel(kind)}`];
  const stage = routerFailureStageLabel(record);
  if (stage) {
    parts.push(stage);
  }
  if (kind === "timeout") {
    const timeoutMs = record.router_timeout_ms ?? record.duration_ms;
    if (typeof timeoutMs === "number") {
      parts.push(`limit ${formatDiagnosticDuration(timeoutMs)}`);
    }
  }
  if (routerAuditHasProxyContext(record)) {
    parts.push(record.proxy_endpoint ? `via ${record.proxy_endpoint}` : "proxy configured");
    if (record.proxy_source || record.proxy_variable) {
      parts.push([
        record.proxy_source ? routerProxySourceLabel(record.proxy_source) : "proxy",
        record.proxy_variable
      ].filter(Boolean).join(" "));
    }
    parts.push("cause unproven");
  } else if (record.proxy_configured === false) {
    parts.push("direct path");
  }
  const resolution = routerFallbackResolutionLabel(record.router_fallback_resolution);
  if (resolution) {
    parts.push(resolution);
  }
  parts.push(`fallback ${record.mode}`);
  return parts.join(" · ");
}

function routerAuditTraceLines(record: RouterAuditRecord): string[] {
  const stages = [
    ...(typeof record.router_dispatch_ms === "number"
      ? [`dispatch ${formatDiagnosticDuration(record.router_dispatch_ms)}`]
      : []),
    ...(typeof record.router_spawn_ms === "number"
      ? [`spawn ${formatDiagnosticDuration(record.router_spawn_ms)}`]
      : []),
    ...routerFirstOutputTraceParts(record),
    ...(typeof record.router_process_ms === "number"
      ? [`process ${formatDiagnosticDuration(record.router_process_ms)}`]
      : []),
    ...(typeof record.router_parse_ms === "number"
      ? [`parse ${formatDiagnosticDuration(record.router_parse_ms)}`]
      : [])
  ];
  const io = [
    ...(typeof record.router_stdout_bytes === "number"
      ? [`stdout ${formatDiagnosticBytes(record.router_stdout_bytes)}`]
      : []),
    ...(typeof record.router_stderr_bytes === "number"
      ? [`stderr ${formatDiagnosticBytes(record.router_stderr_bytes)}`]
      : [])
  ];
  if (stages.length === 0 && io.length === 0) {
    return [];
  }
  if (typeof record.duration_ms === "number") {
    stages.push(`total ${formatDiagnosticDuration(record.duration_ms)}`);
  }
  return [
    ...(stages.length > 0 ? [`trace · ${stages.join(" · ")}`] : []),
    ...(io.length > 0 ? [`io · ${io.join(" · ")}`] : [])
  ];
}

function routerFirstOutputTraceParts(record: RouterAuditRecord): string[] {
  const streams = [
    ...(typeof record.router_first_stdout_ms === "number"
      ? [{ at: record.router_first_stdout_ms, text: `first stdout ${formatDiagnosticDuration(record.router_first_stdout_ms)}` }]
      : []),
    ...(typeof record.router_first_stderr_ms === "number"
      ? [{ at: record.router_first_stderr_ms, text: `first stderr ${formatDiagnosticDuration(record.router_first_stderr_ms)}` }]
      : [])
  ];
  if (streams.length > 0) {
    return streams.sort((left, right) => left.at - right.at).map((stream) => stream.text);
  }
  if (typeof record.router_first_output_ms === "number") {
    return [`first output ${formatDiagnosticDuration(record.router_first_output_ms)}`];
  }
  return record.router_failure_stage === "waiting-output" ? ["first output none"] : [];
}

function routerAuditFailureKind(record: RouterAuditRecord): RouterFailureKind | null {
  return record.failure_kind ?? classifyRouterFailure(record.reason);
}

function routerAuditHasProxyContext(record: RouterAuditRecord): boolean {
  if (typeof record.proxy_configured === "boolean") {
    return record.proxy_configured;
  }
  return /\bproxy\b|代理/i.test(record.reason);
}

function routerDiagnosticsProxyPolicy(policy: RouterDiagnosticsPolicy, recorded: number): string {
  if (!policy.proxyConfigured) {
    return `proxy · direct now · ${recorded} recorded · context only`;
  }
  return [
    "proxy",
    policy.proxySource ? routerProxySourceLabel(policy.proxySource) : "configured now",
    policy.proxyVariable,
    policy.proxyEndpoint,
    `${recorded} recorded`,
    "context only"
  ].filter(Boolean).join(" · ");
}

function routerProxySourceLabel(source: "router-config" | "environment"): string {
  return source === "router-config" ? "router config" : "environment";
}

function routerFailureKindLabel(kind: RouterFailureKind): string {
  return kind.replaceAll("-", " ");
}

function routerFailureStageLabel(record: RouterAuditRecord): string | null {
  const stage = record.router_failure_stage;
  if (stage === "waiting-output") {
    return "waiting output";
  }
  if (stage === "streaming") {
    if (record.router_stdout_bytes && record.router_stdout_bytes > 0) {
      return "after stdout";
    }
    if (record.router_stderr_bytes && record.router_stderr_bytes > 0) {
      return "after stderr";
    }
    return "after output";
  }
  if (stage === "response") {
    return "response parse";
  }
  return stage ?? null;
}

function routerFallbackResolutionLabel(
  resolution: RouterAuditRecord["router_fallback_resolution"]
): string | null {
  if (resolution === "main") {
    return "resolved Main";
  }
  if (resolution === "parallel") {
    return "resolved Parallel";
  }
  if (resolution === "retry") {
    return "Router retry requested";
  }
  if (resolution === "cancelled") {
    return "cancelled by user";
  }
  if (resolution === "configured") {
    return "configured fallback";
  }
  return null;
}

function normalizedWorkspace(workspace: string): string {
  return resolve(workspace.trim());
}

function wrapDiagnosticLine(line: RouterDiagnosticLine, width: number): RouterDiagnosticLine[] {
  if (!line.text) {
    return [line];
  }
  return wrapByDisplayWidth(line.text, width).map((text) => ({ ...line, text }));
}

function boundedDiagnosticText(value: string): string {
  const safe = safeDiagnosticText(value).replace(/\s+/g, " ").trim();
  const characters = Array.from(safe);
  return characters.length <= 320
    ? safe
    : `${characters.slice(0, 308).join("")} [truncated]`;
}

function safeDiagnosticText(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi, "$1***@");
}

function formatDiagnosticDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.round(durationMs)}ms`;
  }
  return `${(durationMs / 1000).toFixed(durationMs % 1000 === 0 ? 0 : 1)}s`;
}

function formatDiagnosticBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.round(bytes)}B`;
  }
  return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
}

function routerDiagnosticsContentWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth - 2);
}
