import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";
import { displayWidth } from "../src/tui/display-width.js";

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
