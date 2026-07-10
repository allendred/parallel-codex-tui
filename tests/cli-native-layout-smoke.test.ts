import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { defaultConfig } from "../src/core/config.js";
import { writeJson } from "../src/core/file-store.js";
import { NativeSessionSchema, TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { displayWidth } from "../src/tui/display-width.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";
import { TUI_THEME_PRESETS } from "../src/tui/theme.js";

describe("CLI native layout smoke", () => {
  it("keeps the outer app chrome visible when native attach output fills a short terminal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-native-layout-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-native-layout-app-"));
    const taskId = "task-20260705-000000-native-layout";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const agentScript = join(workspace, "fake-agent.cjs");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 140, rows: 24, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      agentScript,
      [
        "for (let index = 1; index <= 40; index += 1) console.log('native line ' + index);",
        "setInterval(() => {}, 1000);"
      ].join("")
    );
    await writeConfig(appRoot, agentScript);
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace, "--task", taskId],
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
      await waitForText(chunks, "attach");
      child.write("\x0f");
      await waitForText(chunks, "native line 40");
      await waitForScreenText(() => screenWrites, screen, "native line 40");

      const snapshot = screen.snapshot();
      const nativeTitleLine = screen
        .styledSnapshotLines()
        .find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("native actor/mock"));
      const nativeTitleLineText = nativeTitleLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const nativeIdentityText = nativeTitleLine?.chunks
        .filter((chunk) => chunk.style.color === TUI_THEME_PRESETS.codex.accent)
        .map((chunk) => chunk.text)
        .join("") ?? "";
      const nativeMetadataText = nativeTitleLine?.chunks
        .filter((chunk) => chunk.style.color === TUI_THEME_PRESETS.codex.muted)
        .map((chunk) => chunk.text)
        .join("") ?? "";
      expect(snapshot).toContain("parallel-codex-tui");
      expect(snapshot).toContain("native");
      expect(snapshot).not.toContain("Native agent");
      expect(snapshot).toContain("#000000-native-layout");
      expect(snapshot).not.toContain("task 000000-native-layout");
      expect(snapshot).toContain("native line 40");
      expect(snapshot).toContain("native · scroll · ^] logs");
      expect(snapshot).not.toContain("native · wheel/Pg");
      expect(nativeTitleLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.chrome)).toBe(true);
      expect(nativeTitleLine?.chunks.some((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.rail)).toBe(false);
      expect(nativeIdentityText).toContain("native actor/mock");
      expect(nativeMetadataText).toContain("native-layout");
      expect(displayWidth(nativeTitleLineText)).toBe(137);
    } finally {
      child.write("\x1d");
      child.kill("SIGTERM");
    }
  }, 10000);

  it("keeps native attach titles compact in a narrow terminal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-native-compact-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-native-compact-app-"));
    const taskId = "task-20260705-000000-native-compact";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const agentScript = join(workspace, "fake-agent.cjs");
    const nativeSessionId = "native-snap-session-long-id";
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 42, rows: 18, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      agentScript,
      [
        "for (let index = 1; index <= 8; index += 1) console.log('native line ' + index);",
        "setInterval(() => {}, 1000);"
      ].join("")
    );
    await writeConfig(appRoot, agentScript);
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir, nativeSessionId });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace, "--task", taskId],
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
      await waitForText(chunks, "attach");
      child.write("\x0f");
      await waitForText(chunks, "native line 8");
      await waitForScreenText(() => screenWrites, screen, "native line 8");
      await waitForScreenText(() => screenWrites, screen, "native · scroll · ^]");

      const snapshot = screen.snapshot();
      const headerRow = snapshot.split("\n")[0] ?? "";
      expect(headerRow).toContain("pct");
      expect(headerRow).toContain("^]");
      expect(snapshot).not.toContain("│");
      expect(snapshot).toContain("native actor/mock");
      expect(snapshot).toContain("native-snap");
      expect(snapshot).toContain("...");
      expect(snapshot).toContain("native line 8");
      expect(snapshot).toContain("native · scroll · ^]");
      expect(snapshot).not.toContain("native · wheel/Pg");
      expect(snapshot).not.toContain("native · ^] logs");
      expect(snapshot).not.toContain("fake-agent.cjs");
      expect(snapshot).not.toContain(`(${nativeSessionId})`);
      expect(snapshot).not.toContain(`\n (${nativeSessionId})`);
    } finally {
      child.write("\x1d");
      child.kill("SIGTERM");
    }
  }, 10000);

  it("fills short native attach blank rows with the themed surface", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-native-short-fill-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-native-short-fill-app-"));
    const taskId = "task-20260705-000000-native-short-fill";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const agentScript = join(workspace, "fake-agent.cjs");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 64, rows: 18, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(agentScript, "console.log('native short line'); setInterval(() => {}, 1000);");
    await writeConfig(appRoot, agentScript);
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir, nativeSessionId: "native-short-fill" });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 64,
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
      await waitForText(chunks, "attach");
      child.write("\x0f");
      await waitForText(chunks, "native short line");
      await waitForScreenText(() => screenWrites, screen, "native short line");
      await waitForScreenText(() => screenWrites, screen, "native · scroll");

      const lines = screen.styledSnapshotLines();
      const nativeTitleLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("native actor/mock"));
      const nativeTitleLineText = nativeTitleLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const outputIndex = lines.findIndex((line) => line.chunks.map((chunk) => chunk.text).join("").includes("native short line"));
      const inputIndex = lines.findIndex((line) => line.chunks.map((chunk) => chunk.text).join("").includes("native · scroll"));
      const blankContentLines = lines.slice(outputIndex + 1, inputIndex).filter((line) => {
        const text = line.chunks.map((chunk) => chunk.text).join("");
        return text.trim().length === 0;
      });

      expect(outputIndex).toBeGreaterThanOrEqual(0);
      expect(inputIndex).toBeGreaterThan(outputIndex);
      expect(blankContentLines.length).toBeGreaterThan(0);
      expect(blankContentLines.every((line) => displayWidth(line.chunks.map((chunk) => chunk.text).join("")) === displayWidth(nativeTitleLineText))).toBe(true);
      expect(blankContentLines.every((line) => line.chunks.every((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.surface))).toBe(true);
    } finally {
      child.write("\x1d");
      child.kill("SIGTERM");
    }
  }, 10000);

  it("fills native attach empty output placeholders with the themed surface", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-native-empty-fill-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-native-empty-fill-app-"));
    const taskId = "task-20260705-000000-native-empty-fill";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const agentScript = join(workspace, "fake-agent.cjs");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 64, rows: 18, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(agentScript, "setInterval(() => {}, 1000);");
    await writeConfig(appRoot, agentScript);
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir, nativeSessionId: "native-empty-fill" });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 64,
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
      await waitForText(chunks, "attach");
      child.write("\x0f");
      await waitForScreenText(() => screenWrites, screen, "waiting for output");

      const lines = screen.styledSnapshotLines();
      const nativeTitleLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("native actor/mock"));
      const nativeTitleLineText = nativeTitleLine?.chunks.map((chunk) => chunk.text).join("") ?? "";
      const emptyLine = lines.find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("waiting for output"));
      const emptyLineText = emptyLine?.chunks.map((chunk) => chunk.text).join("") ?? "";

      expect(emptyLineText).toContain("waiting for output");
      expect(displayWidth(emptyLineText)).toBe(displayWidth(nativeTitleLineText));
      expect(emptyLine?.chunks.every((chunk) => chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.surface)).toBe(true);
    } finally {
      child.write("\x1d");
      child.kill("SIGTERM");
    }
  }, 10000);

  it("shows closed native guidance when the attached process exits", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-native-closed-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-native-closed-app-"));
    const taskId = "task-20260705-000000-native-closed";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const agentScript = join(workspace, "fake-agent.cjs");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 42, rows: 18, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(agentScript, "console.log('native done'); process.exit(7);");
    await writeConfig(appRoot, agentScript);
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir, nativeSessionId: "native-closed-session" });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace, "--task", taskId],
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
      await waitForText(chunks, "attach");
      child.write("\x0f");
      await waitForText(chunks, "process exited · code 7");
      await waitForScreenText(() => screenWrites, screen, "exited 7");
      await waitForScreenText(() => screenWrites, screen, "closed · scroll · ^]");

      const snapshot = screen.snapshot();
      const closedTitleLine = screen
        .styledSnapshotLines()
        .find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("native actor/mock · exited 7"));
      const exitStateText = closedTitleLine?.chunks
        .filter((chunk) => chunk.style.color === TUI_THEME_PRESETS.codex.danger)
        .map((chunk) => chunk.text)
        .join("") ?? "";
      expect(snapshot).toContain("native done");
      expect(snapshot).toContain("process exited · code 7");
      expect(snapshot).toContain("native actor/mock · exited 7");
      expect(exitStateText).toContain("exited 7");
      expect(snapshot).toContain("closed · scroll · ^]");
      expect(snapshot).not.toContain("closed · scroll · ^] logs");
      expect(snapshot).not.toContain("closed · scroll · ^] back");
      expect(snapshot).not.toContain("native · scroll · ^]");
      expect(snapshot).not.toContain("wheel/Pg");
    } finally {
      child.write("\x1d");
      child.kill("SIGTERM");
    }
  }, 10000);

  it("resizes the embedded native screen and PTY with the outer terminal", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-native-resize-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-native-resize-app-"));
    const taskId = "task-20260705-000000-native-resize";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const agentScript = join(workspace, "resize-agent.cjs");
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 100, rows: 24, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(workerDir, { recursive: true });
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      agentScript,
      [
        "const report = () => console.log(`inner-size:${process.stdout.columns}x${process.stdout.rows}`);",
        "report();",
        "process.on('SIGWINCH', report);",
        "setInterval(() => {}, 1000);"
      ].join("\n")
    );
    await writeConfig(appRoot, agentScript);
    await writeTaskFiles({ workspace, taskId, taskDir, workerDir, nativeSessionId: "native-resize" });

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace, "--task", taskId],
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
      await waitForText(chunks, "attach");
      child.write("\x0f");
      await waitForText(chunks, "inner-size:98x19");

      child.resize(60, 16);
      const resizableScreen = screen as NativeTerminalScreen & { resize?: (cols: number, rows: number) => void };
      resizableScreen.resize?.(60, 16);
      await waitForText(chunks, "inner-size:58x11");
      await waitForScreenText(() => screenWrites, screen, "inner-size:58x11");

      const snapshot = screen.snapshot();
      expect(snapshot.split("\n")[0]).toContain("pct");
      expect(snapshot).toContain("native actor/mock");
      expect(Math.max(...snapshot.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(60);
    } finally {
      child.write("\x1d");
      child.kill("SIGTERM");
    }
  }, 10000);
});

