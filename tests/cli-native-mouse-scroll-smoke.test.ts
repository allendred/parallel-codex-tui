import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { defaultConfig } from "../src/core/config.js";
import { writeJson } from "../src/core/file-store.js";
import { NativeSessionSchema, TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";

describe("CLI native mouse scroll smoke", () => {
  it("scrolls the embedded native terminal scrollback with mouse wheel input", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-native-wheel-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-native-wheel-app-"));
    const taskId = "task-20260702-000000-native-wheel";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const agentScript = join(workspace, "fake-agent.cjs");
    const chunks: string[] = [];

    await mkdir(workerDir, { recursive: true });
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      agentScript,
      [
        "for (let i = 1; i <= 80; i += 1) console.log('native line ' + i);",
        "setInterval(() => {}, 1000);"
      ].join("")
    );
    await writeConfig(appRoot, agentScript);
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 120,
        rows: 28,
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
      child.write("\x0f");
      await waitForText(chunks, "native line 80");
      chunks.length = 0;
      child.write("\x1b[<64;10;5M");
      child.write("\x1b[<64;10;5M");
      child.write("\x1b[<64;10;5M");
      await waitForText(chunks, "native line 38");

      expect(chunks.join("")).toContain("native line 38");
      expect(chunks.join("")).toContain("native");
      expect(chunks.join("")).toContain("back ");
      expect(chunks.join("")).not.toContain("Native agent");
    } finally {
      child.write("\x1d");
      child.kill("SIGTERM");
    }
  }, 10000);
});

async function writeConfig(appRoot: string, agentScript: string): Promise<void> {
  const config = defaultConfig(appRoot);
  const text = [
    "[router]",
    'defaultMode = "complex"',
    "",
    "[workers.mock]",
    `command = "${escapeToml(agentScript)}"`,
    "args = []",
    "",
    "[workers.mock.interactive]",
    `command = "${escapeToml(process.execPath)}"`,
    `args = ["${escapeToml(agentScript)}"]`,
    "",
    "[workers.mock.nativeSession]",
    'fallback = "new"',
    "",
    "[pairing]",
    'main = "mock"',
    'judge = "mock"',
    'actor = "mock"',
    'critic = "mock"',
    "",
    "[ui]",
    `showStatusBar = ${config.ui.showStatusBar}`,
    `autoOpenFailedWorker = ${config.ui.autoOpenFailedWorker}`
  ].join("\n");

  await writeFile(join(appRoot, ".parallel-codex", "config.toml"), `${text}\n`);
}

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
      title: "native wheel smoke",
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
      summary: "ready",
      native_session_id: "native-wheel"
    })
  );
  await writeFile(join(input.workerDir, "output.log"), "ready\n");
  await writeJson(
    join(input.workerDir, "native-session.json"),
    NativeSessionSchema.parse({
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-wheel",
      scope: "task",
      cwd: input.workspace,
      created_at: "2026-07-02T00:00:00.000Z",
      last_used_at: "2026-07-02T00:00:00.000Z",
      source: "manual"
    })
  );
}

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
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
