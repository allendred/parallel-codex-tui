import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { pathExists, readJson, readTextIfExists } from "../src/core/file-store.js";
import { TaskMetaSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI new task smoke", () => {
  it("starts a second independent task with Ctrl+N without deleting the first session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-new-task-workspace-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-new-task-app-"));
    const screen = new NativeTerminalScreen({ cols: 100, rows: 20, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();

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
        'critic = "mock"'
      ].join("\n") + "\n"
    );

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 100,
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
      await waitForScreenText(() => screenWrites, screen, "> | message");
      child.write("实现第一个独立功能\r");

      const [firstTaskId] = await waitForTaskCount(workspace, 1);
      await waitForTaskState(workspace, firstTaskId, "done");
      await waitForScreenText(() => screenWrites, screen, "done · complex task completed");
      await waitForScreenText(() => screenWrites, screen, "^N new");

      child.write("\x0e");
      await waitForScreenText(() => screenWrites, screen, "new task · ready");
      const firstTaskMarker = firstTaskId.replace(/^task-\d{8}-/, "");
      expect(screen.snapshot().split("\n")[0]).not.toContain(firstTaskMarker);
      expect(screen.snapshot()).not.toContain("^N new");

      child.write("实现第二个独立功能\r");
      const taskIds = await waitForTaskCount(workspace, 2);
      const secondTaskId = taskIds.find((taskId) => taskId !== firstTaskId);
      expect(secondTaskId).toBeTruthy();
      await waitForTaskState(workspace, secondTaskId ?? "", "done");

      expect(await readTextIfExists(join(workspace, ".parallel-codex", "sessions", firstTaskId, "user-request.md"))).toContain(
        "实现第一个独立功能"
      );
      expect(await readTextIfExists(join(workspace, ".parallel-codex", "sessions", secondTaskId ?? "", "user-request.md"))).toContain(
        "实现第二个独立功能"
      );
      expect(await pathExists(join(workspace, ".parallel-codex", "sessions", firstTaskId, "turns", "0002"))).toBe(false);
      expect(await pathExists(join(workspace, ".parallel-codex", "sessions", secondTaskId ?? "", "turns", "0001"))).toBe(true);

      const chat = await readTextIfExists(join(workspace, ".parallel-codex", "sessions", "main", "chat.jsonl"));
      expect(chat.match(/new task · ready/g)).toHaveLength(1);
      expect(chat).toContain("实现第一个独立功能");
      expect(chat).toContain("实现第二个独立功能");

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

async function taskIds(workspace: string): Promise<string[]> {
  try {
    return (await readdir(join(workspace, ".parallel-codex", "sessions")))
      .filter((entry) => entry.startsWith("task-"))
      .sort();
  } catch {
    return [];
  }
}

async function waitForTaskCount(workspace: string, count: number): Promise<string[]> {
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const ids = await taskIds(workspace);
    if (ids.length === count) {
      return ids;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${count} task sessions`);
}

async function waitForTaskState(workspace: string, taskId: string, state: string): Promise<void> {
  const metaPath = join(workspace, ".parallel-codex", "sessions", taskId, "meta.json");
  for (let attempt = 0; attempt < 160; attempt += 1) {
    try {
      const meta = await readJson(metaPath, TaskMetaSchema);
      if (meta.status === state) {
        return;
      }
    } catch {
      // The task is still starting or updating its metadata.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${taskId} to become ${state}`);
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
  throw new Error("Timed out waiting for TUI exit");
}
