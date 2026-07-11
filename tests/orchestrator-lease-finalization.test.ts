import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { readJson } from "../src/core/file-store.js";
import type { TaskRunLease } from "../src/core/process-ownership.js";
import { SessionManager } from "../src/core/session-manager.js";
import { TaskMetaSchema } from "../src/domain/schemas.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { MockWorkerAdapter } from "../src/workers/mock-adapter.js";
import type { WorkerAdapter, WorkerResult, WorkerRunSpec } from "../src/workers/types.js";

describe("Orchestrator lease finalization", () => {
  it("preserves both the Worker failure and task lease release failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-task-lease-finalize-"));
    const config = mockConfig(root, "complex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-07-12T07:20:00.000Z"),
      randomId: () => "lease-finalize"
    });
    const release = vi.fn(async () => {
      throw new Error("task lease disk unavailable");
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new RejectingJudgeAdapter()]]),
      undefined,
      undefined,
      undefined,
      { claimTaskRunLease: leaseClaimer(release) }
    );

    const failure = await orchestrator.handleRequest({
      request: "实现需要可靠收尾的功能",
      cwd: root
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("judge failed before artifacts");
    expect((failure as Error).message).toContain("task lease disk unavailable");
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toHaveLength(2);
    expect(release).toHaveBeenCalledOnce();
    await expect(readJson(
      join(root, ".parallel-codex", "sessions", "task-20260712-072000-lease-finalize", "meta.json"),
      TaskMetaSchema
    )).resolves.toMatchObject({ status: "failed" });
  });

  it("preserves both the Main Worker failure and Main lease release failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-main-lease-finalize-"));
    const config = mockConfig(root, "simple");
    const manager = new SessionManager({ projectRoot: root, dataDir: config.dataDir });
    const release = vi.fn(async () => {
      throw new Error("main lease disk unavailable");
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new RejectingMainAdapter()]]),
      undefined,
      undefined,
      undefined,
      { claimTaskRunLease: leaseClaimer(release) }
    );

    const failure = await orchestrator.handleRequest({
      request: "解释当前状态",
      cwd: root
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("main worker failed");
    expect((failure as Error).message).toContain("main lease disk unavailable");
    expect((failure as Error).cause).toBeInstanceOf(AggregateError);
    expect(((failure as Error).cause as AggregateError).errors).toHaveLength(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects a successful Main run when its lease cannot be released", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-orch-main-lease-release-only-"));
    const config = mockConfig(root, "simple");
    const manager = new SessionManager({ projectRoot: root, dataDir: config.dataDir });
    const releaseError = new Error("main lease unlink failed");
    const release = vi.fn(async () => {
      throw releaseError;
    });
    const orchestrator = new Orchestrator(
      config,
      manager,
      new Map([["mock", new MockWorkerAdapter()]]),
      undefined,
      undefined,
      undefined,
      { claimTaskRunLease: leaseClaimer(release) }
    );

    const failure = await orchestrator.handleRequest({
      request: "正常回答后释放租约",
      cwd: root
    }).then(() => null, (error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Main session lease release failed: main lease unlink failed");
    expect((failure as Error).cause).toBe(releaseError);
    expect((failure as Error).cause).not.toBeInstanceOf(AggregateError);
    expect(release).toHaveBeenCalledOnce();
  });
});

class RejectingJudgeAdapter implements WorkerAdapter {
  readonly name = "mock" as const;

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "judge") {
      throw new Error("judge failed before artifacts");
    }
    return new MockWorkerAdapter().run(spec);
  }
}

class RejectingMainAdapter extends MockWorkerAdapter {
  override async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    if (spec.role === "main") {
      throw new Error("main worker failed");
    }
    return super.run(spec);
  }
}

function mockConfig(root: string, mode: "simple" | "complex") {
  const config = defaultConfig(root);
  config.router.defaultMode = mode;
  config.pairing.main = "mock";
  config.pairing.judge = "mock";
  config.pairing.actor = "mock";
  config.pairing.critic = "mock";
  config.workers.mock.command = "mock";
  return config;
}

function leaseClaimer(release: TaskRunLease["release"]): () => Promise<TaskRunLease> {
  return async () => ({
    owner: {
      version: 1,
      owner_id: "test-lease-owner",
      pid: process.pid,
      acquired_at: "2026-07-12T07:20:00.000Z"
    },
    release
  });
}
