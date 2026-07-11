import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import type { RouterAuditRecord } from "../src/core/router-audit.js";
import { displayWidth } from "../src/tui/display-width.js";
import * as diagnosticsModule from "../src/tui/RouterDiagnosticsView.js";

describe("RouterDiagnosticsView", () => {
  it("derives policy without exposing proxy values or counting unresolved placeholders", () => {
    const routerDiagnosticsPolicy = (
      diagnosticsModule as typeof diagnosticsModule & {
        routerDiagnosticsPolicy?: (
          router: ReturnType<typeof defaultConfig>["router"],
          env?: NodeJS.ProcessEnv
        ) => ReturnType<typeof policy>;
      }
    ).routerDiagnosticsPolicy;
    const router = defaultConfig("/tmp/app").router;
    router.codex.env = {
      HTTPS_PROXY: "{env:PRIVATE_PROXY}",
      NO_PROXY: "localhost"
    };

    expect(routerDiagnosticsPolicy).toBeTypeOf("function");
    expect(routerDiagnosticsPolicy?.(router, {})).toEqual({
      mode: "auto",
      timeoutMs: 30000,
      followUpTimeoutMs: 20000,
      fallback: "simple",
      proxyConfigured: false,
      proxySource: null,
      proxyVariable: null,
      proxyEndpoint: null
    });
    expect(routerDiagnosticsPolicy?.(router, { PRIVATE_PROXY: "http://user:secret@proxy.test" }))
      .toEqual(expect.objectContaining({
        proxyConfigured: true,
        proxySource: "router-config",
        proxyVariable: "HTTPS_PROXY",
        proxyEndpoint: "proxy.test"
      }));
    expect(JSON.stringify(routerDiagnosticsPolicy?.(router, { PRIVATE_PROXY: "http://user:secret@proxy.test" })))
      .not.toContain("user:secret");
  });

  it("renders global health, policy, redacted failure evidence, and recent requests", () => {
    const RouterDiagnosticsView = (
      diagnosticsModule as typeof diagnosticsModule & {
        RouterDiagnosticsView?: React.ComponentType<Record<string, unknown>>;
      }
    ).RouterDiagnosticsView;

    expect(RouterDiagnosticsView).toBeTypeOf("function");
    const view = render(React.createElement(RouterDiagnosticsView!, {
      records: records(),
      policy: policy(),
      currentWorkspace: "/tmp/tetris",
      scope: "all",
      terminalWidth: 80,
      height: 28
    }));
    const frame = view.lastFrame() ?? "";
    const flattened = frame.replace(/\s+/g, " ");

    expect(frame).toContain("Router diagnostics");
    expect(frame).toContain("scope · all · 2/2 routes · 1 workspace");
    expect(frame).toContain("health · codex 1 · fallback 1 · timeout 1");
    expect(frame).toContain("latency · success p50 9.7s · p95 9.7s · max 9.7s · n 1");
    expect(frame).toContain("budget · initial learning · 30s / p95 9.7s · n 1 · follow-up no data · 20s");
    expect(frame).toContain("policy · auto · 30s / 20s · fallback simple");
    expect(flattened).toContain("proxy · router config · HTTPS_PROXY · proxy.test:8443 · 1 recorded · context only");
    expect(frame).toContain("tetris · initial · simple · codex · 9.7s · attempt 2");
    expect(flattened).toContain("evidence · timeout · after stderr · limit 30s · via 127.0.0.1:7890 · router config HTTPS_PROXY · cause unproven");
    expect(flattened).toContain("resolved Parallel");
    expect(flattened).toContain("diagnosis · Router emitted diagnostics but no route response");
    expect(flattened).toContain("next · inspect the reason, then run parallel-codex-tui --doctor --probe-router");
    expect(flattened).toContain("trace · dispatch 2ms · spawn 8ms · first stderr 24ms · process 30s · total 30s");
    expect(flattened).toContain("io · stdout 0B · stderr 73B");
    expect(flattened).toContain("trace · dispatch 1ms · spawn 5ms · first stderr 120ms · first stdout 8.9s · process 9.6s · parse 1ms · total 9.7s");
    expect(flattened).toContain("io · stdout 86B · stderr 15B");
    expect(flattened).toContain("timeout after stderr · via 127.0.0.1:7890");
    expect(frame).toContain("做个俄罗斯方块");
    expect(frame).not.toContain("user:secret");
    view.unmount();
  });

  it("filters the shared audit to the current workspace without losing global totals", () => {
    const diagnostics = diagnosticsModule as typeof diagnosticsModule & {
      filterRouterAuditRecords?: (
        records: RouterAuditRecord[],
        currentWorkspace: string,
        scope: "all" | "workspace"
      ) => RouterAuditRecord[];
      routerDiagnosticsDisplayLines?: (
        records: RouterAuditRecord[],
        routerPolicy: ReturnType<typeof policy>,
        terminalWidth: number,
        state?: { currentWorkspace?: string; scope?: "all" | "workspace" }
      ) => Array<{ text: string }>;
    };
    const allRecords = [
      ...records(),
      { ...records()[0]!, request: "other workspace", workspace: "/tmp/other" }
    ];

    expect(diagnostics.filterRouterAuditRecords).toBeTypeOf("function");
    expect(diagnostics.filterRouterAuditRecords?.(allRecords, "/tmp/tetris", "workspace"))
      .toHaveLength(2);
    const text = diagnostics.routerDiagnosticsDisplayLines?.(allRecords, policy(), 100, {
      currentWorkspace: "/tmp/tetris",
      scope: "workspace"
    }).map((line) => line.text).join("\n") ?? "";
    expect(text).toContain("scope · current · tetris · 2/3 routes");
    expect(text).not.toContain("other workspace");
  });

  it("flags timeout budgets that are far above or below successful p95 latency", () => {
    const routerDiagnosticsBudget = (
      diagnosticsModule as typeof diagnosticsModule & {
        routerDiagnosticsBudget?: (
          records: RouterAuditRecord[],
          routerPolicy: ReturnType<typeof policy>
        ) => { text: string; tone: string };
      }
    ).routerDiagnosticsBudget;

    expect(routerDiagnosticsBudget).toBeTypeOf("function");
    expect(routerDiagnosticsBudget?.(budgetRecords(), {
      ...policy(),
      timeoutMs: 120000
    })).toEqual({
      text: "budget · initial high · 120s / p95 9.7s · n 3 · consider 20s · follow-up no data · 20s",
      tone: "warning"
    });
    expect(routerDiagnosticsBudget?.(budgetRecords(), {
      ...policy(),
      timeoutMs: 5000
    })).toEqual({
      text: "budget · initial tight · 5s / p95 9.7s · n 3 · consider 20s · follow-up no data · 20s",
      tone: "warning"
    });
  });

  it("keeps every rendered diagnostic row within narrow terminal widths", () => {
    const displayLines = (
      diagnosticsModule as typeof diagnosticsModule & {
        routerDiagnosticsDisplayLines?: (
          records: RouterAuditRecord[],
          routerPolicy: ReturnType<typeof policy>,
          terminalWidth: number
        ) => Array<{ text: string }>;
      }
    ).routerDiagnosticsDisplayLines;

    expect(displayLines).toBeTypeOf("function");
    const overflow: string[] = [];
    for (let width = 8; width <= 80; width += 1) {
      for (const line of displayLines?.(records(), policy(), width) ?? []) {
        if (displayWidth(line.text) > Math.max(1, width - 2)) {
          overflow.push(`${width}:${displayWidth(line.text)}:${line.text}`);
        }
      }
    }
    expect(overflow).toEqual([]);
  });
});

