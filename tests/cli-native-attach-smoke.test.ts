import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { defaultConfig } from "../src/core/config.js";
import { writeJson } from "../src/core/file-store.js";
import { NativeSessionSchema, TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";

describe("CLI native attach smoke", () => {
  it("forwards model configuration, Chinese text, and terminal controls to the native agent", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-native-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-native-app-"));
    const taskId = "task-20260702-000000-smoke";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const agentScript = join(workspace, "fake-agent.cjs");
    const receivedPath = join(workspace, "received.txt");
    const launchPath = join(workspace, "launch.json");
    const chunks: string[] = [];

    await mkdir(workerDir, { recursive: true });
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      agentScript,
      [
        `require('node:fs').writeFileSync(${JSON.stringify(launchPath)}, JSON.stringify({ argv: process.argv.slice(2), endpoint: process.env.MODEL_ENDPOINT, secret: process.env.MODEL_SECRET }));`,
        "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
        "process.stdin.setEncoding('utf8');",
        "let input = '';",
        "console.log('fake-agent-ready');",
        "process.stdin.on('data', chunk => {",
        "  input += chunk;",
        "  if (input.includes('DONE')) {",
        `    require('node:fs').writeFileSync(${JSON.stringify(receivedPath)}, input);`,
        "    console.log('agent-received:' + JSON.stringify(input));",
        "  }",
        "});"
      ].join("")
    );
    await writeConfig(appRoot, agentScript);
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 160,
        rows: 36,
        name: "xterm-256color",
        env: {
          ...process.env,
          PCT_NATIVE_MODEL_ENDPOINT: "https://gateway.example/v1",
          PCT_NATIVE_MODEL_SECRET: "smoke-secret",
          TERM: "xterm-256color"
        }
      }
    );

    child.onData((chunk) => chunks.push(chunk));
    try {
      await waitForText(chunks, "attach");
      child.write("\x0f");
      await waitForText(chunks, "fake-agent-ready");
      expect(JSON.parse(await readFile(launchPath, "utf8"))).toEqual({
        argv: ["--model", "vendor-coder-v2", "--provider", "acme-gateway"],
        endpoint: "https://gateway.example/v1",
        secret: "smoke-secret"
      });
      expect(chunks.join("")).not.toContain("smoke-secret");
      child.write("\x1b[200~做个俄罗斯方块的游戏\x1b[201~");
      child.write("\x1b");
      child.write("\x1b[5~");
      child.write("DONE");

      await waitForText(chunks, "agent-received:");
      expect(chunks.join("")).toContain("做个俄罗斯方块的游戏");
      expect(await readFile(receivedPath, "utf8")).toBe(
        "\x1b[200~做个俄罗斯方块的游戏\x1b[201~\x1b\x1b[5~DONE"
      );
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
    "[workers.mock.model]",
    'name = "vendor-coder-v2"',
    'provider = "acme-gateway"',
    'args = ["--model", "{model}", "--provider", "{provider}"]',
    "",
    "[workers.mock.model.env]",
    'MODEL_ENDPOINT = "{env:PCT_NATIVE_MODEL_ENDPOINT}"',
    'MODEL_SECRET = "{env:PCT_NATIVE_MODEL_SECRET}"',
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
      title: "native smoke",
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
      native_session_id: "native-smoke"
    })
  );
  await writeFile(join(input.workerDir, "output.log"), "ready\n");
  await writeJson(
    join(input.workerDir, "native-session.json"),
    NativeSessionSchema.parse({
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: "native-smoke",
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
