import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const failures = vi.hoisted(() => ({
  clearOwnership: false,
  finalStatus: false,
  output: false
}));

vi.mock("../src/core/file-store.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/file-store.js")>("../src/core/file-store.js");
  return {
    ...actual,
    appendText: vi.fn(async (path: string, value: string) => {
      if (failures.output && value === "persist me\n") {
        throw new Error("worker output disk unavailable");
      }
      await actual.appendText(path, value);
    }),
    writeJson: vi.fn(async (path: string, value: unknown) => {
      if (
        failures.finalStatus
        && value !== null
        && typeof value === "object"
        && (value as Record<string, unknown>).state === "done"
      ) {
        throw new Error("final status disk unavailable");
      }
      await actual.writeJson(path, value);
    })
  };
});

vi.mock("../src/core/process-ownership.js", async () => {
  const actual = await vi.importActual<typeof import("../src/core/process-ownership.js")>(
    "../src/core/process-ownership.js"
  );
  return {
    ...actual,
    clearWorkerProcessRecord: vi.fn(async (workerDir: string) => {
      if (failures.clearOwnership) {
        throw new Error("ownership cleanup disk unavailable");
      }
      await actual.clearWorkerProcessRecord(workerDir);
    })
  };
});

import { pathExists, readJson, readTextIfExists, writeText } from "../src/core/file-store.js";
import { processIsAlive, workerProcessRecordPath } from "../src/core/process-ownership.js";
import { WorkerStatusSchema } from "../src/domain/schemas.js";
import { ProcessWorkerAdapter } from "../src/workers/process-adapter.js";

describe("ProcessWorkerAdapter finalization failures", () => {
  beforeEach(() => {
    failures.clearOwnership = false;
    failures.finalStatus = false;
    failures.output = false;
  });

  it("rejects when Worker output cannot be persisted", async () => {
    failures.output = true;
    const fixture = await createFixture(
      "output",
      "console.log('persist me');setInterval(() => {}, 1000)",
      10_000
    );

    await expect(fixture.run()).rejects.toThrow("worker output disk unavailable");
    const processRecordPath = workerProcessRecordPath(fixture.filesDir);
    expect(await pathExists(processRecordPath)).toBe(true);
    const processRecord = JSON.parse(await readTextIfExists(processRecordPath)) as { pid: number };
    expect(processIsAlive(processRecord.pid)).toBe(false);
    await expect(readJson(fixture.statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "failed",
      phase: "process-finalization-error"
    });
  }, 3000);

  it("rejects when the terminal Worker status cannot be persisted", async () => {
    failures.finalStatus = true;
    const fixture = await createFixture("status", "process.exit(0)");

    await expect(fixture.run()).rejects.toThrow("final status disk unavailable");
    expect(await pathExists(workerProcessRecordPath(fixture.filesDir))).toBe(true);
    await expect(readJson(fixture.statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "failed",
      phase: "process-finalization-error"
    });
  }, 3000);

  it("rejects and retains ownership when process record removal fails", async () => {
    failures.clearOwnership = true;
    const fixture = await createFixture("ownership", "process.exit(0)");

    await expect(fixture.run()).rejects.toThrow("ownership cleanup disk unavailable");
    expect(await pathExists(workerProcessRecordPath(fixture.filesDir))).toBe(true);
    await expect(readJson(fixture.statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "failed",
      phase: "process-finalization-error"
    });
  }, 3000);

  it("rejects when native-session persistence callback fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-process-finalize-native-session-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    await writeText(promptPath, "detect session");
    const adapter = new ProcessWorkerAdapter(
      process.execPath,
      ["-e", "console.log('session id: callback-123');setInterval(() => {}, 1000)"]
    );

    await expect(adapter.run({
      workerId: "actor-finalize-native-session",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "detect session",
      timeoutMs: 2000,
      nativeSessionConfig: {
        enabled: true,
        resumeArgs: [],
        detectSessionId: true,
        fallback: "fail"
      },
      onNativeSession: () => {
        throw new Error("native session index unavailable");
      }
    })).rejects.toThrow("native session index unavailable");
    expect(await pathExists(workerProcessRecordPath(filesDir))).toBe(true);
    await expect(readJson(statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "failed",
      phase: "process-finalization-error"
    });
  }, 3000);

  it("does not emit an unhandled rejection when spawn-error cleanup fails", async () => {
    failures.clearOwnership = true;
    const root = await mkdtemp(join(tmpdir(), "pct-process-finalize-spawn-error-"));
    const filesDir = join(root, "actor-mock");
    const promptPath = join(filesDir, "prompt.md");
    const outputLogPath = join(filesDir, "output.log");
    const statusPath = join(filesDir, "status.json");
    await writeText(promptPath, "cannot spawn");
    const adapter = new ProcessWorkerAdapter("pct-command-that-does-not-exist", []);

    await expect(adapter.run({
      workerId: "actor-finalize-spawn-error",
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "cannot spawn",
      timeoutMs: 2000
    })).rejects.toThrow("ownership cleanup disk unavailable");
    await expect(readJson(statusPath, WorkerStatusSchema)).resolves.toMatchObject({
      state: "failed",
      phase: "process-finalization-error"
    });
  }, 3000);
});

async function createFixture(label: string, script: string, timeoutMs = 2000): Promise<{
  filesDir: string;
  statusPath: string;
  run(): ReturnType<ProcessWorkerAdapter["run"]>;
}> {
  const root = await mkdtemp(join(tmpdir(), `pct-process-finalize-${label}-`));
  const filesDir = join(root, "actor-mock");
  const promptPath = join(filesDir, "prompt.md");
  const outputLogPath = join(filesDir, "output.log");
  const statusPath = join(filesDir, "status.json");
  await writeText(promptPath, "finalize safely");
  const adapter = new ProcessWorkerAdapter(process.execPath, ["-e", script]);

  return {
    filesDir,
    statusPath,
    run: () => adapter.run({
      workerId: `actor-finalize-${label}`,
      role: "actor",
      engine: "mock",
      cwd: root,
      filesDir,
      promptPath,
      outputLogPath,
      statusPath,
      prompt: "finalize safely",
      timeoutMs
    })
  };
}
