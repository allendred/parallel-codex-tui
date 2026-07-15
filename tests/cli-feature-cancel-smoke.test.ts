import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { pathExists, readJson, readTextIfExists } from "../src/core/file-store.js";
import { TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { displayWidth } from "../src/tui/display-width.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";
import { resizeAndWaitForFreshScreenText } from "./pty-resize.js";

describe("CLI Feature control smoke", () => {
  it("pauses, resumes, and cancels only the selected active Feature from the board", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-feature-cancel-workspace-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-feature-cancel-app-"));
    const agentScript = join(appRoot, "feature-cancel-agent.cjs");
    const screen = new NativeTerminalScreen({ cols: 100, rows: 20, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    let outputRevision = 0;

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(agentScript, featureCancelAgentSource());
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "complex"',
        "",
        "[orchestration]",
        "maxParallelFeatures = 2",
        "",
        "[workers.codex]",
        `command = "${escapeToml(process.execPath)}"`,
        `args = ["${escapeToml(agentScript)}"]`,
        "timeoutMs = 30000",
        "idleTimeoutMs = 15000",
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
        cols: 100,
        rows: 20,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );
    child.onData((chunk) => {
      outputRevision += 1;
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "> | message");
      child.write("并行实现 alpha 与 beta\r");

      const taskDir = await waitForTaskDir(workspace);
      const alphaWorkerPath = join(taskDir, "actor-codex-0001-alpha", "status.json");
      await waitForWorkerPhase(alphaWorkerPath, "process-output");

      child.write("\x02");
      await waitForScreenText(() => screenWrites, screen, "F features");
      for (let attempt = 0; attempt < 3 && !screen.snapshot().includes("> Actor (codex) · Alpha"); attempt += 1) {
        child.write("\x1b[B");
        await new Promise((resolve) => setTimeout(resolve, 100));
        await screenWrites;
      }
      await waitForScreenText(() => screenWrites, screen, "> Actor (codex) · Alpha");
      await waitForScreenText(() => screenWrites, screen, "activity · output");
      await waitForScreenText(() => screenWrites, screen, "idle timeout in");
      const firstDeadline = idleDeadlineSeconds(screen.snapshot());
      await new Promise((resolve) => setTimeout(resolve, 1200));
      await screenWrites;
      const nextDeadline = idleDeadlineSeconds(screen.snapshot());
      expect(nextDeadline).toBeLessThan(firstDeadline);
      child.write("f");
      await waitForScreenText(() => screenWrites, screen, "Feature board");
      await waitForScreenText(() => screenWrites, screen, "> T0001 · Alpha · actor running");
      await waitForScreenText(() => screenWrites, screen, "X cancel");

      await resizeAndWaitForFreshScreenText({
        child,
        screen,
        screenWrites: () => screenWrites,
        revision: () => outputRevision,
        cols: 40,
        rows: 20,
        text: "ft · P pause · X cancel · Esc workers"
      });
      expect(Math.max(...screen.snapshot().split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(40);

      child.write("x");
      await waitForScreenText(() => screenWrites, screen, "cancel feature? · X confirm · Esc keep");
      await resizeAndWaitForFreshScreenText({
        child,
        screen,
        screenWrites: () => screenWrites,
        revision: () => outputRevision,
        cols: 32,
        rows: 20,
        text: "cancel? · X confirm · Esc keep"
      });
      expect(Math.max(...screen.snapshot().split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(32);
      await resizeAndWaitForFreshScreenText({
        child,
        screen,
        screenWrites: () => screenWrites,
        revision: () => outputRevision,
        cols: 100,
        rows: 20,
        text: "cancel feature? · X confirm · Esc keep"
      });
      await waitForScreenText(() => screenWrites, screen, "Cancel Alpha? Active peers will finish; integration stays blocked.");
      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "X cancel");
      expect((await readJson(alphaWorkerPath, WorkerStatusSchema)).state).toBe("running");

      child.write("p");
      await waitForScreenText(() => screenWrites, screen, "pause feature? · P confirm · Esc keep");
      await waitForScreenText(() => screenWrites, screen, "Pause Alpha? Completed peer checkpoints will be kept.");
      child.write("p");
      await waitForTaskState(join(taskDir, "meta.json"), "paused");
      await waitForScreenText(() => screenWrites, screen, "Pause requested for Alpha");
      await waitForScreenText(() => screenWrites, screen, "Alpha · paused");
      expect((await readJson(alphaWorkerPath, WorkerStatusSchema)).state).toBe("cancelled");
      expect((await readJson(
        join(taskDir, "actor-codex-0001-beta", "status.json"),
        WorkerStatusSchema
      )).state).toBe("done");
      let events = await readTextIfExists(join(taskDir, "events.jsonl"));
      expect(events).toContain("feature.pause_requested");
      expect(events).toContain("feature.paused");

      child.write("\x12");
      await waitForFileText(join(taskDir, "actor-codex-0001-alpha", "run-count.txt"), "2");
      await waitForWorkerPhase(alphaWorkerPath, "process-output");
      await waitForScreenText(() => screenWrites, screen, "Alpha · actor running");
      events = await readTextIfExists(join(taskDir, "events.jsonl"));
      expect(events).toContain("feature.resume_requested");

      child.write("x");
      await waitForScreenText(() => screenWrites, screen, "cancel feature? · X confirm · Esc keep");
      child.write("x");
      await waitForTaskState(join(taskDir, "meta.json"), "cancelled");
      await waitForScreenText(() => screenWrites, screen, "Cancellation requested for Alpha");
      await waitForScreenText(() => screenWrites, screen, "^R retry task");
      await waitForScreenText(() => screenWrites, screen, "Alpha · cancelled");

      const betaWorker = await readJson(
        join(taskDir, "actor-codex-0001-beta", "status.json"),
        WorkerStatusSchema
      );
      events = await readTextIfExists(join(taskDir, "events.jsonl"));
      expect((await readJson(alphaWorkerPath, WorkerStatusSchema)).state).toBe("cancelled");
      expect(betaWorker.state).toBe("done");
      expect(events).toContain("feature.cancel_requested");
      expect(events).toContain("feature.cancelled");
      expect(await pathExists(join(taskDir, "critic-codex-0001-alpha"))).toBe(false);
      expect(await pathExists(join(taskDir, "critic-codex-0001-beta"))).toBe(false);
      expect(await pathExists(join(workspace, "alpha.txt"))).toBe(false);
      expect(await pathExists(join(workspace, "beta.txt"))).toBe(false);

      child.write("\x12");
      await waitForTaskState(join(taskDir, "meta.json"), "done");
      await waitForScreenText(() => screenWrites, screen, "2 features · 2 approved");
      const resumedEvents = await readTextIfExists(join(taskDir, "events.jsonl"));
      expect(await readTextIfExists(join(taskDir, "actor-codex-0001-alpha", "run-count.txt"))).toBe("3");
      expect(await readTextIfExists(join(taskDir, "actor-codex-0001-beta", "run-count.txt"))).toBe("1");
      expect(await readTextIfExists(join(workspace, "alpha.txt"))).toBe("alpha\n");
      expect(await readTextIfExists(join(workspace, "beta.txt"))).toBe("beta\n");
      expect(resumedEvents).toContain("feature.wave_checkpoint_loaded");
      expect(resumedEvents).toContain("feature.wave_actor_checkpoints_reused");

      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 35000);
});

function featureCancelAgentSource(): string {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const role = process.env.PARALLEL_CODEX_ROLE;",
    "const workerId = process.env.PARALLEL_CODEX_WORKER_ID;",
    "const dir = process.env.PARALLEL_CODEX_FILES_DIR;",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  if (role === 'judge') {",
    "    fs.writeFileSync(path.join(dir, 'requirements.md'), '# Requirements\\n\\n- [R-001] Implement alpha and beta.\\n');",
    "    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\\n\\n1. [P-001] Implement both features.\\n');",
    "    fs.writeFileSync(path.join(dir, 'acceptance.md'), '# Acceptance\\n\\n- [A-001] [R-001] Both feature files are integrated.\\n');",
    "    fs.writeFileSync(path.join(dir, 'actor-brief.md'), '# Actor Brief\\n\\nImplement the assigned feature.\\n');",
    "    fs.writeFileSync(path.join(dir, 'critic-brief.md'), '# Critic Brief\\n\\nVerify the assigned feature.\\n');",
    "    fs.writeFileSync(path.join(dir, 'features.json'), JSON.stringify({version:1,features:[",
    "      {id:'alpha',title:'Alpha',description:'Implement alpha',depends_on:[]},",
    "      {id:'beta',title:'Beta',description:'Implement beta',depends_on:[]}",
    "    ]}));",
    "    console.log('judge done');",
    "    return;",
    "  }",
    "  if (role === 'actor') {",
    "    console.log(workerId + ' started');",
    "    const countPath = path.join(dir, 'run-count.txt');",
    "    const runCount = (fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0) + 1;",
    "    fs.writeFileSync(countPath, String(runCount));",
    "    if (workerId.endsWith('-alpha') && runCount <= 2) setInterval(() => {}, 1000);",
    "    else setTimeout(() => {",
    "      const name = workerId.endsWith('-alpha') ? 'alpha' : 'beta';",
    "      fs.writeFileSync(path.join(process.cwd(), name + '.txt'), name + '\\n');",
    "      fs.writeFileSync(path.join(dir, 'worklog.md'), name + ' complete\\n');",
    "      process.exit(0);",
    "    }, workerId.endsWith('-alpha') ? 50 : 300);",
    "    return;",
    "  }",
    "  if (role === 'critic') { fs.writeFileSync(path.join(dir, 'review.md'), 'APPROVED\\n'); console.log('critic done'); }",
    "});"
  ].join("\n");
}

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function idleDeadlineSeconds(snapshot: string): number {
  const match = snapshot.match(/idle timeout in (\d+)s/);
  if (!match) {
    throw new Error(`Worker idle deadline is not visible:\n${snapshot}`);
  }
  return Number(match[1]);
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

async function waitForTaskState(metaPath: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      if ((await readJson(metaPath, TaskMetaSchema)).status === state) {
        return;
      }
    } catch {
      // Task metadata is not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for task state ${state}`);
}

async function waitForFileText(path: string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if ((await readTextIfExists(path)).includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text} in ${path}`);
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

async function waitForExit(exits: number[]): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (exits.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for TUI to exit");
}
