import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acknowledgeSupervisorRun,
  appendSupervisorCommand,
  appendSupervisorEvent,
  claimSupervisorController,
  createSupervisorRun,
  listSupervisorRuns,
  readSupervisorCommands,
  readSupervisorEvents,
  readSupervisorRunRequest,
  readSupervisorRunState,
  supervisorRunIsAcknowledged
} from "../src/supervisor/store.js";
import type { SupervisorRunRequest } from "../src/supervisor/protocol.js";

describe("Supervisor store", () => {
  let root = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pct-supervisor-store-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("persists a run, ordered events, commands, and acknowledgement", async () => {
    const request = simpleRequest(root, "run-test");
    const files = await createSupervisorRun(root, ".parallel-codex", request);

    expect(await readSupervisorRunRequest(files)).toEqual(request);
    expect(await readSupervisorRunState(files)).toMatchObject({
      run_id: "run-test",
      status: "queued",
      kind: "handle-request"
    });

    await appendSupervisorEvent(files, {
      version: 1,
      sequence: 0,
      at: "2026-07-21T00:00:01.000Z",
      type: "status",
      payload: { taskId: "main", main: "starting" }
    });
    await appendSupervisorCommand(files, {
      version: 1,
      id: "command-1",
      at: "2026-07-21T00:00:02.000Z",
      type: "cancel-run"
    });

    expect(await readSupervisorEvents(files)).toHaveLength(1);
    expect(await readSupervisorCommands(files)).toHaveLength(1);
    expect(await supervisorRunIsAcknowledged(files)).toBe(false);
    await acknowledgeSupervisorRun(files);
    expect(await supervisorRunIsAcknowledged(files)).toBe(true);
    expect((await listSupervisorRuns(root, ".parallel-codex"))[0]?.state.run_id).toBe("run-test");
  });

  it("allows only one live TUI controller and releases ownership explicitly", async () => {
    const files = await createSupervisorRun(root, ".parallel-codex", simpleRequest(root, "run-control"));
    const first = await claimSupervisorController(files, { controllerId: "first" });
    expect(first?.owner.controller_id).toBe("first");
    expect(await claimSupervisorController(files, { controllerId: "second" })).toBeNull();

    await first?.release();
    const second = await claimSupervisorController(files, { controllerId: "second" });
    expect(second?.owner.controller_id).toBe("second");
    await second?.release();
  });
});

function simpleRequest(root: string, runId: string): SupervisorRunRequest {
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
