import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { ChatRecordSchema } from "../src/domain/schemas.js";
import { readSupervisorRunState, supervisorRunFiles } from "../src/supervisor/store.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI Supervisor detach smoke", () => {
  it("keeps work alive after Ctrl+C and restores the completed answer on reopen", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-workspace-"));
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "simple"',
        "",
        "[pairing]",
        'main = "mock"',
        'judge = "mock"',
        'actor = "mock"',
        'critic = "mock"',
        "",
        "[workers.mock.model.env]",
        'PCT_MOCK_DELAY_MS = "1200"',
        ""
      ].join("\n"),
      "utf8"
    );

    const first = startCli(appRoot, workspace);
    try {
      await waitForScreenText(first, "> | message");
      first.child.write("detached supervisor marker\r");
      await waitForScreenText(first, "working");
      const runDir = await latestRunDir(workspace);
      first.child.write("\x03");
      await waitForExit(first.exits);
      expect(first.exits[0]).toBe(0);

      expect((await readSupervisorRunState(supervisorRunFiles(runDir))).status).not.toMatch(/completed|failed|cancelled/);
      await waitForSupervisorStatus(runDir, "completed");
      await waitForChatText(workspace, "Mock simple response for: detached supervisor marker");

      const second = startCli(appRoot, workspace);
      try {
        await waitForScreenText(second, "Mock simple response for: detached supervisor marker");
        await waitForFile(join(runDir, "acknowledged.json"));
        second.child.write("\x03");
        await waitForExit(second.exits);
        expect(second.exits[0]).toBe(0);
      } finally {
        stopCli(second);
      }
    } finally {
      stopCli(first);
      await rm(appRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30000);

  it("continues a complex Worker run after the outer TUI exits", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-complex-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-complex-workspace-"));
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "complex"',
        "",
        "[pairing]",
        'main = "mock"',
        'judge = "mock"',
        'actor = "mock"',
        'critic = "mock"',
        "",
        "[workers.mock.model.env]",
        'PCT_MOCK_DELAY_MS = "250"',
        ""
      ].join("\n"),
      "utf8"
    );

    const first = startCli(appRoot, workspace);
    try {
      await waitForScreenText(first, "> | message");
      first.child.write("build a detached complex feature\r");
      await waitForScreenText(first, "working");
      const runDir = await latestRunDir(workspace);
      first.child.write("\x03");
      await waitForExit(first.exits);

      await waitForSupervisorStatus(runDir, "completed");
      const state = await readSupervisorRunState(supervisorRunFiles(runDir));
      expect(state.result).toMatchObject({ mode: "complex" });
      expect(state.result?.taskId).toMatch(/^task-/);
      expect(state.result?.workers.length).toBeGreaterThan(0);

      const second = startCli(appRoot, workspace);
      try {
        await waitForScreenText(second, "complex task completed");
        await waitForFile(join(runDir, "acknowledged.json"));
        second.child.write("\x03");
        await waitForExit(second.exits);
      } finally {
        stopCli(second);
      }
    } finally {
      stopCli(first);
      await rm(appRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }, 45000);

  it("keeps one controller while another TUI observes and transfers control on detach", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-control-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-control-workspace-"));
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "complex"',
        "",
        "[pairing]",
        'main = "mock"',
        'judge = "mock"',
        'actor = "mock"',
        'critic = "mock"',
        "",
        "[workers.mock.model.env]",
        'PCT_MOCK_DELAY_MS = "5000"',
        ""
      ].join("\n"),
      "utf8"
    );

    const first = startCli(appRoot, workspace);
    let second: ReturnType<typeof startCli> | null = null;
    try {
      await waitForScreenText(first, "> | message");
      first.child.write("run with a second observer\r");
      await waitForScreenText(first, "working");
      const runDir = await latestRunDir(workspace);
      await waitForSupervisorTask(runDir);
      await waitForControllerPid(runDir, first.child.pid);

      second = startCli(appRoot, workspace);
      await waitForScreenText(second, "observing · ^C detach");
      expect(await currentControllerPid(runDir)).toBe(first.child.pid);

      first.child.write("\x03");
      await waitForExit(first.exits);
      await waitForControllerPid(runDir, second.child.pid);
      await waitForScreenText(second, "Esc stop · ^C detach");

      second.child.write("\x1b");
      await waitForSupervisorStatus(runDir, "cancelled");
      await waitForScreenText(second, "cancelled");
      second.child.write("\x03");
      await waitForExit(second.exits);
    } finally {
      stopCli(first);
      if (second) {
        stopCli(second);
      }
      await rm(appRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }, 45000);
});

