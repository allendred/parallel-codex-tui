import { mkdtemp } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pathExists, writeJson } from "../src/core/file-store.js";
import {
  claimTaskRunLease,
  inspectTaskRunLease,
  processIsAlive,
  TaskRunLeaseConflictError,
  terminateOwnedWorkerProcess,
  workerProcessRecordPath,
  writeWorkerProcessRecord
} from "../src/core/process-ownership.js";

describe("process ownership", () => {
  it("prevents a second live owner from claiming the same task", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "pct-task-lease-"));
    const lease = await claimTaskRunLease(taskDir, { ownerId: "owner-one" });

    await expect(inspectTaskRunLease(taskDir)).resolves.toMatchObject({ state: "active" });
    const conflict = await claimTaskRunLease(taskDir, { ownerId: "owner-two" }).catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(TaskRunLeaseConflictError);
    expect(conflict).toMatchObject({
      name: "TaskRunLeaseConflictError",
      owner: { owner_id: "owner-one", pid: process.pid }
    });
    expect((conflict as Error).message).toContain("Task is already running in another parallel-codex-tui process");

    await lease.release();
    await expect(inspectTaskRunLease(taskDir)).resolves.toEqual({ state: "missing", owner: null });
  });

  it("reclaims a lease whose recorded owner process is gone", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "pct-stale-task-lease-"));
    await writeJson(join(taskDir, "run-owner.json"), {
      version: 1,
      owner_id: "dead-owner",
      pid: 2147483647,
      acquired_at: "2026-07-11T14:00:00.000Z",
      process_start_token: "dead-token"
    });

    const lease = await claimTaskRunLease(taskDir, { ownerId: "replacement-owner" });

    await expect(inspectTaskRunLease(taskDir)).resolves.toMatchObject({
      state: "active",
      owner: { owner_id: "replacement-owner", pid: process.pid }
    });
    await lease.release();
  });

  it("refuses to terminate a reused PID when its process fingerprint differs", async () => {
    const workerDir = await mkdtemp(join(tmpdir(), "pct-worker-process-"));
    await writeJson(workerProcessRecordPath(workerDir), {
      version: 1,
      worker_id: "actor-codex",
      pid: process.pid,
      process_start_token: "different-process",
      owner_pid: 2147483647,
      command: "codex",
      started_at: "2026-07-11T14:00:00.000Z"
    });

    await expect(terminateOwnedWorkerProcess(workerDir)).resolves.toBe("identity-mismatch");
    expect(await pathExists(workerProcessRecordPath(workerDir))).toBe(true);
  });

  it("records and clears a worker process that has already exited", async () => {
    const workerDir = await mkdtemp(join(tmpdir(), "pct-finished-worker-process-"));
    await writeWorkerProcessRecord(workerDir, {
      workerId: "actor-codex",
      pid: 2147483647,
      command: "codex"
    });

    await expect(terminateOwnedWorkerProcess(workerDir)).resolves.toBe("not-running");
    expect(await pathExists(workerProcessRecordPath(workerDir))).toBe(false);
  });

  it("terminates descendants that remain after the process-group leader exits", async () => {
    if (process.platform === "win32") {
      return;
    }
    const workerDir = await mkdtemp(join(tmpdir(), "pct-worker-process-group-"));
    const parent = spawn(process.execPath, [
      "-e",
      [
        "const {spawn}=require('node:child_process');",
        "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});process.send?.('ready');setInterval(()=>{},1000)\"],{stdio:['ignore','ignore','ignore','ipc']});",
        "child.once('message',()=>console.log(child.pid));",
        "setInterval(()=>{},1000);"
      ].join("")
    ], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const parentPid = parent.pid ?? 0;
    const childPid = await readFirstPid(parent);
    await writeWorkerProcessRecord(workerDir, {
      workerId: "actor-codex",
      pid: parentPid,
      processGroupId: parentPid,
      command: process.execPath
    });

    try {
      await expect(terminateOwnedWorkerProcess(workerDir)).resolves.toBe("terminated");
      await waitForStopped(childPid);
      expect(processIsAlive(parentPid)).toBe(false);
      expect(processIsAlive(childPid)).toBe(false);
    } finally {
      try {
        process.kill(-parentPid, "SIGKILL");
      } catch {
        // The process group is expected to be gone.
      }
    }
  }, 5000);
});

async function readFirstPid(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for child pid")), 2000);
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString("utf8");
      const pid = Number(output.trim().split(/\s+/)[0]);
      if (Number.isInteger(pid) && pid > 0) {
        clearTimeout(timeout);
        resolve(pid);
      }
    });
    child.once("error", reject);
  });
}

async function waitForStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!processIsAlive(pid)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Process ${pid} did not stop`);
}
