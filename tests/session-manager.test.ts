import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendText, pathExists, readJson, readTextIfExists, writeJson, writeText } from "../src/core/file-store.js";
import { SessionIndex } from "../src/core/session-index.js";
import { SessionManager } from "../src/core/session-manager.js";
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
});
