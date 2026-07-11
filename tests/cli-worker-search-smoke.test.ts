import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { writeJson, writeText } from "../src/core/file-store.js";
import { RouteDecisionSchema, TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI Worker log search smoke", () => {
  it("searches rendered Chinese lines and jumps to semantic error and Diff targets", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-worker-search-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-worker-search-workspace-"));
    const taskId = "task-20260711-090000-search";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const workerDir = join(taskDir, "actor-mock");
    const outputPath = join(workerDir, "output.log");
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeText(join(appRoot, ".parallel-codex", "config.toml"), [
      "[router]",
      'defaultMode = "complex"',
      "",
      "[pairing]",
      'main = "mock"',
      'judge = "mock"',
      'actor = "mock"',
      'critic = "mock"',
      ""
    ].join("\n"));
    await writeJson(join(taskDir, "meta.json"), TaskMetaSchema.parse({
      id: taskId,
      title: "Search worker output",
      created_at: "2026-07-11T09:00:00.000Z",
      cwd: workspace,
      mode: "complex",
      status: "done"
    }));
    await writeJson(join(taskDir, "route.json"), RouteDecisionSchema.parse({
      mode: "complex",
      reason: "Search fixture",
      source: "forced",
      duration_ms: 0,
      suggested_roles: ["actor"],
      actor_engine: "mock"
    }));
    await writeJson(join(workerDir, "status.json"), WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "fixture-ready",
      last_event_at: "2026-07-11T09:01:00.000Z",
      summary: "Search fixture ready"
    }));
    await writeText(join(workerDir, "worklog.md"), [
      "# Search Fixture",
      "",
      "- 中文目标 alpha",
      "- unrelated middle row",
      "- 中文目标 omega",
      ""
    ].join("\n"));
    await writeText(join(workerDir, "patch.diff"), [
      "diff --git a/src/search.ts b/src/search.ts",
      "index 1111111..2222222 100644",
      "--- a/src/search.ts",
      "+++ b/src/search.ts",
      "@@ -1,2 +1,2 @@",
      "-const mode = 'old';",
      "+const mode = 'new';",
      ""
    ].join("\n"));
    await writeText(outputPath, [
      "ERROR: unique search failure",
      ...Array.from({ length: 30 }, (_, index) => `trace step ${String(index + 1).padStart(2, "0")}`),
      ""
    ].join("\n"));

    const screen = new NativeTerminalScreen({ cols: 100, rows: 16, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 100,
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
      await waitForScreenText(() => screenWrites, screen, "^W logs");
      child.write("\x17");
      await waitForScreenText(() => screenWrites, screen, "^F find");
      expect(screen.snapshot()).not.toContain("ERROR: unique search failure");

      child.write("\x06");
      await waitForScreenText(() => screenWrites, screen, "/ |");
      child.write("中文");
      child.write("目标");
      await waitForScreenText(() => screenWrites, screen, "/ 中文目标|");
      await waitForScreenText(() => screenWrites, screen, "1/2");
      await waitForScreenText(() => screenWrites, screen, "find 1/2");
      expect(selectedLine(screen, "中文目标").trimStart()).toMatch(/^>/);

      child.write("\r");
      await waitForScreenText(() => screenWrites, screen, "2/2");
      await waitForScreenText(() => screenWrites, screen, "find 2/2");
      expect(selectedLine(screen, "中文目标").trimStart()).toMatch(/^>/);
      child.write("\x1b[A");
      await waitForScreenText(() => screenWrites, screen, "find 1/2");

      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "^F find");
      child.write("e");
      await waitForScreenText(() => screenWrites, screen, "error · unique search failure");
      child.write("dd");
      await waitForScreenText(() => screenWrites, screen, "actor/mock · 1/1 · top");
      await waitForScreenText(() => screenWrites, screen, "1 - const mode = 'old';");

      child.write("\x06不存在");
      await waitForScreenText(() => screenWrites, screen, "0/0");
      child.write("\x1b");
      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 20000);
});

function selectedLine(screen: NativeTerminalScreen, text: string): string {
  return screen.snapshot().split("\n").find((line) => (
    line.includes(text) && line.trimStart().startsWith(">")
  )) ?? "";
}

async function waitForScreenText(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
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
