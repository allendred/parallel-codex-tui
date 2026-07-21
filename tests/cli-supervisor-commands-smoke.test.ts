import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { readProcessStartToken } from "../src/core/process-identity.js";
import type {
  SupervisorCancellationResult,
  SupervisorRunsReport
} from "../src/supervisor/operations.js";
import {
  readSupervisorCommands,
  readSupervisorRunState,
  createSupervisorRun,
  supervisorRunFiles,
  writeSupervisorRunState
} from "../src/supervisor/store.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

const execFileAsync = promisify(execFile);

describe("CLI Supervisor commands smoke", () => {
  it("queries and cancels a live run from a second non-interactive CLI", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-commands-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-commands-workspace-"));
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

    const tui = startCli(appRoot, workspace);
    let runDir: string | null = null;
    try {
      const empty = await runCliCommand(appRoot, workspace, ["--runs", "--json"]);
      expect((JSON.parse(empty.stdout) as SupervisorRunsReport).runs).toEqual([]);

      await waitForScreenText(tui, "> | message");
      tui.child.write("run a task managed from another cli\r");
      await waitForScreenText(tui, "working");
      runDir = await latestRunDir(workspace);
      await waitForSupervisorTask(runDir);

      const status = await runCliCommand(appRoot, workspace, ["--runs", "--json"]);
      expect(status.stderr).toBe("");
      const report = JSON.parse(status.stdout) as SupervisorRunsReport;
      expect(report.runs[0]).toMatchObject({
        run_id: runDir.split("/").at(-1),
        status: "running",
        control: "controlled",
        process_active: true,
        controller_active: true
      });
      expect(status.stdout).not.toContain("run a task managed from another cli");

      const runId = report.runs[0]!.run_id;
      const cancellation = await runCliCommand(appRoot, workspace, [
        `--cancel-run=${runId}`,
        "--json"
      ]);
      expect(cancellation.stderr).toBe("");
      expect(JSON.parse(cancellation.stdout) as SupervisorCancellationResult).toMatchObject({
        run: { run_id: runId, status: "running" }
      });

      await waitForSupervisorStatus(runDir, "cancelled");
      await waitForScreenText(tui, "cancelled");

      const settled = await runCliCommand(appRoot, workspace, ["--runs"]);
      expect(settled.stdout).toContain(`cancelled · settled`);
      expect(settled.stdout).toContain(runId);
      expect(settled.stdout).not.toContain("run a task managed from another cli");

      tui.child.write("\x03");
      await waitForExit(tui.exits);
      expect(tui.exits[0]).toBe(0);
    } finally {
      stopCli(tui);
      if (runDir) {
        await stopSupervisor(runDir);
      }
      await rm(appRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }, 45000);

  it("waits for a detached run to complete without taking control or cancelling it", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-wait-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-wait-workspace-"));
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

    const tui = startCli(appRoot, workspace);
    let runDir: string | null = null;
    try {
      await waitForScreenText(tui, "> | message");
      tui.child.write("private detached wait request\r");
      await waitForScreenText(tui, "working");
      runDir = await latestRunDir(workspace);
      const runId = runDir.split("/").at(-1)!;

      tui.child.write("\x03");
      await waitForExit(tui.exits);
      expect(tui.exits[0]).toBe(0);

      const waited = await runCliCommand(appRoot, workspace, [
        "--wait-run",
        runId,
        "--wait-timeout",
        "10",
        "--json"
      ]);
      expect(waited.stderr).toBe("");
      const result = JSON.parse(waited.stdout) as {
        outcome: string;
        run: { run_id: string; status: string; control: string; controller_active: boolean };
      };
      expect(result).toMatchObject({
        outcome: "completed",
        run: {
          run_id: runId,
          status: "completed",
          control: "settled",
          controller_active: false
        }
      });
      expect(waited.stdout).not.toContain("private detached wait request");
      expect(await readSupervisorCommands(supervisorRunFiles(runDir))).toEqual([]);
      await expect(readFile(join(runDir, "acknowledged.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });

      const immediate = await runCliCommand(appRoot, workspace, [`--wait-run=${runId}`]);
      expect(immediate.stdout).toContain(`Run completed · ${runId}`);
    } finally {
      stopCli(tui);
      if (runDir) {
        await stopSupervisor(runDir);
      }
      await rm(appRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30000);

  it("times out through the real CLI without changing a live run", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-timeout-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-timeout-workspace-"));
    const runId = "run-cli-timeout";
    try {
      const files = await createSupervisorRun(workspace, ".parallel-codex", {
        version: 1,
        run_id: runId,
        kind: "handle-request",
        app_root: appRoot,
        workspace_root: workspace,
        data_dir: ".parallel-codex",
        created_at: new Date().toISOString(),
        request: "private timeout request",
        cwd: workspace
      });
      const initial = await readSupervisorRunState(files);
      const processStartToken = await readProcessStartToken(process.pid);
      await writeSupervisorRunState(files, {
        ...initial,
        status: "running",
        updated_at: new Date().toISOString(),
        pid: process.pid,
        ...(processStartToken ? { process_start_token: processStartToken } : {})
      });

      await expect(runCliCommand(appRoot, workspace, [
        "--wait-run",
        runId,
        "--wait-timeout",
        "0.05",
        "--json"
      ])).rejects.toMatchObject({
        code: 4,
        stderr: "",
        stdout: expect.stringContaining('"outcome": "timeout"')
      });
      expect(await readSupervisorCommands(files)).toEqual([]);
      expect((await readSupervisorRunState(files)).status).toBe("running");
      await expect(readFile(files.controllerPath, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(appRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }, 15000);
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

async function runCliCommand(appRoot: string, workspace: string, args: string[]) {
  return execFileAsync(process.execPath, [
    "--import",
    "tsx",
    "src/cli.tsx",
    "--app-root",
    appRoot,
    "--workspace",
    workspace,
    ...args
  ], {
    cwd: process.cwd(),
    env: { ...process.env, FORCE_COLOR: "0" }
  });
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
      // The run may still be publishing its complete directory.
    }
    await delay(20);
  }
  throw new Error("Timed out waiting for Supervisor run directory");
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

async function waitForScreenText(
  tui: ReturnType<typeof startCli>,
  text: string
): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    await tui.screenWrites();
    if (tui.screen.snapshot().includes(text)) {
      return;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for screen text: ${text}\n${tui.screen.snapshot()}`);
}

async function waitForExit(exits: number[]): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (exits.length > 0) {
      return;
    }
    await delay(20);
  }
  throw new Error("Timed out waiting for CLI exit");
}

async function stopSupervisor(runDir: string): Promise<void> {
  try {
    const state = await readSupervisorRunState(supervisorRunFiles(runDir));
    if (state.pid && state.status !== "completed" && state.status !== "failed" && state.status !== "cancelled") {
      process.kill(state.pid, "SIGTERM");
    }
  } catch {
    // Cleanup is best effort after a failed assertion.
  }
}

function stopCli(tui: ReturnType<typeof startCli>): void {
  try {
    tui.child.kill();
  } catch {
    // The PTY may already be closed.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
