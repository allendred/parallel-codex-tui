import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { pathExists } from "../src/core/file-store.js";
import { prepareWorkspace } from "../src/core/workspace.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";
import { TUI_THEME_PRESETS } from "../src/tui/theme.js";

describe("CLI workspace picker smoke", () => {
  it("opens a two-digit recent project shortcut from separate PTY keypresses", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-picker-two-digit-"));
    const projects = Array.from({ length: 10 }, (_, index) => join(appRoot, `project-${index + 1}`));
    for (const project of projects) {
      await prepareWorkspace(appRoot, project);
    }
    const screen = new NativeTerminalScreen({ cols: 84, rows: 18, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot],
      {
        cwd: process.cwd(),
        cols: 84,
        rows: 18,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );

    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "Open project");
      child.write("1");
      await new Promise((resolve) => setTimeout(resolve, 50));
      child.write("0");
      await waitForScreenText(() => screenWrites, screen, "> | message");

      const header = lineText(screen.styledSnapshotLines()[0]);
      expect(header).toContain("· project-1 ·");
      expect(header).not.toContain("· project-10 ·");
      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 10000);

  it("selects a recent project with arrow keys and clears the picker before chat", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-picker-"));
    const first = join(appRoot, "first-project");
    const second = join(appRoot, "second-project");
    const screen = new NativeTerminalScreen({ cols: 84, rows: 18, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();

    await prepareWorkspace(appRoot, first);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await prepareWorkspace(appRoot, second);

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--theme", "paper"],
      {
        cwd: process.cwd(),
        cols: 84,
        rows: 18,
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
      await waitForScreenText(() => screenWrites, screen, "Open project");
      const pickerLines = await waitForThemedPickerFill(() => screenWrites, screen, 18);
      const pickerHeader = pickerLines.find((line) => lineText(line).includes("parallel-codex-tui"));
      const initiallySelected = await waitForSelectedProject(() => screenWrites, screen, "second-project");

      expect(pickerLines).toHaveLength(18);
      expect(pickerLines.at(-1)?.chunks.some((chunk) => (
        chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.surface
      ))).toBe(true);
      expect(lineText(pickerHeader)).toContain("workspace");
      expect(pickerHeader?.chunks.some((chunk) => (
        chunk.text.includes("parallel-codex-tui") &&
        chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.chrome &&
        chunk.style.color === TUI_THEME_PRESETS.paper.accent &&
        chunk.style.bold
      ))).toBe(true);
      expect(initiallySelected?.chunks.some((chunk) => (
        chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.rail && chunk.style.bold
      ))).toBe(true);

      child.write("\u001B[B");
      const movedSelection = await waitForSelectedProject(() => screenWrites, screen, "first-project");
      expect(movedSelection?.chunks.some((chunk) => (
        chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.rail && chunk.style.bold
      ))).toBe(true);

      child.write("\r");
      await waitForScreenText(() => screenWrites, screen, "> | message");

      const chatSnapshot = screen.snapshot();
      const chatHeader = screen.styledSnapshotLines().find((line) => lineText(line).includes("parallel-codex-tui"));
      expect(chatSnapshot).toContain("first-project");
      expect(chatSnapshot).not.toContain("Open project");
      expect(chatSnapshot).not.toContain("New project");
      expect(lineText(chatHeader)).toContain("chat");
      expect(chatHeader?.chunks.some((chunk) => (
        chunk.text.includes("parallel-codex-tui") &&
        chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.chrome &&
        chunk.style.color === TUI_THEME_PRESETS.paper.accent
      ))).toBe(true);

      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 10000);

  it("keeps the first-run picker compact and preserves a Chinese project path", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-picker-narrow-"));
    const workspace = join(appRoot, "中文项目");
    const repoRoot = process.cwd();
    const screen = new NativeTerminalScreen({ cols: 24, rows: 10, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      [join(repoRoot, "node_modules/.bin/tsx"), join(repoRoot, "src/cli.tsx"), "--app-root", appRoot],
      {
        cwd: appRoot,
        cols: 24,
        rows: 10,
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
      await waitForScreenText(() => screenWrites, screen, "Workspace path");
      expect(screen.snapshot()).toContain("pct · workspace");

      child.write("中文项目");
      child.write("\r");
      await waitForScreenText(() => screenWrites, screen, "> | message");

      expect(await pathExists(join(workspace, ".parallel-codex"))).toBe(true);
      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 10000);

  it("exits cleanly when the user cancels workspace selection", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-picker-cancel-"));
    const screen = new NativeTerminalScreen({ cols: 80, rows: 18, scrollback: 1000 });
    const chunks: string[] = [];
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot],
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 18,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );

    child.onData((chunk) => {
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "Workspace path");
      child.write("\x03");
      await waitForExit(exits);
      await screenWrites;

      expect(exits[0]).toBe(0);
      expect(chunks.join("")).not.toContain("Startup error");
      expect(chunks.join("")).not.toContain("Workspace selection cancelled");
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 10000);

  it("exits cleanly when the terminal delivers SIGINT during workspace selection", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-workspace-picker-sigint-"));
    const screen = new NativeTerminalScreen({ cols: 80, rows: 18, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot],
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 18,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );

    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "Workspace path");
      child.kill("SIGINT");
      await waitForExit(exits);

      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 10000);
});

function lineText(line: ReturnType<NativeTerminalScreen["styledSnapshotLines"]>[number] | undefined): string {
  return line?.chunks.map((chunk) => chunk.text).join("") ?? "";
}

async function waitForScreenText(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await screenWritesRef();
    if (screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text}\nSnapshot:\n${screen.snapshot()}`);
}

async function waitForSelectedProject(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  projectName: string
): Promise<ReturnType<NativeTerminalScreen["styledSnapshotLines"]>[number]> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await screenWritesRef();
    const line = screen.styledSnapshotLines().find((candidate) => lineText(candidate).includes(projectName));
    if (line?.chunks.some((chunk) => (
      chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.rail && chunk.style.bold
    ))) {
      return line;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for selected project ${projectName}\nSnapshot:\n${screen.snapshot()}`);
}

async function waitForThemedPickerFill(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  rows: number
): Promise<ReturnType<NativeTerminalScreen["styledSnapshotLines"]>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await screenWritesRef();
    const lines = screen.styledSnapshotLines();
    if (
      lines.length === rows
      && lines.at(-1)?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.surface)
    ) {
      return lines;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for themed picker fill\nSnapshot:\n${screen.snapshot()}`);
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
