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
      failure_kind: "timeout"
    })}\n`);

    expect(classifyRouterFailure).toBeTypeOf("function");
    expect(classifyRouterFailure?.("Codex router timed out after 30000ms with proxy configured"))
      .toBe("timeout");
    expect(classifyRouterFailure?.("No JSON object in Codex router output")).toBe("invalid-output");
    await expect(readRouterAudit?.(path)).resolves.toEqual([
      expect.objectContaining({
        router_timeout_ms: 30000,
        proxy_configured: true,
        failure_kind: "timeout"
      })
    ]);
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
