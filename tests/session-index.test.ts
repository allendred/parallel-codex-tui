import { rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { writeJson, writeText } from "../src/core/file-store.js";
import { SessionIndex } from "../src/core/session-index.js";
import { NativeSessionSchema, RouteDecisionSchema, TaskMetaSchema, TurnMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";

describe("SessionIndex", () => {
  it("lists newest task summaries with counts and persists the active task", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-index-catalog-"));
    const index = await SessionIndex.open(root, ".parallel-codex");
    const catalog = index as SessionIndex & {
      listTasks?: (limit?: number) => Promise<Array<{
        id: string;
        title: string;
        turnCount: number;
        workerCount: number;
        nativeSessionCount: number;
      }>>;
      activeTaskId?: () => Promise<string | null | undefined>;
      setActiveTaskId?: (taskId: string | null) => Promise<void>;
    };

    await index.upsertTask({
      id: "task-old",
      title: "Older task",
      created_at: "2026-07-01T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "done"
    });
    await index.upsertTask({
      id: "task-new",
      title: "Newest task",
      created_at: "2026-07-02T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "failed"
    });
    for (const turnId of ["0001", "0002"]) {
      await index.upsertTurn("task-new", {
        task_id: "task-new",
        turn_id: turnId,
        created_at: `2026-07-02T01:0${Number(turnId)}:00.000Z`,
        request_path: `turns/${turnId}/user.md`
      });
    }
    await index.upsertWorker("task-new", {
      worker_id: "actor-codex",
      role: "actor",
      engine: "codex",
      state: "failed",
      phase: "review",
      last_event_at: "2026-07-02T01:03:00.000Z",
      summary: "Needs work",
      native_session_id: "native-new"
    }, {
      dir: join(root, "actor-codex"),
      statusPath: join(root, "actor-codex", "status.json"),
      outputLogPath: join(root, "actor-codex", "output.log")
    });
    await index.upsertNativeSession("task-new", {
      engine: "codex",
      role: "actor",
      worker_id: "actor-codex",
      session_id: "native-new",
      scope: "task",
      cwd: root,
      created_at: "2026-07-02T01:00:00.000Z",
      last_used_at: "2026-07-02T01:03:00.000Z",
      source: "manual"
    });

    expect(catalog.listTasks).toBeTypeOf("function");
    await expect(catalog.listTasks?.(10)).resolves.toEqual([
      expect.objectContaining({
        id: "task-new",
        title: "Newest task",
        turnCount: 2,
        workerCount: 1,
        nativeSessionCount: 1
      }),
      expect.objectContaining({
        id: "task-old",
        title: "Older task",
        turnCount: 0,
        workerCount: 0,
        nativeSessionCount: 0
      })
    ]);

    expect(catalog.setActiveTaskId).toBeTypeOf("function");
    expect(catalog.activeTaskId).toBeTypeOf("function");
    await expect(catalog.activeTaskId?.()).resolves.toBeUndefined();
    await catalog.setActiveTaskId?.("task-new");
    await expect(catalog.activeTaskId?.()).resolves.toBe("task-new");
    index.close();

    const reopened = await SessionIndex.open(root, ".parallel-codex");
    const reopenedCatalog = reopened as SessionIndex & {
      activeTaskId?: () => Promise<string | null | undefined>;
      setActiveTaskId?: (taskId: string | null) => Promise<void>;
    };
    await expect(reopenedCatalog.activeTaskId?.()).resolves.toBe("task-new");
    await reopenedCatalog.setActiveTaskId?.(null);
    await expect(reopenedCatalog.activeTaskId?.()).resolves.toBeNull();
    reopened.close();
  });

  it("indexes task, turn, worker, and native session rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-index-"));
    const index = await SessionIndex.open(root, ".parallel-codex");

    await index.upsertTask({
      id: "task-a",
      title: "Build it",
      created_at: "2026-07-01T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "created"
    });
    await index.upsertTurn("task-a", {
      task_id: "task-a",
      turn_id: "0001",
      created_at: "2026-07-01T01:00:00.000Z",
      request_path: "turns/0001/user.md"
    });
    await index.upsertWorker("task-a", {
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "mock-done",
      last_event_at: "2026-07-01T01:01:00.000Z",
      summary: "done",
      native_session_id: "native-1"
    }, {
      dir: join(root, ".parallel-codex", "sessions", "task-a", "actor-mock"),
      statusPath: join(root, ".parallel-codex", "sessions", "task-a", "actor-mock", "status.json"),
      outputLogPath: join(root, ".parallel-codex", "sessions", "task-a", "actor-mock", "output.log")
    });
    await index.upsertNativeSession("task-a", {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-1",
      scope: "task",
      cwd: root,
      created_at: "2026-07-01T01:00:00.000Z",
      last_used_at: "2026-07-01T01:01:00.000Z",
      source: "manual"
    });

    await expect(index.countRows("tasks")).resolves.toBe(1);
    await expect(index.countRows("turns")).resolves.toBe(1);
    await expect(index.countRows("workers")).resolves.toBe(1);
    await expect(index.countRows("native_sessions")).resolves.toBe(1);
    index.close();
  });

  it("rebuilds index rows from session files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-index-rebuild-"));
    const dataDir = ".parallel-codex";
    const sessionDir = join(root, dataDir, "sessions", "task-rebuild");
    const workerDir = join(sessionDir, "actor-mock");
    const turnDir = join(sessionDir, "turns", "0001");
    const route = RouteDecisionSchema.parse({
      mode: "complex",
      reason: "test",
      suggested_roles: ["judge", "actor", "critic"],
      judge_engine: "mock",
      actor_engine: "mock",
      critic_engine: "mock"
    });

    await writeJson(join(sessionDir, "meta.json"), TaskMetaSchema.parse({
      id: "task-rebuild",
      title: "Rebuild",
      created_at: "2026-07-01T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "done"
    }));
    await writeJson(join(sessionDir, "route.json"), route);
    await writeText(join(sessionDir, "user-request.md"), "Rebuild\n");
    await writeJson(join(turnDir, "turn.json"), TurnMetaSchema.parse({
      task_id: "task-rebuild",
      turn_id: "0001",
      created_at: "2026-07-01T01:00:00.000Z",
      request_path: "turns/0001/user.md"
    }));
    await writeText(join(turnDir, "user.md"), "Rebuild\n");
    await writeJson(join(turnDir, "route.json"), route);
    await writeJson(join(workerDir, "status.json"), WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "mock-done",
      last_event_at: "2026-07-01T01:01:00.000Z",
      summary: "done",
      native_session_id: "native-1"
    }));
    await writeText(join(workerDir, "output.log"), "output\n");
    await writeJson(join(workerDir, "native-session.json"), NativeSessionSchema.parse({
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-1",
      scope: "task",
      cwd: root,
      created_at: "2026-07-01T01:00:00.000Z",
      last_used_at: "2026-07-01T01:01:00.000Z",
      source: "manual"
    }));

    const dbPath = join(root, dataDir, "session-index.sqlite");
    await rm(dbPath, { force: true });
    const index = await SessionIndex.open(root, dataDir);
    await index.rebuildFromFiles();

    await expect(index.countRows("tasks")).resolves.toBe(1);
    await expect(index.countRows("turns")).resolves.toBe(1);
    await expect(index.countRows("workers")).resolves.toBe(1);
    await expect(index.countRows("native_sessions")).resolves.toBe(1);
    index.close();
  });

  it("rolls back every index table when a filesystem error interrupts rebuilding", async () => {
    if (process.platform === "win32") {
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "pct-index-rebuild-rollback-"));
    const dataDir = ".parallel-codex";
    const index = await SessionIndex.open(root, dataDir);
    await index.upsertTask({
      id: "task-stable",
      title: "Stable task",
      created_at: "2026-07-01T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "failed"
    });
    await index.upsertTurn("task-stable", {
      task_id: "task-stable",
      turn_id: "0001",
      created_at: "2026-07-01T01:00:00.000Z",
      request_path: "turns/0001/user.md"
    });
    await index.upsertWorker("task-stable", {
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "failed",
      phase: "process-exited",
      last_event_at: "2026-07-01T01:01:00.000Z",
      summary: "failed",
      native_session_id: "stable-native"
    }, {
      dir: join(root, dataDir, "sessions", "task-stable", "actor-mock"),
      statusPath: join(root, dataDir, "sessions", "task-stable", "actor-mock", "status.json"),
      outputLogPath: join(root, dataDir, "sessions", "task-stable", "actor-mock", "output.log")
    });
    await index.upsertNativeSession("task-stable", {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "stable-native",
      scope: "task",
      cwd: root,
      created_at: "2026-07-01T01:00:00.000Z",
      last_used_at: "2026-07-01T01:01:00.000Z",
      source: "manual"
    });
    await index.setActiveTaskId("task-stable");

    const brokenTaskDir = join(root, dataDir, "sessions", "task-broken");
    await writeJson(join(brokenTaskDir, "meta.json"), TaskMetaSchema.parse({
      id: "task-broken",
      title: "Broken task",
      created_at: "2026-07-02T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "created"
    }));
    await symlink("turns", join(brokenTaskDir, "turns"));

    await expect(index.rebuildFromFiles()).rejects.toMatchObject({ code: "ELOOP" });

    await expect(index.listTasks()).resolves.toEqual([
      expect.objectContaining({
        id: "task-stable",
        status: "failed",
        turnCount: 1,
        workerCount: 1,
        nativeSessionCount: 1
      })
    ]);
    await expect(index.countRows("tasks")).resolves.toBe(1);
    await expect(index.countRows("turns")).resolves.toBe(1);
    await expect(index.countRows("workers")).resolves.toBe(1);
    await expect(index.countRows("native_sessions")).resolves.toBe(1);
    await expect(index.activeTaskId()).resolves.toBe("task-stable");
    index.close();
  });

  it("keeps the previous index visible to other connections until rebuilding commits", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-index-rebuild-visibility-"));
    const dataDir = ".parallel-codex";
    const index = await SessionIndex.open(root, dataDir);
    const observer = await SessionIndex.open(root, dataDir);
    await index.upsertTask({
      id: "task-old",
      title: "Old snapshot",
      created_at: "2026-07-01T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "failed"
    });
    await writeJson(join(root, dataDir, "sessions", "task-new", "meta.json"), TaskMetaSchema.parse({
      id: "task-new",
      title: "New snapshot",
      created_at: "2026-07-02T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "created"
    }));

    type RebuildInternals = {
      rebuildTask(taskDir: string, taskId: string): Promise<void>;
    };
    const internals = index as unknown as RebuildInternals;
    const originalRebuildTask = internals.rebuildTask.bind(index);
    let enterRebuild = () => {};
    const rebuildEntered = new Promise<void>((resolve) => {
      enterRebuild = resolve;
    });
    let continueRebuild = () => {};
    const rebuildGate = new Promise<void>((resolve) => {
      continueRebuild = resolve;
    });
    internals.rebuildTask = async (taskDir, taskId) => {
      enterRebuild();
      await rebuildGate;
      await originalRebuildTask(taskDir, taskId);
    };

    const rebuilding = index.rebuildFromFiles();
    await rebuildEntered;
    try {
      await expect(observer.listTasks()).resolves.toEqual([
        expect.objectContaining({ id: "task-old", title: "Old snapshot" })
      ]);
    } finally {
      continueRebuild();
    }
    await rebuilding;

    await expect(observer.listTasks()).resolves.toEqual([
      expect.objectContaining({ id: "task-new", title: "New snapshot" })
    ]);
    observer.close();
    index.close();
  });

  it("does not resurrect retired native session ids into worker index rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-index-retired-status-"));
    const dataDir = ".parallel-codex";
    const sessionDir = join(root, dataDir, "sessions", "task-retired");
    const workerDir = join(sessionDir, "actor-mock");

    await writeJson(join(sessionDir, "meta.json"), TaskMetaSchema.parse({
      id: "task-retired",
      title: "Retired",
      created_at: "2026-07-01T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "done"
    }));
    await writeJson(join(workerDir, "status.json"), WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-07-01T01:01:00.000Z",
      summary: "done",
      native_session_id: "retired-1"
    }));
    await writeJson(join(workerDir, "native-session.json"), NativeSessionSchema.parse({
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "retired-1",
      scope: "task",
      cwd: root,
      created_at: "2026-07-01T01:00:00.000Z",
      last_used_at: "2026-07-01T01:01:00.000Z",
      source: "manual"
    }));
    await writeJson(join(workerDir, "native-session.retired.json"), {
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "retired-1",
      scope: "task",
      cwd: root,
      created_at: "2026-07-01T01:00:00.000Z",
      last_used_at: "2026-07-01T01:01:00.000Z",
      source: "manual",
      retired_at: "2026-07-01T01:02:00.000Z",
      retired_reason: "context window full"
    });

    const index = await SessionIndex.open(root, dataDir);
    await index.rebuildFromFiles();

    await expect(index.countRows("native_sessions")).resolves.toBe(0);
    await expect(index.workerNativeSessionId("task-retired", "actor-mock")).resolves.toBeNull();
    index.close();
  });

  it("skips corrupt worker status files while rebuilding startup indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-index-corrupt-status-"));
    const dataDir = ".parallel-codex";
    const sessionDir = join(root, dataDir, "sessions", "task-corrupt-status");
    const goodWorkerDir = join(sessionDir, "judge-mock");
    const corruptWorkerDir = join(sessionDir, "actor-mock");

    await writeJson(join(sessionDir, "meta.json"), TaskMetaSchema.parse({
      id: "task-corrupt-status",
      title: "Corrupt status",
      created_at: "2026-07-01T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "done"
    }));
    await writeJson(join(goodWorkerDir, "status.json"), WorkerStatusSchema.parse({
      worker_id: "judge-mock",
      role: "judge",
      engine: "mock",
      state: "done",
      phase: "mock-done",
      last_event_at: "2026-07-01T01:01:00.000Z",
      summary: "done"
    }));
    await writeText(join(corruptWorkerDir, "status.json"), "{");

    const index = await SessionIndex.open(root, dataDir);
    await index.rebuildFromFiles();

    await expect(index.countRows("workers")).resolves.toBe(1);
    index.close();
  });

  it("skips corrupt turn metadata while rebuilding startup indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-index-corrupt-turn-"));
    const dataDir = ".parallel-codex";
    const sessionDir = join(root, dataDir, "sessions", "task-corrupt-turn");
    const goodTurnDir = join(sessionDir, "turns", "0001");
    const corruptTurnDir = join(sessionDir, "turns", "0002");
    const route = RouteDecisionSchema.parse({
      mode: "complex",
      reason: "Committed turn.",
      suggested_roles: ["judge", "actor", "critic"],
      judge_engine: "mock",
      actor_engine: "mock",
      critic_engine: "mock"
    });

    await writeJson(join(sessionDir, "meta.json"), TaskMetaSchema.parse({
      id: "task-corrupt-turn",
      title: "Corrupt turn",
      created_at: "2026-07-01T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "done"
    }));
    await writeJson(join(goodTurnDir, "turn.json"), TurnMetaSchema.parse({
      task_id: "task-corrupt-turn",
      turn_id: "0001",
      created_at: "2026-07-01T01:00:00.000Z",
      request_path: "turns/0001/user.md"
    }));
    await writeText(join(goodTurnDir, "user.md"), "Committed request.\n");
    await writeJson(join(goodTurnDir, "route.json"), route);
    await writeText(join(corruptTurnDir, "turn.json"), "{");

    const index = await SessionIndex.open(root, dataDir);
    await index.rebuildFromFiles();

    await expect(index.countRows("turns")).resolves.toBe(1);
    index.close();
  });

  it("indexes only committed turn directories with matching identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-index-committed-turns-"));
    const dataDir = ".parallel-codex";
    const taskId = "task-committed-turns";
    const sessionDir = join(root, dataDir, "sessions", taskId);
    const route = RouteDecisionSchema.parse({
      mode: "complex",
      reason: "Committed turn.",
      suggested_roles: ["judge", "actor", "critic"],
      judge_engine: "mock",
      actor_engine: "mock",
      critic_engine: "mock"
    });

    await writeJson(join(sessionDir, "meta.json"), TaskMetaSchema.parse({
      id: taskId,
      title: "Committed turns only",
      created_at: "2026-07-01T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "cancelled"
    }));
    await writeJson(join(sessionDir, "turns", "0001", "turn.json"), TurnMetaSchema.parse({
      task_id: taskId,
      turn_id: "0001",
      created_at: "2026-07-01T01:00:00.000Z",
      request_path: "turns/0001/user.md"
    }));
    await writeText(join(sessionDir, "turns", "0001", "user.md"), "Committed request.\n");
    await writeJson(join(sessionDir, "turns", "0001", "route.json"), route);
    await writeJson(join(sessionDir, "turns", ".turn-0002-crashed.pending", "turn.json"), TurnMetaSchema.parse({
      task_id: taskId,
      turn_id: "0002",
      created_at: "2026-07-01T01:01:00.000Z",
      request_path: "turns/0002/user.md"
    }));
    await writeText(join(sessionDir, "turns", ".turn-0002-crashed.pending", "user.md"), "Pending request.\n");
    await writeJson(join(sessionDir, "turns", ".turn-0002-crashed.pending", "route.json"), route);
    await writeJson(join(sessionDir, "turns", "0003", "turn.json"), TurnMetaSchema.parse({
      task_id: "task-other",
      turn_id: "9999",
      created_at: "2026-07-01T01:02:00.000Z",
      request_path: "turns/9999/user.md"
    }));
    await writeText(join(sessionDir, "turns", "0003", "user.md"), "Mismatched request.\n");
    await writeJson(join(sessionDir, "turns", "0003", "route.json"), route);

    const index = await SessionIndex.open(root, dataDir);
    await index.rebuildFromFiles();

    await expect(index.countRows("turns")).resolves.toBe(1);
    index.close();
  });

  it("skips corrupt native session files while rebuilding startup indexes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-index-corrupt-native-"));
    const dataDir = ".parallel-codex";
    const sessionDir = join(root, dataDir, "sessions", "task-corrupt-native");
    const workerDir = join(sessionDir, "actor-mock");

    await writeJson(join(sessionDir, "meta.json"), TaskMetaSchema.parse({
      id: "task-corrupt-native",
      title: "Corrupt native",
      created_at: "2026-07-01T01:00:00.000Z",
      cwd: root,
      mode: "complex",
      status: "done"
    }));
    await writeJson(join(workerDir, "status.json"), WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "mock-done",
      last_event_at: "2026-07-01T01:01:00.000Z",
      summary: "done",
      native_session_id: "native-corrupt"
    }));
    await writeText(join(workerDir, "native-session.json"), "{");

    const index = await SessionIndex.open(root, dataDir);
    await index.rebuildFromFiles();

    await expect(index.countRows("workers")).resolves.toBe(1);
    await expect(index.countRows("native_sessions")).resolves.toBe(0);
    await expect(index.workerNativeSessionId("task-corrupt-native", "actor-mock")).resolves.toBeNull();
    index.close();
  });
});
