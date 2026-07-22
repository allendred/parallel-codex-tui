import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { pathExists, readJson, writeJson, writeText } from "../src/core/file-store.js";
import { RouteDecisionSchema, TaskMetaSchema, TurnMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI Task session management smoke", () => {
  it("renames, archives, exports, and confirms deletion from the running TUI", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-session-manage-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-session-manage-workspace-"));
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
        'critic = "mock"',
        ""
      ].join("\n"),
      "utf8"
    );
    const managedId = "task-20260715-083100-managed";
    const keepId = "task-20260715-083000-keep";
    await writeTerminalTask(
      workspace,
      managedId,
      "Managed session",
      "2026-07-15T08:31:00.000Z",
      "修复中文输入并增加回归测试"
    );
    await writeTerminalTask(workspace, keepId, "Keep session", "2026-07-15T08:30:00.000Z");
    await writeJson(
      join(workspace, ".parallel-codex", "sessions", managedId, "actor-codex-0001-input", "status.json"),
      WorkerStatusSchema.parse({
        worker_id: "actor-codex-0001-input",
        feature_id: "0001-input",
        feature_title: "中文输入",
        role: "actor",
        engine: "codex",
        model_name: "gpt-5.6-codex",
        model_provider: "openai",
        state: "done",
        phase: "implementation",
        last_event_at: "2026-07-15T08:32:00.000Z",
        summary: "中文输入回归测试已通过"
      })
    );

    const run = startCli(appRoot, workspace);
    try {
      await waitForScreenText(run, "> | message");
      run.child.write("\x0e");
      await waitForScreenText(run, "new conversation · ready");
      run.child.write("\x14");
      await waitForScreenText(run, "Task sessions");
      await waitForScreenText(run, ">   Managed session");

      run.child.write("\x06");
      await waitForScreenText(run, "find > |");
      run.child.write("turn:中文 role:actor provider:codex state:done");
      await waitForScreenText(run, "1 match · 1 done");
      await waitForScreenText(run, "match · turn 1 修复中文输入并增加回归测试");
      expect(run.screen.snapshot()).not.toContain("Keep session");
      run.child.write("\rxx");
      await waitForScreenText(run, "Task search cleared");
      await waitForScreenText(run, "2 tasks · 2 done");

      run.child.write("r");
      await waitForScreenText(run, "rename > Managed session|");
      run.child.write("\x01");
      run.child.write("\x1b[3~".repeat(Array.from("Managed session").length));
      run.child.write("整理后的会话\r");
      await waitForScreenText(run, "Renamed · 整理后的会话");
      await expectTaskTitle(workspace, managedId, "整理后的会话");

      run.child.write("a");
      await waitForScreenText(run, "Archived · 整理后的会话");
      await waitForScreenText(run, "1 task · 1 done");
      await expectTaskArchived(workspace, managedId, true);

      run.child.write("h");
      await waitForScreenText(run, "Task sessions · archived shown");
      await waitForScreenText(run, "2 tasks · 1 done · 1 archived");
      run.child.write("\x1b[A");
      await waitForScreenText(run, ">   整理后的会话 · archived · done");
      run.child.write("a");
      await waitForScreenText(run, "Unarchived · 整理后的会话");
      await expectTaskArchived(workspace, managedId, false);

      run.child.write("e");
      await waitForScreenText(run, "Exported ·");
      const exportsRoot = join(workspace, ".parallel-codex", "exports");
      const exportNames = await waitForDirectoryEntries(exportsRoot, 1);
      const exportDir = join(exportsRoot, exportNames[0] ?? "missing");
      expect(await pathExists(join(exportDir, "manifest.json"))).toBe(true);
      expect(await pathExists(join(exportDir, "report.md"))).toBe(true);
      expect(await pathExists(join(exportDir, "report.json"))).toBe(true);
      expect(await pathExists(join(exportDir, "session", "meta.json"))).toBe(true);

      run.child.write("d");
      await waitForScreenText(run, "D confirm · Esc cancel");
      expect(await pathExists(join(workspace, ".parallel-codex", "sessions", managedId))).toBe(true);
      run.child.write("d");
      await waitForScreenText(run, "Deleted · 整理后的会话");
      expect(await pathExists(join(workspace, ".parallel-codex", "sessions", managedId))).toBe(false);
      expect(await pathExists(join(workspace, ".parallel-codex", "sessions", keepId))).toBe(true);

      run.child.write("\x03");
      await waitForExit(run.exits);
      expect(run.exits[0]).toBe(0);
    } finally {
      stopCli(run);
    }
  }, 30000);
});

async function writeTerminalTask(
  workspace: string,
  taskId: string,
  title: string,
  createdAt: string,
  request = title
): Promise<void> {
  const sessionDir = join(workspace, ".parallel-codex", "sessions", taskId);
  const route = RouteDecisionSchema.parse({
    mode: "complex",
    reason: "Persisted task session.",
    source: "forced",
    suggested_roles: ["judge", "actor", "critic"],
    judge_engine: "mock",
    actor_engine: "mock",
    critic_engine: "mock"
  });
  await writeJson(join(sessionDir, "meta.json"), TaskMetaSchema.parse({
    id: taskId,
    title,
    created_at: createdAt,
    cwd: workspace,
    mode: "complex",
    status: "done"
  }));
  await writeJson(join(sessionDir, "route.json"), route);
  await writeText(join(sessionDir, "user-request.md"), `${request}\n`);
  await writeJson(join(sessionDir, "turns", "0001", "turn.json"), TurnMetaSchema.parse({
    task_id: taskId,
    turn_id: "0001",
    created_at: createdAt,
    request_path: "turns/0001/user.md"
  }));
  await writeJson(join(sessionDir, "turns", "0001", "route.json"), route);
  await writeText(join(sessionDir, "turns", "0001", "user.md"), `${request}\n`);
}

function startCli(appRoot: string, workspace: string) {
  const screen = new NativeTerminalScreen({ cols: 110, rows: 22, scrollback: 400 });
  const exits: number[] = [];
  let screenWrites = Promise.resolve();
  const child = spawn(process.execPath, [
    "--import",
    "tsx",
    "src/cli.tsx",
    "--app-root",
    appRoot,
    "--workspace",
    workspace
  ], {
    cwd: process.cwd(),
    cols: 110,
    rows: 22,
    env: { ...process.env, FORCE_COLOR: "0" }
  });
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

async function expectTaskTitle(workspace: string, taskId: string, title: string): Promise<void> {
  const meta = await readJson(
    join(workspace, ".parallel-codex", "sessions", taskId, "meta.json"),
    TaskMetaSchema
  );
  expect(meta.title).toBe(title);
}

async function expectTaskArchived(workspace: string, taskId: string, archived: boolean): Promise<void> {
  const meta = await readJson(
    join(workspace, ".parallel-codex", "sessions", taskId, "meta.json"),
    TaskMetaSchema
  );
  expect(Boolean(meta.archived_at)).toBe(archived);
}

async function waitForDirectoryEntries(path: string, count: number): Promise<string[]> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const entries = (await readdir(path)).filter((entry) => !entry.startsWith("."));
      if (entries.length === count) {
        return entries;
      }
    } catch {
      // Export is still being created.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} exports in ${path}`);
}

async function waitForScreenText(run: ReturnType<typeof startCli>, text: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    await run.screenWrites();
    if (run.screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${text}\nSnapshot:\n${run.screen.snapshot()}`);
}

async function waitForExit(exits: number[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (exits.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for CLI exit");
}
