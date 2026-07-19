import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { SessionManager } from "../src/core/session-manager.js";
import { prepareWorkspace } from "../src/core/workspace.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

const realIt = process.env.PCT_REAL_AGENT_TESTS === "1" ? it : it.skip;

describe("CLI real Agent multi-workspace acceptance", () => {
  realIt("keeps two real Claude sessions isolated while switching inside one TUI", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-real-workspace-app-"));
    const projectsRoot = await mkdtemp(join(tmpdir(), "pct-real-workspaces-"));
    const first = join(projectsRoot, "real-first");
    const second = join(projectsRoot, "real-second");
    await prepareWorkspace(appRoot, first);
    await prepareWorkspace(appRoot, second);
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "simple"',
        "",
        "[workers.claude]",
        "timeoutMs = 180000",
        "firstOutputTimeoutMs = 120000",
        "idleTimeoutMs = 60000",
        "",
        "[workers.claude.model.env]",
        'HTTP_PROXY = "{env:HTTP_PROXY}"',
        'HTTPS_PROXY = "{env:HTTPS_PROXY}"',
        'ALL_PROXY = "{env:ALL_PROXY}"',
        'NO_PROXY = "{env:NO_PROXY}"',
        "",
        "[pairing]",
        'main = "claude"',
        'judge = "codex"',
        'actor = "codex"',
        'critic = "claude"',
        ""
      ].join("\n"),
      "utf8"
    );

    const screen = new NativeTerminalScreen({ cols: 110, rows: 22, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", first],
      {
        cwd: process.cwd(),
        cols: 110,
        rows: 22,
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
      expect(screen.snapshot().split("\n")[0]).toContain(basename(first));
      child.write("这是连通性验收。记住暗号 PCT_REAL_MEMORY_CYAN，然后只回复 PCT_REAL_WORKSPACE_ONE，不要使用工具。\r");
      await waitForScreenText(() => screenWrites, screen, "PCT_REAL_WORKSPACE_ONE");
      await waitForScreenText(() => screenWrites, screen, "> | message");

      const firstSessionPath = join(
        first,
        ".parallel-codex",
        "sessions",
        "main",
        "main-claude",
        "native-session.json"
      );
      const firstSession = JSON.parse(await readFile(firstSessionPath, "utf8")) as { session_id: string };
      const firstSessions = new SessionManager({
        projectRoot: first,
        dataDir: ".parallel-codex"
      });
      await firstSessions.retireNativeSession(
        { dir: join(first, ".parallel-codex", "sessions", "main", "main-claude") },
        "real file-backed memory acceptance"
      );
      child.write("刚才让我记住的暗号是什么？只回复 MEMORY= 加暗号，不要使用工具。\r");
      await waitForScreenText(() => screenWrites, screen, "MEMORY=PCT_REAL_MEMORY_CYAN");
      await waitForScreenText(() => screenWrites, screen, "> | message");
      const replacementSession = JSON.parse(await readFile(firstSessionPath, "utf8")) as { session_id: string };
      expect(replacementSession.session_id).not.toBe(firstSession.session_id);

      child.write("\x10");
      await waitForScreenText(() => screenWrites, screen, "Open project");
      child.write("2");
      await waitForProjectChat(() => screenWrites, screen, second);
      expect(screen.snapshot()).not.toContain("PCT_REAL_WORKSPACE_ONE");
      child.write("这是连通性验收。请只回复 PCT_REAL_WORKSPACE_TWO，不要使用工具。\r");
      await waitForScreenText(() => screenWrites, screen, "PCT_REAL_WORKSPACE_TWO");
      await waitForScreenText(() => screenWrites, screen, "> | message");

      child.write("\x10");
      await waitForScreenText(() => screenWrites, screen, "Open project");
      child.write("2");
      await waitForProjectChat(() => screenWrites, screen, first);
      await waitForScreenText(() => screenWrites, screen, "PCT_REAL_WORKSPACE_ONE");
      expect(screen.snapshot().split("\n")[0]).toContain(basename(first));
      expect(screen.snapshot()).not.toContain("PCT_REAL_WORKSPACE_TWO");

      const firstHistory = await readFile(join(first, ".parallel-codex", "sessions", "main", "chat.jsonl"), "utf8");
      const secondHistory = await readFile(join(second, ".parallel-codex", "sessions", "main", "chat.jsonl"), "utf8");
      expect(firstHistory).toContain("PCT_REAL_WORKSPACE_ONE");
      expect(firstHistory).not.toContain("PCT_REAL_WORKSPACE_TWO");
      expect(secondHistory).toContain("PCT_REAL_WORKSPACE_TWO");
      expect(secondHistory).not.toContain("PCT_REAL_WORKSPACE_ONE");
      expect(systemResponses(firstHistory)).toContain("PCT_REAL_WORKSPACE_ONE");
      expect(systemResponses(secondHistory)).toContain("PCT_REAL_WORKSPACE_TWO");

      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 300_000);
});

async function waitForScreenText(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await screenWritesRef();
    if (screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${text}\nSnapshot:\n${screen.snapshot()}`);
}

async function waitForProjectChat(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  workspace: string
): Promise<void> {
  const project = basename(workspace);
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await screenWritesRef();
    const snapshot = screen.snapshot();
    const header = snapshot.split("\n")[0] ?? "";
    if (header.includes(project) && header.includes("parallel-codex-tui") && snapshot.includes("> | message")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${project} chat\nSnapshot:\n${screen.snapshot()}`);
}

function systemResponses(history: string): string {
  return history
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { from?: string; text?: string })
    .filter((record) => record.from === "system")
    .map((record) => record.text ?? "")
    .join("\n");
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
