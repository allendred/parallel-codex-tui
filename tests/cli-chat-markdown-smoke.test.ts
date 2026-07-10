import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";
import { TUI_THEME_PRESETS } from "../src/tui/theme.js";

describe("CLI chat Markdown smoke", () => {
  it("renders Main Markdown with semantic theme styles and hides local link targets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-chat-markdown-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-chat-markdown-app-"));
    const agentScript = join(appRoot, "fake-main.cjs");
    const screen = new NativeTerminalScreen({ cols: 100, rows: 18, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      agentScript,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  process.stdout.write('See [review.md](/tmp/review.md:1), run `npm test`, then **ship it**.\\n');",
        "});"
      ].join("\n")
    );
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "simple"',
        "",
        "[workers.codex]",
        `command = "${escapeToml(process.execPath)}"`,
        `args = ["${escapeToml(agentScript)}"]`,
        "",
        "[pairing]",
        'main = "codex"',
        'judge = "codex"',
        'actor = "codex"',
        'critic = "codex"'
      ].join("\n") + "\n"
    );

    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 18,
        name: "xterm-256color",
        env: {
          ...process.env,
          TERM: "xterm-256color"
        }
      }
    );

    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForScreenText(() => screenWrites, screen, "> | message");
      child.write("show result\r");
      await waitForScreenText(() => screenWrites, screen, "See review.md");

      const snapshot = screen.snapshot();
      const responseLine = screen
        .styledSnapshotLines()
        .find((line) => line.chunks.map((chunk) => chunk.text).join("").includes("See review.md"));
      const linkText = responseLine?.chunks
        .filter((chunk) => chunk.style.color === TUI_THEME_PRESETS.codex.accent && chunk.style.underline)
        .map((chunk) => chunk.text)
        .join("") ?? "";
      const codeText = responseLine?.chunks
        .filter((chunk) => (
          chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.rail &&
          chunk.style.color === TUI_THEME_PRESETS.codex.warning
        ))
        .map((chunk) => chunk.text)
        .join("") ?? "";
      const strongText = responseLine?.chunks
        .filter((chunk) => chunk.style.bold && chunk.style.color === TUI_THEME_PRESETS.codex.text)
        .map((chunk) => chunk.text)
        .join("") ?? "";

      expect(snapshot).toContain("See review.md, run npm test, then ship it.");
      expect(snapshot).not.toContain("/tmp/review.md:1");
      expect(snapshot).not.toContain("[review.md]");
      expect(snapshot).not.toContain("`npm test`");
      expect(snapshot).not.toContain("**ship it**");
      expect(linkText).toContain("review.md");
      expect(codeText).toContain("npm test");
      expect(strongText).toContain("ship it");
      expect(snapshot).toContain("route simple");
      expect(snapshot).not.toContain("@ route");
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);
});

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

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
