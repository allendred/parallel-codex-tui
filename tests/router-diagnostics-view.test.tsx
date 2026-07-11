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
      proxyConfigured: false
    });
    expect(routerDiagnosticsPolicy?.(router, { PRIVATE_PROXY: "http://user:secret@proxy.test" }))
      .toEqual(expect.objectContaining({ proxyConfigured: true }));
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
      height: 18
    }));
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("Router diagnostics");
    expect(frame).toContain("scope · all · 2/2 routes · 1 workspace");
    expect(frame).toContain("health · codex 1 · fallback 1 · timeout 1");
    expect(frame).toContain("latency · p50 9.7s · p95 30s · max 30s");
    expect(frame).toContain("policy · auto · 30s / 20s · fallback simple");
    expect(frame).toContain("proxy · configured now · 1 recorded · context only");
    expect(frame).toContain("tetris · initial · simple · codex · 9.7s");
    expect(frame).toContain("evidence · timeout · limit 30s · proxy configured · cause unproven");
    expect(frame).toContain("timeout via proxy");
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
    proxyConfigured: true
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
      duration_ms: 9700
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
      failure_kind: "timeout"
    }
  ];
}
