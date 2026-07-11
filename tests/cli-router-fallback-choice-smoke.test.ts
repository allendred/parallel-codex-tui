import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { pathExists, readTextIfExists } from "../src/core/file-store.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI Router fallback choice", () => {
  it("retries Codex routing and records both attempts before following the decision", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-router-choice-retry-workspace-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-router-choice-retry-app-"));
    const routerScript = join(appRoot, "retry-router.cjs");
    const countPath = join(appRoot, "router-count.txt");
    await writeFile(routerScript, [
      "const fs = require('node:fs');",
      `const countPath = ${JSON.stringify(countPath)};`,
      "const count = Number(fs.existsSync(countPath) ? fs.readFileSync(countPath, 'utf8') : '0') + 1;",
      "fs.writeFileSync(countPath, String(count));",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  if (count === 1) {",
      "    process.stderr.write('first attempt stalled\\n');",
      "    setInterval(() => {}, 1000);",
      "    return;",
      "  }",
      "  process.stdout.write(JSON.stringify({ mode: 'simple', reason: 'retry succeeded' }));",
      "});"
    ].join("\n"));
    await writeConfig(appRoot, routerScript, 450);

    const session = startCli(appRoot, workspace);
    try {
      await waitForScreenText(session, "> | message");
      session.child.write("你好\r");
      await waitForScreenText(session, "route failed · 1 Main · 2 Parallel · R retry · Esc cancel");
      session.child.write("r");
      await waitForScreenText(session, "Mock simple response for: 你好");

      const records = await readRouteAudit(appRoot);
      expect(records).toEqual([
        expect.objectContaining({
          source: "fallback",
          router_attempt: 1,
          router_fallback_resolution: "retry"
        }),
        expect.objectContaining({
          source: "codex",
          mode: "simple",
          router_attempt: 2
        })
      ]);
      expect(await readTextIfExists(countPath)).toBe("2");
      await stopCli(session);
    } finally {
      session.dispose();
    }
  }, 15000);

  it("starts a real parallel task when the user chooses Parallel", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-router-choice-parallel-workspace-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-router-choice-parallel-app-"));
    const routerScript = join(appRoot, "failed-router.cjs");
    await writeFile(routerScript, [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stderr.write('router unavailable\\n');",
      "  process.exitCode = 2;",
      "});"
    ].join("\n"));
    await writeConfig(appRoot, routerScript, 1000);

    const session = startCli(appRoot, workspace);
    try {
      await waitForScreenText(session, "> | message");
      session.child.write("实现一个功能\r");
      await waitForScreenText(session, "route failed · 1 Main · 2 Parallel · R retry · Esc cancel");
      session.child.write("2");
      await waitForScreenText(session, "done · complex task completed");

      const records = await readRouteAudit(appRoot);
      expect(records).toEqual([
        expect.objectContaining({
          mode: "complex",
          source: "fallback",
          router_attempt: 1,
          router_fallback_resolution: "parallel"
        })
      ]);
      expect(await pathExists(join(workspace, ".parallel-codex", "sessions"))).toBe(true);
      await stopCli(session);
    } finally {
      session.dispose();
    }
  }, 15000);

  it("cancels at the fallback prompt without starting Main or task workers", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-router-choice-cancel-workspace-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-router-choice-cancel-app-"));
    const routerScript = join(appRoot, "stalled-router.cjs");
    await writeFile(routerScript, "process.stderr.write('waiting\\n'); setInterval(() => {}, 1000);\n");
    await writeConfig(appRoot, routerScript, 450);

    const session = startCli(appRoot, workspace);
    try {
      await waitForScreenText(session, "> | message");
      session.child.write("不要继续\r");
      await waitForScreenText(session, "route failed · 1 Main · 2 Parallel · R retry · Esc cancel");
      session.child.write("\x1b");
      await waitForScreenText(session, "cancelled · request stopped");

      const records = await readRouteAudit(appRoot);
      expect(records).toEqual([
        expect.objectContaining({
          source: "fallback",
          router_attempt: 1,
          router_fallback_resolution: "cancelled"
        })
      ]);
      expect(await pathExists(join(workspace, ".parallel-codex", "sessions", "main", "main-mock"))).toBe(false);
      await stopCli(session);
    } finally {
      session.dispose();
    }
  }, 15000);
});

interface CliSession {
  child: ReturnType<typeof spawn>;
  screen: NativeTerminalScreen;
  screenWrites: () => Promise<void>;
  exits: number[];
  dispose: () => void;
}

function startCli(appRoot: string, workspace: string): CliSession {
  const screen = new NativeTerminalScreen({ cols: 100, rows: 14, scrollback: 1000 });
  const exits: number[] = [];
  let writes = Promise.resolve();
  const child = spawn(
    process.execPath,
    ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
    {
      cwd: process.cwd(),
      cols: 100,
      rows: 14,
      name: "xterm-256color",
      env: { ...process.env, TERM: "xterm-256color" }
    }
  );
  child.onData((chunk) => {
    writes = writes.then(() => screen.write(chunk));
  });
  child.onExit(({ exitCode }) => exits.push(exitCode));
  return {
    child,
    screen,
    screenWrites: () => writes,
    exits,
    dispose: () => {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  };
}

async function writeConfig(appRoot: string, routerScript: string, timeoutMs: number): Promise<void> {
  await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
  await writeFile(join(appRoot, ".parallel-codex", "config.toml"), [
    "[router]",
    'defaultMode = "auto"',
    "",
    "[router.codex]",
    `command = "${escapeToml(process.execPath)}"`,
    `args = ["${escapeToml(routerScript)}"]`,
    `timeoutMs = ${timeoutMs}`,
    'fallback = "simple"',
    "",
    "[pairing]",
    'main = "mock"',
    'judge = "mock"',
    'actor = "mock"',
    'critic = "mock"',
    ""
  ].join("\n"));
}

async function readRouteAudit(appRoot: string): Promise<Array<Record<string, unknown>>> {
  return (await readTextIfExists(join(appRoot, ".parallel-codex", "router", "routes.jsonl")))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function waitForScreenText(session: CliSession, text: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await session.screenWrites();
    if (session.screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text}\nSnapshot:\n${session.screen.snapshot()}`);
}

async function stopCli(session: CliSession): Promise<void> {
  session.child.write("\x03");
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (session.exits.length > 0) {
      expect(session.exits[0]).toBe(0);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for CLI exit");
}

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