async function writeConfig(appRoot: string, agentScript: string): Promise<void> {
  const config = defaultConfig(appRoot);
  const text = [
    "[router]",
    'defaultMode = "complex"',
    "",
    "[workers.mock]",
    `command = "${escapeToml(agentScript)}"`,
    "args = []",
    "",
    "[workers.mock.interactive]",
    `command = "${escapeToml(process.execPath)}"`,
    `args = ["${escapeToml(agentScript)}"]`,
    "",
    "[workers.mock.nativeSession]",
    'fallback = "new"',
    "",
    "[pairing]",
    'main = "mock"',
    'judge = "mock"',
    'actor = "mock"',
    'critic = "mock"',
    "",
    "[ui]",
    `showStatusBar = ${config.ui.showStatusBar}`,
    `autoOpenFailedWorker = ${config.ui.autoOpenFailedWorker}`
  ].join("\n");

  await writeFile(join(appRoot, ".parallel-codex", "config.toml"), `${text}\n`);
}

async function writeTaskFiles(input: {
  workspace: string;
  taskId: string;
  taskDir: string;
  workerDir: string;
  nativeSessionId?: string;
}): Promise<void> {
  const nativeSessionId = input.nativeSessionId ?? "native-layout";
  await writeJson(
    join(input.taskDir, "meta.json"),
    TaskMetaSchema.parse({
      id: input.taskId,
      title: "native layout smoke",
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
      summary: "ready",
      native_session_id: nativeSessionId
    })
  );
  await writeFile(join(input.workerDir, "output.log"), "ready\n");
  await writeJson(
    join(input.workerDir, "native-session.json"),
    NativeSessionSchema.parse({
      engine: "mock",
      role: "actor",
      worker_id: "actor-mock",
      session_id: nativeSessionId,
      scope: "task",
      cwd: input.workspace,
      created_at: "2026-07-05T00:00:00.000Z",
      last_used_at: "2026-07-05T00:00:00.000Z",
      source: "manual"
    })
  );
}

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
    await screenWritesRef();
    if (screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for screen text ${text}\nSnapshot:\n${screen.snapshot()}`);
}
