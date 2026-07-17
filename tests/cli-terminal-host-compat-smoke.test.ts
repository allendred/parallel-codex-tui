import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn, type IPty } from "node-pty";
import { displayWidth } from "../src/tui/display-width.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

type TerminalHost = "apple-terminal" | "tmux" | "zellij";

describe("CLI terminal host compatibility smoke", () => {
  it("keeps input, status, and resize layout intact for an Apple Terminal profile", async () => {
    await assertTerminalHost("apple-terminal");
  }, 15000);

  it.skipIf(!commandExists("tmux"))(
    "keeps input, status, and resize layout intact inside a real tmux server",
    async () => {
      await assertTerminalHost("tmux");
    },
    20000
  );

  it.skipIf(!commandExists("zellij"))(
    "keeps input, status, and resize layout intact inside a real zellij session",
    async () => {
      await assertTerminalHost("zellij");
    },
    25000
  );
});

async function assertTerminalHost(host: TerminalHost): Promise<void> {
  const fixture = await createFixture(host);
  const run = startHost(host, fixture, 100, 24);

  try {
    await waitForScreenText(run, "> | message");
    assertScreenBounds(run.screen, 100);
    expect(run.screen.snapshot()).toContain("parallel-codex-tui");

    run.child.write("终端兼容测试\r");
    await waitForScreenText(run, "Mock simple response for: 终端兼容测试");

    const previousRevision = run.outputRevision();
    await resizeHost(host, fixture, run, 42, 18);
    await waitForFreshScreenText(run, previousRevision, "> | message");
    const narrowSnapshot = hostSnapshot(host, fixture, run);
    assertTextBounds(narrowSnapshot, 42);
    expect(narrowSnapshot).not.toContain("�");

    if (host === "apple-terminal") {
      const output = run.rawOutput();
      expect(output).toContain("\x1b[?1049h\x1b[?1007h");
      expect(output).not.toContain("\x1b[?1000h");
      expect(output).not.toContain("\x1b[?1002h");
      expect(output).not.toContain("\x1b[?1003h");
      expect(output).not.toContain("\x1b[?1006h");
    }
  } finally {
    stopHost(host, fixture, run);
  }
}

interface TerminalFixture {
  appRoot: string;
  workspace: string;
  wrapperPath: string;
  sessionName: string;
  tmuxSocket: string;
  zellijConfigDir: string;
}

interface TerminalRun {
  child: IPty;
  screen: NativeTerminalScreen;
  screenWrites(): Promise<void>;
  outputRevision(): number;
  rawOutput(): string;
  exits: number[];
}