function startCli(appRoot: string, workspace: string) {
  const screen = new NativeTerminalScreen({ cols: 110, rows: 22, scrollback: 800 });
  const exits: number[] = [];
  let screenWrites = Promise.resolve();
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.tsx",
    "--app-root",
    appRoot,
    "--workspace",
    workspace
  ], {
    cwd: process.cwd(),
    cols: 110,
    rows: 22,
    env: { ...process.env, FORCE_COLOR: "0" }
  });
  child.onData((chunk) => {
    screenWrites = screenWrites.then(() => screen.write(chunk));
  });
  child.onExit(({ exitCode }) => exits.push(exitCode));
  return { child, screen, exits, screenWrites: () => screenWrites };
}

async function latestRunDir(workspace: string): Promise<string> {
  const root = join(workspace, ".parallel-codex", "supervisor", "runs");
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const names = (await readdir(root)).filter((name) => name.startsWith("run-")).sort();
      if (names.length > 0) {
        return join(root, names.at(-1)!);
      }
    } catch {
      // The submit path may still be publishing its run directory.
    }
    await delay(20);
  }
  throw new Error("Timed out waiting for Supervisor run directory");
}

async function waitForSupervisorStatus(runDir: string, expected: string): Promise<void> {
  const files = supervisorRunFiles(runDir);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await readSupervisorRunState(files)).status === expected) {
      return;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for Supervisor status ${expected}`);
}

async function waitForSupervisorTask(runDir: string): Promise<void> {
  const files = supervisorRunFiles(runDir);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if ((await readSupervisorRunState(files)).task_id) {
      return;
    }
    await delay(20);
  }
  throw new Error("Timed out waiting for Supervisor task id");
}

async function currentControllerPid(runDir: string): Promise<number | null> {
  try {
    const value = JSON.parse(await readFile(join(runDir, "controller.json"), "utf8")) as { pid?: unknown };
    return typeof value.pid === "number" ? value.pid : null;
  } catch {
    return null;
  }
}

async function waitForControllerPid(runDir: string, expected: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await currentControllerPid(runDir) === expected) {
      return;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for controller pid ${expected}`);
}

async function waitForChatText(workspace: string, expected: string): Promise<void> {
  const path = join(workspace, ".parallel-codex", "sessions", "main", "chat.jsonl");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const records = (await readFile(path, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => ChatRecordSchema.parse(JSON.parse(line)));
      if (records.some((record) => record.text === expected)) {
        return;
      }
    } catch {
      // The Supervisor owns the append and may not have published it yet.
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for chat text ${expected}`);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function waitForScreenText(run: ReturnType<typeof startCli>, text: string, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await run.screenWrites();
    if (run.screen.snapshot().includes(text)) {
      return;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(text)}\n${run.screen.snapshot()}`);
}

async function waitForExit(exits: number[], timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exits.length > 0) {
      return;
    }
    await delay(20);
  }
  throw new Error("Timed out waiting for CLI exit");
}

function stopCli(run: ReturnType<typeof startCli>): void {
  if (run.exits.length === 0) {
    try {
      run.child.kill();
    } catch {
      // The PTY may have exited between the guard and kill.
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
