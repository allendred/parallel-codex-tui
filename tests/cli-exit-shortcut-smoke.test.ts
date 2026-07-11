import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { pathExists, writeJson } from "../src/core/file-store.js";
import { TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI exit shortcuts", () => {
  it("gracefully terminates an active worker before exiting on SIGINT", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-active-sigint-workspace-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-active-sigint-app-"));
    const workerScript = join(appRoot, "sigint-worker.cjs");
    const workerPidPath = join(appRoot, "worker.pid");
    const terminatedPath = join(appRoot, "worker-terminated");
    const survivedPath = join(appRoot, "worker-survived");
    const exits: number[] = [];
    const chunks: string[] = [];

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(workerScript, [
      "const { writeFileSync } = require('node:fs');",
      `writeFileSync(${JSON.stringify(workerPidPath)}, String(process.pid));`,
      `process.on('SIGTERM', () => { writeFileSync(${JSON.stringify(terminatedPath)}, 'terminated'); process.exit(0); });`,
      `setTimeout(() => writeFileSync(${JSON.stringify(survivedPath)}, 'survived'), 1200);`,
      "setInterval(() => {}, 1000);"
    ].join(""));
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "complex"',
        "",
        "[workers.codex]",
        `command = "${escapeToml(process.execPath)}"`,
        `args = ["${escapeToml(workerScript)}"]`,
        "timeoutMs = 10000",
        "idleTimeoutMs = 10000",
        "firstOutputTimeoutMs = 3000",
        "",
        "[workers.codex.nativeSession]",
        "enabled = false",
        "",
        "[pairing]",
        'main = "codex"',
        'judge = "codex"',
        'actor = "codex"',
        'critic = "codex"'
      ].join("\n") + "\n"
    );

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 90,
        rows: 20,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );
    child.onData((chunk) => chunks.push(chunk));
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForText(chunks, "message");
      child.write("run until interrupted\r");
      await waitForPath(workerPidPath);
      child.kill("SIGINT");
      await waitForExit(exits);
      await waitForPath(terminatedPath);
      await new Promise((resolve) => setTimeout(resolve, 1300));

      expect(exits[0]).toBe(0);
      expect(await pathExists(survivedPath)).toBe(false);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
      const workerPid = Number.parseInt(await readFile(workerPidPath, "utf8").catch(() => ""), 10);
      if (Number.isInteger(workerPid) && workerPid > 0) {
        try {
          process.kill(-workerPid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      }
    }
  }, 15000);

  it("exits cleanly when the terminal delivers SIGINT between raw-mode transitions", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-sigint-exit-"));
    const exits: number[] = [];
    const chunks: string[] = [];
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 18,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );
    child.onData((chunk) => chunks.push(chunk));
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForText(chunks, "message");
      child.kill("SIGINT");
      await waitForExit(exits);

      expect(exits[0]).toBe(0);
      expect(chunks.join("")).toContain("\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?25h");
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 10000);

  it("exits the outer TUI on ctrl-c from the worker log view", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-exit-"));
    const taskId = "task-20260703-000000-exit";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const chunks: string[] = [];
    const exits: number[] = [];
    const screen = new NativeTerminalScreen({ cols: 140, rows: 24, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 140,
        rows: 24,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );

    child.onData((chunk) => {
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForText(chunks, "attach");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "logs · scroll");
      child.write("\x03");
      await waitForExit(exits);

      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 10000);
});

async function writeTaskFiles(input: {
  workspace: string;
  taskId: string;
  taskDir: string;
  workerDir: string;
}): Promise<void> {
  await writeJson(
    join(input.taskDir, "meta.json"),
    TaskMetaSchema.parse({
      id: input.taskId,
      title: "exit smoke",
      created_at: "2026-07-03T00:00:00.000Z",
      cwd: input.workspace,
      mode: "complex",
      status: "done"
    })
  );
  await writeJson(
    join(input.workerDir, "status.json"),
    WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-07-03T00:00:00.000Z",
      summary: "ready"
    })
  );
  await writeFile(join(input.workerDir, "output.log"), "ready\n");
}

async function waitForText(chunks: string[], text: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (chunks.join("").includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text}\nOutput:\n${chunks.join("")}`);
}

async function waitForExit(exits: number[]): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (exits.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for TUI to exit");
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    if (await pathExists(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function waitForScreenText(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await screenWritesRef();
    if (screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for screen text ${text}\nSnapshot:\n${screen.snapshot()}`);
}
