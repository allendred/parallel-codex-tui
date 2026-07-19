import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { readJson } from "../src/core/file-store.js";
import { ChatRecordSchema, MainConversationStateSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI Main conversation sessions smoke", () => {
  it("restores a prior Main scope and keeps it active across restart", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-main-conversations-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-main-conversations-workspace-"));
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

    const firstRun = startCli(appRoot, workspace);
    let restoredConversationId = "";
    try {
      await waitForScreenText(firstRun, "> | message");
      firstRun.child.write("legacy conversation marker\r");
      await waitForScreenText(firstRun, "Mock simple response for: legacy conversation marker");

      firstRun.child.write("\x0e");
      await waitForScreenText(firstRun, "new conversation · ready");
      firstRun.child.write("conversation A marker\r");
      await waitForScreenText(firstRun, "Mock simple response for: conversation A marker");

      const records = await readChatRecords(workspace);
      restoredConversationId = records.find((record) => record.text === "conversation A marker")?.conversation_id ?? "";
      expect(restoredConversationId).toMatch(/^conversation-/);

      firstRun.child.write("\x0e");
      await waitForConversationChange(workspace, restoredConversationId);
      await waitForChatTextCount(workspace, "new conversation · ready", 2);

      firstRun.child.write("\x14");
      await waitForScreenText(firstRun, "Task sessions");
      await waitForScreenText(firstRun, "No saved task sessions");
      await new Promise((resolve) => setTimeout(resolve, 100));
      firstRun.child.write("c");
      await waitForScreenText(firstRun, "Main conversations");
      await waitForScreenText(firstRun, "3 conversations");
      await waitForScreenText(firstRun, "* Untitled conversation");
      firstRun.child.write("\x1b[B");
      await waitForScreenText(firstRun, ">   conversation A marker");
      firstRun.child.write("\r");
      await waitForScreenText(firstRun, "conversation restored · conversation A marker · 0 native");

      const state = await readJson(
        join(workspace, ".parallel-codex", "sessions", "main", "conversation.json"),
        MainConversationStateSchema
      );
      expect(state.id).toBe(restoredConversationId);
      const restoredRecords = await readChatRecords(workspace);
      expect(restoredRecords.at(-1)).toMatchObject({
        text: "conversation restored · conversation A marker · 0 native",
        conversation_id: restoredConversationId
      });

      firstRun.child.write("\x03");
      await waitForExit(firstRun.exits);
      expect(firstRun.exits[0]).toBe(0);
    } finally {
      stopCli(firstRun);
    }

    const secondRun = startCli(appRoot, workspace);
    try {
      await waitForScreenText(secondRun, "> | message");
      secondRun.child.write("\x14");
      await waitForScreenText(secondRun, "Task sessions");
      await waitForScreenText(secondRun, "No saved task sessions");
      await new Promise((resolve) => setTimeout(resolve, 100));
      secondRun.child.write("c");
      await waitForScreenText(secondRun, "Main conversations");
      await waitForScreenText(secondRun, "* conversation A marker");
      const state = await readJson(
        join(workspace, ".parallel-codex", "sessions", "main", "conversation.json"),
        MainConversationStateSchema
      );
      expect(state.id).toBe(restoredConversationId);
      secondRun.child.write("\x03");
      await waitForExit(secondRun.exits);
      expect(secondRun.exits[0]).toBe(0);
    } finally {
      stopCli(secondRun);
    }
  }, 30000);
});

function startCli(appRoot: string, workspace: string) {
  const screen = new NativeTerminalScreen({ cols: 110, rows: 22, scrollback: 800 });
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

async function readChatRecords(workspace: string) {
  const text = await readFile(
    join(workspace, ".parallel-codex", "sessions", "main", "chat.jsonl"),
    "utf8"
  );
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => ChatRecordSchema.parse(JSON.parse(line)));
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

async function waitForConversationChange(
  workspace: string,
  previousId: string,
  timeoutMs = 5000
): Promise<void> {
  const statePath = join(workspace, ".parallel-codex", "sessions", "main", "conversation.json");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await readJson(statePath, MainConversationStateSchema);
      if (state.id !== previousId) {
        return;
      }
    } catch {
      // The atomic state file may not exist yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for Main conversation to change from ${previousId}`);
}

async function waitForChatTextCount(
  workspace: string,
  text: string,
  count: number,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const records = await readChatRecords(workspace);
      if (records.filter((record) => record.text === text).length >= count) {
        return;
      }
    } catch {
      // The append may still be publishing its first complete JSONL row.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${count} chat records matching ${JSON.stringify(text)}`);
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
      run.child.kill();
    } catch {
      // The PTY may have exited between the guard and kill.
    }
  }
}
