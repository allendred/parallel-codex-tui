import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { pathExists, readJson } from "../src/core/file-store.js";
import { claimTaskRunLease } from "../src/core/process-ownership.js";
import { SessionManager } from "../src/core/session-manager.js";
import { RouteDecisionSchema, type RouteDecision } from "../src/domain/schemas.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { MockWorkerAdapter } from "../src/workers/mock-adapter.js";

describe("Orchestrator follow-up lease", () => {
  it("does not commit a routed complex follow-up when another TUI owns the task", async () => {
    const fixture = await followUpFixture("complex");
    const lease = await claimTaskRunLease(fixture.task.dir, { ownerId: "active-complex-owner" });

    try {
      const routed = await fixture.orchestrator.routeTaskFollowUp({
        taskId: fixture.task.id,
        request: "add another feature",
        cwd: fixture.root
      });
      expect(routed.mode).toBe("complex");

      await expect(fixture.orchestrator.handleTaskTurn({
        taskId: fixture.task.id,
        request: "add another feature",
        cwd: fixture.root,
        route: routed.route
      })).rejects.toThrow("Task is already running in another parallel-codex-tui process");

      await expect(readJson(fixture.latestRoutePath, RouteDecisionSchema)).resolves.toMatchObject({
        reason: "Committed baseline route."
      });
      expect(await pathExists(join(fixture.task.dir, "turns", "0002"))).toBe(false);
    } finally {
      await lease.release();
    }
  });

  it("does not run Main or commit a simple question while another TUI owns the task", async () => {
    const fixture = await followUpFixture("simple");
    const lease = await claimTaskRunLease(fixture.task.dir, { ownerId: "active-question-owner" });

    try {
      const routed = await fixture.orchestrator.routeTaskFollowUp({
        taskId: fixture.task.id,
        request: "why did it fail",
        cwd: fixture.root
      });
      expect(routed.mode).toBe("simple");
      const questionInput = {
        taskId: fixture.task.id,
        request: "why did it fail",
        cwd: fixture.root,
        route: routed.route
      } as Parameters<Orchestrator["answerTaskQuestion"]>[0];

      await expect(fixture.orchestrator.answerTaskQuestion(questionInput)).rejects.toThrow(
        "Task is already running in another parallel-codex-tui process"
      );

      await expect(readJson(fixture.latestRoutePath, RouteDecisionSchema)).resolves.toMatchObject({
        reason: "Committed baseline route."
      });
      expect(await pathExists(join(fixture.manager.mainSessionDir(), "main-mock"))).toBe(false);
    } finally {
      await lease.release();
    }
  });
});

async function followUpFixture(mode: "simple" | "complex") {
  const root = await mkdtemp(join(tmpdir(), `pct-orch-follow-up-${mode}-lease-`));
  const config = defaultConfig(root);
  config.router.defaultMode = "auto";
  config.pairing.main = "mock";
  config.pairing.judge = "mock";
  config.pairing.actor = "mock";
  config.pairing.critic = "mock";
  const manager = new SessionManager({
    projectRoot: root,
    dataDir: config.dataDir,
    now: () => new Date("2026-07-11T15:00:00.000Z"),
    randomId: () => mode
  });
  const initialRoute: RouteDecision = {
    mode: "complex",
    reason: "Initial project work.",
    suggested_roles: ["judge", "actor", "critic"],
    judge_engine: "mock",
    actor_engine: "mock",
    critic_engine: "mock",
    source: "forced"
  };
  const task = await manager.createTask({
    request: "build the initial project",
    cwd: root,
    route: initialRoute
  });
  await manager.recordLatestRoute(task, {
    ...initialRoute,
    reason: "Committed baseline route."
  });
  const orchestrator = new Orchestrator(
    config,
    manager,
    new Map([["mock", new MockWorkerAdapter()]]),
    async () => JSON.stringify({
      mode,
      reason: mode === "complex" ? "Needs project workers." : "Conversational task question."
    })
  );

  return {
    root,
    manager,
    orchestrator,
    task,
    latestRoutePath: join(task.dir, "latest-route.json")
  };
}
