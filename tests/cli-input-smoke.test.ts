import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";
import { displayWidth } from "../src/tui/display-width.js";
import { readTextIfExists } from "../src/core/file-store.js";

describe("CLI input smoke", () => {
  it("keeps quick consecutive Chinese input chunks in the visible chat input", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-input-"));
    const chunks: string[] = [];
    const child = spawn(process.execPath, ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspace", workspace], {
      cwd: process.cwd(),
      cols: 120,
      rows: 30,
      name: "xterm-256color",
      env: {
        ...process.env,
        TERM: "xterm-256color"
      }
    });

    child.onData((chunk) => chunks.push(chunk));
    try {
      await waitForText(chunks, "ready");
      await waitForText(chunks, "message");
      child.write("做");
      child.write("个");
      child.write("俄罗斯");
      child.write("方块");
      child.write("的游戏");

      await waitForText(chunks, "做个俄罗斯方块的游戏");
      expect(chunks.join("")).toContain("做个俄罗斯方块的游戏");
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("keeps long narrow chat input on one visible tail line", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-long-input-"));
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 32, rows: 18, scrollback: 1000 });
    let screenWrites = Promise.resolve();
    const child = spawn(process.execPath, ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspace", workspace], {
      cwd: process.cwd(),
      cols: 32,
      rows: 18,
      name: "xterm-256color",
      env: {
        ...process.env,
        TERM: "xterm-256color"
      }
    });

    child.onData((chunk) => {
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    try {
      await waitForText(chunks, "ready");
      await waitForText(chunks, "message");
      child.write("请帮我继续优化这个并行编码终端界面让它在窄屏下也保持专业稳定不要换行乱掉");

      await waitForText(chunks, "不要换行乱掉");
      await waitForScreenText(() => screenWrites, screen, "不要换行乱掉");
      const snapshot = screen.snapshot();
      const inputLines = snapshot.split("\n").filter((line) => line.includes("不要换行乱掉"));

      expect(inputLines).toHaveLength(1);
      expect(inputLines[0]).toContain("...");
      expect(snapshot).not.toContain("请帮我继续优化");
      expect(Math.max(...snapshot.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(32);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("edits Chinese text at the visible cursor with terminal navigation keys", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-cursor-input-"));
    const screen = new NativeTerminalScreen({ cols: 40, rows: 18, scrollback: 1000 });
    let screenWrites = Promise.resolve();
    const child = spawn(process.execPath, ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspace", workspace], {
      cwd: process.cwd(),
      cols: 40,
      rows: 18,
      name: "xterm-256color",
      env: {
        ...process.env,
        TERM: "xterm-256color"
      }
    });

    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    try {
      await waitForScreenText(() => screenWrites, screen, "> | message");
      child.write("你好界");
      await waitForScreenText(() => screenWrites, screen, "> 你好界|");

      child.write("\x1b[D");
      await waitForScreenText(() => screenWrites, screen, "> 你好|界");
      child.write("世");
      await waitForScreenText(() => screenWrites, screen, "> 你好世|界");

      child.write("\x1b[H");
      await waitForScreenText(() => screenWrites, screen, "> |你好世界");
      child.write("\x1b[3~");
      await waitForScreenText(() => screenWrites, screen, "> |好世界");
      child.write("\x1b[F");
      await waitForScreenText(() => screenWrites, screen, "> 好世界|");

      expect(screen.snapshot().split("\n").filter((line) => line.includes("好世界|"))).toHaveLength(1);
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("recalls persisted user requests and restores the unsent draft with Up and Down", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-input-history-"));
    const chatDir = join(workspace, ".parallel-codex", "sessions", "main");
    await mkdir(chatDir, { recursive: true });
    await writeFile(
      join(chatDir, "chat.jsonl"),
      [
        JSON.stringify({ time: "2026-07-10T00:00:00.000Z", from: "user", text: "第一条" }),
        JSON.stringify({ time: "2026-07-10T00:00:01.000Z", from: "system", text: "第一条完成" }),
        JSON.stringify({ time: "2026-07-10T00:00:02.000Z", from: "user", text: "第二条" })
      ].join("\n") + "\n",
      "utf8"
    );

    const screen = new NativeTerminalScreen({ cols: 60, rows: 18, scrollback: 1000 });
    let screenWrites = Promise.resolve();
    const child = spawn(process.execPath, ["./node_modules/.bin/tsx", "src/cli.tsx", "--workspace", workspace], {
      cwd: process.cwd(),
      cols: 60,
      rows: 18,
      name: "xterm-256color",
      env: {
        ...process.env,
        TERM: "xterm-256color"
      }
    });

    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    try {
      await waitForScreenText(() => screenWrites, screen, "> | message");
      child.write("草稿");
      await waitForScreenText(() => screenWrites, screen, "> 草稿|");

      child.write("\x1b[A");
      await waitForScreenText(() => screenWrites, screen, "> 第二条|");
      child.write("\x1b[A");
      await waitForScreenText(() => screenWrites, screen, "> 第一条|");
      child.write("\x1b[B");
      await waitForScreenText(() => screenWrites, screen, "> 第二条|");
      child.write("\x1b[B");
      await waitForScreenText(() => screenWrites, screen, "> 草稿|");

      child.write("\x1b[A");
      await waitForScreenText(() => screenWrites, screen, "> 第二条|");
      child.write("改");
      await waitForScreenText(() => screenWrites, screen, "> 第二条改|");
      child.write("\x1b[B");
      await new Promise((resolve) => setTimeout(resolve, 100));
      await screenWrites;

      expect(screen.snapshot()).toContain("> 第二条改|");
      expect(screen.snapshot()).not.toContain("> 草稿|");
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("keeps a split multiline bracketed paste in one draft until explicit submit", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-input-paste-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-input-paste-app-"));
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
        'critic = "mock"'
      ].join("\n") + "\n",
      "utf8"
    );
    const chunks: string[] = [];
    const screen = new NativeTerminalScreen({ cols: 60, rows: 18, scrollback: 1000 });
    let screenWrites = Promise.resolve();
    const child = spawn(process.execPath, [
      "./node_modules/.bin/tsx",
      "src/cli.tsx",
      "--app-root",
      appRoot,
      "--workspace",
      workspace
    ], {
      cwd: process.cwd(),
      cols: 60,
      rows: 18,
      name: "xterm-256color",
      env: {
        ...process.env,
        TERM: "xterm-256color"
      }
    });

    child.onData((chunk) => {
      chunks.push(chunk);
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    try {
      await waitForScreenText(() => screenWrites, screen, "> | message");
      child.write("\x1b[200~第一行");
      child.write("\n第二行\x1b[20");
      child.write("1~");

      await waitForScreenText(() => screenWrites, screen, "> 第一行↵第二行|");
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(await readTextIfExists(join(workspace, ".parallel-codex", "sessions", "main", "chat.jsonl"))).toBe("");
      expect(chunks.join("")).toContain("\x1b[?2004h");

      child.write("继续");
      await waitForScreenText(() => screenWrites, screen, "> 第一行↵第二行继续|");
      expect(screen.snapshot().split("\n").filter((line) => line.includes("第一行↵第二行继续|"))).toHaveLength(1);

      child.write("\r");
      await waitForScreenText(() => screenWrites, screen, "Mock simple response for: 第一行");
      const chatPath = join(workspace, ".parallel-codex", "sessions", "main", "chat.jsonl");
      await waitForFileText(chatPath, "第二行继续");
      const records = (await readTextIfExists(chatPath))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { from: string; text: string });
      expect(records[0]).toMatchObject({
        from: "user",
        text: "第一行\n第二行继续"
      });
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);
});

async function waitForText(chunks: string[], text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await screenWritesRef();
    if (screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for screen text ${text}\nSnapshot:\n${screen.snapshot()}`);
}

async function waitForFileText(path: string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await readTextIfExists(path)).includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text} in ${path}`);
}
