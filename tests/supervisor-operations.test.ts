import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProcessStartToken } from "../src/core/process-identity.js";
import type { SupervisorRunRequest } from "../src/supervisor/protocol.js";
import {
  formatSupervisorCancellation,
  formatSupervisorRuns,
  formatSupervisorSubmission,
  formatSupervisorWait,
  inspectSupervisorRuns,
  requestSupervisorRunCancellation,
  submitSupervisorRun,
  supervisorWaitExitCode,
  waitForSupervisorRun
} from "../src/supervisor/operations.js";
import {
  acknowledgeSupervisorRun,
  claimSupervisorController,
  createSupervisorRun,
  readSupervisorCommands,
  readSupervisorRunState,
  supervisorRunFiles,
  writeSupervisorRunState,
  type SupervisorRunFiles
} from "../src/supervisor/store.js";

describe("Supervisor operations", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pct-supervisor-operations-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reports non-sensitive run metadata and controller state", async () => {
    const files = await createSupervisorRun(root, ".parallel-codex", request(root, "run-visible"));
    const initial = await readSupervisorRunState(files);
    const processStartToken = await readProcessStartToken(process.pid);
    await writeSupervisorRunState(files, {
      ...initial,
      status: "running",
      updated_at: "2026-07-21T00:00:02.000Z",
      pid: process.pid,
      ...(processStartToken ? { process_start_token: processStartToken } : {})
    });
    const controller = await claimSupervisorController(files, { controllerId: "test-controller" });

    const report = await inspectSupervisorRuns(
      root,
      ".parallel-codex",
      new Date("2026-07-21T00:00:03.000Z")
    );

    expect(report.runs).toEqual([expect.objectContaining({
      run_id: "run-visible",
      status: "running",
      control: "controlled",
      process_active: true,
      controller_active: true,
      acknowledged: false
    })]);
    expect(JSON.stringify(report)).not.toContain("private request text");
    expect(formatSupervisorRuns(report)).toContain("running · controlled · unread · run-visible");

    await controller?.release();
  });

  it("submits one detached run and reuses it for an identical idempotency key", async () => {
    let launches = 0;
    const processStartToken = await readProcessStartToken(process.pid);
    const launch = async (files: SupervisorRunFiles) => {
      launches += 1;
      const state = await readSupervisorRunState(files);
      await writeSupervisorRunState(files, {
        ...state,
        status: "running",
        updated_at: "2026-07-21T00:00:01.000Z",
        started_at: "2026-07-21T00:00:01.000Z",
        pid: process.pid,
        ...(processStartToken ? { process_start_token: processStartToken } : {})
      });
    };
    const input = {
      appRoot: root,
      workspaceRoot: root,
      dataDir: ".parallel-codex",
      cwd: root,
      request: "private submitted request",
      idempotencyKey: "ci:submit-1"
    };

    const first = await submitSupervisorRun(input, {
      launch,
      now: () => new Date("2026-07-21T00:00:00.000Z")
    });
    const second = await submitSupervisorRun(input, {
      launch,
      now: () => new Date("2026-07-21T00:00:02.000Z")
    });

    expect(first).toMatchObject({
      version: 1,
      reused: false,
      run: { status: "running", control: "detached", controller_active: false }
    });
    expect(first.run.run_id).toMatch(/^run-idem-[a-f0-9]{24}$/);
    expect(second).toMatchObject({ reused: true, run: { run_id: first.run.run_id } });
    expect(launches).toBe(1);
    expect(formatSupervisorSubmission(first)).toBe(
      `Run submitted · ${first.run.run_id} · handle-request · running`
    );
    expect(JSON.stringify(first)).not.toContain("private submitted request");
    await expect(submitSupervisorRun({ ...input, request: "different private request" }, { launch }))
      .rejects.toThrow("different Supervisor request");
  });

  it("serializes concurrent submissions with the same idempotency key", async () => {
    let launches = 0;
    const processStartToken = await readProcessStartToken(process.pid);
    const launch = async (files: SupervisorRunFiles) => {
      launches += 1;
      await delay(40);
      const state = await readSupervisorRunState(files);
      await writeSupervisorRunState(files, {
        ...state,
        status: "running",
        updated_at: new Date().toISOString(),
        pid: process.pid,
        ...(processStartToken ? { process_start_token: processStartToken } : {})
      });
    };
    const input = {
      appRoot: root,
      workspaceRoot: root,
      dataDir: ".parallel-codex",
      cwd: root,
      request: "concurrent private request",
      idempotencyKey: "ci:concurrent-submit"
    };

    const results = await Promise.all([
      submitSupervisorRun(input, { launch }),
      submitSupervisorRun(input, { launch })
    ]);

    expect(results.map((result) => result.reused).sort()).toEqual([false, true]);
    expect(new Set(results.map((result) => result.run.run_id))).toHaveLength(1);
    expect(launches).toBe(1);
  });

  it("reports lock cleanup failure without turning a successful submission into a failure", async () => {
    let releaseAttempts = 0;
    const result = await submitSupervisorRun({
      appRoot: root,
      workspaceRoot: root,
      dataDir: ".parallel-codex",
      cwd: root,
      request: "private request that still starts"
    }, {
      acquireSubmissionTurn: async () => ({
        release: async () => {
          releaseAttempts += 1;
          throw new Error("unlink denied");
        }
      }),
      launch: async (files) => {
        const state = await readSupervisorRunState(files);
        await writeSupervisorRunState(files, {
          ...state,
          status: "completed",
          updated_at: new Date().toISOString(),
          finished_at: new Date().toISOString(),
          result: { mode: "simple", taskId: null, summary: "done", workers: [] }
        });
      }
    });

    expect(result).toMatchObject({
      reused: false,
      run: { status: "completed" },
      warnings: [expect.stringContaining("lock cleanup failed after 3 attempts: unlink denied")]
    });
    expect(formatSupervisorSubmission(result)).toContain("Run submitted");
    expect(formatSupervisorSubmission(result)).toContain("Warning:");
    expect(JSON.stringify(result)).not.toContain("private request that still starts");
    expect(releaseAttempts).toBe(3);
  });

  it("serializes submission, rejects another active run, and persists startup failure", async () => {
    const activeRoot = join(root, "active");
    const processStartToken = await readProcessStartToken(process.pid);
    await submitSupervisorRun({
      appRoot: activeRoot,
      workspaceRoot: activeRoot,
      dataDir: ".parallel-codex",
      cwd: activeRoot,
      request: "first request"
    }, {
      launch: async (files) => {
        const state = await readSupervisorRunState(files);
        await writeSupervisorRunState(files, {
          ...state,
          status: "running",
          updated_at: new Date().toISOString(),
          pid: process.pid,
          ...(processStartToken ? { process_start_token: processStartToken } : {})
        });
      }
    });
    await expect(submitSupervisorRun({
      appRoot: activeRoot,
      workspaceRoot: activeRoot,
      dataDir: ".parallel-codex",
      cwd: activeRoot,
      request: "second request"
    }, { launch: async () => undefined })).rejects.toThrow("already active in this workspace");

    const failureRoot = join(root, "failure");
    await expect(submitSupervisorRun({
      appRoot: failureRoot,
      workspaceRoot: failureRoot,
      dataDir: ".parallel-codex",
      cwd: failureRoot,
      request: "private failed request"
    }, {
      launch: async () => {
        throw new Error("launcher unavailable");
      }
    })).rejects.toThrow("launcher unavailable");
    const [failed] = await inspectSupervisorRuns(failureRoot, ".parallel-codex").then((value) => value.runs);
    expect(failed).toMatchObject({ status: "failed", control: "settled" });
    expect(JSON.stringify(failed)).not.toContain("private failed request");
    const failedState = await readSupervisorRunState(supervisorRunFiles(join(
      failureRoot,
      ".parallel-codex",
      "supervisor",
      "runs",
      failed!.run_id
    )));
    expect(failedState.error).toBe("launcher unavailable");
    expect(JSON.stringify(failedState)).not.toContain("private failed request");
  });

  it("cancels the latest active run and leaves terminal history untouched", async () => {
    const completedFiles = await createSupervisorRun(root, ".parallel-codex", request(root, "run-completed"));
    const completed = await readSupervisorRunState(completedFiles);
    await writeSupervisorRunState(completedFiles, {
      ...completed,
      status: "completed",
      updated_at: "2026-07-21T00:00:01.000Z",
      finished_at: "2026-07-21T00:00:01.000Z"
    });
    await acknowledgeSupervisorRun(completedFiles);

    const activeFiles = await createSupervisorRun(root, ".parallel-codex", {
      ...request(root, "run-active"),
      created_at: "2026-07-21T00:00:02.000Z"
    });
    const active = await readSupervisorRunState(activeFiles);
    const processStartToken = await readProcessStartToken(process.pid);
    await writeSupervisorRunState(activeFiles, {
      ...active,
      status: "running",
      updated_at: "2026-07-21T00:00:03.000Z",
      pid: process.pid,
      ...(processStartToken ? { process_start_token: processStartToken } : {})
    });

    const result = await requestSupervisorRunCancellation(
      root,
      ".parallel-codex",
      null,
      new Date("2026-07-21T00:00:04.000Z")
    );

    expect(result.run.run_id).toBe("run-active");
    expect(formatSupervisorCancellation(result)).toBe(
      "Cancellation requested · run-active · handle-request"
    );
    expect(await readSupervisorCommands(activeFiles)).toEqual([
      expect.objectContaining({ id: result.command_id, type: "cancel-run" })
    ]);
    expect(await readSupervisorCommands(completedFiles)).toEqual([]);
  });

  it("rejects missing, terminal, and stale cancellation targets", async () => {
    await expect(requestSupervisorRunCancellation(root, ".parallel-codex", "run-missing"))
      .rejects.toThrow("Supervisor run not found: run-missing");

    const files = await createSupervisorRun(root, ".parallel-codex", request(root, "run-stale"));
    const state = await readSupervisorRunState(files);
    await writeSupervisorRunState(files, {
      ...state,
      status: "running",
      updated_at: "2026-07-20T00:00:00.000Z",
      pid: 2147483647
    });
    await expect(requestSupervisorRunCancellation(
      root,
      ".parallel-codex",
      "run-stale",
      new Date("2026-07-21T00:00:00.000Z")
    )).rejects.toThrow("Supervisor run is not active: run-stale (running)");

    await writeSupervisorRunState(files, {
      ...state,
      status: "cancelled",
      updated_at: "2026-07-21T00:00:01.000Z",
      finished_at: "2026-07-21T00:00:01.000Z"
    });
    await expect(requestSupervisorRunCancellation(root, ".parallel-codex", "run-stale"))
      .rejects.toThrow("Supervisor run is already cancelled: run-stale");
  });

  it("waits for a live run to finish without reading its private request or writing commands", async () => {
    const files = await createSupervisorRun(root, ".parallel-codex", request(root, "run-wait-complete"));
    const initial = await readSupervisorRunState(files);
    const processStartToken = await readProcessStartToken(process.pid);
    await writeSupervisorRunState(files, {
      ...initial,
      status: "running",
      updated_at: "2026-07-21T00:00:01.000Z",
      pid: process.pid,
      ...(processStartToken ? { process_start_token: processStartToken } : {})
    });
    const completion = delay(30).then(() => writeSupervisorRunState(files, {
      ...initial,
      status: "completed",
      updated_at: "2026-07-21T00:00:02.000Z",
      finished_at: "2026-07-21T00:00:02.000Z"
    }));

    const result = await waitForSupervisorRun(root, ".parallel-codex", "run-wait-complete", {
      timeoutMs: 1000,
      pollIntervalMs: 10
    });
    await completion;

    expect(result).toMatchObject({
      version: 1,
      outcome: "completed",
      run: { run_id: "run-wait-complete", status: "completed", control: "settled" }
    });
    expect(result.waited_ms).toBeGreaterThanOrEqual(20);
    expect(supervisorWaitExitCode(result.outcome)).toBe(0);
    expect(formatSupervisorWait(result)).toContain("Run completed · run-wait-complete");
    expect(JSON.stringify(result)).not.toContain("private request text");
    expect(await readSupervisorCommands(files)).toEqual([]);
  });

  it("times out without cancelling a live run", async () => {
    const files = await createSupervisorRun(root, ".parallel-codex", request(root, "run-wait-timeout"));
    const initial = await readSupervisorRunState(files);
    const processStartToken = await readProcessStartToken(process.pid);
    await writeSupervisorRunState(files, {
      ...initial,
      status: "running",
      updated_at: "2026-07-21T00:00:01.000Z",
      pid: process.pid,
      ...(processStartToken ? { process_start_token: processStartToken } : {})
    });

    const result = await waitForSupervisorRun(root, ".parallel-codex", null, {
      timeoutMs: 30,
      pollIntervalMs: 10
    });

    expect(result).toMatchObject({
      outcome: "timeout",
      run: { run_id: "run-wait-timeout", status: "running" }
    });
    expect(supervisorWaitExitCode(result.outcome)).toBe(4);
    expect(await readSupervisorCommands(files)).toEqual([]);
  });

  it("reports stale and cancelled wait outcomes with distinct exit codes", async () => {
    await expect(waitForSupervisorRun(root, ".parallel-codex", "run-missing"))
      .rejects.toThrow("Supervisor run not found: run-missing");

    const files = await createSupervisorRun(root, ".parallel-codex", request(root, "run-wait-stale"));
    const initial = await readSupervisorRunState(files);
    await writeSupervisorRunState(files, {
      ...initial,
      status: "running",
      updated_at: "2026-07-20T00:00:00.000Z",
      pid: 2147483647
    });
    const stale = await waitForSupervisorRun(root, ".parallel-codex", "run-wait-stale");
    expect(stale.outcome).toBe("stale");
    expect(supervisorWaitExitCode(stale.outcome)).toBe(3);

    await writeSupervisorRunState(files, {
      ...initial,
      status: "cancelled",
      updated_at: "2026-07-21T00:00:01.000Z",
      finished_at: "2026-07-21T00:00:01.000Z"
    });
    const cancelled = await waitForSupervisorRun(root, ".parallel-codex", "run-wait-stale");
    expect(cancelled.outcome).toBe("cancelled");
    expect(supervisorWaitExitCode(cancelled.outcome)).toBe(2);
    expect(supervisorWaitExitCode("failed")).toBe(1);
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
    created_at: "2026-07-21T00:00:00.000Z",
    request: "private request text",
    cwd: root
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
