import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { pathExists, readJson, readTextIfExists, writeJson, writeText } from "../src/core/file-store.js";
import { SessionManager } from "../src/core/session-manager.js";
import { TaskMetaSchema } from "../src/domain/schemas.js";
import { Orchestrator, type WorkerRunStatus } from "../src/orchestrator/orchestrator.js";
import { MockWorkerAdapter } from "../src/workers/mock-adapter.js";
import type { WorkerResult, WorkerRunSpec } from "../src/workers/types.js";

describe("Orchestrator integration cancellation", () => {
  it("stops before changing the live workspace when cancellation arrives before commit", async () => {
    const fixture = await integrationFixture("before-commit");
    const controller = new AbortController();

    await expect(fixture.orchestrator.handleRequest({
      request: "实现提交前取消保护",
      cwd: fixture.root,
      signal: controller.signal,
      onStatus: (status) => abortAtIntegration(status, controller, 0)
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(await pathExists(join(fixture.root, "integrated.txt"))).toBe(false);
    const task = await fixture.manager.latestTask();
    expect(task).not.toBeNull();
    await expect(readJson(task!.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("finishes task evidence when cancellation arrives after the live commit", async () => {
    const fixture = await integrationFixture("after-commit");
    const controller = new AbortController();

    const result = await fixture.orchestrator.handleRequest({
      request: "实现提交后完成收尾",
      cwd: fixture.root,
      signal: controller.signal,
      onStatus: (status) => abortAtIntegration(status, controller, 1)
    });

    expect(result.mode).toBe("complex");
    expect(await pathExists(join(fixture.root, "integrated.txt"))).toBe(true);
    const task = fixture.manager.taskFromId(result.taskId!);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "done" });
    await expect(fixture.orchestrator.canRetryTask(task.id)).resolves.toBe(false);
  });

  it("stops a verified multi-feature wave before its live commit", async () => {
    const fixture = await integrationFixture("multi-before-commit", true);
    const controller = new AbortController();

    await expect(fixture.orchestrator.handleRequest({
      request: "并行实现 alpha 和 beta",
      cwd: fixture.root,
      signal: controller.signal,
      onStatus: (status) => {
        if (
          status.featureProgress?.phase === "verification"
          && status.featureProgress.completed === 1
        ) {
          controller.abort();
        }
      }
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(await pathExists(join(fixture.root, "0001-alpha.txt"))).toBe(false);
    expect(await pathExists(join(fixture.root, "0001-beta.txt"))).toBe(false);
  });

  it("retries a lost final integration checkpoint without rerunning workers", async () => {
    const fixture = await integrationFixture("lost-checkpoint-retry");
    const initial = await fixture.orchestrator.handleRequest({
      request: "实现可恢复提交",
      cwd: fixture.root
    });
    const task = fixture.manager.taskFromId(initial.taskId!);
    const waveRoot = join(task.dir, "workspaces", "turn-0001", "wave-0001");
    const integrationPath = join(waveRoot, "integration.json");
    const integration = JSON.parse(await readTextIfExists(integrationPath)) as {
      changed_paths: string[];
      [key: string]: unknown;
    };
    const workspace = JSON.parse(await readTextIfExists(join(waveRoot, "workspace.json"))) as {
      features: Record<string, string>;
    };
    await writeJson(join(waveRoot, "integration.pending.json"), {
      version: 1,
      state: "committing",
      turn_id: "0001",
      wave: 1,
      feature_ids: Object.keys(workspace.features),
      changed_paths: integration.changed_paths
    });
    await writeJson(integrationPath, { ...integration, state: "staged" });
    const meta = await readJson(task.metaPath, TaskMetaSchema);
    await writeJson(task.metaPath, { ...meta, status: "failed" });
    const initialWorkerRuns = fixture.adapter.runs.length;

    const retried = await fixture.orchestrator.retryTask({ taskId: task.id, cwd: fixture.root });

    expect(retried.mode).toBe("complex");
    expect(fixture.adapter.runs).toHaveLength(initialWorkerRuns);
    expect(await readTextIfExists(join(fixture.root, "integrated.txt"))).toBe("committed\n");
    expect(await pathExists(join(waveRoot, "integration.pending.json"))).toBe(false);
    expect(JSON.parse(await readTextIfExists(integrationPath))).toMatchObject({
      state: "integrated",
      changed_paths: ["integrated.txt"]
    });
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "done" });
  });
});

function abortAtIntegration(
  status: WorkerRunStatus,
  controller: AbortController,
  completed: number
): void {
  if (
    status.featureProgress?.phase === "integration"
    && status.featureProgress.completed === completed
  ) {
    controller.abort();
  }
}

async function integrationFixture(id: string, multiFeature = false) {
  const root = await mkdtemp(join(tmpdir(), `pct-orch-integration-cancel-${id}-`));
  const config = defaultConfig(root);
  config.router.defaultMode = "complex";
  config.pairing.judge = "mock";
  config.pairing.actor = "mock";
  config.pairing.critic = "mock";
  config.workers.mock.command = "mock";
  const manager = new SessionManager({
    projectRoot: root,
    dataDir: config.dataDir,
    now: () => new Date("2026-07-12T08:10:00.000Z"),
    randomId: () => id
  });
  const adapter = new EditingMockWorkerAdapter(multiFeature);
  const orchestrator = new Orchestrator(config, manager, new Map([["mock", adapter]]));
  return { root, manager, adapter, orchestrator };
}

class EditingMockWorkerAdapter extends MockWorkerAdapter {
  readonly runs: WorkerRunSpec[] = [];

  constructor(private readonly multiFeature = false) {
    super();
  }

  override async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.runs.push(spec);
    const result = await super.run(spec);
    if (spec.role === "judge" && this.multiFeature && result.exitCode === 0 && !result.cancelled) {
      await writeJson(join(spec.filesDir, "features.json"), {
        version: 1,
        features: [
          { id: "alpha", title: "Alpha", description: "Implement alpha", depends_on: [] },
          { id: "beta", title: "Beta", description: "Implement beta", depends_on: [] }
        ]
      });
    }
    if (spec.role === "actor" && result.exitCode === 0 && !result.cancelled) {
      const file = this.multiFeature && spec.featureId
        ? `${spec.featureId}.txt`
        : "integrated.txt";
      await writeText(join(spec.cwd, file), "committed\n");
    }
    return result;
  }
}
