import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { pathExists, readTextIfExists, writeJson } from "../src/core/file-store.js";
import { SessionManager } from "../src/core/session-manager.js";
import { MockWorkerAdapter } from "../src/workers/mock-adapter.js";

const leaseGate = vi.hoisted(() => {
  let announceEntered: () => void = () => undefined;
  let resumeClaim: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    announceEntered = resolve;
  });
  const resume = new Promise<void>((resolve) => {
    resumeClaim = resolve;
  });
  return { announceEntered, entered, resume, resumeClaim };
});

vi.mock("../src/core/process-ownership.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/process-ownership.js")>(
    "../src/core/process-ownership.js"
  );
  return {
    ...actual,
    claimTaskRunLease: vi.fn(async () => {
      leaseGate.announceEntered();
      await leaseGate.resume;
      return {
        owner: {
          version: 1 as const,
          owner_id: "retry-lease-test",
          pid: process.pid,
          acquired_at: "2026-06-30T03:31:11.000Z"
        },
        release: vi.fn(async () => undefined)
      };
    })
  };
});

import { Orchestrator } from "../src/orchestrator/orchestrator.js";

describe("Orchestrator retry lease", () => {
  it("revalidates retryable state after acquiring the task lease", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-retry-revalidate-"));
    const config = defaultConfig(root);
    config.pairing.judge = "mock";
    config.pairing.actor = "mock";
    config.pairing.critic = "mock";
    config.pairing.main = "mock";
    config.router.defaultMode = "complex";
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-06-30T03:31:11.000Z"),
      randomId: () => "revalidate"
    });
    const task = await manager.createTask({
      request: "实现并行功能",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await manager.updateTaskStatus(task, "failed");
    const adapter = new MockWorkerAdapter();
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));

    const retry = orchestrator.retryTask({ taskId: task.id, cwd: root });
    await leaseGate.entered;
    const failedMeta = await manager.readMeta(task);
    await writeJson(task.metaPath, { ...failedMeta, status: "done" });
    leaseGate.resumeClaim();

    await expect(retry).rejects.toThrow(
      `Task ${task.id} is done; only failed or cancelled tasks can be retried.`
    );
    expect(await pathExists(join(task.dir, "judge-mock"))).toBe(false);
    expect(await readTextIfExists(task.eventsPath)).not.toContain("task.retrying");
  });
});
