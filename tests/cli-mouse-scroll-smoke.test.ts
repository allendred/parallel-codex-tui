import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { writeJson } from "../src/core/file-store.js";
import { TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";

describe("CLI worker log scroll smoke", () => {
  it("scrolls worker logs with SGR mouse wheel input", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-wheel-"));
    const taskId = "task-20260702-000000-wheel";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const chunks: string[] = [];

    await mkdir(workerDir, { recursive: true });
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspace", workspace, "--task", taskId],
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

    child.onData((chunk) => chunks.push(chunk));
    try {
      await waitForText(chunks, "attach");
      child.write("\x1b[<64;10;5M");
      await waitForText(chunks, "tail");
      child.write("\x1b[<64;10;5M");
      await waitForText(chunks, "back 3/");
      child.write("\x1b[<65;10;5M");
      await waitForText(chunks, "tail");

      expect(chunks.join("")).toContain("back 3/");
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
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspace", workspace, "--task", taskId],
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
      child.write("\x17");
      await waitForText(chunks, "tail");
      child.write("\x1b[5~");
      await waitForText(chunks, "back 20/");
      child.write("\x1b[6~");
      await waitForText(chunks, "tail");

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

async function waitForText(chunks: string[], text: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (chunks.join("").includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text}\nOutput:\n${chunks.join("")}`);
}
