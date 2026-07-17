import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn, type IPty } from "node-pty";
import { pathExists, readJson, readTextIfExists } from "../src/core/file-store.js";
import { NativeSessionSchema, TaskMetaSchema } from "../src/domain/schemas.js";
import { displayWidth } from "../src/tui/display-width.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";
import { resizeAndWaitForFreshScreenText } from "./pty-resize.js";

describe("CLI worker history smoke", () => {
  it("keeps twenty task-turn worker logs, native sessions, and tab order across restart", async () => {
    const turnCount = 20;
    const workersPerTurn = 4;
    const workerCount = turnCount * workersPerTurn;
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-history-workspace-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-worker-history-app-"));
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

    const firstRun = startCli(appRoot, workspace);
    let secondRun: CliRun | null = null;
    try {
      await waitForScreenText(firstRun, "> | message");
      firstRun.child.write("实现第一轮功能\r");

      const [taskId] = await waitForTaskCount(workspace, 1);
      expect(taskId).toBeTruthy();
      const taskDir = join(workspace, ".parallel-codex", "sessions", taskId ?? "");
      await waitForTaskTurnDone(taskDir, "0001");
      await waitForIdleInput(firstRun);

      const firstTurnLogs = await Promise.all([
        readTextIfExists(join(taskDir, "judge-mock", "output.log")),
        readTextIfExists(join(taskDir, "actor-mock", "output.log")),
        readTextIfExists(join(taskDir, "critic-mock", "output.log"))
      ]);

      for (let turn = 2; turn <= turnCount; turn += 1) {
        firstRun.child.write(`继续完成第${turn}轮功能\r`);
        await waitForTaskTurnDone(taskDir, String(turn).padStart(4, "0"));
        await waitForIdleInput(firstRun);
      }

      expect(await Promise.all([
        readTextIfExists(join(taskDir, "judge-mock", "output.log")),
        readTextIfExists(join(taskDir, "actor-mock", "output.log")),
        readTextIfExists(join(taskDir, "critic-mock", "output.log"))
      ])).toEqual(firstTurnLogs);
      expect(await workerDirectories(taskDir)).toEqual(expectedWorkerDirectories(turnCount));
      for (const role of ["judge", "actor", "critic"] as const) {
        const firstSession = await readJson(
          join(taskDir, `${role}-mock`, "native-session.json"),
          NativeSessionSchema
        );
        for (let turn = 2; turn <= turnCount; turn += 1) {
          const workerId = `${role}-mock-${String(turn).padStart(4, "0")}`;
          const continuedSession = await readJson(
            join(taskDir, workerId, "native-session.json"),
            NativeSessionSchema
          );
          expect(continuedSession.session_id).toBe(firstSession.session_id);
          expect(continuedSession.worker_id).toBe(workerId);
          expect(await readTextIfExists(join(taskDir, workerId, "output.log"))).not.toBe("");
        }
      }
      const firstJudgeSession = await readJson(
        join(taskDir, "judge-mock", "native-session.json"),
        NativeSessionSchema
      );
      for (let turn = 1; turn <= turnCount; turn += 1) {
        const workerId = `judge-mock-final-${String(turn).padStart(4, "0")}`;
        const finalSession = await readJson(
          join(taskDir, workerId, "native-session.json"),
          NativeSessionSchema
        );
        expect(finalSession.session_id).toBe(firstJudgeSession.session_id);
        expect(finalSession.worker_id).toBe(workerId);
      }

      firstRun.child.write("\x17");
      await assertChronologicalWorkerTabs(firstRun, workerCount);
      await assertNarrowWorkerChrome(firstRun, workerCount);

      firstRun.child.write("\x03");
      await waitForExit(firstRun);
      expect(firstRun.exits[0]).toBe(0);

      secondRun = startCli(appRoot, workspace, taskId);
      await waitForScreenText(secondRun, "> | message");
      secondRun.child.write("\x14");
      await waitForScreenText(secondRun, `${turnCount} turns · ${workerCount} workers · 3 native`);
      secondRun.child.write("\x1b");
      await waitForScreenText(secondRun, "parallel-codex-tui · chat");
      secondRun.child.write("\x17");
      await assertChronologicalWorkerTabs(secondRun, workerCount);

      secondRun.child.write("\x03");
      await waitForExit(secondRun);
      expect(secondRun.exits[0]).toBe(0);
    } finally {
      stopIfRunning(firstRun);
      if (secondRun) {
        stopIfRunning(secondRun);
      }
    }
  }, 90000);
});

interface CliRun {
  child: IPty;
  screen: NativeTerminalScreen;
  exits: number[];
  screenWrites: () => Promise<void>;
  outputRevision: () => number;
}

