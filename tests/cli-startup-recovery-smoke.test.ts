import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { createRuntime } from "../src/bootstrap.js";
import { readJson, readTextIfExists, writeJson } from "../src/core/file-store.js";
import { TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI startup recovery smoke", () => {
  it("marks an ownerless running task retryable and explains the recovery", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-recovery-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-recovery-workspace-"));
    const initial = await createRuntime(appRoot, workspace);
    const task = await initial.sessions.createTask({
      request: "实现启动恢复",
      cwd: workspace,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    await initial.sessions.updateTaskStatus(task, "actor_running");
    const worker = await initial.sessions.initializeWorker(task, {
      workerId: "actor-mock",
      role: "actor",
      engine: "mock",
      prompt: "continue working"
    });
    await writeJson(worker.statusPath, {
      worker_id: worker.workerId,
      role: "actor",
      engine: "mock",
      state: "running",
      phase: "process-output",
      last_event_at: "2026-07-11T14:00:00.000Z",
      summary: "still working"
    });
    initial.index.close();

    const screen = new NativeTerminalScreen({ cols: 100, rows: 20, scrollback: 500 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 20,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );
    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "Recovered interrupted task");
      await waitForScreenText(() => screenWrites, screen, "checkpoints kept · Ctrl+R resume");
      await waitForScreenText(() => screenWrites, screen, "^R retry");
      await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });
      await expect(readJson(worker.statusPath, WorkerStatusSchema)).resolves.toMatchObject({
        state: "cancelled",
        phase: "orphaned-after-restart"
      });
      expect(await readTextIfExists(join(workspace, ".parallel-codex", "sessions", "main", "chat.jsonl")))
        .not.toContain("Recovered interrupted task");

      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 12000);

  it("explains an incomplete legacy done task as completion recovery", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-incomplete-done-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-incomplete-done-workspace-"));
    const initial = await createRuntime(appRoot, workspace);
    const task = await initial.sessions.createTask({
      request: "实现完成证据恢复",
      cwd: workspace,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const meta = await readJson(task.metaPath, TaskMetaSchema);
    await writeJson(join(task.dir, "workspaces", "turn-0001", "wave-0001", "integration.json"), {
      version: 1,
      state: "integrated",
      changed_paths: []
    });
    await writeJson(task.metaPath, { ...meta, status: "done" });
    initial.index.close();

    const screen = new NativeTerminalScreen({ cols: 100, rows: 20, scrollback: 500 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 20,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );
    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "Recovered incomplete task");
      await waitForScreenText(() => screenWrites, screen, "completion evidence missing");
      await waitForScreenText(() => screenWrites, screen, "checkpoints kept · Ctrl+R");
      await waitForScreenText(() => screenWrites, screen, "rebuild");
      await waitForScreenText(() => screenWrites, screen, "^R retry");
      await expect(readJson(task.metaPath, TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });

      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 12000);
});

async function waitForScreenText(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await screenWritesRef();
    if (screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text}\nSnapshot:\n${screen.snapshot()}`);
}

async function waitForExit(exits: number[]): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (exits.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for TUI exit");
}
