import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionManager } from "../src/core/session-manager.js";
import type { Orchestrator } from "../src/orchestrator/orchestrator.js";
import {
  isSupervisorDetachedError,
  SupervisorOrchestrator,
  type SupervisorLauncher
} from "../src/supervisor/client.js";
import type { SupervisorSubmissionTurnAcquirer } from "../src/supervisor/launcher.js";
import type { SupervisorRunRequest } from "../src/supervisor/protocol.js";
import {
  appendSupervisorEvent,
  createSupervisorRun,
  listSupervisorRuns,
  readSupervisorRunState,
  supervisorRunIsAcknowledged,
  writeSupervisorRunState
} from "../src/supervisor/store.js";

describe("SupervisorOrchestrator", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pct-supervisor-client-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("streams persisted callbacks and returns the terminal result", async () => {
    const statuses: string[] = [];
    const routes: string[] = [];
    const client = await createClient(async (files) => {
      const state = await readSupervisorRunState(files);
      await writeSupervisorRunState(files, {
        ...state,
        status: "running",
        updated_at: "2026-07-21T00:00:01.000Z",
        started_at: "2026-07-21T00:00:01.000Z",
        pid: process.pid
      });
      await appendSupervisorEvent(files, {
        version: 1,
        sequence: 0,
        at: "2026-07-21T00:00:02.000Z",
        type: "route",
        payload: { mode: "simple", reason: "test route", source: "forced" }
      });
      await appendSupervisorEvent(files, {
        version: 1,
        sequence: 1,
        at: "2026-07-21T00:00:03.000Z",
        type: "status",
        payload: { taskId: "main", main: "done" }
      });
      await writeSupervisorRunState(files, {
        ...state,
        status: "completed",
        updated_at: "2026-07-21T00:00:04.000Z",
        finished_at: "2026-07-21T00:00:04.000Z",
        result: {
          mode: "simple",
          taskId: null,
          summary: "ready",
          workers: []
        }
      });
    });

    const result = await client.handleRequest({
      request: "hello",
      cwd: root,
      onRoute: (route) => routes.push(route.reason),
      onStatus: (status) => statuses.push(status.main ?? "")
    });

    expect(result.summary).toBe("ready");
    expect(routes).toEqual(["test route"]);
    expect(statuses).toEqual(["done"]);
    await client.acknowledgeBackgroundRun();
    const runs = await listSupervisorRuns(root, ".parallel-codex");
    expect(await supervisorRunIsAcknowledged(runs[0]!.files)).toBe(true);
  });

  it("restores an unacknowledged completed run after reopening", async () => {
    const request = requestRecord(root, "run-restored");
    const files = await createSupervisorRun(root, ".parallel-codex", request);
    const state = await readSupervisorRunState(files);
    await writeSupervisorRunState(files, {
      ...state,
      status: "completed",
      updated_at: "2026-07-21T00:00:05.000Z",
      finished_at: "2026-07-21T00:00:05.000Z",
      result: { mode: "simple", taskId: null, summary: "restored", workers: [] }
    });

    const client = await createClient(async () => {
      throw new Error("completed runs must not relaunch");
    });
    await expect(client.restorePendingRun({ cwd: root })).resolves.toMatchObject({ summary: "restored" });
    await client.acknowledgeBackgroundRun();
    expect(await supervisorRunIsAcknowledged(files)).toBe(true);
  });

  it("detaches its watcher without cancelling the background process", async () => {
    let launchedFiles: Parameters<SupervisorLauncher>[0] | null = null;
    const client = await createClient(async (files) => {
      launchedFiles = files;
      const state = await readSupervisorRunState(files);
      await writeSupervisorRunState(files, {
        ...state,
        status: "running",
        updated_at: "2026-07-21T00:00:01.000Z",
        started_at: "2026-07-21T00:00:01.000Z",
        pid: process.pid
      });
    });

    const pending = client.handleRequest({ request: "long task", cwd: root });
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.detachBackgroundRuns();
    await expect(pending).rejects.toSatisfy(isSupervisorDetachedError);
    expect(launchedFiles).not.toBeNull();
    expect((await readSupervisorRunState(launchedFiles!)).status).toBe("running");
  });

  it("keeps watching a successful run when submission lock cleanup fails", async () => {
    let releaseAttempts = 0;
    const appendChatMessage = vi.fn(async () => undefined);
    const client = await createClient(async (files) => {
      const state = await readSupervisorRunState(files);
      await writeSupervisorRunState(files, {
        ...state,
        status: "completed",
        updated_at: "2026-07-21T00:00:04.000Z",
        finished_at: "2026-07-21T00:00:04.000Z",
        result: { mode: "simple", taskId: null, summary: "still observed", workers: [] }
      });
    }, {
      appendChatMessage,
      acquireSubmissionTurn: async () => ({
        release: async () => {
          releaseAttempts += 1;
          throw new Error("lock unlink denied");
        }
      })
    });

    await expect(client.handleRequest({ request: "hello", cwd: root }))
      .resolves.toMatchObject({ summary: "still observed" });
    expect(releaseAttempts).toBe(3);
    expect(appendChatMessage).toHaveBeenCalledWith(expect.objectContaining({
      from: "system",
      text: expect.stringContaining("lock cleanup failed after 3 attempts: lock unlink denied")
    }));
  });

  async function createClient(
    launch: SupervisorLauncher,
    overrides: {
      acquireSubmissionTurn?: SupervisorSubmissionTurnAcquirer;
      appendChatMessage?: ReturnType<typeof vi.fn>;
    } = {}
  ): Promise<SupervisorOrchestrator> {
    return SupervisorOrchestrator.open({
      delegate: {
        routeInitialRequest: vi.fn(async () => ({
          mode: "simple",
          taskId: null,
          reason: "test route",
          route: { mode: "simple", reason: "test route", source: "forced" },
          roleSelection: {
            main: { engine: "mock", model: "" },
            judge: { engine: "mock", model: "" },
            actor: { engine: "mock", model: "" },
            critic: { engine: "mock", model: "" }
          }
        }))
      } as unknown as Orchestrator,
      sessions: { appendChatMessage: overrides.appendChatMessage ?? vi.fn() } as unknown as SessionManager,
      appRoot: root,
      workspaceRoot: root,
      dataDir: ".parallel-codex",
      acquireSubmissionTurn: overrides.acquireSubmissionTurn,
      launch
    });
  }
});

function requestRecord(root: string, runId: string): SupervisorRunRequest {
  return {
    version: 1,
    run_id: runId,
    kind: "handle-request",
    app_root: root,
    workspace_root: root,
    data_dir: ".parallel-codex",
    created_at: "2026-07-21T00:00:00.000Z",
    request: "hello",
    cwd: root
  };
}
