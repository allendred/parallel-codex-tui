import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { pathExists, readJson } from "../src/core/file-store.js";
import { SessionManager } from "../src/core/session-manager.js";
import {
  MainConversationArchiveSchema,
  NativeSessionSchema
} from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI Main conversation management smoke", () => {
  it("renames, archives, exports, and confirms deletion from the running TUI", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-main-manage-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-main-manage-workspace-"));
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
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

    const ids = ["managed", "current"];
    const manager = new SessionManager({
      projectRoot: workspace,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-20T09:00:00.000Z"),
      randomId: () => ids.shift() ?? "later"
    });
    const managed = await manager.startNewMainConversation();
    await manager.appendChatMessage({ from: "user", text: "Managed conversation" });
    await manager.appendChatMessage({ from: "system", text: "Managed answer" });
    await manager.writeNativeSession(
      { dir: join(manager.mainSessionDir(), "main-codex") },
      NativeSessionSchema.parse({
        engine: "codex",
        role: "main",
        worker_id: "main-codex",
        session_id: "native-managed",
        scope: "main",
        cwd: workspace,
        created_at: "2026-07-20T09:00:00.000Z",
        last_used_at: "2026-07-20T09:00:00.000Z",
        source: "manual"
      })
    );
    const current = await manager.startNewMainConversation();
    await manager.appendChatMessage({ from: "user", text: "Current conversation" });

    const run = startCli(appRoot, workspace);
    try {
      await waitForScreenText(run, "> | message");
      run.child.write("\x14");
      await waitForScreenText(run, "Task sessions");
      run.child.write("c");
      await waitForScreenText(run, "Main conversations");
      await waitForScreenText(run, "2 conversations");
      run.child.write("\x1b[B");
      await waitForScreenText(run, ">   Managed conversation");

      run.child.write("r");
      await waitForScreenText(run, "rename > Managed conversation|");
      run.child.write("\x01");
      run.child.write("\x1b[3~".repeat(Array.from("Managed conversation").length));
      run.child.write("整理后的主会话\r");
      await waitForScreenText(run, "Renamed · 整理后的主会话");
      await expectConversationMetadata(workspace, managed.id, {
        title: "整理后的主会话",
        archived: false
      });

      run.child.write("a");
      await waitForScreenText(run, "Archived · 整理后的主会话");
      await expectConversationMetadata(workspace, managed.id, {
        title: "整理后的主会话",
        archived: true
      });

      run.child.write("h");
      await waitForScreenText(run, "Main conversations · archived shown");
      await waitForScreenText(run, "2 conversations · 3 messages · 1 native · 1 archived");
      await waitForScreenText(run, "Archived conversations shown");
      run.child.write("\x1b[B");
      await waitForScreenText(run, ">   整理后的主会话 · archived");
      run.child.write("a");
      await waitForScreenText(run, "Unarchived · 整理后的主会话");
      await expectConversationMetadata(workspace, managed.id, {
        title: "整理后的主会话",
        archived: false
      });

      run.child.write("e");
      await waitForScreenText(run, "Exported ·");
      const exportsRoot = join(workspace, ".parallel-codex", "exports");
      const exportNames = await waitForDirectoryEntries(exportsRoot, 1);
      const exportDir = join(exportsRoot, exportNames[0] ?? "missing");
      const manifest = JSON.parse(await readFile(join(exportDir, "manifest.json"), "utf8")) as {
        format: string;
        message_count: number;
        native_session_count: number;
        conversation: { id: string | null; title: string };
      };
      expect(manifest).toMatchObject({
        format: "parallel-codex-main-conversation-export-v1",
        message_count: 2,
        native_session_count: 1,
        conversation: { id: managed.id, title: "整理后的主会话" }
      });
      const exportedChat = await readFile(join(exportDir, "chat.jsonl"), "utf8");
      expect(exportedChat).toContain("Managed conversation");
      expect(exportedChat).not.toContain("Current conversation");
      expect(await pathExists(join(exportDir, "native-sessions", "main-codex.json"))).toBe(true);

      run.child.write("d");
      await waitForScreenText(run, "D confirm · Esc cancel");
      const archivePath = join(
        workspace,
        ".parallel-codex",
        "sessions",
        "main",
        "conversations",
        managed.id
      );
      expect(await pathExists(archivePath)).toBe(true);
      run.child.write("d");
      await waitForScreenText(run, "Deleted · 整理后的主会话");
      expect(await pathExists(archivePath)).toBe(false);
      const retainedChat = await readFile(
        join(workspace, ".parallel-codex", "sessions", "main", "chat.jsonl"),
        "utf8"
      );
      expect(retainedChat).not.toContain("Managed conversation");
      expect(retainedChat).not.toContain("Managed answer");
      expect(retainedChat).toContain("Current conversation");

      run.child.write("d");
      await waitForScreenText(run, "Restore another Main conversation before deleting the current one");
      const state = await manager.readMainConversationState();
      expect(state?.id).toBe(current.id);

      run.child.write("\x03");
      await waitForExit(run.exits);
      expect(run.exits[0]).toBe(0);
    } finally {
      stopCli(run);
    }
  }, 30000);
});

function startCli(appRoot: string, workspace: string) {
  const screen = new NativeTerminalScreen({ cols: 110, rows: 22, scrollback: 600 });
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

async function expectConversationMetadata(
  workspace: string,
  conversationId: string | null,
  expected: { title: string; archived: boolean }
): Promise<void> {
  if (!conversationId) {
    throw new Error("Expected a named Main conversation id");
  }
  const metadata = await readJson(
    join(
      workspace,
      ".parallel-codex",
      "sessions",
      "main",
      "conversations",
      conversationId,
      "meta.json"
    ),
    MainConversationArchiveSchema
  );
  expect(metadata.title).toBe(expected.title);
  expect(Boolean(metadata.archived_at)).toBe(expected.archived);
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

async function waitForScreenText(
  run: ReturnType<typeof startCli>,
  text: string,
  timeoutMs = 10000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await run.screenWrites();
    if (run.screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${JSON.stringify(text)} · exits ${JSON.stringify(run.exits)}\n${run.screen.snapshot()}`);
}

async function waitForExit(exits: number[], timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exits.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for CLI exit");
}

function stopCli(run: ReturnType<typeof startCli>): void {
  if (run.exits.length === 0) {
    try {
      run.child.kill("SIGTERM");
    } catch {
      // The PTY may have exited between the guard and kill.
    }
  }
}
