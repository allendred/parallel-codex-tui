import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { readTextIfExists } from "../src/core/file-store.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI router config reload smoke", () => {
  it("applies changed router settings to the next request without restarting the TUI", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-router-reload-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-router-reload-workspace-"));
    const configPath = join(appRoot, ".parallel-codex", "config.toml");
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(configPath, routerConfig("simple"), "utf8");

    const screen = new NativeTerminalScreen({ cols: 80, rows: 20, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 80,
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
      child.write("你好\r");
      await waitForScreenText(() => screenWrites, screen, "Mock simple response for: 你好");
      await waitForIdleInput(() => screenWrites, screen);

      await writeFile(configPath, routerConfig("complex"), "utf8");
      child.write("实现热加载\r");
      await waitForScreenText(() => screenWrites, screen, "done · complex task completed");
      await waitForIdleInput(() => screenWrites, screen);

      const completedScreen = screen.snapshot().split("\n");
      const summaryRow = completedScreen.findIndex((line) => line.includes("done · complex task completed"));
      const inputRow = completedScreen.findIndex((line) => line.includes("> | message"));
      expect(completedScreen[1]).toContain("> 实现热加载");
      expect(completedScreen.join("\n")).not.toContain("Mock simple response for: 你好");
      expect(summaryRow).toBeGreaterThan(1);
      expect(inputRow - summaryRow).toBeGreaterThan(5);

      const sessionsDir = join(workspace, ".parallel-codex", "sessions");
      const taskId = (await readdir(sessionsDir)).find((entry) => entry.startsWith("task-"));
      expect(taskId).toEqual(expect.stringMatching(/^task-/));
      expect(await readTextIfExists(join(sessionsDir, taskId ?? "", "route.json"))).toContain(
        "Forced complex mode from config."
      );

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

function routerConfig(mode: "simple" | "complex"): string {
  return [
    "[router]",
    `defaultMode = "${mode}"`,
    "",
    "[pairing]",
    'main = "mock"',
    'judge = "mock"',
    'actor = "mock"',
    'critic = "mock"',
    ""
  ].join("\n");
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

async function waitForIdleInput(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen
): Promise<void> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    await screenWritesRef();
    if (screen.snapshot().split("\n").some((line) => line.includes("> | message"))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for idle input\nSnapshot:\n${screen.snapshot()}`);
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
