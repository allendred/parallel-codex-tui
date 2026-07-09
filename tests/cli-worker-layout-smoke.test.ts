import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { writeJson } from "../src/core/file-store.js";
import { TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { displayWidth } from "../src/tui/display-width.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";
import { TUI_THEME_PRESETS } from "../src/tui/theme.js";

describe("CLI worker layout smoke", () => {
  it("keeps the idle chat status row on the themed rail", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-idle-status-"));
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 80, rows: 12, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 12,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );

    child.onData((chunk) => {
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForScreenText(() => screenWrites, screen, "Type a message");
      await screenWrites;

      const lines = screen.styledSnapshotLines();
      const inputIndex = lines.findIndex((line) => line.chunks.map((chunk) => chunk.text).join("").includes("Type a message"));
      const statusLine = lines[inputIndex + 1];
      const statusLineText = statusLine?.chunks.map((chunk) => chunk.text).join("") ?? "";

      expect(inputIndex).toBeGreaterThanOrEqual(0);
      expect(statusLineText.trim()).toBe("");
      expect(displayWidth(statusLineText)).toBe(79);
      expect(statusLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.rail)).toBe(true);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("keeps the app header visible when worker logs fill a short terminal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-layout-"));
    const taskId = "task-20260705-000000-layout";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "critic-mock");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 140, rows: 24, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 140,
        rows: 24,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );

    child.onData((chunk) => {
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForText(chunks, "ready");
      await waitForText(chunks, "workers");
      child.write("\x17");
      await waitForText(chunks, "line 80");
      await waitForScreenText(() => screenWrites, screen, "workers 1");
      await screenWrites;

      const snapshot = screen.snapshot();
      const headerLine = screen
        .styledSnapshotLines()
        .find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("parallel-codex-tui"));
      const headerLineText = headerLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const workerTitleLine = screen
        .styledSnapshotLines()
        .find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("critic/mock · 1/1"));
      const workerTitleLineText = workerTitleLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const statusLine = screen
        .styledSnapshotLines()
        .find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("workers 1"));
      const statusLineText = statusLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const inputLine = screen
        .styledSnapshotLines()
        .find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("logs · read"));
      const inputLineText = inputLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      expect(snapshot).toContain("parallel-codex-tui");
      expect(snapshot).toContain("logs");
      expect(snapshot).not.toContain("Worker logs");
      expect(snapshot).toContain("task ");
      expect(headerLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.chrome)).toBe(true);
      expect(displayWidth(headerLineText)).toBe(139);
      expect(workerTitleLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.chrome)).toBe(true);
      expect(workerTitleLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.surface)).toBe(false);
      expect(displayWidth(workerTitleLineText)).toBe(137);
      expect(snapshot).toContain("line 80");
      expect(snapshot).toContain("logs · read");
      expect(snapshot).toContain("^O attach");
      expect(inputLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.rail)).toBe(true);
      expect(displayWidth(inputLineText)).toBe(139);
      expect(snapshot).toContain("workers 1");
      expect(snapshot).toContain("done 1");
      expect(snapshot).toContain("@ critic/mock");
      expect(statusLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.rail)).toBe(true);
      expect(displayWidth(statusLineText)).toBe(139);
      expect(snapshot).not.toContain("Type a message");

      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "^W logs");
      const chatSnapshot = screen.snapshot();
      expect(chatSnapshot).toContain("> | Type a message · ^W logs · Tab worker · ^O attach");
      expect(chatSnapshot).toContain("workers 1");
      expect(chatSnapshot).toContain("done 1");
      expect(chatSnapshot).not.toContain("@ critic/mock");
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("honors showStatusBar=false in the rendered worker shell", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-status-hidden-"));
    const taskId = "task-20260705-000000-status-hidden";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "critic-mock");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 100, rows: 20, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeFile(
      join(workspace, ".parallel-codex", "config.toml"),
      [
        "[ui]",
        "showStatusBar = false",
        "autoOpenFailedWorker = true",
        'theme = "codex"'
      ].join("\n")
    );
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 20,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );

    child.onData((chunk) => {
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForText(chunks, "ready");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "logs · read");
      await screenWrites;

      const snapshot = screen.snapshot();
      expect(snapshot).toContain("critic/mock · 1/1");
      expect(snapshot).toContain("logs · read");
      expect(snapshot).not.toContain("workers 1");
      expect(snapshot).not.toContain("done 1");
      expect(snapshot).not.toContain("@ critic/mock");
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("applies the CLI theme override to the rendered terminal chrome", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-theme-"));
    const taskId = "task-20260705-000000-theme";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "critic-mock");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 100, rows: 24, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--theme", "paper", "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 24,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );

    child.onData((chunk) => {
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForText(chunks, "ready");
      await waitForScreenText(() => screenWrites, screen, "workers 1");
      await waitForScreenText(() => screenWrites, screen, "^W logs");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "line 80");

      const lines = screen.styledSnapshotLines();
      const headerLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("parallel-codex-tui"));
      const workerTitleLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("critic/mock · 1/1"));
      const inputLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("logs · read"));
      const statusLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("workers 1"));

      expect(headerLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.chrome)).toBe(true);
      expect(workerTitleLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.chrome)).toBe(true);
      expect(inputLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.rail)).toBe(true);
      expect(statusLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.rail)).toBe(true);
      expect(headerLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.chrome)).toBe(false);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("keeps worker controls on one line in a compact terminal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-compact-layout-"));
    const taskId = "task-20260705-000000-compact-layout";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "critic-mock");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 42, rows: 18, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 42,
        rows: 18,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );

    child.onData((chunk) => {
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForText(chunks, "ready");
      await waitForScreenText(() => screenWrites, screen, "w1");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "logs · Pg/wheel · Tab · ^O · Esc");

      const snapshot = screen.snapshot();
      expect(snapshot).toContain("logs · Pg/wheel · Tab · ^O · Esc");
      expect(snapshot).toContain("w1");
      expect(snapshot).toContain("d1");
      expect(snapshot).toContain("@ critic/mock");
      expect(snapshot).not.toContain("s readscroll");
      expect(snapshot).not.toContain("workers 1");
      expect(snapshot).not.toContain("Type a message");

      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "^W logs");
      const chatSnapshot = screen.snapshot();
      expect(chatSnapshot).toContain("> | Message · ^W logs · ^O attach");
      expect(chatSnapshot).not.toContain("@ critic/mock");
      expect(Math.max(...chatSnapshot.split("\n").map((line) => line.length))).toBeLessThanOrEqual(42);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("keeps ultra-narrow verification summaries free of orphan labels", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-ultra-verify-"));
    const taskId = "task-20260705-000000-ultra-verify";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 18, rows: 14, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeUltraNarrowVerificationTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 18,
        rows: 14,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );

    child.onData((chunk) => {
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForScreenText(() => screenWrites, screen, "^W");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "tests 30/30");
      const snapshot = screen.snapshot();
      expect(snapshot).toContain("tests 30/30");
      expect(snapshot).toContain("smoke");
      expect(snapshot).toContain("build+dev");
      expect(snapshot).not.toContain("Verify:");
      expect(Math.max(...snapshot.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(18);

      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "> | msg · ^W");
      const chatSnapshot = screen.snapshot();
      expect(chatSnapshot).toContain("> | msg · ^W");
      expect(chatSnapshot).not.toContain("^O");
      expect(Math.max(...chatSnapshot.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(18);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("opens the failed worker first when restoring an existing task", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-failed-first-"));
    const taskId = "task-20260705-000000-failed-first";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const judgeDir = join(taskDir, "judge-mock");
    const actorDir = join(taskDir, "actor-mock");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 100, rows: 24, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(judgeDir, { recursive: true });
    await mkdir(actorDir, { recursive: true });
    await writeFailedFirstTaskFiles({ workspace, taskId, taskDir, judgeDir, actorDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 24,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );

    child.onData((chunk) => {
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForText(chunks, "actor failure details");
      await waitForScreenText(() => screenWrites, screen, "workers 2");
      await screenWrites;

      const snapshot = screen.snapshot();
      expect(snapshot).toContain("logs");
      expect(snapshot).toContain("actor/mock · 2/2");
      expect(snapshot).toContain("actor failure details");
      expect(snapshot).toContain("workers 2");
      expect(snapshot).toContain("fail 1");
      expect(snapshot).toContain("done 1");
      expect(snapshot).toContain("@ actor/mock");
      expect(snapshot).not.toContain("@ judge/mock");

      child.write("\t");
      await waitForScreenText(() => screenWrites, screen, "judge/mock · 1/2");
      await waitForScreenText(() => screenWrites, screen, "judge healthy details");
      await waitForScreenText(() => screenWrites, screen, "@ judge/mock");
      const switchedSnapshot = screen.snapshot();
      expect(switchedSnapshot).toContain("judge healthy details");
      expect(switchedSnapshot).toContain("@ judge/mock");
      expect(switchedSnapshot).not.toContain("@ actor/mock");
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("keeps chat open after escape opts out of later failed-worker auto-open", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-early-esc-"));
    const taskId = "task-20260705-000000-early-esc";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const judgeDir = join(taskDir, "judge-mock");
    const actorDir = join(taskDir, "actor-mock");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 100, rows: 24, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(judgeDir, { recursive: true });
    await mkdir(actorDir, { recursive: true });
    await writeFailedFirstTaskFiles({ workspace, taskId, taskDir, judgeDir, actorDir });
    await writeJson(
      join(actorDir, "status.json"),
      WorkerStatusSchema.parse({
        worker_id: "actor-mock",
        role: "actor",
        engine: "mock",
        state: "done",
        phase: "process-exited",
        last_event_at: "2026-07-05T00:00:01.000Z",
        summary: "actor initially healthy"
      })
    );

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 24,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );

    child.onData((chunk) => {
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForScreenText(() => screenWrites, screen, "^W logs");
      child.write("\x1b");
      await writeJson(
        join(actorDir, "status.json"),
        WorkerStatusSchema.parse({
          worker_id: "actor-mock",
          role: "actor",
          engine: "mock",
          state: "failed",
          phase: "process-exited",
          last_event_at: "2026-07-05T00:00:02.000Z",
          summary: "actor failed after chat opt-out"
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await screenWrites;

      const snapshot = screen.snapshot();
      expect(snapshot).toContain("chat");
      expect(snapshot).toContain("^W logs");
      expect(snapshot).toContain("workers 2");
      expect(snapshot).toContain("fail 1");
      expect(snapshot).not.toContain("@ actor/mock");
      expect(snapshot).not.toContain("actor failure details");
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);
});

async function writeTaskFiles(input: {
  workspace: string;
  taskId: string;
  taskDir: string;
  workerDir: string;
}): Promise<void> {
  await writeJson(
    join(input.taskDir, "meta.json"),
    TaskMetaSchema.parse({
      id: input.taskId,
      title: "worker layout smoke",
      created_at: "2026-07-05T00:00:00.000Z",
      cwd: input.workspace,
      mode: "complex",
      status: "done"
    })
  );
  await writeJson(
    join(input.workerDir, "status.json"),
    WorkerStatusSchema.parse({
      worker_id: "critic-mock",
      role: "critic",
      engine: "mock",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-07-05T00:00:00.000Z",
      summary: "ready"
    })
  );
  await writeFile(join(input.workerDir, "review.md"), "# Review\n\nAPPROVED\n");
  await writeFile(
    join(input.workerDir, "output.log"),
    Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join("\n")
  );
}

async function writeUltraNarrowVerificationTaskFiles(input: {
  workspace: string;
  taskId: string;
  taskDir: string;
  workerDir: string;
}): Promise<void> {
  await writeJson(
    join(input.taskDir, "meta.json"),
    TaskMetaSchema.parse({
      id: input.taskId,
      title: "ultra narrow verification smoke",
      created_at: "2026-07-05T00:00:00.000Z",
      cwd: input.workspace,
      mode: "complex",
      status: "done"
    })
  );
  await writeJson(
    join(input.workerDir, "status.json"),
    WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-07-05T00:00:00.000Z",
      summary: "ready"
    })
  );
  await writeFile(
    join(input.workerDir, "worklog.md"),
    "Verification: unit 18/18 · tests 30/30 · smoke passed · build passed · dev fallback\n"
  );
  await writeFile(join(input.workerDir, "output.log"), "");
}

async function writeFailedFirstTaskFiles(input: {
  workspace: string;
  taskId: string;
  taskDir: string;
  judgeDir: string;
  actorDir: string;
}): Promise<void> {
  await writeJson(
    join(input.taskDir, "meta.json"),
    TaskMetaSchema.parse({
      id: input.taskId,
      title: "failed first smoke",
      created_at: "2026-07-05T00:00:00.000Z",
      cwd: input.workspace,
      mode: "complex",
      status: "failed"
    })
  );
  await writeJson(
    join(input.judgeDir, "status.json"),
    WorkerStatusSchema.parse({
      worker_id: "judge-mock",
      role: "judge",
      engine: "mock",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-07-05T00:00:00.000Z",
      summary: "judge done"
    })
  );
  await writeJson(
    join(input.actorDir, "status.json"),
    WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "failed",
      phase: "process-exited",
      last_event_at: "2026-07-05T00:00:01.000Z",
      summary: "actor failed"
    })
  );
  await writeFile(join(input.judgeDir, "requirements.md"), "judge healthy details\n");
  await writeFile(join(input.judgeDir, "output.log"), "judge process details\n");
  await writeFile(join(input.actorDir, "worklog.md"), "actor failure details\n");
  await writeFile(join(input.actorDir, "output.log"), "actor process failed\n");
}

async function waitForText(chunks: string[], text: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (chunks.join("").includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text}\nOutput:\n${chunks.join("")}`);
}

async function waitForScreenText(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await screenWritesRef();
    if (screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for screen text ${text}\nSnapshot:\n${screen.snapshot()}`);
}
