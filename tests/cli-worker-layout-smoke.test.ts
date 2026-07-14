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
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace],
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
      await waitForScreenText(() => screenWrites, screen, "> | message");
      await screenWrites;

      const lines = screen.styledSnapshotLines();
      const snapshot = screen.snapshot();
      const headerLineText = lines[0]?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const inputIndex = lines.findIndex((line) => line.chunks.map((chunk) => chunk.text).join("").includes("> | message"));
      const statusLine = lines[inputIndex + 1];
      const statusLineText = statusLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const contentLines = lines.slice(1, inputIndex);

      expect(inputIndex).toBeGreaterThanOrEqual(0);
      expect(headerLineText).toContain("parallel-codex-tui");
      expect(headerLineText).toContain("chat");
      expect(headerLineText).not.toContain("task none");
      expect(snapshot).not.toContain("task none");
      expect(contentLines.length).toBeGreaterThan(0);
      expect(
        contentLines.every((line) => line.chunks.every((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.surface))
      ).toBe(true);
      expect(statusLineText.trim()).toBe("");
      expect(displayWidth(statusLineText)).toBe(79);
      expect(statusLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.rail)).toBe(true);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("shows a concise attach hint when no worker exists yet", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-idle-attach-hint-"));
    const screen = new NativeTerminalScreen({ cols: 80, rows: 12, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace],
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
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForScreenText(() => screenWrites, screen, "> | message");
      await openAttachError(child, () => screenWrites, screen, "No workers yet");

      const snapshot = screen.snapshot();
      expect(snapshot).toContain("No workers yet · start a complex task before attaching");
      expect(snapshot).not.toContain("Start a complex task to create workers before attaching.");
      expect(snapshot).not.toContain("Run a complex task");

      child.write("\x1b");
      await waitForScreenTextGone(() => screenWrites, screen, "No workers yet");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "No workers yet · start a complex task before opening logs");

      const logsSnapshot = screen.snapshot();
      expect(logsSnapshot.split("\n")[0]).toContain("chat");
      expect(logsSnapshot.split("\n")[0]).not.toContain("logs");
      expect(logsSnapshot).not.toContain("before attaching");
      child.write("\x1b");
      await waitForScreenTextGone(() => screenWrites, screen, "No workers yet");
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
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
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
      await waitForText(chunks, "1 worker");
      await waitForScreenText(() => screenWrites, screen, "^W logs");
      child.write("\x17");
      await waitForText(chunks, "line 80");
      await waitForScreenText(() => screenWrites, screen, "1 worker");
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
      const workerTitleContentChunks = workerTitleLine?.chunks.filter((chunk) => chunk.text.trim().length > 0) ?? [];
      const statusLine = screen
        .styledSnapshotLines()
        .find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("1 worker"));
      const statusLineText = statusLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const inputLine = screen
        .styledSnapshotLines()
        .find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("logs · scroll"));
      const inputLineText = inputLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      expect(snapshot).toContain("parallel-codex-tui");
      expect(snapshot).toContain("logs");
      expect(snapshot).not.toContain("Worker logs");
      expect(snapshot).toContain("#000000-layout");
      expect(snapshot).not.toContain("task 000000-layout");
      expect(headerLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.chrome)).toBe(true);
      expect(displayWidth(headerLineText)).toBe(139);
      expect(workerTitleLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.chrome)).toBe(true);
      expect(workerTitleContentChunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.surface)).toBe(false);
      const workerIdentityText = workerTitleContentChunks
        .filter((chunk) => chunk.style.color === TUI_THEME_PRESETS.codex.accent)
        .map((chunk) => chunk.text)
        .join("");
      const workerMetadataText = workerTitleContentChunks
        .filter((chunk) => chunk.style.color === TUI_THEME_PRESETS.codex.muted)
        .map((chunk) => chunk.text)
        .join("");
      expect(workerIdentityText).toContain("critic/mock");
      expect(workerMetadataText).toContain("1/1");
      expect(displayWidth(workerTitleLineText)).toBe(137);
      expect(snapshot).toContain("line 80");
      expect(snapshot).toContain("logs · scroll");
      expect(snapshot).not.toContain("logs · wheel/Pg");
      expect(snapshot).not.toContain("logs · read");
      expect(snapshot).toContain("^O attach");
      expect(inputLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.rail)).toBe(true);
      expect(displayWidth(inputLineText)).toBe(139);
      expect(snapshot).toContain("1 worker");
      expect(snapshot).toContain("done");
      expect(snapshot).not.toContain("@ critic/mock");
      expect(statusLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.rail)).toBe(true);
      const successStatusText = statusLine?.chunks
        .filter((chunk) => chunk.style.color === TUI_THEME_PRESETS.codex.success)
        .map((chunk) => chunk.text)
        .join("") ?? "";
      expect(successStatusText).toContain("done");
      expect(successStatusText).not.toContain("critic/mock");
      expect(displayWidth(statusLineText)).toBe(139);
      expect(snapshot).not.toContain("Type a message");

      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "^W logs");
      const chatSnapshot = screen.snapshot();
      expect(chatSnapshot).toContain("> | message · ^N new · ^W logs · ^B workers · ^T tasks · Tab · ^O attach · ^G routes");
      expect(chatSnapshot).toContain("1 worker");
      expect(chatSnapshot).toContain("done");
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
      await waitForScreenText(() => screenWrites, screen, "^W logs");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "logs · scroll");
      await screenWrites;

      const snapshot = screen.snapshot();
      expect(snapshot).toContain("critic/mock · 1/1");
      expect(snapshot).toContain("logs · scroll");
      expect(snapshot).not.toContain("logs · wheel/Pg");
      expect(snapshot).not.toContain("logs · read");
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
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--theme", "paper", "--workspace", workspace, "--task", taskId],
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
      await waitForScreenText(() => screenWrites, screen, "1 worker");
      await waitForScreenText(() => screenWrites, screen, "^W logs");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "line 80");
      await waitForScreenText(() => screenWrites, screen, "1 worker");

      const lines = screen.styledSnapshotLines();
      const headerLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("parallel-codex-tui"));
      const workerTitleLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("critic/mock · 1/1"));
      const inputLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("logs · scroll"));
      const statusLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("1 worker"));
      const statusMutedChunks = statusLine?.chunks.filter((chunk) => chunk.style.color === TUI_THEME_PRESETS.paper.muted) ?? [];

      expect(headerLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.chrome)).toBe(true);
      expect(workerTitleLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.chrome)).toBe(true);
      expect(inputLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.rail)).toBe(true);
      expect(statusLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.paper.rail)).toBe(true);
      expect(headerLine?.chunks.some((chunk) =>
        chunk.text.includes("^C") &&
        chunk.style.color === TUI_THEME_PRESETS.paper.muted &&
        chunk.style.dimColor !== true
      )).toBe(true);
      expect(inputLine?.chunks.some((chunk) =>
        chunk.text.includes("scroll") &&
        chunk.style.color === TUI_THEME_PRESETS.paper.muted &&
        chunk.style.dimColor !== true
      )).toBe(true);
      expect(statusMutedChunks.length).toBeGreaterThan(0);
      expect(statusMutedChunks.every((chunk) => chunk.style.dimColor !== true)).toBe(true);
      expect(statusLine?.chunks.some((chunk) => chunk.text.includes("1 worker") && chunk.style.color === TUI_THEME_PRESETS.paper.text)).toBe(true);
      expect(headerLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.chrome)).toBe(false);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("keeps attach error rows aligned with the reserved terminal width", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-attach-error-width-"));
    const taskId = "task-20260705-000000-attach-error-width";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "critic-mock");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 24, rows: 16, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 24,
        rows: 16,
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
      await waitForScreenText(() => screenWrites, screen, "ready");
      await waitForScreenText(() => screenWrites, screen, "w1");
      await waitForScreenText(() => screenWrites, screen, "d1");
      await waitForScreenText(() => screenWrites, screen, "^W logs");
      child.write("\x0f");
      await waitForScreenText(() => screenWrites, screen, "no session · critic");

      const lines = screen.styledSnapshotLines();
      const headerLineText = lines[0]?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const errorLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("no session · critic"));
      const errorLineText = errorLine?.chunks.map((chunk) => chunk.text).join("") ?? "";

      expect(errorLineText).toContain("no session · critic");
      expect(errorLineText).not.toContain("...");
      expect(displayWidth(errorLineText)).toBe(displayWidth(headerLineText));
      expect(errorLine?.chunks.every((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.dangerSurface)).toBe(true);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("fills short worker code block rows with the themed rail", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-code-fill-"));
    const taskId = "task-20260705-000000-code-fill";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 84, rows: 18, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeActorCodeBlockTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
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
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForText(chunks, "ready");
      await waitForScreenText(() => screenWrites, screen, "^W logs");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "const x = 1");
      await waitForScreenText(() => screenWrites, screen, "^B workers · ^O attach · Esc chat");
      await screenWrites;

      const lines = screen.styledSnapshotLines();
      const workerTitleLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("actor/mock · 1/1"));
      const workerTitleLineText = workerTitleLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const codeLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("| const x = 1"));
      const codeLineText = codeLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const codeBodyChunks = codeLine?.chunks.filter((chunk) => chunk.text.trim().length > 0 || chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.rail) ?? [];
      const inputLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("logs · scroll"));
      const inputLineText = inputLine?.chunks.map((chunk) => chunk.text).join("") ?? "";

      expect(codeLineText).toContain("| const x = 1");
      expect(displayWidth(codeLineText)).toBe(displayWidth(workerTitleLineText));
      expect(codeBodyChunks.every((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.rail)).toBe(true);
      expect(inputLineText).toContain("^B workers · ^O attach · Esc chat");
      expect(inputLineText).not.toMatch(/(?:^| · )(?:\^(?:B|O)|Esc)(?= ·|$)/);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("keeps wrapped diff rows inside the worker panel width", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-diff-width-"));
    const taskId = "task-20260705-000000-diff-width";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 72, rows: 20, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeDiffWidthTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 72,
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
      await waitForScreenText(() => screenWrites, screen, "ready");
      await openWorkerLogs(child, () => screenWrites, screen, "preserve tail");

      const lines = screen.styledSnapshotLines();
      const titleLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("actor/mock"));
      const titleLineText = titleLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const diffLines = lines.filter((line) => {
        const text = line.chunks.map((chunk) => chunk.text).join("");
        return /(?:oldValue|newValue|contextValue|punctuation|aligned|preserve tail|wrap and should)/.test(text);
      });

      expect(diffLines.length).toBeGreaterThan(0);
      expect(diffLines.every((line) => displayWidth(line.chunks.map((chunk) => chunk.text).join("")) <= displayWidth(titleLineText))).toBe(true);
      expect(diffLines.every((line) => line.chunks.every((chunk) => chunk.style.backgroundColor))).toBe(true);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("keeps wrapped source rows inside the worker panel width", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-source-width-"));
    const taskId = "task-20260705-000000-source-width";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 72, rows: 20, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeSourceWidthTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 72,
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
      await waitForScreenText(() => screenWrites, screen, "ready");
      await openWorkerLogs(child, () => screenWrites, screen, "keep source tail");

      const lines = screen.styledSnapshotLines();
      const titleLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("actor/mock"));
      const titleLineText = titleLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const sourceLines = lines.filter((line) => {
        const text = line.chunks.map((chunk) => chunk.text).join("");
        return /(?:sourceValue|sourceTail|keep source tail|中文源码行|aligned continuation)/.test(text);
      });

      expect(sourceLines.length).toBeGreaterThan(0);
      expect(sourceLines.every((line) => displayWidth(line.chunks.map((chunk) => chunk.text).join("")) <= displayWidth(titleLineText))).toBe(true);
      expect(sourceLines.every((line) => line.chunks.every((chunk) => chunk.style.backgroundColor))).toBe(true);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("fills nano worker rows to the themed content width", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-nano-fill-"));
    const taskId = "task-20260705-000000-nano-fill";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "critic-mock");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 12, rows: 12, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeNanoProcessTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 12,
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
      await waitForScreenText(() => screenWrites, screen, "w1 d1");
      await waitForScreenText(() => screenWrites, screen, "> | msg");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "ok");
      await screenWrites;

      const lines = screen.styledSnapshotLines();
      const titleLineText = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("c 1/1"))
        ?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const processLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("process"));
      const okLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("ok"));
      const processLineText = processLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const okLineText = okLine?.chunks.map((chunk) => chunk.text).join("") ?? "";

      expect(processLineText).toContain("process");
      expect(okLineText).toContain("ok");
      expect(displayWidth(processLineText)).toBe(displayWidth(titleLineText));
      expect(displayWidth(okLineText)).toBe(displayWidth(titleLineText));
      expect(processLine?.chunks.every((chunk) => chunk.style.backgroundColor)).toBe(true);
      expect(okLine?.chunks.every((chunk) => chunk.style.backgroundColor)).toBe(true);
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
    const screen = new NativeTerminalScreen({ cols: 40, rows: 18, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 40,
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
      await waitForScreenText(() => screenWrites, screen, "1 worker · done");
      await waitForScreenText(() => screenWrites, screen, "> | message · ^W logs · ^O attach");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "logs · scroll · Tab · Esc chat");

      const snapshot = screen.snapshot();
      expect(snapshot).toContain("logs · scroll · Tab · Esc chat");
      expect(snapshot).not.toContain("^O");
      expect(snapshot).not.toContain("logs · wheel/Pg");
      expect(snapshot).toContain("1 worker · done");
      expect(snapshot).not.toContain("w1");
      expect(snapshot).not.toContain("d1");
      expect(snapshot).not.toContain("@ critic");
      expect(snapshot).not.toContain("@ critic/mock");
      expect(snapshot).not.toContain("s readscroll");
      expect(snapshot).not.toContain("workers 1");
      expect(snapshot).not.toContain("Type a message");

      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "> | message · ^W logs · ^O attach");
      const chatSnapshot = screen.snapshot();
      expect(chatSnapshot).toContain("> | message · ^W logs · ^O attach");
      expect(chatSnapshot).not.toContain("...age");
      expect(chatSnapshot).not.toContain("@ critic/mock");
      expect(Math.max(...chatSnapshot.split("\n").map((line) => line.length))).toBeLessThanOrEqual(40);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("keeps semantic chat and log actions in an 80-column terminal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-semantic-actions-"));
    const taskId = "task-20260714-000000-semantic-actions";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "critic-mock");
    const screen = new NativeTerminalScreen({ cols: 80, rows: 18, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 80,
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
      await waitForScreenText(
        () => screenWrites,
        screen,
        "> | message · ^N new · ^W logs · ^B workers · Tab · ^O attach · ^G routes"
      );
      child.write("\x17");
      await waitForScreenText(
        () => screenWrites,
        screen,
        "logs · scroll · ^F find · E err · D diff · Tab · ^O attach · Esc chat"
      );
      const logSnapshot = screen.snapshot();
      expect(logSnapshot).toContain(
        "logs · scroll · ^F find · E err · D diff · Tab · ^O attach · Esc chat"
      );
      expect(logSnapshot).not.toMatch(/(?:^| · )(?:\^(?:B|O)|Esc)(?= ·|$)/);

      child.write("\x1b");
      await waitForScreenText(
        () => screenWrites,
        screen,
        "> | message · ^N new · ^W logs · ^B workers · Tab · ^O attach · ^G routes"
      );
      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
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
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
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
      await waitForScreenText(() => screenWrites, screen, "^W logs");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "tests 30/30");
      await waitForScreenText(() => screenWrites, screen, "logs · Esc chat");
      const snapshot = screen.snapshot();
      expect(snapshot).toContain("tests 30/30");
      expect(snapshot).toContain("smoke");
      expect(snapshot).toContain("build+dev");
      expect(snapshot).toContain("logs · Esc chat");
      expect(snapshot).not.toContain("Verify:");
      expect(Math.max(...snapshot.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(18);

      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "> | ^W logs");
      const chatSnapshot = screen.snapshot();
      expect(chatSnapshot).toContain("> | ^W logs");
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
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
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
      await waitForScreenText(() => screenWrites, screen, "2 workers");
      await screenWrites;

      const snapshot = screen.snapshot();
      expect(snapshot).toContain("logs");
      expect(snapshot).toContain("actor/mock · 2/2");
      expect(snapshot).toContain("actor failure details");
      expect(snapshot).toContain("2 workers");
      expect(snapshot).toContain("1 failed");
      expect(snapshot).toContain("1 done");
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
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", workspace, "--workspace", workspace, "--task", taskId],
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
      await waitForScreenText(() => screenWrites, screen, "^R retry");
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
      expect(snapshot).toContain("^R retry");
      expect(snapshot).toContain("2 workers");
      expect(snapshot).toContain("1 failed");
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

async function writeActorCodeBlockTaskFiles(input: {
  workspace: string;
  taskId: string;
  taskDir: string;
  workerDir: string;
}): Promise<void> {
  await writeJson(
    join(input.taskDir, "meta.json"),
    TaskMetaSchema.parse({
      id: input.taskId,
      title: "worker code fill smoke",
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
    [
      "# Worklog",
      "",
      "```ts",
      "const x = 1;",
      "```"
    ].join("\n")
  );
  await writeFile(join(input.workerDir, "output.log"), "");
}

async function writeDiffWidthTaskFiles(input: {
  workspace: string;
  taskId: string;
  taskDir: string;
  workerDir: string;
}): Promise<void> {
  await writeJson(
    join(input.taskDir, "meta.json"),
    TaskMetaSchema.parse({
      id: input.taskId,
      title: "worker diff width smoke",
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
    join(input.workerDir, "patch.diff"),
    [
      "diff --git a/src/very-long-file-name.ts b/src/very-long-file-name.ts",
      "--- a/src/very-long-file-name.ts",
      "+++ b/src/very-long-file-name.ts",
      "@@ -1,2 +1,3 @@",
      '-const oldValue = "一段很长的中文内容 mixed with ascii and punctuation that should wrap but keep the line number gutter aligned";',
      '+const newValue = "一段很长的中文内容 mixed with ascii and punctuation that should wrap but keep the line number gutter aligned and preserve tail";',
      ' const contextValue = "context line that is also long enough to wrap and should remain visible";'
    ].join("\n")
  );
  await writeFile(join(input.workerDir, "output.log"), "raw done\n");
}

async function writeSourceWidthTaskFiles(input: {
  workspace: string;
  taskId: string;
  taskDir: string;
  workerDir: string;
}): Promise<void> {
  await writeJson(
    join(input.taskDir, "meta.json"),
    TaskMetaSchema.parse({
      id: input.taskId,
      title: "worker source width smoke",
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
    join(input.workerDir, "output.log"),
    [
      "exec",
      '/bin/zsh -lc "nl -ba src/source-width.ts | sed -n \'1,4p\'"',
      "succeeded in 0ms:",
      '1\tconst sourceValue = "中文源码行 mixed with ascii punctuation should wrap inside panel and keep source tail";',
      '2\tconst sourceTail = "aligned continuation stays on themed surface and preserves keep source tail";'
    ].join("\n")
  );
}

async function writeNanoProcessTaskFiles(input: {
  workspace: string;
  taskId: string;
  taskDir: string;
  workerDir: string;
}): Promise<void> {
  await writeJson(
    join(input.taskDir, "meta.json"),
    TaskMetaSchema.parse({
      id: input.taskId,
      title: "worker nano fill smoke",
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
  await writeFile(join(input.workerDir, "output.log"), "ok\n");
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
  if (await tryWaitForScreenText(screenWritesRef, screen, text, 100)) {
    return;
  }
  throw new Error(`Timed out waiting for screen text ${text}\nSnapshot:\n${screen.snapshot()}`);
}

async function waitForScreenTextGone(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await screenWritesRef();
    if (!screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting to remove screen text ${text}\nSnapshot:\n${screen.snapshot()}`);
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

async function openWorkerLogs(
  child: { write(data: string): void },
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  expectedText: string
): Promise<void> {
  await waitForScreenText(screenWritesRef, screen, "^W logs");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    child.write("\x17");
    if (await tryWaitForScreenText(screenWritesRef, screen, expectedText, 20)) {
      return;
    }
    await waitForScreenText(screenWritesRef, screen, "^W logs");
  }
  await waitForScreenText(screenWritesRef, screen, expectedText);
}

async function openAttachError(
  child: { write(data: string): void },
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  expectedText: string
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    child.write("\x0f");
    if (await tryWaitForScreenText(screenWritesRef, screen, expectedText, 20)) {
      return;
    }
  }
  await waitForScreenText(screenWritesRef, screen, expectedText);
}

async function tryWaitForScreenText(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  text: string,
  attempts: number
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await screenWritesRef();
    if (screen.snapshot().includes(text)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
