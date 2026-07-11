import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI Worker overview smoke", () => {
  it("navigates live workers without replacing the one-key log path", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-worker-board-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-board-workspace-"));
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "complex"',
        "",
        "[pairing]",
        'main = "mock"',
        'judge = "mock"',
        'actor = "mock"',
        'critic = "mock"',
        ""
      ].join("\n"),
      "utf8"
    );

    const screen = new NativeTerminalScreen({ cols: 100, rows: 16, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 16,
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
      child.write("\x02");
      await waitForScreenText(() => screenWrites, screen, "No workers yet · start a complex task before opening overview");
      expect(screen.snapshot().split("\n")[0]).toContain("chat");
      child.write("\x1b");

      child.write("实现一个可测试的功能\r");
      await waitForScreenText(() => screenWrites, screen, "done · complex task completed");
      await waitForScreenText(() => screenWrites, screen, "^B workers");

      child.write("\x02");
      await waitForScreenText(() => screenWrites, screen, "Workers");
      await waitForScreenText(() => screenWrites, screen, "Judge (mock)");
      await waitForScreenText(() => screenWrites, screen, "workers · Up/Dn select · Enter logs");
      let snapshot = screen.snapshot();
      expect(snapshot.split("\n")[0]).toContain("workers");
      expect(snapshot).toContain("workers · Up/Dn select · Enter logs");
      expect(snapshot).toContain("> Judge (mock)");

      child.write("\x1b[B");
      await waitForScreenText(() => screenWrites, screen, "> Actor (mock)");
      child.write("\r");
      await waitForScreenText(() => screenWrites, screen, "parallel-codex-tui · logs");
      await waitForScreenText(() => screenWrites, screen, "actor/mock");

      child.write("\x02");
      await waitForScreenText(() => screenWrites, screen, "parallel-codex-tui · workers");
      child.write("\x07");
      await waitForScreenText(() => screenWrites, screen, "Router diagnostics");
      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "parallel-codex-tui · workers");

      child.write("\x10");
      await waitForScreenText(() => screenWrites, screen, "Open project");
      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "parallel-codex-tui · workers");

      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "parallel-codex-tui · logs");
      expect(exits).toEqual([]);
      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 20000);
});

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
