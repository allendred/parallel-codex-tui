import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { pathExists } from "../src/core/file-store.js";
import {
  RoleConfigurationManager,
  configuredRoleSelection,
  roleFutureConfigurationPath,
  roleNextConfigurationPath,
  roleTaskConfigurationPath,
  roleTurnConfigurationPath
} from "../src/core/role-configuration.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("RoleConfigurationManager", () => {
  it("persists future role providers and models across runtime restarts", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const config = configuredTestConfig(root);
    const manager = await RoleConfigurationManager.open({ config, appRoot: root, workspaceRoot: workspace });
    const roles = configuredRoleSelection(config);
    roles.main = { engine: "claude", model: "claude-opus-4-1" };
    roles.critic = { engine: "codex", model: "gpt-5.6" };

    await manager.apply("future", roles);

    expect(config.pairing.main).toBe("claude");
    expect(config.pairing.critic).toBe("codex");
    expect(await pathExists(roleFutureConfigurationPath(root, config.dataDir))).toBe(true);

    const restartedConfig = configuredTestConfig(root);
    const restarted = await RoleConfigurationManager.open({
      config: restartedConfig,
      appRoot: root,
      workspaceRoot: workspace
    });
    const snapshot = await restarted.snapshot();
    expect(snapshot.future.main).toEqual({ engine: "claude", model: "claude-opus-4-1" });
    expect(snapshot.future.critic).toEqual({ engine: "codex", model: "gpt-5.6" });
    expect(restartedConfig.pairing.main).toBe("claude");
    expect(restarted.modelForTarget(snapshot.future.main).name).toBe("claude-opus-4-1");
  });

  it("consumes a workspace next-request matrix exactly once", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const config = configuredTestConfig(root);
    const manager = await RoleConfigurationManager.open({ config, appRoot: root, workspaceRoot: workspace });
    const next = manager.futureRoles();
    next.main = { engine: "claude", model: "claude-sonnet-next" };

    await manager.apply("next", next);

    expect((await manager.snapshot()).next?.main.model).toBe("claude-sonnet-next");
    expect((await manager.selectionForRequest()).main).toEqual(next.main);
    expect(await pathExists(roleNextConfigurationPath(workspace, config.dataDir))).toBe(false);
    expect((await manager.selectionForRequest()).main.engine).toBe("codex");
  });

  it("keeps current-task defaults separate from one-shot Turn evidence", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const taskDir = join(workspace, ".parallel-codex", "sessions", "task-20260720-test");
    const turnDir = join(taskDir, "turns", "0001");
    const config = configuredTestConfig(root);
    const manager = await RoleConfigurationManager.open({ config, appRoot: root, workspaceRoot: workspace });
    const task = manager.futureRoles();
    task.actor = { engine: "claude", model: "claude-actor" };
    const turn = manager.futureRoles();
    turn.actor = { engine: "codex", model: "gpt-turn-only" };

    await manager.apply("task", task, taskDir);
    await manager.writeTurnSelection(turnDir, turn);

    const snapshot = await manager.snapshot(taskDir);
    expect(snapshot.task?.actor).toEqual(task.actor);
    expect(snapshot.activeTurn?.actor).toEqual(turn.actor);
    expect((await manager.selectionForTask(taskDir)).actor).toEqual(task.actor);
    expect((await manager.modelForTurn(turnDir, "actor", "codex")).name).toBe("gpt-turn-only");
    expect(await pathExists(roleTaskConfigurationPath(taskDir))).toBe(true);
    expect(await pathExists(roleTurnConfigurationPath(turnDir))).toBe(true);
  });

  it("resets persisted scopes to their inherited matrices", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const taskDir = join(workspace, ".parallel-codex", "sessions", "task-20260720-reset");
    const config = configuredTestConfig(root);
    const manager = await RoleConfigurationManager.open({ config, appRoot: root, workspaceRoot: workspace });
    const changed = manager.futureRoles();
    changed.main = { engine: "claude", model: "custom" };
    await manager.apply("future", changed);
    await manager.apply("next", changed);
    await manager.apply("task", changed, taskDir);

    await manager.clear("next");
    await manager.clear("task", taskDir);
    await manager.clear("future");

    const snapshot = await manager.snapshot(taskDir);
    expect(snapshot.next).toBeNull();
    expect(snapshot.task).toBeNull();
    expect(snapshot.future).toEqual(snapshot.baseline);
    expect(config.pairing.main).toBe("codex");
  });

  it("rejects a persisted role that points at an unknown provider", async () => {
    const root = await temporaryRoot();
    const config = configuredTestConfig(root);
    const manager = await RoleConfigurationManager.open({ config, appRoot: root, workspaceRoot: root });
    const roles = manager.futureRoles();
    roles.actor.engine = "missing";

    await expect(manager.apply("future", roles)).rejects.toThrow("Worker provider is not configured: missing");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pct-role-config-"));
  roots.push(root);
  return root;
}

function configuredTestConfig(root: string) {
  const config = defaultConfig(root);
  config.workers.codex.model.name = "gpt-default";
  config.workers.codex.model.provider = "openai";
  config.workers.claude.model.name = "claude-default";
  config.workers.claude.model.provider = "anthropic";
  return config;
}
