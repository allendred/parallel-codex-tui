import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntime } from "../src/bootstrap.js";
import { pathExists, writeText } from "../src/core/file-store.js";

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
  });

  it("creates a missing worker workspace and remembers it for later startup", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-app-root-"));
    const workspaceRoot = join(appRoot, "new-project");
    const runtime = await createRuntime(appRoot, workspaceRoot);

    expect(runtime.workspaceRoot).toBe(workspaceRoot);
    expect(await pathExists(workspaceRoot)).toBe(true);
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
});
