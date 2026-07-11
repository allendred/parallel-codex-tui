import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { ensureDir } from "../src/core/file-store.js";
import { prepareWorkspace } from "../src/core/workspace.js";
import type { RouterAuditRecord } from "../src/core/router-audit.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI Router diagnostics smoke", () => {
  it("opens the global audit, scrolls, preserves the draft, refreshes, and exits", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-router-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-router-workspace-"));
    const otherWorkspace = await mkdtemp(join(tmpdir(), "pct-cli-router-other-"));
    await prepareWorkspace(appRoot, workspace);
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
    const routerDirectory = join(appRoot, ".parallel-codex", "router");
    await ensureDir(routerDirectory);
    const records = [
      ...Array.from({ length: 26 }, (_, index) => routeRecord(
      index === 0 ? "oldest-route-00" : index === 25 ? "newest-visible" : `route-${String(index).padStart(2, "0")}`,
      workspace,
      index
      )),
      routeRecord("other-workspace-route", otherWorkspace, 26)
    ];
    await writeFile(
      join(routerDirectory, "routes.jsonl"),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8"
    );

    const screen = new NativeTerminalScreen({ cols: 100, rows: 16, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 16,
        name: "xterm-256color",
        env: withoutProxyEnvironment(process.env)
      }
    );
    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "^G routes");
      child.write("draft survives");
      await waitForScreenText(() => screenWrites, screen, "> draft survives|");

      child.write("\x07");
      await waitForScreenText(() => screenWrites, screen, "Router diagnostics");
      await waitForScreenText(() => screenWrites, screen, "newest-visible");
      let snapshot = screen.snapshot();
      expect(snapshot.split("\n")[0]).toContain("routes");
      expect(snapshot).toContain("scope · all · 27/27 routes · 2 workspaces");
      expect(snapshot).toContain("latency · p50");
      expect(snapshot).toContain("proxy · direct now");
      expect(snapshot).not.toContain("user:secret");

      child.write("\t");
      await waitForScreenText(() => screenWrites, screen, `scope · current · ${basename(workspace)} · 26/27 routes`);
      await waitForScreenText(() => screenWrites, screen, "evidence · timeout · limit 30s");
      snapshot = screen.snapshot();
      expect(snapshot).not.toContain("other-workspace-route");
      expect(snapshot).toContain("Tab scope");
      expect(snapshot).toContain("cause unproven");

      child.write("\t");
      await waitForScreenText(() => screenWrites, screen, "scope · all · 27/27 routes · 2 workspaces");

      child.write("\x1b[6~".repeat(8));
      await waitForScreenText(() => screenWrites, screen, "oldest-route-00");

      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "> draft survives|");
      child.write("\r");
      await waitForScreenText(() => screenWrites, screen, "Mock simple response for: draft survives");
      await waitForScreenText(() => screenWrites, screen, "^G routes");

      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "logs · scroll");
      child.write("\x07");
      await waitForScreenText(() => screenWrites, screen, "request · draft survives");
      snapshot = screen.snapshot();
      expect(snapshot).toContain(basename(workspace));
      expect(snapshot).toContain("forced");
      expect(exits).toEqual([]);

      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "logs · scroll");

      child.write("\x07");
      await waitForScreenText(() => screenWrites, screen, "request · draft survives");
      child.write("\t\t\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 20000);
});

function routeRecord(request: string, workspace: string, index: number): RouterAuditRecord {
  return {
    time: new Date(Date.UTC(2026, 6, 11, 7, index)).toISOString(),
    request,
    workspace,
    scope: "initial",
    mode: index === 25 ? "complex" : "simple",
    reason: index === 25
      ? "fallback through http://user:secret@127.0.0.1:7890"
      : `route evidence ${index}`,
    suggested_roles: [],
    judge_engine: "codex",
    actor_engine: "codex",
    critic_engine: "codex",
    source: index === 25 ? "fallback" : "codex",
    duration_ms: index === 25 ? 30000 : 700,
    ...(index === 25
      ? {
          router_timeout_ms: 30000,
          proxy_configured: true,
          failure_kind: "timeout" as const
        }
      : {
          router_timeout_ms: 30000,
          proxy_configured: false
        })
  };
}

function withoutProxyEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!/^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(name) && value !== undefined) {
      result[name] = value;
    }
  }
  return result;
}

async function waitForScreenText(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
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
  throw new Error("Timed out waiting for TUI to exit");
}
