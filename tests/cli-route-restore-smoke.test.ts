import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { writeJson } from "../src/core/file-store.js";
import { RouteDecisionSchema, TaskMetaSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI route restore smoke", () => {
  it("restores the latest turn route evidence after restarting a task", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-route-restore-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-route-restore-workspace-"));
    const taskId = "task-20260710-120000-route-restore";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const latestTurnDir = join(taskDir, "turns", "0002");
    const screen = new NativeTerminalScreen({ cols: 80, rows: 16, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();

    await mkdir(latestTurnDir, { recursive: true });
    await writeJson(join(taskDir, "meta.json"), TaskMetaSchema.parse({
      id: taskId,
      title: "restore route evidence",
      created_at: "2026-07-10T12:00:00.000Z",
      cwd: workspace,
      mode: "complex",
      status: "done"
    }));
    await writeJson(join(taskDir, "route.json"), RouteDecisionSchema.parse({
      mode: "complex",
      reason: "Initial Codex route.",
      source: "codex",
      duration_ms: 120,
      suggested_roles: ["judge", "actor", "critic"]
    }));
    await writeJson(join(latestTurnDir, "route.json"), RouteDecisionSchema.parse({
      mode: "complex",
      reason: "Codex router timed out after 30000ms.",
      source: "fallback",
      duration_ms: 30000,
      suggested_roles: ["judge", "actor", "critic"]
    }));
    await writeJson(join(taskDir, "latest-route.json"), RouteDecisionSchema.parse({
      mode: "simple",
      reason: "Configured fallback selected.",
      source: "fallback",
      duration_ms: 30000,
      router_spawn_ms: 1,
      router_process_ms: 30000,
      router_stdout_bytes: 0,
      router_stderr_bytes: 0,
      router_failure_stage: "waiting-output",
      router_failure_kind: "timeout",
      router_timeout_kind: "first-output",
      proxy_configured: true,
      suggested_roles: []
    }));

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 16,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
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
        "route simple · fallback · timeout"
      );
      child.write("\x13");
      await waitForScreenText(() => screenWrites, screen, "parallel-codex-tui · status");
      await waitForScreenText(
        () => screenWrites,
        screen,
        "route simple · fallback · first output timeout · via proxy · 30s"
      );
      const snapshot = screen.snapshot();
      expect(snapshot).not.toContain("route complex · fallback · timeout · 30s");
      expect(snapshot).not.toContain("route complex · 120ms");
      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 10000);
});

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

async function waitForExit(exits: number[]): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (exits.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for CLI exit");
}
