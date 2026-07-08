import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { writeJson, writeText } from "../src/core/file-store.js";
import { SessionIndex } from "../src/core/session-index.js";
import { NativeSessionSchema, RouteDecisionSchema, TaskMetaSchema, TurnMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";

describe("SessionIndex", () => {
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
});
