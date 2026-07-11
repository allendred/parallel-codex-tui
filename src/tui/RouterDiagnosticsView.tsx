import React, { useEffect, useMemo } from "react";
import { basename } from "node:path";
import { Box, Text, type TextProps } from "ink";
import type { AppConfig } from "../core/config.js";
import type { RouterAuditRecord } from "../core/router-audit.js";
import { displayWidth, wrapByDisplayWidth } from "./display-width.js";
import { formatRouteStatus } from "./status-line.js";
import { TUI_THEME } from "./theme.js";

export interface RouterDiagnosticsPolicy {
  mode: "auto" | "simple" | "complex";
  timeoutMs: number;
  followUpTimeoutMs: number;
  fallback: "simple" | "complex";
  proxyConfigured: boolean;
}

export function routerDiagnosticsPolicy(
  router: AppConfig["router"],
  env: NodeJS.ProcessEnv = process.env
): RouterDiagnosticsPolicy {
  const configuredEnvironment = Object.fromEntries(
    Object.entries(router.codex.env).map(([name, value]) => [
      name,
      value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => env[variable] ?? "")
    ])
  );
  const effectiveEnvironment = { ...env, ...configuredEnvironment };
  const proxyConfigured = Object.entries(effectiveEnvironment).some(([name, value]) => (
    /^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(name) && Boolean(value?.trim())
  ));

  return {
    mode: router.defaultMode,
    timeoutMs: router.codex.timeoutMs,
    followUpTimeoutMs: router.codex.followUpTimeoutMs,
    fallback: router.codex.fallback,
    proxyConfigured
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
  scrollOffset = 0,
  height = 20,
  terminalWidth = process.stdout.columns || 120,
  onViewportChange
}: RouterDiagnosticsViewProps) {
  const lines = useMemo(
    () => routerDiagnosticsDisplayLines(records, policy, terminalWidth, { loading, error }),
    [error, loading, policy, records, terminalWidth]
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
  state: { loading?: boolean; error?: string | null } = {}
): RouterDiagnosticLine[] {
  const width = routerDiagnosticsContentWidth(terminalWidth);
  const codexCount = records.filter((record) => record.source === "codex").length;
  const fallbackCount = records.filter((record) => record.source === "fallback").length;
  const forcedCount = records.filter((record) => record.source === "forced").length;
  const health = [
    `health · codex ${codexCount}`,
    `fallback ${fallbackCount}`,
    ...(forcedCount > 0 ? [`forced ${forcedCount}`] : [])
  ].join(" · ");
  const logical: RouterDiagnosticLine[] = [
    { text: "Router diagnostics", tone: "heading" },
    { text: health, tone: fallbackCount > 0 ? "warning" : "success" },
    {
      text: `policy · ${policy.mode} · ${formatDiagnosticDuration(policy.timeoutMs)} / ${formatDiagnosticDuration(policy.followUpTimeoutMs)} · fallback ${policy.fallback}`,
      tone: "muted"
    },
    { text: `proxy · ${policy.proxyConfigured ? "configured" : "direct"}`, tone: policy.proxyConfigured ? "warning" : "muted" },
    { text: "", tone: "text" },
    { text: "Recent routes", tone: "heading" }
  ];

  if (state.loading) {
    logical.push({ text: "loading route audit", tone: "muted" });
  } else if (state.error) {
    logical.push({ text: `error · ${safeDiagnosticText(state.error)}`, tone: "danger" });
  } else if (records.length === 0) {
    logical.push({ text: "no route records", tone: "muted" });
  } else {
    for (const record of [...records].reverse()) {
      const workspace = basename(record.workspace) || record.workspace;
      logical.push({
        text: `${record.time.slice(11, 19)} · ${safeDiagnosticText(workspace)} · ${record.scope} · ${routerAuditStatus(record)}`,
        tone: record.source === "fallback" ? "warning" : record.source === "codex" ? "success" : "muted"
      });
      logical.push({ text: `request · ${boundedDiagnosticText(record.request)}`, tone: "text" });
      logical.push({ text: `reason · ${boundedDiagnosticText(record.reason)}`, tone: "muted" });
    }
  }

  return logical.flatMap((line) => wrapDiagnosticLine(line, width));
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
  if (record.source !== "codex") {
    return formatted;
  }
  const parts = formatted.split(/\s+·\s+/);
  parts.splice(1, 0, "codex");
  return parts.join(" · ");
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

function routerDiagnosticsContentWidth(terminalWidth: number): number {
  return Math.max(1, terminalWidth - 2);
}
