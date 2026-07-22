import { execFile, spawn as spawnChild } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { processIsAlive, readProcessStartToken } from "../src/core/process-identity.js";
import type {
  SupervisorCancellationResult,
  SupervisorRunsReport,
  SupervisorSubmissionResult,
  SupervisorSubmitAndWaitResult
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
  it("creates a missing Workspace and default config before headless submission", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-bootstrap-app-"));
    const workspaceParent = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-bootstrap-workspace-"));
    const workspace = join(workspaceParent, "created-project");
    const emptyBin = join(appRoot, "empty-bin");
    await mkdir(emptyBin);
    let runDir: string | null = null;
    try {
      const submitted = await runCliCommand(appRoot, workspace, [
        "--submit",
        "private bootstrap request",
        "--json"
      ], { PATH: emptyBin });
      expect(submitted.stderr).toBe("");
      const result = JSON.parse(submitted.stdout) as SupervisorSubmissionResult;
      expect(result).toMatchObject({ version: 1, reused: false });
      expect(submitted.stdout).not.toContain("private bootstrap request");
      expect(await readFile(join(appRoot, ".parallel-codex", "config.toml"), "utf8"))
        .toContain("[router]");
      expect(await readFile(join(appRoot, ".parallel-codex", "workspaces.json"), "utf8"))
        .toContain(workspace);
      expect((await readdir(workspace))).toContain(".parallel-codex");
      runDir = join(workspace, ".parallel-codex", "supervisor", "runs", result.run.run_id);
      expect(await readFile(join(runDir, "request.json"), "utf8"))
        .toContain("private bootstrap request");
    } finally {
      if (runDir) {
        await stopSupervisor(runDir);
      }
      await rm(appRoot, { recursive: true, force: true });
      await rm(workspaceParent, { recursive: true, force: true });
    }
  }, 15000);

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

  it("submits detached work directly, deduplicates it, and accepts piped Unicode stdin", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-submit-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-submit-workspace-"));
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

    const runDirs: string[] = [];
    try {
      const first = await runCliCommand(appRoot, workspace, [
        "--submit",
        "private direct submission",
        "--idempotency-key",
        "ci:direct-1",
        "--json"
      ]);
      expect(first.stderr).toBe("");
      const submitted = JSON.parse(first.stdout) as SupervisorSubmissionResult;
      expect(submitted).toMatchObject({
        version: 1,
        reused: false,
        run: { kind: "handle-request", controller_active: false, acknowledged: false }
      });
      expect(first.stdout).not.toContain("private direct submission");
      const firstRunDir = join(workspace, ".parallel-codex", "supervisor", "runs", submitted.run.run_id);
      runDirs.push(firstRunDir);
      await expect(readFile(join(firstRunDir, "controller.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(firstRunDir, "request.json"), "utf8"))
        .not.toContain("ci:direct-1");

      const duplicate = await runCliCommand(appRoot, workspace, [
        "--submit=private direct submission",
        "--idempotency-key=ci:direct-1",
        "--json"
      ]);
      expect(JSON.parse(duplicate.stdout) as SupervisorSubmissionResult).toMatchObject({
        reused: true,
        run: { run_id: submitted.run.run_id }
      });
      const duringRun = await runCliCommand(appRoot, workspace, ["--runs", "--json"]);
      expect((JSON.parse(duringRun.stdout) as SupervisorRunsReport).runs).toHaveLength(1);

      const waited = await runCliCommand(appRoot, workspace, [
        "--wait-run",
        submitted.run.run_id,
        "--wait-timeout",
        "10",
        "--json"
      ]);
      expect(JSON.parse(waited.stdout)).toMatchObject({ outcome: "completed" });
      await expect(readFile(join(firstRunDir, "acknowledged.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });

      const timedOut = await runCliCommand(appRoot, workspace, [
        "--submit",
        "private submit and wait timeout request",
        "--wait-timeout",
        "0.05",
        "--json"
      ]).then(
        () => { throw new Error("Expected submit wait timeout"); },
        (error: unknown) => error as Error & { code: number; stdout: string; stderr: string }
      );
      expect(timedOut).toMatchObject({ code: 4, stderr: "" });
      const timedResult = JSON.parse(timedOut.stdout) as SupervisorSubmitAndWaitResult;
      expect(timedResult).toMatchObject({
        submission: { reused: false, run: { status: "running" } },
        wait: { outcome: "timeout", run: { status: "running" } }
      });
      expect(timedOut.stdout).not.toContain("private submit and wait timeout request");
      const timedRunDir = join(
        workspace,
        ".parallel-codex",
        "supervisor",
        "runs",
        timedResult.submission.run.run_id
      );
      runDirs.push(timedRunDir);
      expect(await readSupervisorCommands(supervisorRunFiles(timedRunDir))).toEqual([]);
      const timedCompletion = await runCliCommand(appRoot, workspace, [
        "--wait-run",
        timedResult.submission.run.run_id,
        "--wait-timeout",
        "10",
        "--json"
      ]);
      expect(JSON.parse(timedCompletion.stdout)).toMatchObject({ outcome: "completed" });

      const piped = await runCliCommandWithInput(appRoot, workspace, [
        "--submit=-",
        "--wait",
        "--json"
      ], "实现输入可靠性\n并保留多轮记忆\n");
      expect(piped.stderr).toBe("");
      const combined = JSON.parse(piped.stdout) as SupervisorSubmitAndWaitResult;
      expect(combined).toMatchObject({
        version: 1,
        submission: { reused: false, run: { kind: "handle-request" } },
        wait: { outcome: "completed" }
      });
      expect(piped.stdout).not.toContain("实现输入可靠性");
      const pipedRunDir = join(
        workspace,
        ".parallel-codex",
        "supervisor",
        "runs",
        combined.submission.run.run_id
      );
      runDirs.push(pipedRunDir);
      expect(await readFile(join(pipedRunDir, "request.json"), "utf8"))
        .toContain("实现输入可靠性\\n并保留多轮记忆");
    } finally {
      for (const runDir of runDirs) {
        await stopSupervisor(runDir);
      }
      await rm(appRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30000);

  it("continues an existing complex Task through headless multi-turn submission", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-submit-turn-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-supervisor-submit-turn-workspace-"));
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
        ""
      ].join("\n"),
      "utf8"
    );

    const runDirs: string[] = [];
    try {
      const first = await runCliCommand(appRoot, workspace, [
        "--submit",
        "build the first feature",
        "--wait",
        "--json"
      ]);
      const initial = JSON.parse(first.stdout) as SupervisorSubmitAndWaitResult;
      expect(initial.wait).toMatchObject({ outcome: "completed" });
      const taskId = initial.wait.run.task_id;
      expect(taskId).toMatch(/^task-/);
      runDirs.push(join(
        workspace,
        ".parallel-codex",
        "supervisor",
        "runs",
        initial.submission.run.run_id
      ));

      const followUp = await runCliCommand(appRoot, workspace, [
        "--task",
        taskId!,
        "--submit",
        "add a second feature without losing the first turn",
        "--wait",
        "--json"
      ]);
      const continued = JSON.parse(followUp.stdout) as SupervisorSubmitAndWaitResult;
      expect(continued).toMatchObject({
        submission: {
          run: { kind: "handle-task-turn", task_id: taskId }
        },
        wait: {
          outcome: "completed",
          run: { task_id: taskId }
        }
      });
      runDirs.push(join(
        workspace,
        ".parallel-codex",
        "supervisor",
        "runs",
        continued.submission.run.run_id
      ));
      const turns = await readdir(join(
        workspace,
        ".parallel-codex",
        "sessions",
        taskId!,
        "turns"
      ));
      expect(turns.filter((entry) => /^\d{4}$/.test(entry))).toEqual(["0001", "0002"]);
      expect(followUp.stdout).not.toContain("without losing the first turn");
    } finally {
      for (const runDir of runDirs) {
        await stopSupervisor(runDir);
      }
      await rm(appRoot, { recursive: true, force: true });
      await rm(workspace, { recursive: true, force: true });
    }
  }, 30000);
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

async function runCliCommand(
  appRoot: string,
  workspace: string,
  args: string[],
  env: NodeJS.ProcessEnv = {}
) {
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
    env: { ...process.env, FORCE_COLOR: "0", ...env }
  });
}

async function runCliCommandWithInput(
  appRoot: string,
  workspace: string,
  args: string[],
  input: string
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnChild(process.execPath, [
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
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(Object.assign(new Error(`CLI exited with code ${code}`), { code, stdout, stderr }));
    });
    child.stdin.end(input);
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
    if (!state.pid) {
      return;
    }
    if (state.status !== "completed" && state.status !== "failed" && state.status !== "cancelled") {
      process.kill(state.pid, "SIGTERM");
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && await recordedProcessIsAlive(state.pid, state.process_start_token)) {
      await delay(25);
    }
    if (await recordedProcessIsAlive(state.pid, state.process_start_token)) {
      process.kill(state.pid, "SIGKILL");
    }
  } catch {
    // Cleanup is best effort after a failed assertion.
  }
}

async function recordedProcessIsAlive(pid: number, expectedStartToken?: string): Promise<boolean> {
  if (!processIsAlive(pid)) {
    return false;
  }
  if (!expectedStartToken) {
    return true;
  }
  return await readProcessStartToken(pid) === expectedStartToken;
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
