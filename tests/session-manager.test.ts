import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appendText, pathExists, readJson, readTextIfExists, writeJson, writeText } from "../src/core/file-store.js";
import { SessionIndex } from "../src/core/session-index.js";
import { SessionManager, type TaskSession } from "../src/core/session-manager.js";
import {
  claimTaskRunLease,
  processIsAlive,
  taskRunOwnerPath,
  workerProcessRecordPath,
  writeWorkerProcessRecord
} from "../src/core/process-ownership.js";
import {
  NativeSessionSchema,
  RouteDecisionSchema,
  TaskMetaSchema,
  TurnMetaSchema,
  WorkerStatusSchema
} from "../src/domain/schemas.js";

describe("SessionManager", () => {
  it("persists bounded workspace chat history and skips corrupt JSONL rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-chat-history-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-10T12:00:00.000Z")
    });
    const chatManager = manager as SessionManager & {
      appendChatMessage?: (message: { from: "user" | "system"; text: string; taskId?: string }) => Promise<void>;
      readChatHistory?: (limit?: number) => Promise<Array<{
        time: string;
        from: "user" | "system";
        text: string;
        task_id?: string;
      }>>;
    };

    expect(chatManager.appendChatMessage).toBeTypeOf("function");
    expect(chatManager.readChatHistory).toBeTypeOf("function");
    await chatManager.appendChatMessage?.({ from: "user", text: "记住暗号蓝色", taskId: "task-blue" });
    await chatManager.appendChatMessage?.({ from: "system", text: "已经记住。", taskId: "task-blue" });

    const chatPath = join(root, ".parallel-codex", "sessions", "main", "chat.jsonl");
    await appendText(chatPath, "not-json\n{\"from\":\"other\",\"text\":\"bad\"}\n");

    await expect(chatManager.readChatHistory?.()).resolves.toEqual([
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "user",
        text: "记住暗号蓝色",
        task_id: "task-blue"
      },
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "system",
        text: "已经记住。",
        task_id: "task-blue"
      }
    ]);
    await expect(chatManager.readChatHistory?.(1)).resolves.toEqual([
      {
        time: "2026-07-10T12:00:00.000Z",
        from: "system",
        text: "已经记住。",
        task_id: "task-blue"
      }
    ]);
  });

  it("creates a complex task session with standard files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-session-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });

    const task = await manager.createTask({
      request: "Implement parallel coding.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      }
    });

    expect(task.id).toBe("task-20260630-033000-a1b2");
    expect(await readTextIfExists(join(task.dir, "user-request.md"))).toContain("Implement parallel coding.");
    expect(await readTextIfExists(join(task.dir, "turns", "0001", "user.md"))).toContain(
      "Implement parallel coding."
    );

    const meta = await readJson(join(task.dir, "meta.json"), TaskMetaSchema);
    const route = await readJson(join(task.dir, "route.json"), RouteDecisionSchema);
    const turn = await readJson(join(task.dir, "turns", "0001", "turn.json"), TurnMetaSchema);
    const turnRoute = await readJson(join(task.dir, "turns", "0001", "route.json"), RouteDecisionSchema);

    expect(meta.status).toBe("created");
    expect(route.mode).toBe("complex");
    expect(turn.turn_id).toBe("0001");
    expect(turnRoute.mode).toBe("complex");
  });

  it("records repeated task status transitions idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-status-idempotent-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "idempotent"
    });
    const task = await manager.createTask({
      request: "Build it.",
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

    await manager.updateTaskStatus(task, "actor_running");
    await manager.updateTaskStatus(task, "actor_running");

    const events = await readTextIfExists(task.eventsPath);
    expect(countOccurrences(events, '"type":"task.actor_running"')).toBe(1);
    expect(events).toContain('"message":"Task moved from created to actor_running"');
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "actor_running" });
  });

  it("repairs a committed task transition after a transient index projection failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-status-projection-retry-"));
    const initial = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "projection-retry"
    });
    const task = await initial.createTask({
      request: "Build it.",
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
    const upsertTask = vi.fn()
      .mockRejectedValueOnce(new Error("index temporarily unavailable"))
      .mockResolvedValue(undefined);
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:31:00.000Z"),
      index: { upsertTask } as unknown as SessionIndex
    });

    await expect(manager.updateTaskStatus(task, "actor_running")).rejects.toThrow("index temporarily unavailable");
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "actor_running" });

    await expect(manager.updateTaskStatus(task, "actor_running")).resolves.toBeUndefined();

    const events = await readTextIfExists(task.eventsPath);
    expect(countOccurrences(events, '"type":"task.actor_running"')).toBe(1);
    expect(events).toContain('"message":"Task moved from created to actor_running"');
    expect(upsertTask).toHaveBeenCalledTimes(2);
  });

  it("repairs the previous committed transition before recording a later failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-status-event-retry-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:32:00.000Z"),
      randomId: () => "event-retry"
    });
    const task = await manager.createTask({
      request: "Build it.",
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
    const eventsBackup = `${task.eventsPath}.backup`;
    await rename(task.eventsPath, eventsBackup);
    await mkdir(task.eventsPath);

    await expect(manager.updateTaskStatus(task, "actor_running")).rejects.toMatchObject({ code: "EISDIR" });
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({
      status: "actor_running",
      status_transition: { from: "created", to: "actor_running" }
    });

    await rm(task.eventsPath, { recursive: true });
    await rename(eventsBackup, task.eventsPath);
    await manager.updateTaskStatus(task, "failed");

    const events = await readTextIfExists(task.eventsPath);
    expect(countOccurrences(events, '"type":"task.actor_running"')).toBe(1);
    expect(countOccurrences(events, '"type":"task.failed"')).toBe(1);
    expect(events.indexOf('"type":"task.actor_running"')).toBeLessThan(events.indexOf('"type":"task.failed"'));
  });

  it("rejects terminal done before the latest turn completion evidence is published", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-done-guard-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "done-guard"
    });
    const task = await manager.createTask({
      request: "Build it.",
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

    await expect(manager.updateTaskStatus(task, "done")).rejects.toThrow(
      `Task ${task.id} cannot move to done before latest-turn completion evidence is published`
    );
    await writeText(join(task.dir, "turns", "0001", "supervisor-summary.md"), "Complex task completed.\n");
    await writeJson(join(task.dir, "features", "0001-mismatch", "status.json"), {
      feature_id: "0001-mismatch",
      task_id: task.id,
      turn_id: "0000",
      title: "Mismatched",
      description: "Wrong turn evidence",
      depends_on: [],
      state: "approved",
      updated_at: "2026-06-30T03:30:00.000Z"
    });
    await expect(manager.updateTaskStatus(task, "done")).rejects.toThrow(
      `Task ${task.id} cannot move to done before latest-turn completion evidence is published`
    );
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "created" });
    expect(await readTextIfExists(task.eventsPath)).not.toContain('"type":"task.done"');
  });

  it("protects complete done tasks from regression while allowing a new follow-up turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-done-regression-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "done-regression"
    });
    const route = {
      mode: "complex" as const,
      reason: "Requires workers.",
      suggested_roles: ["judge" as const, "actor" as const, "critic" as const],
      judge_engine: "mock" as const,
      actor_engine: "mock" as const,
      critic_engine: "mock" as const
    };
    const task = await manager.createTask({ request: "Build it.", cwd: root, route });
    await writeText(join(task.dir, "turns", "0001", "supervisor-summary.md"), "Complex task completed.\n");
    await manager.updateTaskStatus(task, "done");

    await expect(manager.updateTaskStatus(task, "failed")).rejects.toThrow(
      `Task ${task.id} is completely done and cannot move backward to failed`
    );
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "done" });

    await manager.appendTurn(task, { request: "Continue it.", route });
    await expect(manager.updateTaskStatus(task, "judging")).resolves.toBeUndefined();
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "judging" });
  });

  it("appends follow-up turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-turns-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const route = {
      mode: "complex" as const,
      reason: "Requires workers.",
      suggested_roles: ["judge" as const, "actor" as const, "critic" as const],
      judge_engine: "codex" as const,
      actor_engine: "codex" as const,
      critic_engine: "claude" as const
    };
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route
    });

    const turn = await manager.appendTurn(task, {
      request: "继续改",
      route
    });

    expect(turn.turnId).toBe("0002");
    expect(await readTextIfExists(join(task.dir, "turns", "0002", "user.md"))).toContain("继续改");
    const meta = await readJson(join(task.dir, "turns", "0002", "turn.json"), TurnMetaSchema);
    expect(meta.turn_id).toBe("0002");
  });

  it("reads the latest persisted route across task turns", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-latest-route-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Initial route.",
        source: "codex",
        duration_ms: 120,
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      }
    });
    await manager.appendTurn(task, {
      request: "继续",
      route: {
        mode: "complex",
        reason: "Codex router timed out after 30000ms.",
        source: "fallback",
        duration_ms: 30000,
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      }
    });

    await expect(manager.readLatestRoute(task)).resolves.toMatchObject({
      reason: "Codex router timed out after 30000ms.",
      source: "fallback",
      duration_ms: 30000
    });

    await writeText(join(task.dir, "turns", "0002", "route.json"), "{");
    await expect(manager.readLatestRoute(task)).resolves.toMatchObject({
      reason: "Initial route.",
      source: "codex",
      duration_ms: 120
    });
  });

  it("prefers the latest task route evidence over an older worker turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-latest-task-route-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Initial route.",
        source: "codex",
        duration_ms: 120,
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      }
    });
    await manager.appendTurn(task, {
      request: "继续",
      route: {
        mode: "complex",
        reason: "Codex router timed out after 120000ms.",
        source: "fallback",
        duration_ms: 120000,
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      }
    });
    await writeJson(join(task.dir, "latest-route.json"), RouteDecisionSchema.parse({
      mode: "simple",
      reason: "A short task question.",
      source: "codex",
      duration_ms: 9210,
      router_attempt: 2,
      router_total_duration_ms: 39710,
      router_recovered_from: "timeout",
      router_recovered_via: "auto-retry",
      router_recovered_timeout_kind: "idle",
      router_recovered_failure_stage: "streaming",
      suggested_roles: []
    }));

    await expect(manager.readLatestRoute(task)).resolves.toMatchObject({
      mode: "simple",
      source: "codex",
      duration_ms: 9210,
      router_attempt: 2,
      router_total_duration_ms: 39710,
      router_recovered_from: "timeout",
      router_recovered_via: "auto-retry",
      router_recovered_timeout_kind: "idle",
      router_recovered_failure_stage: "streaming"
    });

    await writeText(join(task.dir, "latest-route.json"), "{");
    await expect(manager.readLatestRoute(task)).resolves.toMatchObject({
      mode: "complex",
      source: "fallback",
      duration_ms: 120000
    });
  });

  it("appends follow-up turns when task metadata is corrupt but the active task is known", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-turns-corrupt-meta-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const route = {
      mode: "complex" as const,
      reason: "Requires workers.",
      suggested_roles: ["judge" as const, "actor" as const, "critic" as const],
      judge_engine: "mock" as const,
      actor_engine: "mock" as const,
      critic_engine: "mock" as const
    };
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route
    });
    await expect(index.activeTaskId()).resolves.toBe(task.id);
    await writeText(task.metaPath, "{");

    const turn = await manager.appendTurn(task, {
      request: "继续改",
      route
    });

    expect(turn.turnId).toBe("0002");
    expect(await readTextIfExists(join(task.dir, "turns", "0002", "user.md"))).toContain("继续改");
    await expect(index.countRows("turns")).resolves.toBe(2);
    index.close();
  });

  it("finds the latest complex task from session files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-latest-task-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      randomId: () => "a1b2"
    });
    await manager.createTask({
      request: "First task.",
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
    const second = await manager.createTask({
      request: "Second task.",
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

    const latest = await manager.latestTask();

    expect(latest?.id).toBe(second.id);
  });

  it("skips corrupt task metadata when finding the latest complex task", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-latest-task-corrupt-meta-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "good"
    });
    const good = await manager.createTask({
      request: "Good task.",
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
    const corruptDir = join(root, ".parallel-codex", "sessions", "task-20260630-033100-bad");
    await writeText(join(corruptDir, "meta.json"), "{");

    const latest = await manager.latestTask();

    expect(latest?.id).toBe(good.id);
  });

  it("backfills turn 0001 before appending to legacy tasks with user-request but no turns directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-legacy-turns-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "Original.",
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
    await rm(join(task.dir, "turns"), { recursive: true, force: true });

    const turn = await manager.appendTurn(task, {
      request: "继续",
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });

    expect(turn.turnId).toBe("0002");
    expect(await readTextIfExists(join(task.dir, "turns", "0001", "user.md"))).toContain("Original.");
    expect(await readTextIfExists(join(task.dir, "turns", "0002", "user.md"))).toContain("继续");
  });

  it("backfills legacy task turns with fallback route when route and task metadata are corrupt", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-legacy-corrupt-route-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const route = {
      mode: "complex" as const,
      reason: "Requires workers.",
      suggested_roles: ["judge" as const, "actor" as const, "critic" as const],
      judge_engine: "mock" as const,
      actor_engine: "mock" as const,
      critic_engine: "mock" as const
    };
    const task = await manager.createTask({
      request: "Original.",
      cwd: root,
      route
    });
    await rm(join(task.dir, "turns"), { recursive: true, force: true });
    await writeText(task.routePath, "{");
    await writeText(task.metaPath, "{");

    const turn = await manager.appendTurn(task, {
      request: "继续",
      route
    });

    expect(turn.turnId).toBe("0002");
    expect(await readTextIfExists(join(task.dir, "turns", "0001", "user.md"))).toContain("Original.");
    const backfilledRoute = await readJson(join(task.dir, "turns", "0001", "route.json"), RouteDecisionSchema);
    expect(backfilledRoute.reason).toBe("Requires workers.");
  });

  it("indexes legacy task metadata when appending the first follow-up turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-legacy-index-turns-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const task = await manager.createTask({
      request: "Original.",
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
    await rm(join(task.dir, "turns"), { recursive: true, force: true });
    await index.rebuildFromFiles();

    await manager.appendTurn(task, {
      request: "继续",
      route: {
        mode: "complex",
        reason: "Requires workers.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });

    await expect(index.countRows("tasks")).resolves.toBe(1);
    await expect(index.countRows("turns")).resolves.toBe(2);
    index.close();
  });

  it("initializes worker status files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-worker-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });

    const task = await manager.createTask({
      request: "Build the MVP.",
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

    const worker = await manager.initializeWorker(task, {
      workerId: "judge-mock",
      role: "judge",
      engine: "mock",
      prompt: "Write requirements."
    });

    const status = await readJson(worker.statusPath, WorkerStatusSchema);

    expect(status.worker_id).toBe("judge-mock");
    expect(status.state).toBe("idle");
    expect(await readTextIfExists(worker.promptPath)).toContain("Write requirements.");
  });

  it("clears stale Judge artifacts while preserving its native session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-judge-artifacts-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });
    const task = await manager.createTask({
      request: "Build the MVP.",
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
    const worker = await manager.initializeWorker(task, {
      workerId: "judge-mock",
      role: "judge",
      engine: "mock",
      prompt: "Write first-turn requirements."
    });
    await writeText(join(worker.dir, "requirements.md"), "stale requirements\n");
    await writeJson(join(worker.dir, "features.json"), { version: 1, features: [{ id: "stale" }] });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "judge",
      worker_id: "judge-mock",
      session_id: "judge-session",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });

    await manager.initializeWorker(task, {
      workerId: "judge-mock",
      role: "judge",
      engine: "mock",
      prompt: "Write second-turn requirements."
    });

    expect(await pathExists(join(worker.dir, "requirements.md"))).toBe(false);
    expect(await pathExists(join(worker.dir, "features.json"))).toBe(false);
    expect((await manager.readNativeSession(worker))?.session_id).toBe("judge-session");
  });

  it("stores worker native session metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });

    const task = await manager.createTask({
      request: "Build the MVP.",
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

    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });

    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-123",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });

    const record = await manager.readNativeSession(worker);
    const raw = await readJson(join(worker.dir, "native-session.json"), NativeSessionSchema);

    expect(record?.session_id).toBe("native-123");
    expect(raw.session_id).toBe("native-123");
  });

  it("retires worker native session metadata without leaving it active", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-retired-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2"
    });

    const task = await manager.createTask({
      request: "Build the MVP.",
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
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-123",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });
    await writeJson(worker.statusPath, WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-06-30T03:31:00.000Z",
      summary: "mock exited",
      native_session_id: "native-123"
    }));

    await manager.retireNativeSession(worker, "context window full");

    expect(await manager.readNativeSession(worker)).toBeNull();
    expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(false);
    const status = await readJson(worker.statusPath, WorkerStatusSchema);
    expect(status.native_session_id).toBeUndefined();
    const retired = await readJson(join(worker.dir, "native-session.retired.json"), NativeSessionSchema.extend({
      retired_at: NativeSessionSchema.shape.last_used_at,
      retired_reason: NativeSessionSchema.shape.session_id
    }));
    expect(retired.session_id).toBe("native-123");
    expect(retired.retired_reason).toBe("context window full");
  });

  it("clears corrupt native session metadata when retiring it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-retire-corrupt-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const task = await manager.createTask({
      request: "Build the MVP.",
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
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-corrupt",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });
    await writeText(join(worker.dir, "native-session.json"), "{");
    await writeJson(worker.statusPath, WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-06-30T03:31:00.000Z",
      summary: "mock exited",
      native_session_id: "native-corrupt"
    }));

    await expect(manager.retireNativeSession(worker, "context window full")).resolves.toBeUndefined();
    expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(false);
    expect(await pathExists(join(worker.dir, "native-session.retired.json"))).toBe(false);
    const status = await readJson(worker.statusPath, WorkerStatusSchema);
    expect(status.native_session_id).toBeUndefined();
    await expect(index.countRows("native_sessions")).resolves.toBe(0);
    index.close();
  });

  it("clears corrupt worker native session metadata when reading it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-corrupt-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const task = await manager.createTask({
      request: "Build the MVP.",
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
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-corrupt",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });
    await writeText(join(worker.dir, "native-session.json"), "{");
    await writeJson(worker.statusPath, WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-06-30T03:31:00.000Z",
      summary: "mock exited",
      native_session_id: "native-corrupt"
    }));

    await expect(manager.readNativeSession(worker)).resolves.toBeNull();
    expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(false);
    const status = await readJson(worker.statusPath, WorkerStatusSchema);
    expect(status.native_session_id).toBeUndefined();
    await expect(index.countRows("native_sessions")).resolves.toBe(0);
    index.close();
  });

  it("ignores corrupt worker status while clearing corrupt native sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-session-corrupt-status-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const task = await manager.createTask({
      request: "Build the MVP.",
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
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-corrupt",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });
    await writeText(join(worker.dir, "native-session.json"), "{");
    await writeText(worker.statusPath, "{");

    await expect(manager.readNativeSession(worker)).resolves.toBeNull();
    expect(await pathExists(join(worker.dir, "native-session.json"))).toBe(false);
    await expect(index.countRows("native_sessions")).resolves.toBe(0);
    index.close();
  });

  it("mirrors session writes into the SQLite index", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-session-indexed-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const route = {
      mode: "complex" as const,
      reason: "Requires workers.",
      suggested_roles: ["judge" as const, "actor" as const, "critic" as const],
      judge_engine: "mock" as const,
      actor_engine: "mock" as const,
      critic_engine: "mock" as const
    };
    const task = await manager.createTask({
      request: "Build it.",
      cwd: root,
      route
    });
    await manager.appendTurn(task, {
      request: "继续",
      route
    });
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-123",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });

    await expect(index.countRows("tasks")).resolves.toBe(1);
    await expect(index.countRows("turns")).resolves.toBe(2);
    await expect(index.countRows("workers")).resolves.toBe(1);
    await expect(index.countRows("native_sessions")).resolves.toBe(1);
    index.close();
  });

  it("removes retired native sessions from the SQLite index", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-session-retired-index-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-06-30T03:30:00.000Z"),
      randomId: () => "a1b2",
      index
    });
    const task = await manager.createTask({
      request: "Build it.",
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
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "Write code."
    });
    await manager.writeNativeSession(worker, {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-123",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });

    await manager.retireNativeSession(worker, "context window full");

    await expect(index.countRows("native_sessions")).resolves.toBe(0);
    index.close();
  });

  it("reconciles an interrupted task while preserving its retry checkpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-interrupted-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:00.000Z"),
      randomId: () => "orphan",
      index
    });
    const task = await manager.createTask({
      request: "实现可恢复任务",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "codex",
        actor_engine: "codex",
        critic_engine: "claude"
      }
    });
    await manager.updateTaskStatus(task, "actor_running");
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-codex-0001-ui",
      featureId: "0001-ui",
      featureTitle: "Game UI",
      role: "actor",
      engine: "codex",
      prompt: "implement UI"
    });
    await writeJson(worker.statusPath, {
      worker_id: worker.workerId,
      feature_id: "0001-ui",
      feature_title: "Game UI",
      role: "actor",
      engine: "codex",
      state: "running",
      phase: "process-output",
      last_event_at: "2026-07-11T14:29:00.000Z",
      summary: "editing UI",
      native_session_id: "native-ui-session"
    });
    const featureStatusPath = join(task.dir, "features", "0001-ui", "status.json");
    await writeJson(featureStatusPath, {
      feature_id: "0001-ui",
      task_id: task.id,
      turn_id: "0001",
      title: "Game UI",
      description: "Render the UI",
      depends_on: [],
      state: "actor_running",
      updated_at: "2026-07-11T14:29:00.000Z"
    });
    await writeJson(taskRunOwnerPath(task.dir), {
      version: 1,
      owner_id: "dead-tui",
      pid: 2147483647,
      acquired_at: "2026-07-11T14:28:00.000Z",
      process_start_token: "dead-token"
    });
    await writeWorkerProcessRecord(worker.dir, {
      workerId: worker.workerId,
      pid: 2147483647,
      command: "codex"
    });

    const recovered = await manager.reconcileInterruptedTasks();

    expect(recovered).toEqual([{
      taskId: task.id,
      previousState: "actor_running",
      workersRecovered: 1,
      featuresRecovered: 1,
      processesTerminated: 0
    }]);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });
    await expect(readJson(worker.statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "cancelled",
      phase: "orphaned-after-restart",
      native_session_id: "native-ui-session"
    });
    expect(JSON.parse(await readTextIfExists(featureStatusPath))).toMatchObject({
      state: "cancelled",
      updated_at: "2026-07-11T14:30:00.000Z"
    });
    expect(await readTextIfExists(worker.outputLogPath)).toContain("Recovered after previous TUI exit");
    expect(await readTextIfExists(task.eventsPath)).toContain("task.recovered_after_restart");
    expect(await pathExists(taskRunOwnerPath(task.dir))).toBe(false);
    expect(await pathExists(workerProcessRecordPath(worker.dir))).toBe(false);
    await expect(index.listTasks()).resolves.toEqual([
      expect.objectContaining({ id: task.id, status: "cancelled" })
    ]);
    index.close();
  });

  it("repairs a committed terminal transition projection during startup reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-status-transition-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:29:30.000Z"),
      randomId: () => "transition-repair",
      index
    });
    const task = await manager.createTask({
      request: "修复已提交状态投影",
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
    await writeText(join(task.dir, "turns", "0001", "supervisor-summary.md"), "Complex task completed.\n");
    const meta = await readJson(task.metaPath, TaskMetaSchema);
    await writeJson(task.metaPath, TaskMetaSchema.parse({
      ...meta,
      status: "done",
      status_transition: {
        id: "transition-created-done",
        from: "created",
        to: "done",
        at: "2026-07-11T14:29:15.000Z"
      }
    }));

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([]);
    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([]);

    const events = await readTextIfExists(task.eventsPath);
    expect(countOccurrences(events, '"transition_id":"transition-created-done"')).toBe(1);
    expect(events).toContain('"type":"task.done"');
    expect(events).toContain('"from_state":"created"');
    expect(events).toContain('"to_state":"done"');
    await expect(index.listTasks()).resolves.toEqual([
      expect.objectContaining({ id: task.id, status: "done" })
    ]);
    index.close();
  });

  it("recovers an incomplete terminal done task instead of hiding missing completion evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-incomplete-done-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:10.000Z"),
      randomId: () => "incomplete-done"
    });
    const task = await manager.createTask({
      request: "Build completion evidence.",
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
    const featureStatusPath = join(task.dir, "features", "0001-completion", "status.json");
    await writeJson(featureStatusPath, {
      feature_id: "0001-completion",
      task_id: task.id,
      turn_id: "0001",
      title: "Completion",
      description: "Publish completion evidence",
      depends_on: [],
      state: "integrating",
      updated_at: "2026-07-11T14:30:00.000Z"
    });
    await writeJson(join(task.dir, "workspaces", "turn-0001", "wave-0001", "integration.json"), {
      version: 1,
      state: "integrated",
      changed_paths: []
    });
    const legacyMeta = await readJson(task.metaPath, TaskMetaSchema);
    await writeJson(task.metaPath, { ...legacyMeta, status: "done" });

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([{
      taskId: task.id,
      previousState: "done",
      workersRecovered: 0,
      featuresRecovered: 1,
      processesTerminated: 0
    }]);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });
    expect(JSON.parse(await readTextIfExists(featureStatusPath))).toMatchObject({ state: "cancelled" });
    expect(await readTextIfExists(task.eventsPath)).toContain("task.recovered_incomplete_done");
  });

  it("keeps an evidence-complete terminal done task untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-complete-done-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:20.000Z"),
      randomId: () => "complete-done"
    });
    const task = await manager.createTask({
      request: "Build complete evidence.",
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
    await writeText(join(task.dir, "turns", "0001", "supervisor-summary.md"), "Complex task completed.\n");
    await writeJson(join(task.dir, "features", "0001-complete", "status.json"), {
      feature_id: "0001-complete",
      task_id: task.id,
      turn_id: "0001",
      title: "Complete",
      description: "Complete evidence",
      depends_on: [],
      state: "approved",
      updated_at: "2026-07-11T14:30:19.000Z"
    });
    await manager.updateTaskStatus(task, "done");

    await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([]);
    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "done" });
  });

  it("allows only one startup process to reconcile the same interrupted task", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-race-"));
    const left = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:30.000Z"),
      randomId: () => "race"
    });
    const right = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:30:31.000Z"),
      randomId: () => "unused"
    });
    const task = await left.createTask({
      request: "并发恢复任务",
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
    await left.updateTaskStatus(task, "actor_running");
    const worker = await left.initializeWorker(task, {
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
      phase: "process-output",
      last_event_at: "2026-07-11T14:30:00.000Z",
      summary: "working"
    });

    type ReconcileInternals = {
      reconcileTaskWorkers(task: TaskSession): Promise<{ recovered: number; terminated: number }>;
    };
    let entrants = 0;
    let openGate = () => {};
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    for (const manager of [left, right]) {
      const internal = manager as unknown as ReconcileInternals;
      const original = internal.reconcileTaskWorkers.bind(manager);
      internal.reconcileTaskWorkers = async (currentTask) => {
        entrants += 1;
        if (entrants === 2) {
          openGate();
        }
        await Promise.race([
          gate,
          new Promise((resolve) => setTimeout(resolve, 100))
        ]);
        return original(currentTask);
      };
    }

    const results = await Promise.all([
      left.reconcileInterruptedTasks(),
      right.reconcileInterruptedTasks()
    ]);

    expect(results.flat()).toHaveLength(1);
    expect(entrants).toBe(1);
    expect(countOccurrences(await readTextIfExists(task.eventsPath), "task.recovered_after_restart")).toBe(1);
    expect(countOccurrences(await readTextIfExists(worker.outputLogPath), "Recovered after previous TUI exit")).toBe(1);
    expect(await pathExists(taskRunOwnerPath(task.dir))).toBe(false);
  });

  it("leaves a nonterminal task untouched while its owner lease is active", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-live-owner-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:31:00.000Z"),
      randomId: () => "live"
    });
    const task = await manager.createTask({
      request: "保持运行",
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
    await manager.updateTaskStatus(task, "actor_running");
    const lease = await claimTaskRunLease(task.dir, { ownerId: "live-tui" });

    try {
      await expect(manager.reconcileInterruptedTasks()).resolves.toEqual([]);
      await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "actor_running" });
    } finally {
      await lease.release();
    }
  });

  it("does not commit recovery while a recorded worker process cannot be verified", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-unverifiable-worker-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:31:30.000Z"),
      randomId: () => "unverifiable"
    });
    const task = await manager.createTask({
      request: "安全恢复无法验证的进程",
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
    await manager.updateTaskStatus(task, "actor_running");
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      featureId: "0001-safety",
      role: "actor",
      engine: "mock",
      prompt: "keep working"
    });
    await writeJson(worker.statusPath, {
      worker_id: worker.workerId,
      feature_id: "0001-safety",
      role: "actor",
      engine: "mock",
      state: "running",
      phase: "process-output",
      last_event_at: "2026-07-11T14:31:00.000Z",
      summary: "working"
    });
    const featureStatusPath = join(task.dir, "features", "0001-safety", "status.json");
    await writeJson(featureStatusPath, {
      feature_id: "0001-safety",
      task_id: task.id,
      turn_id: "0001",
      title: "Recovery safety",
      description: "Do not overlap workers",
      depends_on: [],
      state: "actor_running",
      updated_at: "2026-07-11T14:31:00.000Z"
    });
    await writeJson(workerProcessRecordPath(worker.dir), {
      version: 1,
      worker_id: worker.workerId,
      pid: process.pid,
      owner_pid: 2147483647,
      command: process.execPath,
      started_at: "2026-07-11T14:31:00.000Z"
    });

    await expect(manager.reconcileInterruptedTasks()).rejects.toThrow(
      `Startup recovery blocked for task ${task.id}`
    );

    await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "actor_running" });
    await expect(readJson(worker.statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "running",
      phase: "process-output"
    });
    expect(JSON.parse(await readTextIfExists(featureStatusPath))).toMatchObject({ state: "actor_running" });
    expect(await pathExists(workerProcessRecordPath(worker.dir))).toBe(true);
    expect(await pathExists(taskRunOwnerPath(task.dir))).toBe(false);
    expect(await readTextIfExists(worker.outputLogPath)).not.toContain("Recovered after previous TUI exit");
    expect(await readTextIfExists(task.eventsPath)).toContain("task.recovery_blocked");
    expect(await readTextIfExists(task.eventsPath)).not.toContain("task.cancelled");
  });

  it("terminates a recorded orphan even when its worker status is already terminal", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-reconcile-terminal-worker-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T14:32:00.000Z"),
      randomId: () => "terminal-worker"
    });
    const task = await manager.createTask({
      request: "恢复超时进程",
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
    await manager.updateTaskStatus(task, "actor_running");
    const worker = await manager.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "keep running"
    });
    await writeJson(worker.statusPath, {
      worker_id: worker.workerId,
      role: "actor",
      engine: "mock",
      state: "failed",
      phase: "process-idle-timeout",
      last_event_at: "2026-07-11T14:31:00.000Z",
      summary: "worker timed out"
    });
    const detached = process.platform !== "win32";
    const orphan = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      detached,
      stdio: "ignore"
    });
    orphan.unref();
    const orphanPid = orphan.pid ?? 0;
    if (!orphanPid) {
      throw new Error("Orphan process did not receive a pid");
    }
    await writeWorkerProcessRecord(worker.dir, {
      workerId: worker.workerId,
      pid: orphanPid,
      command: process.execPath,
      ...(detached ? { processGroupId: orphanPid } : {})
    });

    try {
      const recovered = await manager.reconcileInterruptedTasks();

      expect(recovered).toEqual([{
        taskId: task.id,
        previousState: "actor_running",
        workersRecovered: 0,
        featuresRecovered: 0,
        processesTerminated: 1
      }]);
      expect(processIsAlive(orphanPid)).toBe(false);
      expect(await pathExists(workerProcessRecordPath(worker.dir))).toBe(false);
      await expect(readJson(worker.statusPath, WorkerStatusSchema)).resolves.toMatchObject({
        state: "failed",
        phase: "process-idle-timeout"
      });
    } finally {
      if (processIsAlive(orphanPid)) {
        try {
          process.kill(detached ? -orphanPid : orphanPid, "SIGKILL");
        } catch {
          // Best-effort cleanup for a failed reconciliation assertion.
        }
      }
    }
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
