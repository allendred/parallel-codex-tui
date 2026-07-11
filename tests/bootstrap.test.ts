import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "../src/bootstrap.js";
import { pathExists, readJson, writeJson, writeText } from "../src/core/file-store.js";
import { workerProcessRecordPath } from "../src/core/process-ownership.js";
import { SessionIndex } from "../src/core/session-index.js";
import { TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";

describe("createRuntime", () => {
  it("wires config, session manager, workers, and orchestrator", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-bootstrap-"));
    const runtime = await createRuntime(root);

    expect(runtime.config.projectRoot).toBe(root);
    expect(runtime.workers.has("mock")).toBe(true);
    expect(runtime.orchestrator).toBeDefined();
  });

  it("keeps app state under app root while targeting a separate worker workspace", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-app-root-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-worker-root-"));
    const runtime = await createRuntime(appRoot, workspaceRoot);

    expect(runtime.config.projectRoot).toBe(appRoot);
    expect(runtime.workspaceRoot).toBe(workspaceRoot);
    expect(runtime.routerCwd).toBe(join(appRoot, ".parallel-codex", "router"));
    expect(await pathExists(runtime.routerCwd)).toBe(true);
  });

  it("creates a missing worker workspace and remembers it for later startup", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-app-root-"));
    const workspaceRoot = join(appRoot, "new-project");
    const runtime = await createRuntime(appRoot, workspaceRoot);

    expect(runtime.workspaceRoot).toBe(workspaceRoot);
    expect(await pathExists(workspaceRoot)).toBe(true);
    expect(await pathExists(join(appRoot, ".parallel-codex", "config.toml"))).toBe(true);
    expect(await pathExists(join(workspaceRoot, ".parallel-codex"))).toBe(true);
    expect(await pathExists(join(appRoot, ".parallel-codex", "last-workspace"))).toBe(true);
  });

  it("stores task sessions under the worker workspace", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-app-root-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-worker-root-"));
    const runtime = await createRuntime(appRoot, workspaceRoot);

    const task = await runtime.sessions.createTask({
      request: "做个俄罗斯方块的游戏",
      cwd: workspaceRoot,
      route: {
        mode: "complex",
        reason: "test",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });

    expect(task.dir.startsWith(workspaceRoot)).toBe(true);
    expect(await pathExists(join(workspaceRoot, ".parallel-codex", "sessions", task.id))).toBe(true);
    expect(await pathExists(join(appRoot, ".parallel-codex", "sessions", task.id))).toBe(false);
    expect(await pathExists(join(workspaceRoot, ".parallel-codex", "session-index.sqlite"))).toBe(true);
    expect(await pathExists(join(appRoot, ".parallel-codex", "session-index.sqlite"))).toBe(false);
  });

  it("can start and restore the latest task when another task has corrupt metadata", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-app-root-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-worker-root-"));
    const firstRuntime = await createRuntime(appRoot, workspaceRoot);
    const task = await firstRuntime.sessions.createTask({
      request: "做个俄罗斯方块的游戏",
      cwd: workspaceRoot,
      route: {
        mode: "complex",
        reason: "test",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const corruptTaskDir = join(workspaceRoot, ".parallel-codex", "sessions", "task-20260701-010000-bad");
    await writeText(join(corruptTaskDir, "meta.json"), "{");

    const restarted = await createRuntime(appRoot, workspaceRoot);
    const latest = await restarted.sessions.latestTask();

    expect(latest?.id).toBe(task.id);
  });

  it("repairs an interrupted task before restoring the workspace", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-reconcile-app-root-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-reconcile-worker-root-"));
    const firstRuntime = await createRuntime(appRoot, workspaceRoot);
    const task = await firstRuntime.sessions.createTask({
      request: "实现可恢复任务",
      cwd: workspaceRoot,
      route: {
        mode: "complex",
        reason: "test",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await firstRuntime.sessions.updateTaskStatus(task, "actor_running");
    const worker = await firstRuntime.sessions.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "keep working"
    });
    await writeJson(worker.statusPath, {
      worker_id: worker.workerId,
      role: "actor",
      engine: "mock",
      state: "running",
      phase: "process-running",
      last_event_at: "2026-07-11T14:00:00.000Z",
      summary: "worker running"
    });
    firstRuntime.index.close();

    const restarted = await createRuntime(appRoot, workspaceRoot);

    expect(restarted.recoveredTasks).toEqual([{
      taskId: task.id,
      previousState: "actor_running",
      workersRecovered: 1,
      featuresRecovered: 0,
      processesTerminated: 0
    }]);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });
    await expect(readJson(worker.statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "cancelled",
      phase: "orphaned-after-restart"
    });
    await expect(restarted.orchestrator.canRetryTask(task.id)).resolves.toBe(true);
    restarted.index.close();
  });

  it("closes the session index when startup recovery blocks runtime creation", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-bootstrap-blocked-app-root-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-bootstrap-blocked-worker-root-"));
    const firstRuntime = await createRuntime(appRoot, workspaceRoot);
    const task = await firstRuntime.sessions.createTask({
      request: "阻止重复 Worker",
      cwd: workspaceRoot,
      route: {
        mode: "complex",
        reason: "test",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await firstRuntime.sessions.updateTaskStatus(task, "actor_running");
    const worker = await firstRuntime.sessions.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "keep working"
    });
    await writeJson(workerProcessRecordPath(worker.dir), {
      version: 1,
      worker_id: worker.workerId,
      pid: process.pid,
      owner_pid: 2147483647,
      command: process.execPath,
      started_at: "2026-07-11T14:31:00.000Z"
    });
    firstRuntime.index.close();
    const closeSpy = vi.spyOn(SessionIndex.prototype, "close");

    try {
      await expect(createRuntime(appRoot, workspaceRoot)).rejects.toThrow("Startup recovery blocked");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("reloads router settings for the next request without rebuilding the worker runtime", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-router-reload-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-router-reload-workspace-"));
    const writeRouterMode = (mode: "simple" | "complex") => writeText(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        `defaultMode = "${mode}"`,
        "",
        "[pairing]",
        'main = "mock"',
        'judge = "mock"',
        'actor = "mock"',
        'critic = "mock"'
      ].join("\n")
    );
    await writeRouterMode("simple");
    const runtime = await createRuntime(appRoot, workspaceRoot);

    const first = await runtime.orchestrator.handleRequest({ request: "你好", cwd: workspaceRoot });
    expect(first.mode).toBe("simple");

    await writeRouterMode("complex");
    const second = await runtime.orchestrator.handleRequest({ request: "实现热加载", cwd: workspaceRoot });

    expect(second.mode).toBe("complex");
    expect(second.taskId).toEqual(expect.stringMatching(/^task-/));
  });
});
