import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pathExists } from "../src/core/file-store.js";
import { readProcessStartToken } from "../src/core/process-identity.js";
import type { SupervisorRunRequest } from "../src/supervisor/protocol.js";
import {
  appendSupervisorEvent,
  createSupervisorRun,
  readSupervisorCommands,
  readSupervisorRunState,
  writeSupervisorRunState
} from "../src/supervisor/store.js";
import {
  formatSupervisorWatchRecord,
  watchSupervisorRun,
  type SupervisorWatchRecord
} from "../src/supervisor/watch.js";

describe("Supervisor watch", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pct-supervisor-watch-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("replays existing events and follows incremental Worker output until completion", async () => {
    const files = await createSupervisorRun(root, ".parallel-codex", request(root, "run-watch"));
    const state = await readSupervisorRunState(files);
    const processStartToken = await readProcessStartToken(process.pid);
    const logPath = join(root, "worker.log");
    const statusPath = join(root, "worker-status.json");
    const worker = {
      id: "actor-codex-0001-watch",
      featureId: "0001-watch",
      role: "actor" as const,
      engine: "codex" as const,
      label: "Watch implementation",
      logPath,
      statusPath
    };
    await writeFile(logPath, "alpha\n", "utf8");
    await writeSupervisorRunState(files, {
      ...state,
      status: "running",
      updated_at: "2026-07-22T00:00:01.000Z",
      started_at: "2026-07-22T00:00:01.000Z",
      task_id: "task-watch",
      pid: process.pid,
      ...(processStartToken ? { process_start_token: processStartToken } : {})
    });
    await appendSupervisorEvent(files, {
      version: 1,
      sequence: 0,
      at: "2026-07-22T00:00:02.000Z",
      type: "worker",
      payload: worker
    });

    const records: SupervisorWatchRecord[] = [];
    const completion = delay(35).then(async () => {
      await appendFile(logPath, "beta 你好\n", "utf8");
      await appendSupervisorEvent(files, {
        version: 1,
        sequence: 1,
        at: "2026-07-22T00:00:03.000Z",
        type: "status",
        payload: {
          taskId: "task-watch",
          actor: "done",
          featureProgress: { wave: 1, waves: 1, phase: "actor", completed: 1, total: 1 }
        }
      });
      const current = await readSupervisorRunState(files);
      await writeSupervisorRunState(files, {
        ...current,
        status: "completed",
        updated_at: "2026-07-22T00:00:04.000Z",
        finished_at: "2026-07-22T00:00:04.000Z",
        result: {
          mode: "complex",
          taskId: "task-watch",
          summary: "private terminal summary",
          workers: [worker]
        }
      });
    });

    const result = await watchSupervisorRun(root, ".parallel-codex", "run-watch", {
      pollIntervalMs: 10,
      timeoutMs: 1000,
      onRecord: (record) => {
        records.push(record);
      }
    });
    await completion;

    expect(result).toMatchObject({ outcome: "completed", run: { run_id: "run-watch" } });
    expect(records.map((record) => record.type)).toEqual(expect.arrayContaining([
      "snapshot",
      "event",
      "worker-output",
      "finish"
    ]));
    const output = records
      .filter((record): record is Extract<SupervisorWatchRecord, { type: "worker-output" }> => (
        record.type === "worker-output"
      ))
      .map((record) => record.text)
      .join("");
    expect(output).toBe("alpha\nbeta 你好\n");
    expect(output.match(/alpha/g)).toHaveLength(1);
    expect(output.match(/beta/g)).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain("private request that watch must not read");
    expect(JSON.stringify(records)).toContain("private terminal summary");
    expect(formatSupervisorWatchRecord(records[0]!)).toContain("Watching · run-watch");
    expect(formatSupervisorWatchRecord(records.at(-1)!)).toContain("Run completed · run-watch");
    expect(await readSupervisorCommands(files)).toEqual([]);
    expect(await pathExists(files.controllerPath)).toBe(false);
    expect(await pathExists(files.acknowledgedPath)).toBe(false);
  });

  it("times out without changing or controlling the selected run", async () => {
    const files = await createSupervisorRun(root, ".parallel-codex", request(root, "run-watch-timeout"));
    const state = await readSupervisorRunState(files);
    const processStartToken = await readProcessStartToken(process.pid);
    await writeSupervisorRunState(files, {
      ...state,
      status: "running",
      updated_at: new Date().toISOString(),
      pid: process.pid,
      ...(processStartToken ? { process_start_token: processStartToken } : {})
    });
    const records: SupervisorWatchRecord[] = [];

    const result = await watchSupervisorRun(root, ".parallel-codex", null, {
      pollIntervalMs: 10,
      timeoutMs: 25,
      onRecord: (record) => {
        records.push(record);
      }
    });

    expect(result.outcome).toBe("timeout");
    expect(records.at(-1)).toMatchObject({ type: "finish", result: { outcome: "timeout" } });
    expect(await readSupervisorCommands(files)).toEqual([]);
    expect(await pathExists(files.controllerPath)).toBe(false);
    expect(await pathExists(files.acknowledgedPath)).toBe(false);
  });

  it("rejects missing runs and invalid timing options", async () => {
    await expect(watchSupervisorRun(root, ".parallel-codex", "run-missing", {
      onRecord: () => undefined
    })).rejects.toThrow("Supervisor run not found: run-missing");
    await expect(watchSupervisorRun(root, ".parallel-codex", null, {
      pollIntervalMs: 0,
      onRecord: () => undefined
    })).rejects.toThrow("poll interval must be a positive number");
  });
});

function request(root: string, runId: string): SupervisorRunRequest {
  return {
    version: 1,
    run_id: runId,
    kind: "handle-request",
    app_root: root,
    workspace_root: root,
    data_dir: ".parallel-codex",
    created_at: "2026-07-22T00:00:00.000Z",
    request: "private request that watch must not read",
    cwd: root
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
