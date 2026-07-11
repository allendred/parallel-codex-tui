import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { pathExists, readTextIfExists } from "../src/core/file-store.js";
import { prepareWorkspace } from "../src/core/workspace.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI workspace switch smoke", () => {
  it("switches workspaces without exiting and restores isolated chat state", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-switch-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-switch-projects-"));
    const first = join(workspaceRoot, "first-project");
    const second = join(workspaceRoot, "second-project");
    await prepareWorkspace(appRoot, first);
    await prepareWorkspace(appRoot, second);
    await writeHistory(first, "first-only memory");
    await writeHistory(second, "second-only memory");
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "simple"',
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

    const screen = new NativeTerminalScreen({ cols: 90, rows: 20, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", first],
      {
        cwd: process.cwd(),
        cols: 90,
        rows: 20,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );
    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "first-only memory");
      await waitForScreenText(() => screenWrites, screen, "^P project");
      expect(screen.snapshot().split("\n")[0]).toContain(basename(first));

      child.write("draft survives");
      await waitForScreenText(() => screenWrites, screen, "> draft survives|");
      child.write("\x10");
      await waitForScreenText(() => screenWrites, screen, "Open project");
      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "> draft survives|");

      child.write("\r");
      await waitForScreenText(() => screenWrites, screen, "Mock simple response for: draft survives");
      await waitForScreenText(() => screenWrites, screen, "> | message · ^W logs");
      child.write("\x10");
      await waitForScreenText(() => screenWrites, screen, "Open project");
      child.write("2");
      await waitForScreenText(() => screenWrites, screen, "second-only memory");

      let snapshot = screen.snapshot();
      expect(snapshot.split("\n")[0]).toContain(basename(second));
      expect(snapshot).not.toContain("first-only memory");
      expect(snapshot).not.toContain("draft survives");
      expect(exits).toEqual([]);

      child.write("second question\r");
      await waitForScreenText(() => screenWrites, screen, "Mock simple response for: second question");
      await waitForScreenText(() => screenWrites, screen, "> | message · ^W logs");

      child.write("\x10");
      await waitForScreenText(() => screenWrites, screen, "Open project");
      child.write("2");
      await waitForScreenText(() => screenWrites, screen, "Mock simple response for: draft survives");

      snapshot = screen.snapshot();
      expect(snapshot.split("\n")[0]).toContain(basename(first));
      expect(snapshot).toContain("first-only memory");
      expect(snapshot).not.toContain("second-only memory");
      expect(snapshot).not.toContain("second question");
      expect(exits).toEqual([]);

      const firstHistory = await readTextIfExists(join(first, ".parallel-codex", "sessions", "main", "chat.jsonl"));
      const secondHistory = await readTextIfExists(join(second, ".parallel-codex", "sessions", "main", "chat.jsonl"));
      const routeAudit = await readTextIfExists(join(appRoot, ".parallel-codex", "router", "routes.jsonl"));
      expect(firstHistory).toContain("draft survives");
      expect(firstHistory).not.toContain("second question");
      expect(secondHistory).toContain("second question");
      expect(secondHistory).not.toContain("draft survives");
      expect(routeAudit).toContain(`"workspace":"${first}"`);
      expect(routeAudit).toContain(`"workspace":"${second}"`);

      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 20000);

  it("creates and opens a new workspace from the running TUI", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-create-app-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-create-projects-"));
    const existing = join(workspaceRoot, "existing-project");
    const created = join(workspaceRoot, "created-project");
    await prepareWorkspace(appRoot, existing);
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      ["[router]", 'defaultMode = "simple"', ""].join("\n"),
      "utf8"
    );

    const screen = new NativeTerminalScreen({ cols: 90, rows: 20, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", existing],
      {
        cwd: process.cwd(),
        cols: 90,
        rows: 20,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );
    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "^P project");
      child.write("\x10");
      await waitForScreenText(() => screenWrites, screen, "Open project");
      child.write("n");
      await waitForScreenText(() => screenWrites, screen, "Workspace path");
      child.write(`${created}\r`);
      await waitForScreenText(() => screenWrites, screen, basename(created));
      await waitForScreenText(() => screenWrites, screen, "> | message · ^P project");

      expect(screen.snapshot().split("\n")[0]).toContain(basename(created));
      expect(await pathExists(join(created, ".parallel-codex", "session-index.sqlite"))).toBe(true);
      expect(exits).toEqual([]);

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

async function writeHistory(workspace: string, text: string): Promise<void> {
  const directory = join(workspace, ".parallel-codex", "sessions", "main");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "chat.jsonl"), `${JSON.stringify({
    time: "2026-07-11T00:00:00.000Z",
    from: "system",
    text
  })}\n`, "utf8");
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

async function waitForExit(exits: number[]): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (exits.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for TUI to exit");
}
