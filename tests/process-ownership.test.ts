import { mkdtemp, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { pathExists, writeJson, writeText } from "../src/core/file-store.js";
import {
  claimTaskRunLease,
  clearStaleTaskRunLease,
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

  it("elects exactly one owner while concurrently replacing a corrupt lease", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "pct-corrupt-task-lease-race-"));
    await writeText(join(taskDir, "run-owner.json"), "{");

    const settled = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => (
        claimTaskRunLease(taskDir, { ownerId: `candidate-${String(index).padStart(2, "0")}` })
      ))
    );
    const fulfilled = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const rejected = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    expect(rejected.every((error) => error instanceof TaskRunLeaseConflictError)).toBe(true);
    const winner = fulfilled[0];
    if (!winner) {
      throw new Error("Concurrent lease election produced no winner");
    }
    await expect(inspectTaskRunLease(taskDir)).resolves.toMatchObject({
      state: "active",
      owner: { owner_id: winner.owner.owner_id }
    });
    await expectClaimIntentsCleared(taskDir);

    await winner.release();
    await expect(inspectTaskRunLease(taskDir)).resolves.toEqual({ state: "missing", owner: null });
    await expectClaimIntentsCleared(taskDir);
  });

  it("elects exactly one owner while concurrently replacing a dead lease", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "pct-dead-task-lease-race-"));
    await writeJson(join(taskDir, "run-owner.json"), {
      version: 1,
      owner_id: "dead-owner",
      pid: 2147483647,
      acquired_at: "2026-07-11T14:00:00.000Z",
      process_start_token: "dead-token"
    });

    const settled = await Promise.allSettled(
      Array.from({ length: 12 }, (_, index) => (
        claimTaskRunLease(taskDir, { ownerId: `replacement-${String(index).padStart(2, "0")}` })
      ))
    );
    const fulfilled = settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    const rejected = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(11);
    expect(rejected.every((error) => error instanceof TaskRunLeaseConflictError)).toBe(true);
    const winner = fulfilled[0];
    if (!winner) {
      throw new Error("Concurrent dead lease recovery produced no winner");
    }
    await expect(inspectTaskRunLease(taskDir)).resolves.toMatchObject({
      state: "active",
      owner: { owner_id: winner.owner.owner_id }
    });
    await expectClaimIntentsCleared(taskDir);

    await winner.release();
    await expect(inspectTaskRunLease(taskDir)).resolves.toEqual({ state: "missing", owner: null });
    await expectClaimIntentsCleared(taskDir);
  });

  it("never clears a live task lease through stale cleanup", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "pct-live-task-lease-cleanup-"));
    const lease = await claimTaskRunLease(taskDir, { ownerId: "live-owner" });

    await clearStaleTaskRunLease(taskDir);

    await expect(inspectTaskRunLease(taskDir)).resolves.toMatchObject({
      state: "active",
      owner: { owner_id: "live-owner" }
    });
    await expectClaimIntentsCleared(taskDir);
    await lease.release();
  });

  it("removes an abandoned claim intent before taking ownership", async () => {
    const taskDir = await mkdtemp(join(tmpdir(), "pct-abandoned-task-claim-"));
    await writeJson(join(taskDir, ".run-owner-claim-abandoned.json"), {
      version: 1,
      intent_id: "abandoned",
      pid: 2147483647,
      created_at: "2026-07-11T14:00:00.000Z",
      choosing: false,
      ticket: 1,
      process_start_token: "dead-token"
    });

    const lease = await claimTaskRunLease(taskDir, { ownerId: "recovered-owner" });

    await expect(inspectTaskRunLease(taskDir)).resolves.toMatchObject({
      state: "active",
      owner: { owner_id: "recovered-owner" }
    });
    await expectClaimIntentsCleared(taskDir);
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

  it("terminates an owned process group after its recorded leader already exited", async () => {
    if (process.platform === "win32") {
      return;
    }
    const workerDir = await mkdtemp(join(tmpdir(), "pct-worker-orphan-group-"));
    const parent = spawn(process.execPath, [
      "-e",
      [
        "const {spawn}=require('node:child_process');",
        "const child=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});",
        "console.log(child.pid);",
        "setTimeout(()=>process.exit(0),800);"
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
      await waitForStopped(parentPid);
      expect(processIsAlive(childPid)).toBe(true);

      await expect(terminateOwnedWorkerProcess(workerDir)).resolves.toBe("terminated");
      await waitForStopped(childPid);
      expect(await pathExists(workerProcessRecordPath(workerDir))).toBe(false);
    } finally {
      try {
        process.kill(-parentPid, "SIGKILL");
      } catch {
        // The process group is expected to be gone.
      }
    }
  }, 6000);

  it("reports a worker that remains alive after both termination signals", async () => {
    const workerDir = await mkdtemp(join(tmpdir(), "pct-worker-still-running-"));
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {
      stdio: "ignore"
    });
    const childPid = child.pid ?? 0;
    await writeWorkerProcessRecord(workerDir, {
      workerId: "actor-codex",
      pid: childPid,
      command: process.execPath
    });
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (signal === 0) {
        return originalKill(pid, 0);
      }
      return true;
    });

    try {
      await expect(terminateOwnedWorkerProcess(workerDir)).resolves.toBe("still-running");
      expect(processIsAlive(childPid)).toBe(true);
      expect(await pathExists(workerProcessRecordPath(workerDir))).toBe(true);
    } finally {
      killSpy.mockRestore();
      child.kill("SIGKILL");
      await waitForStopped(childPid);
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

async function expectClaimIntentsCleared(taskDir: string): Promise<void> {
  const names = await readdir(taskDir);
  expect(names.filter((name) => name.startsWith(".run-owner-claim-"))).toEqual([]);
}
