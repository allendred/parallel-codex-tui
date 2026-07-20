import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { readJson, writeText } from "../src/core/file-store.js";
import { RoleConfigurationManager } from "../src/core/role-configuration.js";
import { SessionManager } from "../src/core/session-manager.js";
import { RouteDecisionSchema } from "../src/domain/schemas.js";
import { Orchestrator } from "../src/orchestrator/orchestrator.js";
import type { WorkerAdapter, WorkerResult, WorkerRunSpec } from "../src/workers/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Orchestrator role configuration", () => {
  it("runs the next request with its one-shot Main provider and model, then returns to defaults", async () => {
    const root = await temporaryRoot();
    const config = defaultConfig(root);
    config.router.defaultMode = "simple";
    config.workers.codex.model.name = "gpt-default";
    config.workers.claude.model.name = "sonnet-default";
    const roles = await RoleConfigurationManager.open({ config, appRoot: root, workspaceRoot: root });
    const once = roles.futureRoles();
    once.main = { engine: "claude", model: "opus-once" };
    await roles.apply("next", once);
    const codex = new MainCapturingAdapter("codex");
    const claude = new MainCapturingAdapter("claude");
    const orchestrator = new Orchestrator(
      config,
      new SessionManager({ projectRoot: root, dataDir: config.dataDir }),
      new Map([["codex", codex], ["claude", claude]]),
      undefined,
      join(root, config.dataDir, "router"),
      undefined,
      { roleConfiguration: roles }
    );

    const first = await orchestrator.handleRequest({ request: "first", cwd: root });
    const second = await orchestrator.handleRequest({ request: "second", cwd: root });

    expect(first.workers[0]?.engine).toBe("claude");
    expect(claude.runs[0]?.modelConfig?.name).toBe("opus-once");
    expect(second.workers[0]?.engine).toBe("codex");
    expect(codex.runs[0]?.modelConfig?.name).toBe("gpt-default");
    expect((await roles.snapshot()).next).toBeNull();
  });

  it("rewrites retryable current-Task route and Turn model evidence without deleting history", async () => {
    const root = await temporaryRoot();
    const config = defaultConfig(root);
    config.workers.codex.model.name = "gpt-default";
    config.workers.claude.model.name = "sonnet-default";
    const sessions = new SessionManager({
      projectRoot: root,
      dataDir: config.dataDir,
      now: () => new Date("2026-07-20T08:00:00.000Z"),
      randomId: () => "roles"
    });
    const route = RouteDecisionSchema.parse({
      mode: "complex",
      reason: "coding",
      source: "forced",
      judge_engine: "codex",
      actor_engine: "codex",
      critic_engine: "claude"
    });
    const task = await sessions.createTask({ request: "build", cwd: root, route });
    await sessions.updateTaskStatus(task, "failed");
    const roles = await RoleConfigurationManager.open({ config, appRoot: root, workspaceRoot: root });
    await roles.writeTurnSelection(join(task.dir, "turns", "0001"), roles.futureRoles());
    const orchestrator = new Orchestrator(
      config,
      sessions,
      new Map(),
      undefined,
      join(root, config.dataDir, "router"),
      undefined,
      { roleConfiguration: roles }
    );
    const changed = roles.futureRoles();
    changed.judge = { engine: "claude", model: "opus-judge" };
    changed.actor = { engine: "claude", model: "sonnet-actor" };
    changed.critic = { engine: "codex", model: "gpt-critic" };

    const snapshot = await orchestrator.updateRoleConfiguration({
      scope: "task",
      taskId: task.id,
      roles: changed
    });
    const persistedRoute = await readJson(join(task.dir, "turns", "0001", "route.json"), RouteDecisionSchema);
    const turnRoles = await roles.readTurnSelection(join(task.dir, "turns", "0001"));

    expect(snapshot.task).toEqual(changed);
    expect(persistedRoute.judge_engine).toBe("claude");
    expect(persistedRoute.actor_engine).toBe("claude");
    expect(persistedRoute.critic_engine).toBe("codex");
    expect(turnRoles?.judge.model).toBe("opus-judge");
    expect(turnRoles?.actor.model).toBe("sonnet-actor");
    expect(turnRoles?.critic.model).toBe("gpt-critic");
    expect(await sessions.readMeta(task)).toMatchObject({ id: task.id, status: "failed" });
  });
});

class MainCapturingAdapter implements WorkerAdapter {
  readonly runs: WorkerRunSpec[] = [];

  constructor(readonly name: "codex" | "claude") {}

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    this.runs.push(spec);
    await writeText(spec.outputLogPath, `${this.name} response\n`);
    return { workerId: spec.workerId, exitCode: 0, signal: null };
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pct-orch-roles-"));
  roots.push(root);
  return root;
}
