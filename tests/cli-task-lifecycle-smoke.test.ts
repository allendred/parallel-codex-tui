import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { pathExists, readJson, readTextIfExists } from "../src/core/file-store.js";
import { TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";
import { TUI_THEME_PRESETS } from "../src/tui/theme.js";

describe("CLI task lifecycle smoke", () => {
  it("stops a running task with Escape and retries the same turn with Ctrl+R", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-task-lifecycle-workspace-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-task-lifecycle-app-"));
    const agentScript = join(appRoot, "lifecycle-agent.cjs");
    const screen = new NativeTerminalScreen({ cols: 100, rows: 20, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(agentScript, lifecycleAgentSource());
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "complex"',
        "",
        "[workers.codex]",
        `command = "${escapeToml(process.execPath)}"`,
        `args = ["${escapeToml(agentScript)}"]`,
        "timeoutMs = 10000",
        "idleTimeoutMs = 5000",
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
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );
    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "> | message");
      child.write("做个可取消的俄罗斯方块\r");

      const taskDir = await waitForTaskDir(workspace);
      await waitForWorkerPhase(join(taskDir, "actor-codex", "status.json"), "process-output");
      await waitForScreenText(() => screenWrites, screen, "Esc stop");
      child.write("\x1b");

      await waitForTaskState(join(taskDir, "meta.json"), "cancelled");
      await waitForScreenText(() => screenWrites, screen, "^R retry");
      expect(screen.snapshot()).toContain("cancelled · request stopped");
      const retryLine = screen.styledSnapshotLines().find((line) => (
        line.chunks.some((chunk) => chunk.text.includes("^R retry"))
      ));
      expect(retryLine?.chunks.some((chunk) => (
        chunk.text.includes("^R retry") &&
        chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.rail &&
        chunk.style.color === TUI_THEME_PRESETS.codex.warning
      ))).toBe(true);

      child.write("\x12");
      await waitForTaskState(join(taskDir, "meta.json"), "done");
      await waitForScreenText(() => screenWrites, screen, "done · complex task completed");
      await waitForScreenText(() => screenWrites, screen, "Implementation");
      await waitForScreenText(() => screenWrites, screen, "Actor retry completed.");
      await waitForScreenText(() => screenWrites, screen, "^D compact");
      expect(screen.snapshot()).not.toContain("Findings");
      const resultHeader = screen.styledSnapshotLines().find((line) => (
        line.chunks.some((chunk) => chunk.text.includes("complex task completed"))
      ));
      expect(resultHeader?.chunks.some((chunk) => (
        chunk.text.includes("done")
        && chunk.style.color === TUI_THEME_PRESETS.codex.success
        && chunk.style.bold
      ))).toBe(true);

      child.write("\x1b[6~");
      await waitForScreenText(() => screenWrites, screen, "Findings");
      await waitForScreenText(() => screenWrites, screen, "result 2/2");

      const completionLines = screen.styledSnapshotLines().filter((line) => (
        /done · complex task completed|APPROVED|none/.test(
          line.chunks.map((chunk) => chunk.text).join("")
        )
      ));
      const successText = completionLines
        .flatMap((line) => line.chunks)
        .filter((chunk) => chunk.style.color === TUI_THEME_PRESETS.codex.success && chunk.style.bold)
        .map((chunk) => chunk.text)
        .join("");
      const mutedText = completionLines
        .flatMap((line) => line.chunks)
        .filter((chunk) => chunk.style.color === TUI_THEME_PRESETS.codex.muted)
        .map((chunk) => chunk.text)
        .join("");
      expect(successText).toContain("APPROVED");
      expect(mutedText).toContain("none");

      child.write("\x04");
      await waitForScreenText(() => screenWrites, screen, "review · APPROVED");
      await waitForScreenText(() => screenWrites, screen, "findings · none");
      await waitForScreenText(() => screenWrites, screen, "^D details");
      child.write("\x04");
      await waitForScreenText(() => screenWrites, screen, "Implementation");
      await waitForScreenText(() => screenWrites, screen, "^D compact");
      child.write("继续优化");
      await waitForScreenText(() => screenWrites, screen, "继续优化|");
      expect(screen.snapshot()).not.toContain("Implementation");

      const actorLog = await readTextIfExists(join(taskDir, "actor-codex", "output.log"));
      const events = await readTextIfExists(join(taskDir, "events.jsonl"));
      const chatPath = join(workspace, ".parallel-codex", "sessions", "main", "chat.jsonl");
      await waitForFileText(chatPath, "Complex task completed.");
      const chat = await readTextIfExists(chatPath);
      expect(actorLog).toContain("actor waiting for cancel");
      expect(actorLog).toContain("Process cancelled by user");
      expect(actorLog).toContain("--- retry");
      expect(actorLog).toContain("actor retry done");
      expect(events).toContain("task.cancelled");
      expect(events).toContain("task.retrying");
      expect(chat).toContain("做个可取消的俄罗斯方块");
      expect(chat).toContain("cancelled · request stopped");
      expect(chat).toContain("Complex task completed.");
      expect(chat).toContain(`"task_id":"${taskDir.split("/").at(-1)}"`);
      expect(await pathExists(join(taskDir, "turns", "0002"))).toBe(false);

      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 15000);
});

function lifecycleAgentSource(): string {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const role = process.env.PARALLEL_CODEX_ROLE;",
    "const dir = process.env.PARALLEL_CODEX_FILES_DIR;",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  if (role === 'judge') {",
    "    fs.writeFileSync(path.join(dir, 'requirements.md'), '# Requirements\\n\\n- Build the game.\\n');",
    "    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\\n\\n1. Implement.\\n');",
    "    fs.writeFileSync(path.join(dir, 'acceptance.md'), '# Acceptance\\n\\n- Tests pass.\\n');",
    "    fs.writeFileSync(path.join(dir, 'actor-brief.md'), '# Actor Brief\\n\\nImplement the game.\\n');",
    "    fs.writeFileSync(path.join(dir, 'critic-brief.md'), '# Critic Brief\\n\\nReview the game.\\n');",
    "    console.log('judge done');",
    "    return;",
    "  }",
    "  if (role === 'actor') {",
    "    const marker = path.join(dir, 'cancelled-once.marker');",
    "    if (!fs.existsSync(marker)) {",
    "      fs.writeFileSync(marker, '1');",
    "      console.log('actor waiting for cancel');",
    "      setInterval(() => {}, 1000);",
    "      return;",
    "    }",
    "    fs.writeFileSync(path.join(dir, 'worklog.md'), '# Worklog\\n\\n- Actor retry completed.\\n- Added board state.\\n- Added keyboard controls.\\n- Added scoring.\\n- Added level progression.\\n- Added next-piece preview.\\n- Added hold support.\\n- Added pause support.\\n- Added game-over handling.\\n- Verified retry state.\\n');",
    "    fs.writeFileSync(path.join(dir, 'patch.diff'), 'diff --git a/game b/game\\n');",
    "    console.log('actor retry done');",
    "    return;",
    "  }",
    "  if (role === 'critic') {",
    "    fs.writeFileSync(path.join(dir, 'review.md'), '# Review\\n\\nAPPROVED\\n');",
    "    console.log('critic approved');",
    "  }",
    "});"
  ].join("\n");
}

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function waitForTaskDir(workspace: string): Promise<string> {
  const sessionsDir = join(workspace, ".parallel-codex", "sessions");
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const taskId = (await readdir(sessionsDir)).find((entry) => entry.startsWith("task-"));
      if (taskId) {
        return join(sessionsDir, taskId);
      }
    } catch {
      // Startup has not created the sessions directory yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for task directory");
}

async function waitForWorkerPhase(statusPath: string, phase: string): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const status = await readJson(statusPath, WorkerStatusSchema);
      if (status.phase === phase) {
        return;
      }
    } catch {
      // Worker has not written a valid status yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for worker phase ${phase}`);
}

async function waitForTaskState(metaPath: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const meta = await readJson(metaPath, TaskMetaSchema);
      if (meta.status === state) {
        return;
      }
    } catch {
      // Task status is being written.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for task state ${state}`);
}

async function waitForScreenText(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
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

async function waitForFileText(path: string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await readTextIfExists(path)).includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text} in ${path}`);
}
