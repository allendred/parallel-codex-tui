import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { pathExists, readTextIfExists } from "../src/core/file-store.js";
import { SessionManager } from "../src/core/session-manager.js";
import { RouteDecisionSchema } from "../src/domain/schemas.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { MockWorkerAdapter } from "../src/workers/mock-adapter.js";
import type { WorkerResult, WorkerRunSpec } from "../src/workers/types.js";

describe("Orchestrator cancellation handoff", () => {
  it("does not create a complex task when cancellation arrives with the route result", async () => {
    const fixture = await cancellationFixture("initial-complex", "complex");
    const controller = new AbortController();

    await expect(fixture.orchestrator.handleRequest({
      request: "实现取消边界",
      cwd: fixture.root,
      signal: controller.signal,
      onRoute: () => controller.abort()
    })).rejects.toMatchObject({ name: "AbortError" });

    await expect(fixture.manager.latestTask()).resolves.toBeNull();
    expect(fixture.adapter.runs).toHaveLength(0);
  });

  it("does not initialize Main when cancellation arrives with a simple route", async () => {
    const fixture = await cancellationFixture("initial-simple", "simple");
    const controller = new AbortController();

    await expect(fixture.orchestrator.handleRequest({
      request: "解释当前状态",
      cwd: fixture.root,
      signal: controller.signal,
      onRoute: () => controller.abort()
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(fixture.adapter.runs).toHaveLength(0);
    expect(await pathExists(join(
      fixture.root,
      ".parallel-codex",
      "sessions",
      "main",
      "main-mock",
      "status.json"
    ))).toBe(false);
  });

  it("does not append a turn when a supplied follow-up route is already cancelled", async () => {
    const fixture = await completedTaskFixture("supplied-follow-up");
    const controller = new AbortController();
    controller.abort();
    fixture.adapter.runs.length = 0;

    await expect(fixture.orchestrator.handleTaskTurn({
      taskId: fixture.taskId,
      request: "继续增加关卡",
      cwd: fixture.root,
      route: complexRoute("Supplied follow-up route."),
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });

    await expect(fixture.manager.latestTurn(fixture.manager.taskFromId(fixture.taskId))).resolves.toMatchObject({
      turnId: "0001"
    });
    expect(fixture.adapter.runs).toHaveLength(0);
  });

  it("does not append a turn when cancellation arrives with a follow-up route result", async () => {
    const fixture = await completedTaskFixture("routed-follow-up");
    const controller = new AbortController();
    fixture.adapter.runs.length = 0;

    await expect(fixture.orchestrator.handleTaskTurn({
      taskId: fixture.taskId,
      request: "继续增加音效",
      cwd: fixture.root,
      signal: controller.signal,
      onRoute: () => controller.abort()
    })).rejects.toMatchObject({ name: "AbortError" });

    await expect(fixture.manager.latestTurn(fixture.manager.taskFromId(fixture.taskId))).resolves.toMatchObject({
      turnId: "0001"
    });
    expect(fixture.adapter.runs).toHaveLength(0);
  });

  it("rechecks cancellation after acquiring the task run lease", async () => {
    const fixture = await completedTaskFixture("lease-wait");
    const controller = new AbortController();
    const release = vi.fn(async () => undefined);
    const claim = vi.fn(async () => {
      controller.abort();
      return {
        owner: {
          version: 1 as const,
          owner_id: "cancel-during-lease",
          pid: process.pid,
          acquired_at: "2026-07-12T08:01:00.000Z"
        },
        release
      };
    });
    const orchestrator = new Orchestrator(
      fixture.config,
      fixture.manager,
      new Map([["mock", fixture.adapter]]),
      undefined,
      undefined,
      undefined,
      { claimTaskRunLease: claim }
    );
    fixture.adapter.runs.length = 0;

    await expect(orchestrator.handleTaskTurn({
      taskId: fixture.taskId,
      request: "等待锁后继续",
      cwd: fixture.root,
      route: complexRoute("Lease wait route."),
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(claim).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await expect(fixture.manager.latestTurn(fixture.manager.taskFromId(fixture.taskId))).resolves.toMatchObject({
      turnId: "0001"
    });
    expect(fixture.adapter.runs).toHaveLength(0);
  });

  it("does not record or lease an already-cancelled retry", async () => {
    const fixture = await cancellationFixture("retry", "complex");
    const task = await fixture.manager.createTask({
      request: "实现可重试功能",
      cwd: fixture.root,
      route: complexRoute("Initial task route.")
    });
    await fixture.manager.updateTaskStatus(task, "cancelled");
    const controller = new AbortController();
    controller.abort();
    const claim = vi.fn(async () => {
      throw new Error("cancelled retry claimed a task lease");
    });
    const orchestrator = new Orchestrator(
      fixture.config,
      fixture.manager,
      new Map([["mock", fixture.adapter]]),
      undefined,
      undefined,
      undefined,
      { claimTaskRunLease: claim }
    );

    await expect(orchestrator.retryTask({
      taskId: task.id,
      cwd: fixture.root,
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(claim).not.toHaveBeenCalled();
    expect(await readTextIfExists(task.eventsPath)).not.toContain("task.retrying");
    expect(fixture.adapter.runs).toHaveLength(0);
  });

  it("does not record a retry when its route callback cancels execution", async () => {
    const fixture = await cancellationFixture("retry-route", "complex");
    const task = await fixture.manager.createTask({
      request: "实现回调取消功能",
      cwd: fixture.root,
      route: complexRoute("Initial task route.")
    });
    await fixture.manager.updateTaskStatus(task, "cancelled");
    const controller = new AbortController();

    await expect(fixture.orchestrator.retryTask({
      taskId: task.id,
      cwd: fixture.root,
      signal: controller.signal,
      onRoute: () => controller.abort()
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(await readTextIfExists(task.eventsPath)).not.toContain("task.retrying");
    expect(fixture.adapter.runs).toHaveLength(0);
  });

  it("does not lease an already-cancelled task question", async () => {
    const fixture = await cancellationFixture("question", "simple");
    const task = await fixture.manager.createTask({
      request: "实现任务上下文",
      cwd: fixture.root,
      route: complexRoute("Initial task route.")
    });
    const controller = new AbortController();
    controller.abort();
    const claim = vi.fn(async () => {
      throw new Error("cancelled question claimed a task lease");
    });
    const orchestrator = new Orchestrator(
      fixture.config,
      fixture.manager,
      new Map([["mock", fixture.adapter]]),
      undefined,
      undefined,
      undefined,
      { claimTaskRunLease: claim }
    );

    await expect(orchestrator.answerTaskQuestion({
      taskId: task.id,
      request: "现在做到哪里了",
      cwd: fixture.root,
      signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(claim).not.toHaveBeenCalled();
    expect(fixture.adapter.runs).toHaveLength(0);
  });
});

async function cancellationFixture(id: string, mode: "simple" | "complex") {
  const root = await mkdtemp(join(tmpdir(), `pct-orch-cancel-handoff-${id}-`));
  const config = defaultConfig(root);
  config.router.defaultMode = mode;
  config.pairing.main = "mock";
  config.pairing.judge = "mock";
  config.pairing.actor = "mock";
  config.pairing.critic = "mock";
  config.workers.mock.command = "mock";
  const manager = new SessionManager({
    projectRoot: root,
    dataDir: config.dataDir,
    now: () => new Date("2026-07-12T08:00:00.000Z"),
    randomId: () => id
  });
  const adapter = new CountingMockWorkerAdapter();
  const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
  return { root, config, manager, adapter, orchestrator };
}

async function completedTaskFixture(id: string) {
  const fixture = await cancellationFixture(id, "complex");
  const result = await fixture.orchestrator.handleRequest({
    request: "实现基础游戏",
    cwd: fixture.root
  });
  if (!result.taskId) {
    throw new Error("Complex fixture did not create a task");
  }
  return { ...fixture, taskId: result.taskId };
}

function complexRoute(reason: string) {
  return RouteDecisionSchema.parse({
    mode: "complex",
    reason,
    suggested_roles: ["judge", "actor", "critic"],
    judge_engine: "mock",
    actor_engine: "mock",
    critic_engine: "mock"
  });
}

class CountingMockWorkerAdapter extends MockWorkerAdapter {
  readonly runs: WorkerRunSpec[] = [];

  override async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.runs.push(spec);
    return super.run(spec);
  }
}
