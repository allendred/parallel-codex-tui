import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { pathExists } from "../src/core/file-store.js";
import { taskRunOwnerPath } from "../src/core/process-ownership.js";
import { SessionManager } from "../src/core/session-manager.js";
import { Orchestrator, type WorkerRunStatus } from "../src/orchestrator/orchestrator.js";
import { MockWorkerAdapter } from "../src/workers/mock-adapter.js";
import type { WorkerResult, WorkerRunSpec } from "../src/workers/types.js";

class TerminalThenSuccessfulMainAdapter extends MockWorkerAdapter {
  calls = 0;

  constructor(private readonly firstResult: WorkerResult) {
    super();
  }

  override async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.calls += 1;
    if (this.calls === 1) {
      return this.firstResult;
    }
    return super.run(spec);
  }
}

describe("Orchestrator task-question status", () => {
  it.each([
    {
      label: "failure",
      firstResult: { workerId: "main-mock", exitCode: 2, signal: null } satisfies WorkerResult,
      terminal: "failed"
    },
    {
      label: "cancellation",
      firstResult: {
        workerId: "main-mock",
        exitCode: 130,
        signal: "SIGTERM",
        cancelled: true
      } satisfies WorkerResult,
      terminal: "cancelled"
    }
  ])("reports $label and releases both leases for the next question", async ({ firstResult, terminal }) => {
    const root = await mkdtemp(join(tmpdir(), `pct-task-question-${terminal}-`));
    const config = defaultConfig(root);
    config.pairing.main = "mock";
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-07-11T15:10:00.000Z"),
      randomId: () => terminal
    });
    const task = await manager.createTask({
      request: "build a project",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Initial project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock",
        source: "forced"
      }
    });
    const adapter = new TerminalThenSuccessfulMainAdapter(firstResult);
    const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
    const updates: WorkerRunStatus[] = [];

    await expect(orchestrator.answerTaskQuestion({
      taskId: task.id,
      request: "why did it stop",
      cwd: root,
      onStatus: (status) => updates.push(status)
    })).rejects.toBeInstanceOf(Error);

    expect(updates.map((status) => status.main).filter(Boolean)).toEqual(["starting", terminal]);
    expect(await pathExists(taskRunOwnerPath(task.dir))).toBe(false);
    expect(await pathExists(taskRunOwnerPath(manager.mainSessionDir()))).toBe(false);

    const recovered = await orchestrator.answerTaskQuestion({
      taskId: task.id,
      request: "try the question again",
      cwd: root
    });
    expect(recovered.summary).toBe("Mock simple response for: try the question again");
    expect(adapter.calls).toBe(2);
  });
});
