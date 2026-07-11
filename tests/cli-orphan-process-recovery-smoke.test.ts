import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { spawn as spawnProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { pathExists, readJson, readTextIfExists } from "../src/core/file-store.js";
import {
  processIsAlive,
  workerProcessRecordPath,
  writeWorkerProcessRecord
} from "../src/core/process-ownership.js";
import { TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI orphan process recovery smoke", () => {
  it("terminates an owned Worker left behind by a hard-killed TUI", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-orphan-workspace-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-orphan-app-"));
    const agentScript = join(appRoot, "orphan-agent.cjs");
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(agentScript, orphanAgentSource());
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "complex"',
        "",
        "[workers.codex]",
        `command = "${escapeToml(process.execPath)}"`,
        `args = ["${escapeToml(agentScript)}"]`,
        "timeoutMs = 60000",
        "idleTimeoutMs = 60000",
        "firstOutputTimeoutMs = 5000",
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

    const firstScreen = new NativeTerminalScreen({ cols: 100, rows: 20, scrollback: 500 });
    const firstExits: number[] = [];
    let firstWrites = Promise.resolve();
    const first = launchCli(appRoot, workspace);
    first.onData((chunk) => {
      firstWrites = firstWrites.then(() => firstScreen.write(chunk));
    });
    first.onExit(({ exitCode }) => firstExits.push(exitCode));
    let workerPid = 0;

    try {
      await waitForScreenText(() => firstWrites, firstScreen, "> | message");
      first.write("实现硬退出恢复\r");
      const taskDir = await waitForTaskDir(workspace);
      const workerDir = join(taskDir, "actor-codex");
      await waitForWorkerPhase(join(workerDir, "status.json"), "process-output");
      await waitForPath(workerProcessRecordPath(workerDir));
      const processRecord = JSON.parse(await readTextIfExists(workerProcessRecordPath(workerDir))) as {
        pid: number;
        process_start_token?: string;
      };
      workerPid = processRecord.pid;
      expect(processRecord.process_start_token).toEqual(expect.any(String));
      expect(processIsAlive(workerPid)).toBe(true);

      process.kill(first.pid, "SIGKILL");
      await waitForExit(firstExits);
      if (processIsAlive(workerPid)) {
        process.kill(-workerPid, "SIGKILL");
        await waitForProcessState(workerPid, false);
      }
      const orphan = spawnProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        detached: true,
        stdio: "ignore"
      });
      orphan.unref();
      workerPid = orphan.pid ?? 0;
      if (!workerPid) {
        throw new Error("Detached orphan process did not receive a pid");
      }
      await writeWorkerProcessRecord(workerDir, {
        workerId: "actor-codex",
        pid: workerPid,
        processGroupId: workerPid,
        command: process.execPath
      });
      await waitForProcessState(workerPid, true);

      const secondScreen = new NativeTerminalScreen({ cols: 100, rows: 20, scrollback: 500 });
      const secondExits: number[] = [];
      let secondWrites = Promise.resolve();
      const second = launchCli(appRoot, workspace);
      second.onData((chunk) => {
        secondWrites = secondWrites.then(() => secondScreen.write(chunk));
      });
      second.onExit(({ exitCode }) => secondExits.push(exitCode));

      try {
        await waitForScreenText(() => secondWrites, secondScreen, "Recovered interrupted task");
        await waitForScreenText(() => secondWrites, secondScreen, "^R retry");
        await waitForProcessState(workerPid, false);
        await expect(readJson(join(taskDir, "meta.json"), TaskMetaSchema)).resolves.toMatchObject({ status: "cancelled" });
        await expect(readJson(join(workerDir, "status.json"), WorkerStatusSchema)).resolves.toMatchObject({
          state: "cancelled",
          phase: "orphaned-after-restart"
        });
        expect(await pathExists(workerProcessRecordPath(workerDir))).toBe(false);
        expect(await readTextIfExists(join(taskDir, "events.jsonl"))).toContain("task.recovered_after_restart");

        second.write("\x03");
        await waitForExit(secondExits);
        expect(secondExits[0]).toBe(0);
      } finally {
        if (secondExits.length === 0) {
          second.kill("SIGTERM");
        }
      }
    } finally {
      if (firstExits.length === 0) {
        first.kill("SIGKILL");
      }
      if (workerPid > 0 && processIsAlive(workerPid)) {
        try {
          process.kill(workerPid, "SIGKILL");
        } catch {
          // Best-effort cleanup for a failed ownership assertion.
        }
      }
    }
  }, 20000);
});

function launchCli(appRoot: string, workspace: string) {
  return spawn(
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
}

function orphanAgentSource(): string {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const role = process.env.PARALLEL_CODEX_ROLE;",
    "const dir = process.env.PARALLEL_CODEX_FILES_DIR;",
    "process.on('SIGHUP', () => {});",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  if (role === 'judge') {",
    "    fs.writeFileSync(path.join(dir, 'requirements.md'), '# Requirements\\n\\n- [R-001] Run a recoverable Actor.\\n');",
    "    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\\n\\n1. [P-001] Start the Actor process.\\n');",
    "    fs.writeFileSync(path.join(dir, 'acceptance.md'), '# Acceptance\\n\\n- [A-001] [R-001] The orphan process is recovered.\\n');",
    "    fs.writeFileSync(path.join(dir, 'actor-brief.md'), '# Actor Brief\\n\\nImplement the requested behavior.\\n');",
    "    fs.writeFileSync(path.join(dir, 'critic-brief.md'), '# Critic Brief\\n\\nVerify process recovery.\\n');",
    "    console.log('judge done');",
    "    return;",
    "  }",
    "  if (role === 'actor') {",
    "    console.log('orphan actor pid ' + process.pid);",
    "    setInterval(() => {}, 1000);",
    "    return;",
    "  }",
    "  if (role === 'critic') fs.writeFileSync(path.join(dir, 'review.md'), 'APPROVED\\n');",
    "});"
  ].join("\n");
}

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function waitForTaskDir(workspace: string): Promise<string> {
  const sessionsDir = join(workspace, ".parallel-codex", "sessions");
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const taskId = (await readdir(sessionsDir)).find((entry) => entry.startsWith("task-"));
      if (taskId) {
        return join(sessionsDir, taskId);
      }
    } catch {
      // Task startup has not created the session directory yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for task directory");
}

async function waitForWorkerPhase(statusPath: string, phase: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await readJson(statusPath, WorkerStatusSchema)).phase === phase) {
        return;
      }
    } catch {
      // Worker status is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for worker phase ${phase}`);
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await pathExists(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${path}`);
}

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

async function waitForProcessState(pid: number, alive: boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (processIsAlive(pid) === alive) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for process ${pid} to become ${alive ? "alive" : "stopped"}`);
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
