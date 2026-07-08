import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { pathExists, readJson, writeJson, writeText } from "../src/core/file-store.js";
import { NativeSessionSchema } from "../src/domain/schemas.js";
import * as nativeAttach from "../src/workers/native-attach.js";
import { buildNativeAttachLaunch, startNativeAttachProcess } from "../src/workers/native-attach.js";

describe("buildNativeAttachLaunch", () => {
  const originalClaudeProjectsDir = process.env.PARALLEL_CODEX_CLAUDE_PROJECTS_DIR;

  afterEach(() => {
    if (originalClaudeProjectsDir === undefined) {
      delete process.env.PARALLEL_CODEX_CLAUDE_PROJECTS_DIR;
    } else {
      process.env.PARALLEL_CODEX_CLAUDE_PROJECTS_DIR = originalClaudeProjectsDir;
    }
  });

  it("does not expose the old outer-TUI-exiting attach helper", () => {
    expect("attachNativeLaunch" in nativeAttach).toBe(false);
    expect("attachNativeWorker" in nativeAttach).toBe(false);
  });

  it("renders the configured interactive command from the worker native session", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-attach-"));
    const workerDir = join(root, "task-a", "actor-codex");
    await writeJson(join(workerDir, "native-session.json"), {
      engine: "codex",
      role: "actor",
      worker_id: "actor-codex",
      session_id: "native-abc",
      scope: "task",
      cwd: root,
      created_at: "2026-06-30T03:30:00.000Z",
      last_used_at: "2026-06-30T03:30:00.000Z",
      source: "manual"
    });
    const config = defaultConfig(root);
    config.workers.codex.interactive.args = ["resume", "{sessionId}", "--model", "{model}"];
    config.workers.codex.model.name = "gpt-5";

    const launch = await buildNativeAttachLaunch({
      config,
      worker: {
        id: "actor-codex",
        role: "actor",
        engine: "codex",
        label: "Actor (codex)",
        logPath: join(workerDir, "output.log"),
        statusPath: join(workerDir, "status.json")
      }
    });

    expect(launch).toEqual({
      command: "codex",
      args: ["resume", "native-abc", "--model", "gpt-5"],
      cwd: root,
      sessionId: "native-abc",
      label: "Actor (codex)"
    });
  });

  it("fails when the selected worker has no native session file", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-attach-missing-"));
    const workerDir = join(root, "task-a", "critic-claude");

    await expect(
      buildNativeAttachLaunch({
        config: defaultConfig(root),
        worker: {
          id: "critic-claude",
          role: "critic",
          engine: "claude",
          label: "Critic (claude)",
          logPath: join(workerDir, "output.log"),
          statusPath: join(workerDir, "status.json")
        }
      })
    ).rejects.toThrow("No native session recorded");
  });

  it("treats corrupt native session files as missing when attaching", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-attach-corrupt-"));
    const workerDir = join(root, "task-a", "actor-codex");
    await writeText(join(workerDir, "native-session.json"), "{");

    await expect(
      buildNativeAttachLaunch({
        config: defaultConfig(root),
        worker: {
          id: "actor-codex",
          role: "actor",
          engine: "codex",
          label: "Actor (codex)",
          logPath: join(workerDir, "output.log"),
          statusPath: join(workerDir, "status.json")
        }
      })
    ).rejects.toThrow("No native session recorded");
  });

  it("recovers a Claude native session from Claude's project log when the worker file is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-native-attach-claude-log-"));
    const workspace = join(root, "workspace");
    const taskDir = join(workspace, ".parallel-codex", "sessions", "task-a");
    const workerDir = join(taskDir, "critic-claude");
    const prompt = "# Role: Critic\n\nUser request:\n继续优化\n";
    const sessionId = "3dc94406-f446-4cc1-a401-bd19e9a3f70c";
    const claudeProjectsDir = join(root, "claude-projects");
    const claudeProjectDir = join(claudeProjectsDir, workspace.replace(/[^A-Za-z0-9]/g, "-"));
    process.env.PARALLEL_CODEX_CLAUDE_PROJECTS_DIR = claudeProjectsDir;

    await writeJson(join(taskDir, "meta.json"), {
      id: "task-a",
      title: "Task A",
      created_at: "2026-06-30T03:30:00.000Z",
      cwd: workspace,
      mode: "complex",
      status: "done"
    });
    await writeText(join(workerDir, "prompt.md"), prompt);
    await writeText(
      join(claudeProjectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: "queue-operation",
          operation: "enqueue",
          timestamp: "2026-07-01T04:26:00.254Z",
          sessionId,
          content: prompt
        }),
        JSON.stringify({
          type: "user",
          timestamp: "2026-07-01T04:26:00.296Z",
          cwd: workspace,
          sessionId,
          message: {
            role: "user",
            content: prompt
          }
        })
      ].join("\n")
    );

    const launch = await buildNativeAttachLaunch({
      config: defaultConfig(root),
      worker: {
        id: "critic-claude",
        role: "critic",
        engine: "claude",
        label: "Critic (claude)",
        logPath: join(workerDir, "output.log"),
        statusPath: join(workerDir, "status.json")
      }
    });

    expect(launch).toMatchObject({
      command: "claude",
      args: ["--resume", sessionId],
      cwd: workspace,
      sessionId,
      label: "Critic (claude)"
    });
    expect(await pathExists(join(workerDir, "native-session.json"))).toBe(true);
    const record = await readJson(join(workerDir, "native-session.json"), NativeSessionSchema);
    expect(record).toMatchObject({
      engine: "claude",
      role: "critic",
      worker_id: "critic-claude",
      session_id: sessionId,
      cwd: workspace,
      source: "claude-project-log"
    });
  });

  it("starts an embedded native process with writable input and captured output", async () => {
    const output: string[] = [];
    const closed: number[] = [];
    const script = [
      "console.log('ready');",
      "process.stdin.on('data', chunk => {",
      "  const text = chunk.toString('utf8').trim();",
      "  console.log('input:' + text);",
      "  if (text === 'exit') process.exit(0);",
      "});"
    ].join("");

    const processRef = startNativeAttachProcess(
      {
        command: process.execPath,
        args: ["-e", script],
        cwd: process.cwd(),
        sessionId: "native-node",
        label: "Actor (node)"
      },
      {
        onOutput: (chunk) => output.push(chunk),
        onClose: (code) => closed.push(code)
      }
    );

    await waitForText(output, "ready");
    processRef.write("hello\n");
    await waitForText(output, "input:hello");
    processRef.write("exit\n");
    await waitForClose(closed);

    expect(output.join("")).toContain("input:hello");
    expect(closed).toEqual([0]);
  });

  it("forwards Chinese text and terminal control sequences to the embedded native process", async () => {
    const output: string[] = [];
    const closed: number[] = [];
    const script = [
      "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
      "process.stdin.setEncoding('utf8');",
      "let input = '';",
      "console.log('ready');",
      "process.stdin.on('data', chunk => {",
      "  input += chunk;",
      "  if (input.includes('DONE')) {",
      "    console.log('received:' + JSON.stringify(input));",
      "    process.exit(0);",
      "  }",
      "});"
    ].join("");

    const processRef = startNativeAttachProcess(
      {
        command: process.execPath,
        args: ["-e", script],
        cwd: process.cwd(),
        sessionId: "native-node",
        label: "Actor (node)"
      },
      {
        onOutput: (chunk) => output.push(chunk),
        onClose: (code) => closed.push(code)
      }
    );

    await waitForText(output, "ready");
    processRef.write("\x1b[200~做个俄罗斯方块的游戏\x1b[201~");
    processRef.write("\x1b");
    processRef.write("\x1b[5~");
    processRef.write("DONE");
    await waitForClose(closed);

    expect(output.join("")).toContain(
      'received:"\\u001b[200~做个俄罗斯方块的游戏\\u001b[201~\\u001b\\u001b[5~DONE"'
    );
    expect(closed).toEqual([0]);
  });

  it("starts the embedded native process with a TTY stdin", async () => {
    const output: string[] = [];
    const closed: number[] = [];
    const script = [
      "console.log('stdin-is-tty:' + Boolean(process.stdin.isTTY));",
      "process.exit(process.stdin.isTTY ? 0 : 1);"
    ].join("");

    startNativeAttachProcess(
      {
        command: process.execPath,
        args: ["-e", script],
        cwd: process.cwd(),
        sessionId: "native-node",
        label: "Actor (node)"
      },
      {
        onOutput: (chunk) => output.push(chunk),
        onClose: (code) => closed.push(code)
      }
    );

    await waitForClose(closed);

    expect(output.join("")).toContain("stdin-is-tty:true");
    expect(closed).toEqual([0]);
  });

  it("starts the embedded native process with the requested terminal size", async () => {
    const output: string[] = [];
    const closed: number[] = [];
    const script = [
      "console.log(`size:${process.stdout.columns}x${process.stdout.rows}`);",
      "process.exit(process.stdout.columns === 42 && process.stdout.rows === 9 ? 0 : 1);"
    ].join("");
    const launch = {
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      sessionId: "native-node",
      label: "Actor (node)",
      cols: 42,
      rows: 9
    };

    startNativeAttachProcess(launch, {
      onOutput: (chunk) => output.push(chunk),
      onClose: (code) => closed.push(code)
    });

    await waitForClose(closed);

    expect(output.join("")).toContain("size:42x9");
    expect(closed).toEqual([0]);
  });
});

async function waitForText(chunks: string[], text: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (chunks.join("").includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${text}`);
}

async function waitForClose(codes: number[]): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (codes.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for native attach close");
}