function policy() {
  return {
    mode: "auto" as const,
    timeoutMs: 30000,
    followUpTimeoutMs: 20000,
    fallback: "simple" as const,
    proxyConfigured: true,
    proxySource: "router-config" as const,
    proxyVariable: "HTTPS_PROXY",
    proxyEndpoint: "proxy.test:8443"
  };
}

function records(): RouterAuditRecord[] {
  return [
    {
      time: "2026-07-11T07:00:00.000Z",
      request: "你好",
      workspace: "/tmp/tetris",
      scope: "initial",
      mode: "simple",
      reason: "Short status question.",
      suggested_roles: [],
      judge_engine: "codex",
      actor_engine: "codex",
      critic_engine: "codex",
      source: "codex",
      duration_ms: 9700,
      router_dispatch_ms: 1,
      router_spawn_ms: 5,
      router_first_output_ms: 8900,
      router_first_stdout_ms: 8900,
      router_first_stderr_ms: 120,
      router_process_ms: 9600,
      router_parse_ms: 1,
      router_stdout_bytes: 86,
      router_stderr_bytes: 15,
      router_attempt: 2
    },
    {
      time: "2026-07-11T07:01:00.000Z",
      request: "做个俄罗斯方块",
      workspace: "/tmp/tetris",
      scope: "initial",
      mode: "complex",
      reason: "Codex router timed out via proxy http://user:secret@127.0.0.1:7890.",
      suggested_roles: ["judge", "actor", "critic"],
      judge_engine: "codex",
      actor_engine: "codex",
      critic_engine: "codex",
      source: "fallback",
      duration_ms: 30000,
      router_timeout_ms: 30000,
      proxy_configured: true,
      proxy_source: "router-config",
      proxy_variable: "HTTPS_PROXY",
      proxy_endpoint: "127.0.0.1:7890",
      failure_kind: "timeout",
      router_attempt: 1,
      router_fallback_resolution: "parallel",
      router_failure_stage: "streaming",
      router_dispatch_ms: 2,
      router_spawn_ms: 8,
      router_first_output_ms: 24,
      router_first_stderr_ms: 24,
      router_process_ms: 30000,
      router_stdout_bytes: 0,
      router_stderr_bytes: 73
    }
  ];
}

function budgetRecords(): RouterAuditRecord[] {
  const successful = records()[0]!;
  return [8000, 9000, 9700].map((duration, index) => ({
    ...successful,
    time: `2026-07-11T07:00:0${index}.000Z`,
    duration_ms: duration
  }));
}
