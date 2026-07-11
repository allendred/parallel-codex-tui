import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeText } from "../src/core/file-store.js";
import * as routerAuditModule from "../src/core/router-audit.js";

describe("readRouterAudit", () => {
  it("returns the latest valid records while skipping corrupt JSONL rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-audit-"));
    const path = join(root, "routes.jsonl");
    const readRouterAudit = (
      routerAuditModule as typeof routerAuditModule & {
        readRouterAudit?: (path: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
      }
    ).readRouterAudit;

    expect(readRouterAudit).toBeTypeOf("function");
    await writeText(path, [
      JSON.stringify(routeRecord("first", "codex")),
      "{partial",
      JSON.stringify({ ...routeRecord("invalid", "codex"), mode: "unknown" }),
      JSON.stringify(routeRecord("second", "fallback"))
    ].join("\n") + "\n");

    await expect(readRouterAudit?.(path, 1)).resolves.toEqual([
      expect.objectContaining({ request: "second", source: "fallback", scope: "initial" })
    ]);
    await expect(readRouterAudit?.(path, 0)).resolves.toEqual([]);
  });

  it("keeps structured timeout and proxy evidence and classifies legacy failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-audit-evidence-"));
    const path = join(root, "routes.jsonl");
    const readRouterAudit = (
      routerAuditModule as typeof routerAuditModule & {
        readRouterAudit?: (path: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
        classifyRouterFailure?: (reason: string) => string | null;
      }
    ).readRouterAudit;
    const classifyRouterFailure = (
      routerAuditModule as typeof routerAuditModule & {
        classifyRouterFailure?: (reason: string) => string | null;
      }
    ).classifyRouterFailure;
    await writeText(path, `${JSON.stringify({
      ...routeRecord("timeout", "fallback"),
      router_timeout_ms: 30000,
      proxy_configured: true,
      failure_kind: "timeout",
      router_failure_stage: "waiting-output",
      router_spawn_ms: 12,
      router_process_ms: 30000,
      router_stdout_bytes: 0,
      router_stderr_bytes: 0
    })}\n`);

    expect(classifyRouterFailure).toBeTypeOf("function");
    expect(classifyRouterFailure?.("Codex router timed out after 30000ms with proxy configured"))
      .toBe("timeout");
    expect(classifyRouterFailure?.("Codex router failed while proxy was configured"))
      .toBeNull();
    expect(classifyRouterFailure?.("proxy was configured, but the Router failed"))
      .toBeNull();
    expect(classifyRouterFailure?.("proxy connection refused"))
      .toBe("proxy");
    expect(classifyRouterFailure?.("proxy authentication required"))
      .toBe("proxy");
    expect(classifyRouterFailure?.("HTTP 401 Unauthorized"))
      .toBe("auth");
    expect(classifyRouterFailure?.("No JSON object in Codex router output")).toBe("invalid-output");
    await expect(readRouterAudit?.(path)).resolves.toEqual([
      expect.objectContaining({
        router_timeout_ms: 30000,
        proxy_configured: true,
        failure_kind: "timeout",
        router_failure_stage: "waiting-output",
        router_spawn_ms: 12,
        router_process_ms: 30000,
        router_stdout_bytes: 0,
        router_stderr_bytes: 0
      })
    ]);
  });

  it("turns structured process evidence into bounded diagnoses and next actions", () => {
    const diagnoseRouterFailure = (
      routerAuditModule as typeof routerAuditModule & {
        diagnoseRouterFailure?: (evidence: Record<string, unknown>) => {
          kind: string;
          summary: string;
          action: string;
        };
      }
    ).diagnoseRouterFailure;

    expect(diagnoseRouterFailure).toBeTypeOf("function");
    expect(diagnoseRouterFailure?.({
      reason: "Codex router timed out after 30000ms with proxy configured",
      failure_kind: "timeout",
      proxy_configured: true,
      router_failure_stage: "waiting-output",
      router_stdout_bytes: 0,
      router_stderr_bytes: 0
    })).toEqual({
      kind: "timeout",
      summary: "Router produced no output before the timeout",
      action: "run parallel-codex-tui --doctor --probe-router; verify Codex login and proxy upstream"
    });
    expect(diagnoseRouterFailure?.({
      reason: "Codex router timed out after stderr",
      failure_kind: "timeout",
      router_failure_stage: "streaming",
      router_stdout_bytes: 0,
      router_stderr_bytes: 73
    })).toEqual(expect.objectContaining({
      summary: "Router emitted diagnostics but no route response",
      action: "inspect the reason, then run parallel-codex-tui --doctor --probe-router"
    }));
    expect(diagnoseRouterFailure?.({
      reason: "Codex router timed out after stdout",
      failure_kind: "timeout",
      router_failure_stage: "streaming",
      router_stdout_bytes: 18,
      router_stderr_bytes: 0
    })).toEqual(expect.objectContaining({
      summary: "Router began a route response but did not finish",
      action: "retry Router or raise router.codex.timeoutMs"
    }));
    expect(diagnoseRouterFailure?.({
      reason: "HTTP 401 Unauthorized: sign in required",
      router_failure_stage: "exit"
    })).toEqual({
      kind: "auth",
      summary: "Codex authentication failed",
      action: "run codex login, then retry Router"
    });
    expect(diagnoseRouterFailure?.({
      reason: "No JSON object in Codex router output",
      router_failure_stage: "response"
    })).toEqual({
      kind: "invalid-output",
      summary: "Router returned output that was not valid route JSON",
      action: "retry Router; if it repeats, inspect the Router model/provider output"
    });
    expect(diagnoseRouterFailure?.({
      reason: "spawn codex ENOENT",
      router_failure_stage: "spawn"
    })).toEqual({
      kind: "unavailable",
      summary: "Router process could not start",
      action: "run parallel-codex-tui --doctor and fix router.codex.command"
    });
  });
});

function routeRecord(request: string, source: "codex" | "fallback"): Record<string, unknown> {
  return {
    time: "2026-07-11T07:00:00.000Z",
    request,
    workspace: "/tmp/tetris",
    mode: source === "codex" ? "simple" : "complex",
    reason: source === "codex"
      ? "Short status question."
      : "Codex router timed out after 30000ms with proxy configured.",
    suggested_roles: [],
    judge_engine: "codex",
    actor_engine: "codex",
    critic_engine: "codex",
    source,
    duration_ms: source === "codex" ? 9700 : 30000
  };
}
