import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { readJson, writeJson } from "../src/core/file-store.js";
import { NativeSessionSchema, TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI Task sessions smoke", () => {
  it("restores an older task and native session, remembers it, and persists a cleared context", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-task-sessions-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-task-sessions-workspace-"));
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    const nativeScript = "process.stdout.write('RESTORED:' + process.argv[1])";
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
        "",
        "[workers.mock.interactive]",
        `command = ${JSON.stringify(process.execPath)}`,
        `args = ["-e", ${JSON.stringify(nativeScript)}, "{sessionId}"]`,
        ""
      ].join("\n"),
      "utf8"
    );
    let firstTaskId = "";

    const firstRun = startCli(appRoot, workspace);
    try {
      await waitForScreenText(firstRun, "> | message");
      firstRun.child.write("第一个会话标记\r");
      [firstTaskId] = await waitForTaskCount(workspace, 1);
      await waitForTaskState(workspace, firstTaskId, "done");
      await waitForScreenText(firstRun, "done · complex task completed");
      await replaceNativeSession(workspace, firstTaskId, "judge-mock", "first-judge-native");

      firstRun.child.write("\x0e");
      await waitForScreenText(firstRun, "new task · ready");
      firstRun.child.write("第二个会话标记\r");
      const taskIds = await waitForTaskCount(workspace, 2);
      const secondTaskId = taskIds.find((taskId) => taskId !== firstTaskId);
      expect(secondTaskId).toBeTruthy();
      await waitForTaskState(workspace, secondTaskId ?? "", "done");
      await waitForScreenText(firstRun, "done · complex task completed");
      await waitForScreenText(firstRun, "> | message");
      await waitForScreenText(firstRun, "^T tasks");
      firstRun.child.write("跨任务草稿");
      await waitForScreenText(firstRun, "> 跨任务草稿|");

      firstRun.child.write("\x14");
      await waitForScreenText(firstRun, "Task sessions");
      await waitForScreenText(firstRun, "2 tasks · 2 done");
      let snapshot = firstRun.screen.snapshot();
      expect(snapshot.split("\n")[0]).toContain("sessions");
      expect(snapshot).toContain("* 第二个会话标记");
      expect(snapshot).toContain("第一个会话标记");

      firstRun.child.write("\x1b");
      await waitForScreenText(firstRun, "> 跨任务草稿|");
      firstRun.child.write("\x14");
      await waitForScreenText(firstRun, "Task sessions");

      firstRun.child.write("\x1b[B");
      await waitForScreenText(firstRun, ">   第一个会话标记");
      firstRun.child.write("\r");
      const firstMarker = compactTaskMarker(firstTaskId);
      await waitForScreenText(firstRun, `#${firstMarker}`);
      await waitForScreenText(firstRun, "> 跨任务草稿|");

      firstRun.child.write("\x02");
      await waitForScreenText(firstRun, "> Judge (mock)");
      await waitForScreenText(firstRun, "session");
      firstRun.child.write("\x14");
      await waitForScreenText(firstRun, "parallel-codex-tui · sessions");
      firstRun.child.write("\x1b");
      await waitForScreenText(firstRun, "parallel-codex-tui · workers");
      firstRun.child.write("\x0f");
      await waitForScreenText(firstRun, "RESTORED:first-judge-native");
      firstRun.child.write("\x1d");
      await waitForScreenText(firstRun, "parallel-codex-tui · logs");
      firstRun.child.write("\x03");
      await waitForExit(firstRun.exits);
      expect(firstRun.exits[0]).toBe(0);
    } finally {
      stopCli(firstRun);
    }

    const secondRun = startCli(appRoot, workspace);
    try {
      const firstMarker = compactTaskMarker(firstTaskId);
      await waitForScreenText(secondRun, `#${firstMarker}`);
      secondRun.child.write("\x14");
      await waitForScreenText(secondRun, "Task sessions");
      await waitForScreenText(secondRun, "> * 第一个会话标记");
      secondRun.child.write("\x1b");
      await waitForScreenText(secondRun, "parallel-codex-tui · chat");
      secondRun.child.write("\x0e");
      await waitForScreenText(secondRun, "new task · ready");
      secondRun.child.write("\x03");
      await waitForExit(secondRun.exits);
      expect(secondRun.exits[0]).toBe(0);
    } finally {
      stopCli(secondRun);
    }

    const thirdRun = startCli(appRoot, workspace);
    try {
      await waitForScreenText(thirdRun, "parallel-codex-tui · chat");
      await waitForScreenText(thirdRun, "> | message");
      await waitForScreenText(thirdRun, "^T tasks");
      const header = thirdRun.screen.snapshot().split("\n")[0] ?? "";
      expect(header).not.toContain("#");
      expect(thirdRun.screen.snapshot()).not.toContain("^N new");
      thirdRun.child.write("\x14");
      await waitForScreenText(thirdRun, "2 tasks · 2 done");
      expect(thirdRun.screen.snapshot()).not.toContain("> *");
      thirdRun.child.write("\x03");
      await waitForExit(thirdRun.exits);
      expect(thirdRun.exits[0]).toBe(0);
    } finally {
      stopCli(thirdRun);
    }
  }, 30000);
});

function startCli(appRoot: string, workspace: string) {
  const screen = new NativeTerminalScreen({ cols: 110, rows: 18, scrollback: 1000 });
  const exits: number[] = [];
  let screenWrites = Promise.resolve();
  const child = spawn(
    process.execPath,
    ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
    {
      cwd: process.cwd(),
      cols: 110,
      rows: 18,
      name: "xterm-256color",
      env: { ...process.env, TERM: "xterm-256color" }
    }
  );
  child.onData((chunk) => {
    screenWrites = screenWrites.then(() => screen.write(chunk));
  });
  child.onExit(({ exitCode }) => exits.push(exitCode));
  return { child, screen, exits, screenWrites: () => screenWrites };
}

function stopCli(run: ReturnType<typeof startCli>): void {
  if (run.exits.length === 0) {
    run.child.kill("SIGTERM");
  }
}

async function replaceNativeSession(
  workspace: string,
  taskId: string,
  workerId: string,
  sessionId: string
): Promise<void> {
  const workerDir = join(workspace, ".parallel-codex", "sessions", taskId, workerId);
  const statusPath = join(workerDir, "status.json");
  const nativePath = join(workerDir, "native-session.json");
  const status = await readJson(statusPath, WorkerStatusSchema);
  const native = await readJson(nativePath, NativeSessionSchema);
  await writeJson(statusPath, WorkerStatusSchema.parse({ ...status, native_session_id: sessionId }));
  await writeJson(nativePath, NativeSessionSchema.parse({ ...native, session_id: sessionId }));
}

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
  for (let attempt = 0; attempt < 200; attempt += 1) {
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const meta = await readJson(metaPath, TaskMetaSchema);
      if (meta.status === state) {
        return;
      }
    } catch {
      // The task is still being created or updated.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${taskId} to become ${state}`);
}

function compactTaskMarker(taskId: string): string {
  return taskId.replace(/^task-\d{8}-/, "");
}

async function waitForScreenText(run: ReturnType<typeof startCli>, text: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await run.screenWrites();
    if (run.screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text}\nSnapshot:\n${run.screen.snapshot()}`);
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
