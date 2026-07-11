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

  it("sanitizes legacy Router audit text before diagnostics display", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-router-audit-redaction-"));
    const path = join(root, "routes.jsonl");
    const readRouterAudit = (
      routerAuditModule as typeof routerAuditModule & {
        readRouterAudit?: (path: string, limit?: number) => Promise<Array<Record<string, unknown>>>;
      }
    ).readRouterAudit;
    await writeText(path, `${JSON.stringify({
      ...routeRecord(
        "inspect https://user:secret@proxy.test/private?token=hidden OPENAI_API_KEY=sk-proj-routersecret",
        "fallback"
      ),
      reason: "Bearer bearer-secret failed through https://proxy.test/private?token=hidden"
    })}\n`);

    const record = (await readRouterAudit?.(path))?.[0];
    const visibleText = JSON.stringify(record);

    expect(record?.request).toContain("https://***@proxy.test");
    expect(record?.reason).toContain("https://proxy.test");
    expect(visibleText).not.toMatch(/user:secret|\/private|hidden|routersecret|bearer-secret/);
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
      router_first_output_timeout_ms: 15000,
      router_idle_timeout_ms: 25000,
      router_max_attempts: 2,
      router_retry_delay_ms: 500,
      router_timeout_kind: "first-output",
      proxy_configured: true,
      proxy_source: "router-config",
      proxy_variable: "HTTPS_PROXY",
      proxy_endpoint: "127.0.0.1:7890",
      failure_kind: "timeout",
      router_failure_stage: "waiting-output",
      router_dispatch_ms: 2,
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
        router_first_output_timeout_ms: 15000,
        router_idle_timeout_ms: 25000,
        router_max_attempts: 2,
        router_retry_delay_ms: 500,
        router_timeout_kind: "first-output",
        proxy_configured: true,
        proxy_source: "router-config",
        proxy_variable: "HTTPS_PROXY",
        proxy_endpoint: "127.0.0.1:7890",
        failure_kind: "timeout",
        router_failure_stage: "waiting-output",
        router_dispatch_ms: 2,
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
      router_timeout_kind: "first-output",
      router_failure_stage: "waiting-output",
      router_stdout_bytes: 0,
      router_stderr_bytes: 0
    })).toEqual({
      kind: "timeout",
      summary: "Router produced no output before the first-output deadline",
      action: "run parallel-codex-tui --doctor --probe-router; verify Codex login and proxy upstream, or raise router.codex.firstOutputTimeoutMs"
    });
    expect(diagnoseRouterFailure?.({
      reason: "Codex router idle timed out after 25000ms",
      failure_kind: "timeout",
      router_timeout_kind: "idle",
      router_failure_stage: "streaming",
      router_stdout_bytes: 0,
      router_stderr_bytes: 73
    })).toEqual({
      kind: "timeout",
      summary: "Router diagnostics stopped before a route response",
      action: "inspect the reason; retry Router or raise router.codex.idleTimeoutMs"
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

  it("limits automatic retries to failures likely to recover on another attempt", () => {
    const routerFallbackIsTransient = (
      routerAuditModule as typeof routerAuditModule & {
        routerFallbackIsTransient?: (route: Record<string, unknown>) => boolean;
      }
    ).routerFallbackIsTransient;
    const fallback = (reason: string, evidence: Record<string, unknown> = {}) => ({
      mode: "simple",
      source: "fallback",
      reason,
      ...evidence
    });

    expect(routerFallbackIsTransient).toBeTypeOf("function");
    expect(routerFallbackIsTransient?.(fallback("silent", { router_timeout_kind: "first-output" }))).toBe(true);
    expect(routerFallbackIsTransient?.(fallback("stalled", { router_timeout_kind: "idle" }))).toBe(true);
    expect(routerFallbackIsTransient?.(fallback("hard ceiling", { router_timeout_kind: "total" }))).toBe(false);
    expect(routerFallbackIsTransient?.(fallback("fetch failed: ECONNRESET"))).toBe(true);
    expect(routerFallbackIsTransient?.(fallback("proxy connection refused"))).toBe(true);
    expect(routerFallbackIsTransient?.(fallback("generic", { router_failure_kind: "network" }))).toBe(true);
    expect(routerFallbackIsTransient?.(fallback("generic", { router_failure_kind: "auth" }))).toBe(false);
    expect(routerFallbackIsTransient?.(fallback("HTTP 401 Unauthorized"))).toBe(false);
    expect(routerFallbackIsTransient?.(fallback("HTTP 429 rate limit"))).toBe(false);
    expect(routerFallbackIsTransient?.(fallback("spawn ENOENT"))).toBe(false);
    expect(routerFallbackIsTransient?.(fallback("No JSON object in Codex router output"))).toBe(false);
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
