import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { writeJson } from "../src/core/file-store.js";
import { TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI worker log scroll smoke", () => {
  it("scrolls worker logs with SGR mouse wheel input", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-wheel-"));
    const taskId = "task-20260702-000000-wheel";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const chunks: string[] = [];
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
    try {
      await waitForText(chunks, "attach");
      await screenWrites;
      child.write("\x1b[<65;10;5M");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await screenWrites;
      expect(screen.snapshot().split("\n")[0]).toContain("chat");
      expect(screen.snapshot().split("\n")[0]).not.toContain("logs");

      let outputCursor = chunks.length;
      child.write("\x1b[<64;10;5M");
      child.write("\x1b[<64;10;5M");
      child.write("\x1b[<64;10;5M");
      await waitForText(chunks, "back 9/", outputCursor);
      await settleScreen(() => screenWrites);
      expect(screen.snapshot()).toContain("back 9/");
      outputCursor = chunks.length;
      child.write("\x1b[<65;10;5M");
      child.write("\x1b[<65;10;5M");
      child.write("\x1b[<65;10;5M");
      await waitForText(chunks, "tail", outputCursor);
      await settleScreen(() => screenWrites);
      expect(screen.snapshot()).toContain("tail");
      expect(screen.snapshot()).not.toContain("back 9/");

      expect(chunks.join("")).toContain("back 9/");
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("scrolls worker logs with PageUp and PageDown", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-page-scroll-"));
    const taskId = "task-20260702-000000-page-scroll";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const chunks: string[] = [];

    await mkdir(workerDir, { recursive: true });
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 24,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );

    child.onData((chunk) => chunks.push(chunk));
    try {
      await waitForText(chunks, "attach");
      await writeUntilText(child, chunks, "\x17", "tail");
      await writeUntilText(child, chunks, "\x1b[5~", "back 20/");
      await writeUntilText(child, chunks, "\x1b[6~", "tail");

      expect(chunks.join("")).toContain("back 20/");
    } finally {
      child.kill("SIGTERM");
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
      title: "wheel smoke",
      created_at: "2026-07-02T00:00:00.000Z",
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
      last_event_at: "2026-07-02T00:00:00.000Z",
      summary: "ready"
    })
  );
  await writeFile(
    join(input.workerDir, "output.log"),
    Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join("\n")
  );
}

async function writeUntilText(
  child: { write(input: string): void },
  chunks: string[],
  input: string,
  text: string
): Promise<void> {
  const startIndex = chunks.length;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    child.write(input);
    try {
      await waitForText(chunks, text, startIndex, 6);
      return;
    } catch {
      // Try the shortcut again in case the TUI had not entered raw mode yet.
    }
  }
  await waitForText(chunks, text, startIndex);
}

async function waitForText(chunks: string[], text: string, startIndex = 0, maxAttempts = 120): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (chunks.slice(startIndex).join("").includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text}\nOutput:\n${chunks.join("")}`);
}

async function settleScreen(screenWrites: () => Promise<void>): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await screenWrites();
}
