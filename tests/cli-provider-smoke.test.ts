import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { readJson, readTextIfExists } from "../src/core/file-store.js";
import { TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI named Worker provider smoke", () => {
  it("runs role-specific compatible providers and persists the actual model snapshot", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-provider-workspace-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-provider-app-"));
    const agentScript = join(appRoot, "provider-agent.cjs");
    const screen = new NativeTerminalScreen({ cols: 110, rows: 22, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(agentScript, providerAgentSource());
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "complex"',
        "",
        "[workers.openai_compat]",
        'extends = "generic"',
        `command = "${escapeToml(process.execPath)}"`,
        `args = ["${escapeToml(agentScript)}", "openai"]`,
        "timeoutMs = 10000",
        "idleTimeoutMs = 5000",
        "firstOutputTimeoutMs = 3000",
        "",
        "[workers.openai_compat.model]",
        'name = "openai-third-party-model"',
        'provider = "openai-compatible"',
        'args = ["--model", "{model}", "--provider", "{provider}"]',
        "",
        "[workers.openai_compat.model.env]",
        'PROVIDER_TOKEN = "{env:OPENAI_COMPAT_TOKEN}"',
        "",
        "[workers.anthropic_compat]",
        'extends = "generic"',
        `command = "${escapeToml(process.execPath)}"`,
        `args = ["${escapeToml(agentScript)}", "anthropic"]`,
        "timeoutMs = 10000",
        "idleTimeoutMs = 5000",
        "firstOutputTimeoutMs = 3000",
        "",
        "[workers.anthropic_compat.model]",
        'name = "anthropic-third-party-model"',
        'provider = "anthropic-compatible"',
        'args = ["--model", "{model}", "--provider", "{provider}"]',
        "",
        "[workers.anthropic_compat.model.env]",
        'PROVIDER_TOKEN = "{env:ANTHROPIC_COMPAT_TOKEN}"',
        "",
        "[pairing]",
        'main = "anthropic_compat"',
        'judge = "openai_compat"',
        'actor = "openai_compat"',
        'critic = "anthropic_compat"'
      ].join("\n") + "\n"
    );

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 110,
        rows: 22,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color",
          OPENAI_COMPAT_TOKEN: "openai-secret",
          ANTHROPIC_COMPAT_TOKEN: "anthropic-secret"
        }
      }
    );
    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "> | message");
      child.write("使用第三方模型完成 provider 测试\r");
      const taskDir = await waitForTaskDir(workspace);
      await waitForTaskState(join(taskDir, "meta.json"), "done");
      await waitForScreenText(() => screenWrites, screen, "done · complex task completed");

      const actorDir = join(taskDir, "actor-openai_compat");
      const criticDir = join(taskDir, "critic-anthropic_compat");
      const actor = await readJson(join(actorDir, "status.json"), WorkerStatusSchema);
      const critic = await readJson(join(criticDir, "status.json"), WorkerStatusSchema);
      expect(actor).toMatchObject({
        engine: "openai_compat",
        model_name: "openai-third-party-model",
        model_provider: "openai-compatible",
        state: "done"
      });
      expect(critic).toMatchObject({
        engine: "anthropic_compat",
        model_name: "anthropic-third-party-model",
        model_provider: "anthropic-compatible",
        state: "done"
      });
      expect(JSON.parse(await readTextIfExists(join(actorDir, "provider-observed.json")))).toEqual({
        channel: "openai",
        args: ["--model", "openai-third-party-model", "--provider", "openai-compatible"],
        token: "openai-secret"
      });
      expect(JSON.parse(await readTextIfExists(join(criticDir, "provider-observed.json")))).toEqual({
        channel: "anthropic",
        args: ["--model", "anthropic-third-party-model", "--provider", "anthropic-compatible"],
        token: "anthropic-secret"
      });
      expect(await readTextIfExists(join(workspace, "provider-result.txt"))).toBe("provider integration complete\n");

      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 30000);
});

function providerAgentSource(): string {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const channel = process.argv[2];",
    "const args = process.argv.slice(3);",
    "const role = process.env.PARALLEL_CODEX_ROLE;",
    "const workerId = process.env.PARALLEL_CODEX_WORKER_ID;",
    "const dir = process.env.PARALLEL_CODEX_FILES_DIR;",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  fs.writeFileSync(path.join(dir, 'provider-observed.json'), JSON.stringify({channel,args,token:process.env.PROVIDER_TOKEN}));",
    "  if (role === 'judge' && workerId.includes('-final-')) {",
    "    fs.writeFileSync(path.join(dir, 'final-acceptance.json'), JSON.stringify({version:1,decision:'approved',summary:'provider integration verified',acceptance:[{criterion_id:'A-001',status:'passed',evidence:'provider-result.txt integrated'}],changed_paths:['provider-result.txt']}));",
    "    console.log('final judge approved');",
    "    return;",
    "  }",
    "  if (role === 'judge') {",
    "    fs.writeFileSync(path.join(dir, 'requirements.md'), '# Requirements\\n\\n- [R-001] Run role-specific providers.\\n');",
    "    fs.writeFileSync(path.join(dir, 'plan.md'), '# Plan\\n\\n1. [P-001] Implement provider flow.\\n');",
    "    fs.writeFileSync(path.join(dir, 'acceptance.md'), '# Acceptance\\n\\n- [A-001] [R-001] provider-result.txt is integrated.\\n');",
    "    fs.writeFileSync(path.join(dir, 'actor-brief.md'), '# Actor Brief\\n\\nWrite the provider result.\\n');",
    "    fs.writeFileSync(path.join(dir, 'critic-brief.md'), '# Critic Brief\\n\\nVerify the provider result.\\n');",
    "    fs.writeFileSync(path.join(dir, 'features.json'), JSON.stringify({version:1,features:[{id:'provider-flow',title:'Provider flow',description:'Exercise named providers',depends_on:[]}]}));",
    "    console.log('judge planned provider flow');",
    "    return;",
    "  }",
    "  if (role === 'actor') {",
    "    fs.writeFileSync(path.join(process.cwd(), 'provider-result.txt'), 'provider integration complete\\n');",
    "    fs.writeFileSync(path.join(dir, 'worklog.md'), '# Worklog\\n\\nProvider flow implemented.\\n');",
    "    console.log('actor completed provider flow');",
    "    return;",
    "  }",
    "  if (role === 'critic') {",
    "    fs.writeFileSync(path.join(dir, 'review.md'), '# Review\\n\\nAPPROVED\\n\\nProvider flow verified.\\n');",
    "    console.log('critic approved provider flow');",
    "  }",
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

async function waitForTaskState(metaPath: string, state: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
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

async function waitForScreenText(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
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
