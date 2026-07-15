import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeJson, writeText } from "../src/core/file-store.js";
import { loadTaskSessionDetails, taskSessionWorkerTurnId } from "../src/core/task-session-details.js";
import type { TaskIndexSummary } from "../src/core/session-index.js";

describe("task session details", () => {
  it("loads Turn, Worker, model, native cwd, and last activity from persisted files", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-session-details-"));
    const taskDir = join(root, ".parallel-codex", "sessions", "task-details");
    await writeJson(join(taskDir, "turns", "0001", "turn.json"), {
      task_id: "task-details",
      turn_id: "0001",
      created_at: "2026-07-15T01:00:00.000Z",
      request_path: "turns/0001/user.md"
    });
    await writeText(join(taskDir, "turns", "0001", "user.md"), "实现输入可靠性\n并补齐测试\n");
    const workerDir = join(taskDir, "actor-codex-0001-input");
    await writeJson(join(workerDir, "status.json"), {
      worker_id: "actor-codex-0001-input",
      feature_id: "0001-input",
      feature_title: "Input reliability",
      role: "actor",
      engine: "codex",
      model_name: "persisted-model",
      model_provider: "openai-compatible",
      state: "done",
      phase: "completed",
      last_event_at: "2026-07-15T01:02:00.000Z",
      summary: "Input fixed",
      native_session_id: "019f-session"
    });
    await writeText(join(workerDir, "output.log"), "done\n");
    await writeJson(join(workerDir, "native-session.json"), {
      engine: "codex",
      role: "actor",
      worker_id: "actor-codex-0001-input",
      session_id: "019f-session",
      scope: "task",
      cwd: join(root, "feature-workspace"),
      writable_dirs: [workerDir],
      created_at: "2026-07-15T01:01:00.000Z",
      last_used_at: "2026-07-15T01:03:00.000Z",
      source: "output-detected"
    });

    const details = await loadTaskSessionDetails({
      task: task(root),
      taskDir,
      modelNames: { codex: "gpt-5.4" }
    });

    expect(details.projectName).toBe(root.split("/").at(-1));
    expect(details.turns).toEqual([
      expect.objectContaining({
        turnId: "0001",
        request: "实现输入可靠性 并补齐测试",
        workers: [expect.objectContaining({ id: "actor-codex-0001-input" })]
      })
    ]);
    expect(details.workers).toEqual([
      expect.objectContaining({
        turnId: "0001",
        role: "actor",
        engine: "codex",
        model: "persisted-model",
        modelProvider: "openai-compatible",
        lastActivityAt: "2026-07-15T01:03:00.000Z",
        nativeSession: expect.objectContaining({
          sessionId: "019f-session",
          cwd: join(root, "feature-workspace")
        })
      })
    ]);
  });

  it("derives worker turns for Feature, Wave, Final Judge, and legacy first-turn ids", () => {
    expect(taskSessionWorkerTurnId("actor-codex-0003-ui", "0003-ui")).toBe("0003");
    expect(taskSessionWorkerTurnId("critic-codex-wave-0002-0001")).toBe("0002");
    expect(taskSessionWorkerTurnId("judge-codex-final-0004")).toBe("0004");
    expect(taskSessionWorkerTurnId("judge-codex")).toBe("0001");
  });

  it("keeps legacy Workers visible when their persisted Turn metadata is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-task-session-details-legacy-"));
    const taskDir = join(root, ".parallel-codex", "sessions", "task-details");
    const workerDir = join(taskDir, "judge-codex");
    await writeJson(join(workerDir, "status.json"), {
      worker_id: "judge-codex",
      role: "judge",
      engine: "codex",
      state: "done",
      phase: "completed",
      last_event_at: "2026-07-15T01:02:00.000Z",
      summary: "Legacy requirements"
    });
    await writeText(join(workerDir, "output.log"), "legacy judge output\n");

    const details = await loadTaskSessionDetails({ task: task(root), taskDir });

    expect(details.workers.map((worker) => worker.id)).toEqual(["judge-codex"]);
    expect(details.turns).toEqual([
      expect.objectContaining({
        turnId: "0001",
        request: "",
        workers: [expect.objectContaining({ id: "judge-codex" })]
      })
    ]);
  });
});

function task(root: string): TaskIndexSummary {
  return {
    id: "task-details",
    title: "Session details",
    created_at: "2026-07-15T01:00:00.000Z",
    cwd: root,
    mode: "complex",
    status: "done",
    turnCount: 1,
    workerCount: 1,
    nativeSessionCount: 1
  };
}
