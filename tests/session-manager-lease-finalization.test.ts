import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TaskRunLease } from "../src/core/process-ownership.js";
import { SessionManager, type TaskSession } from "../src/core/session-manager.js";

describe("SessionManager recovery lease finalization", () => {
  it("preserves both the Main recovery failure and lease release failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-main-recovery-lease-finalize-"));
    const release = vi.fn(async () => {
      throw new Error("main recovery lease disk unavailable");
    });
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      claimTaskRunLease: leaseClaimer(release)
    });
    await mkdir(manager.mainSessionDir(), { recursive: true });
    replaceWorkerRecovery(manager, async () => {
      throw new Error("main recovery process inspection failed");
    });

    const failure = await manager.reconcileInterruptedMainSession()
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("main recovery process inspection failed");
    expect((failure as Error).message).toContain("main recovery lease disk unavailable");
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toHaveLength(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it("preserves both the task recovery failure and lease release failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-recovery-lease-finalize-"));
    const release = vi.fn(async () => {
      throw new Error("task recovery lease disk unavailable");
    });
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-12T10:00:00.000Z"),
      randomId: () => "lease-finalize",
      claimTaskRunLease: leaseClaimer(release)
    });
    const task = await manager.createTask({
      request: "Recover an interrupted task safely.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    replaceWorkerRecovery(manager, async () => {
      throw new Error("task recovery process inspection failed");
    });

    const failure = await manager.reconcileInterruptedTasks()
      .then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("task recovery process inspection failed");
    expect((failure as Error).message).toContain("task recovery lease disk unavailable");
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toHaveLength(2);
    expect(release).toHaveBeenCalledOnce();
    expect(task.id).toBe("task-20260712-100000-lease-finalize");
  });
});

type WorkerRecovery = (task: TaskSession, subject?: string) => Promise<{
  recovered: number;
  terminated: number;
}>;

function replaceWorkerRecovery(manager: SessionManager, recovery: WorkerRecovery): void {
  (manager as unknown as { reconcileTaskWorkers: WorkerRecovery }).reconcileTaskWorkers = recovery;
}

function leaseClaimer(release: TaskRunLease["release"]): () => Promise<TaskRunLease> {
  return async () => ({
    owner: {
      version: 1,
      owner_id: "test-recovery-lease-owner",
      pid: process.pid,
      acquired_at: "2026-07-12T10:00:00.000Z"
    },
    release
  });
}