function startCli(appRoot: string, workspace: string, taskId?: string): CliRun {
  const screen = new NativeTerminalScreen({ cols: 112, rows: 22, scrollback: 1000 });
  const exits: number[] = [];
  let pendingWrites = Promise.resolve();
  let outputRevision = 0;
  const args = [
    "./node_modules/.bin/tsx",
    "src/cli.tsx",
    "--app-root",
    appRoot,
    "--workspace",
    workspace,
    ...(taskId ? ["--task", taskId] : [])
  ];
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    cols: 112,
    rows: 22,
    name: "xterm-256color",
    env: { ...process.env, TERM: "xterm-256color" }
  });
  child.onData((chunk) => {
    outputRevision += 1;
    pendingWrites = pendingWrites.then(() => screen.write(chunk));
  });
  child.onExit(({ exitCode }) => exits.push(exitCode));
  return {
    child,
    screen,
    exits,
    screenWrites: () => pendingWrites,
    outputRevision: () => outputRevision
  };
}

async function assertChronologicalWorkerTabs(run: CliRun, workerCount: number): Promise<void> {
  await waitForScreenText(run, `judge/mock · 1/${workerCount}`);
  await waitForScreenText(run, `workers ${workerCount} · done`);
  run.child.write("\t");
  await waitForScreenText(run, `actor/mock · 2/${workerCount}`);
  run.child.write("\t");
  await waitForScreenText(run, `critic/mock · 3/${workerCount}`);
  run.child.write("\t");
  await waitForScreenText(run, `judge/mock · Final acceptance · 4/${workerCount}`);
  run.child.write("\t");
  await waitForScreenText(run, `judge/mock · Turn 2 · 5/${workerCount}`);
}

async function assertNarrowWorkerChrome(run: CliRun, workerCount: number): Promise<void> {
  await resizeAndWaitForFreshScreenText({
    child: run.child,
    screen: run.screen,
    screenWrites: run.screenWrites,
    revision: run.outputRevision,
    cols: 32,
    rows: 22,
    text: `judge/mock · 5/${workerCount}`
  });
  expect(maxScreenWidth(run.screen)).toBeLessThanOrEqual(32);

  await resizeAndWaitForFreshScreenText({
    child: run.child,
    screen: run.screen,
    screenWrites: run.screenWrites,
    revision: run.outputRevision,
    cols: 24,
    rows: 22,
    text: `judge/mock · 5/${workerCount}`
  });
  expect(maxScreenWidth(run.screen)).toBeLessThanOrEqual(24);
}

function maxScreenWidth(screen: NativeTerminalScreen): number {
  return Math.max(...screen.snapshot().split("\n").map((line) => displayWidth(line)));
}

async function workerDirectories(taskDir: string): Promise<string[]> {
  return (await readdir(taskDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^(?:judge|actor|critic)-mock(?:-|$)/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function expectedWorkerDirectories(turnCount: number): string[] {
  return [
    ...(["actor", "critic", "judge"] as const).flatMap((role) =>
    Array.from({ length: turnCount }, (_, index) => {
      const turn = index + 1;
      return turn === 1 ? `${role}-mock` : `${role}-mock-${String(turn).padStart(4, "0")}`;
    })
    ),
    ...Array.from(
      { length: turnCount },
      (_, index) => `judge-mock-final-${String(index + 1).padStart(4, "0")}`
    )
  ].sort();
}

async function waitForTaskCount(workspace: string, count: number): Promise<string[]> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const ids = (await readdir(join(workspace, ".parallel-codex", "sessions")))
        .filter((entry) => entry.startsWith("task-"))
        .sort();
      if (ids.length === count) {
        return ids;
      }
    } catch {
      // The first task has not been published yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${count} task sessions`);
}

async function waitForTaskTurnDone(taskDir: string, turnId: string): Promise<void> {
  const summaryPath = join(taskDir, "turns", turnId, "supervisor-summary.md");
  const metaPath = join(taskDir, "meta.json");
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const meta = await readJson(metaPath, TaskMetaSchema);
      if (meta.status === "done" && await pathExists(summaryPath)) {
        return;
      }
    } catch {
      // The turn is still being published or completed.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for task turn ${turnId} to complete`);
}

async function waitForScreenText(run: CliRun, text: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await run.screenWrites();
    if (run.screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text}\nSnapshot:\n${run.screen.snapshot()}`);
}

async function waitForIdleInput(run: CliRun): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await run.screenWrites();
    const snapshot = run.screen.snapshot();
    if (snapshot.includes("> | message") && !snapshot.includes("run working")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for the chat input to become idle\nSnapshot:\n${run.screen.snapshot()}`);
}

async function waitForScreenMatch(run: CliRun, pattern: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await run.screenWrites();
    if (pattern.test(run.screen.snapshot())) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${pattern}\nSnapshot:\n${run.screen.snapshot()}`);
}

async function waitForExit(run: CliRun): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (run.exits.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for TUI exit");
}

function stopIfRunning(run: CliRun): void {
  if (run.exits.length === 0) {
    run.child.kill("SIGTERM");
  }
}