async function createFixture(host: TerminalHost): Promise<TerminalFixture> {
  const root = await mkdtemp(join(tmpdir(), `pct-terminal-${host}-`));
  const appRoot = join(root, "app");
  const workspace = join(root, "workspace");
  const zellijConfigDir = join(root, "zellij-config");
  const wrapperPath = join(root, "run-parallel-codex-tui.sh");
  await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(zellijConfigDir, { recursive: true });
  await writeFile(
    join(zellijConfigDir, "config.kdl"),
    [
      'default_mode "locked"',
      "pane_frames false",
      "mouse_mode false",
      "show_startup_tips false",
      "show_release_notes false",
      "session_serialization false",
      "keybinds clear-defaults=true {",
      "  locked {",
      '    bind "Ctrl g" { SwitchToMode "Normal"; }',
      "  }",
      "  normal {",
      '    bind "Ctrl g" { SwitchToMode "Locked"; }',
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
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

  const repoRoot = resolve(import.meta.dirname, "..");
  const command = [
    process.execPath,
    join(repoRoot, "node_modules", ".bin", "tsx"),
    join(repoRoot, "src", "cli.tsx"),
    "--app-root",
    appRoot,
    "--workspace",
    workspace
  ].map(shellQuote).join(" ");
  await writeFile(wrapperPath, `#!/bin/sh\nexec ${command}\n`, "utf8");
  await chmod(wrapperPath, 0o755);

  const suffix = `${process.pid.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    appRoot,
    workspace,
    wrapperPath,
    sessionName: `pct-${host[0]}-${suffix}`,
    tmuxSocket: `pct-${suffix}`,
    zellijConfigDir
  };
}

function startHost(host: TerminalHost, fixture: TerminalFixture, cols: number, rows: number): TerminalRun {
  const screen = new NativeTerminalScreen({ cols, rows, scrollback: 1000 });
  const chunks: string[] = [];
  const exits: number[] = [];
  let pendingWrites = Promise.resolve();
  let outputRevision = 0;
  const env = terminalEnvironment(host, fixture);
  const launch = hostLaunch(host, fixture);
  const child = spawn(launch.command, launch.args, {
    cwd: process.cwd(),
    cols,
    rows,
    name: "xterm-256color",
    env
  });
  child.onData((chunk) => {
    chunks.push(chunk);
    outputRevision += 1;
    pendingWrites = pendingWrites.then(() => screen.write(chunk));
  });
  child.onExit(({ exitCode }) => exits.push(exitCode));

  return {
    child,
    screen,
    screenWrites: () => pendingWrites,
    outputRevision: () => outputRevision,
    rawOutput: () => chunks.join(""),
    exits
  };
}

function hostLaunch(host: TerminalHost, fixture: TerminalFixture): { command: string; args: string[] } {
  if (host === "tmux") {
    return {
      command: "tmux",
      args: [
        "-L",
        fixture.tmuxSocket,
        "-f",
        "/dev/null",
        "-u",
        "new-session",
        "-s",
        fixture.sessionName,
        fixture.wrapperPath
      ]
    };
  }
  if (host === "zellij") {
    return {
      command: "zellij",
      args: [
        "--config-dir",
        fixture.zellijConfigDir,
        "--session",
        fixture.sessionName,
        "options",
        "--default-shell",
        fixture.wrapperPath,
        "--default-mode",
        "locked",
        "--mouse-mode",
        "false",
        "--pane-frames",
        "false",
        "--show-startup-tips",
        "false",
        "--show-release-notes",
        "false",
        "--session-serialization",
        "false"
      ]
    };
  }
  return { command: fixture.wrapperPath, args: [] };
}

function terminalEnvironment(host: TerminalHost, fixture: TerminalFixture): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.ZELLIJ;
  delete env.ZELLIJ_PANE_ID;
  env.TERM = "xterm-256color";
  if (host === "apple-terminal") {
    env.TERM_PROGRAM = "Apple_Terminal";
    env.TERM_PROGRAM_VERSION = "455.1";
  } else {
    delete env.TERM_PROGRAM;
    delete env.TERM_PROGRAM_VERSION;
  }
  if (host === "zellij") {
    env.ZELLIJ_CONFIG_DIR = fixture.zellijConfigDir;
  }
  return env;
}

function stopHost(host: TerminalHost, fixture: TerminalFixture, run: TerminalRun): void {
  if (run.exits.length === 0) {
    run.child.kill("SIGTERM");
  }
  try {
    if (host === "tmux") {
      execFileSync("tmux", ["-L", fixture.tmuxSocket, "kill-server"], { stdio: "ignore" });
    } else if (host === "zellij") {
      execFileSync("zellij", ["kill-session", fixture.sessionName], {
        stdio: "ignore",
        env: terminalEnvironment(host, fixture)
      });
    }
  } catch {
    // The host may already have closed after its only pane exited.
  }
}

async function resizeHost(
  host: TerminalHost,
  fixture: TerminalFixture,
  run: TerminalRun,
  cols: number,
  rows: number
): Promise<void> {
  await run.screenWrites();
  run.screen.resize(cols, rows);
  run.child.resize(cols, rows);
  if (host === "tmux") {
    execFileSync(
      "tmux",
      ["-L", fixture.tmuxSocket, "resize-window", "-t", fixture.sessionName, "-x", String(cols), "-y", String(rows)],
      { stdio: "ignore" }
    );
  }
}

function assertScreenBounds(screen: NativeTerminalScreen, cols: number): void {
  assertTextBounds(screen.snapshot(), cols);
}

function assertTextBounds(text: string, cols: number): void {
  const lines = text.split("\n");
  const widths = lines.map((line) => displayWidth(line));
  const maxWidth = Math.max(...widths);
  if (maxWidth > cols) {
    const index = widths.indexOf(maxWidth);
    throw new Error(`Terminal line exceeds ${cols} columns (${maxWidth}): ${lines[index] ?? ""}`);
  }
}

function hostSnapshot(host: TerminalHost, fixture: TerminalFixture, run: TerminalRun): string {
  if (host === "tmux") {
    return execFileSync(
      "tmux",
      ["-L", fixture.tmuxSocket, "capture-pane", "-p", "-t", fixture.sessionName],
      { encoding: "utf8" }
    );
  }
  if (host === "zellij") {
    return execFileSync(
      "zellij",
      ["--session", fixture.sessionName, "action", "dump-screen"],
      { encoding: "utf8", env: terminalEnvironment(host, fixture) }
    );
  }
  return run.screen.snapshot();
}

async function waitForScreenText(run: TerminalRun, text: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await run.screenWrites();
    if (run.screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text}\nSnapshot:\n${run.screen.snapshot()}\nOutput:\n${run.rawOutput()}`);
}

async function waitForFreshScreenText(run: TerminalRun, revision: number, text: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await run.screenWrites();
    if (run.outputRevision() > revision && run.screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for fresh ${text}\nSnapshot:\n${run.screen.snapshot()}`);
}

function commandExists(command: string): boolean {
  try {
    execFileSync("which", [command], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
