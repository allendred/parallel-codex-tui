import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node-pty";
import { describe, expect, it } from "vitest";
import { pathExists, readTextIfExists } from "../src/core/file-store.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI role configuration smoke", () => {
  it("applies a next-request provider from the real TUI and consumes it during execution", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-role-workspace-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-role-app-"));
    const agentScript = join(appRoot, "role-agent.cjs");
    const nextConfigurationPath = join(workspace, ".parallel-codex", "role-configuration.next.json");
    const observedPath = join(
      workspace,
      ".parallel-codex",
      "sessions",
      "main",
      "main-beta",
      "provider-observed.json"
    );
    const screen = new NativeTerminalScreen({ cols: 112, rows: 24, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(agentScript, roleAgentSource());
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "simple"',
        "",
        "[workers.alpha]",
        'extends = "generic"',
        `command = "${escapeToml(process.execPath)}"`,
        `args = ["${escapeToml(agentScript)}", "alpha"]`,
        "timeoutMs = 10000",
        "idleTimeoutMs = 5000",
        "firstOutputTimeoutMs = 3000",
        "",
        "[workers.alpha.model]",
        'name = "alpha-model"',
        'provider = "alpha-provider"',
        'args = ["--model", "{model}", "--provider", "{provider}"]',
        "",
        "[workers.beta]",
        'extends = "generic"',
        `command = "${escapeToml(process.execPath)}"`,
        `args = ["${escapeToml(agentScript)}", "beta"]`,
        "timeoutMs = 10000",
        "idleTimeoutMs = 5000",
        "firstOutputTimeoutMs = 3000",
        "",
        "[workers.beta.model]",
        'name = "beta-model"',
        'provider = "beta-provider"',
        'args = ["--model", "{model}", "--provider", "{provider}"]',
        "",
        "[pairing]",
        'main = "alpha"',
        'judge = "alpha"',
        'actor = "alpha"',
        'critic = "alpha"'
      ].join("\n") + "\n"
    );

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 112,
        rows: 24,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );
    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "> | message");
      child.write("\x05");
      await waitForScreenText(() => screenWrites, screen, "Role & model control");
      await waitForScreenText(() => screenWrites, screen, "> Main    alpha · alpha-provider/alpha-model");

      child.write("\x1b[C");
      await waitForScreenText(() => screenWrites, screen, "> Main    beta · beta-provider/beta-model");
      child.write("\r");
      await waitForPath(nextConfigurationPath);

      expect(JSON.parse(await readTextIfExists(nextConfigurationPath))).toMatchObject({
        version: 1,
        roles: {
          main: { engine: "beta", model: "beta-model" },
          judge: { engine: "alpha", model: "alpha-model" },
          actor: { engine: "alpha", model: "alpha-model" },
          critic: { engine: "alpha", model: "alpha-model" }
        }
      });

      child.write("\x05");
      await waitForScreenText(() => screenWrites, screen, "> | message");
      child.write("verify role selection\r");
      await waitForPath(observedPath);

      expect(JSON.parse(await readTextIfExists(observedPath))).toEqual({
        channel: "beta",
        args: ["--model", "beta-model", "--provider", "beta-provider"]
      });
      await waitForMissingPath(nextConfigurationPath);
      await waitForScreenText(() => screenWrites, screen, "beta reply");

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

function roleAgentSource(): string {
  return [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const channel = process.argv[2];",
    "const args = process.argv.slice(3);",
    "const dir = process.env.PARALLEL_CODEX_FILES_DIR;",
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  fs.mkdirSync(dir, { recursive: true });",
    "  fs.writeFileSync(path.join(dir, 'provider-observed.json'), JSON.stringify({ channel, args }));",
    "  console.log(`${channel} reply`);",
    "});"
  ].join("\n");
}

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await pathExists(path)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for path ${path}`);
}

async function waitForMissingPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!(await pathExists(path))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for path removal ${path}`);
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
