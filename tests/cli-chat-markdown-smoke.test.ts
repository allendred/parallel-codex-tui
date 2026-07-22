import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { readJson, readRecentJsonLines, readTextIfExists } from "../src/core/file-store.js";
import { SessionManager } from "../src/core/session-manager.js";
import { ChatRecordSchema, MainConversationStateSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";
import { TUI_THEME_PRESETS } from "../src/tui/theme.js";

describe("CLI chat Markdown smoke", () => {
  it("restores file-backed Main memory when every Agent call starts fresh", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-main-file-memory-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-main-file-memory-app-"));
    const mainScript = join(appRoot, "memory-main.cjs");
    const screen = new NativeTerminalScreen({ cols: 100, rows: 14, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      mainScript,
      [
        "const fs = require('node:fs');",
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  const archiveMatch = input.match(/Scoped JSONL snapshot: (\"(?:[^\"\\\\]|\\\\.)*\")/);",
        "  let archive = '';",
        "  if (archiveMatch) {",
        "    try { archive = fs.readFileSync(JSON.parse(archiveMatch[1]), 'utf8'); } catch {}",
        "  }",
        "  const restored = !input.includes('User: 暗号是青色') && archive.includes('暗号是青色') && input.includes('User request:\\n暗号是什么');",
        "  process.stdout.write(restored ? '文件记忆恢复成功\\n' : '已经记住暗号\\n');",
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
        `args = ["${escapeToml(mainScript)}"]`,
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
        rows: 14,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );
    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });

    try {
      await waitForScreenText(() => screenWrites, screen, "> | message");
      child.write("暗号是青色\r");
      await waitForScreenText(() => screenWrites, screen, "已经记住暗号");
      await waitForScreenText(() => screenWrites, screen, "> | message");
      const sessions = new SessionManager({
        projectRoot: workspace,
        dataDir: ".parallel-codex"
      });
      for (let index = 1; index <= 16; index += 1) {
        await sessions.appendChatMessage({
          from: index % 2 === 0 ? "system" : "user",
          text: `填充对话 ${index}`
        });
      }
      child.write("暗号是什么\r");
      await waitForScreenText(() => screenWrites, screen, "文件记忆恢复成功");

      const prompt = await readTextIfExists(join(
        workspace,
        ".parallel-codex",
        "sessions",
        "main",
        "main-codex",
        "prompt.md"
      ));
      expect(prompt).toContain("# Recent conversation");
      expect(prompt).not.toContain("User: 暗号是青色");
      expect(prompt).toContain("# Extended conversation memory");
      expect(prompt).toContain("conversation.jsonl");
      expect(prompt.split("暗号是什么")).toHaveLength(2);
      const archive = await readTextIfExists(join(
        workspace,
        ".parallel-codex",
        "sessions",
        "main",
        "main-codex",
        "conversation.jsonl"
      ));
      expect(archive).toContain("暗号是青色");
      expect(archive).toContain("已经记住暗号");
      expect(archive).not.toContain("暗号是什么");
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("starts a file-backed Main conversation boundary with Ctrl+N", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-main-conversation-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-main-conversation-app-"));
    const mainScript = join(appRoot, "conversation-main.cjs");
    const screen = new NativeTerminalScreen({ cols: 100, rows: 14, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      mainScript,
      [
        "let input = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  if (input.includes('新对话还能看到吗')) {",
        "    process.stdout.write(input.includes('PCT_OLD_SECRET') ? 'CONVERSATION_LEAK\\n' : 'CONVERSATION_ISOLATED\\n');",
        "    return;",
        "  }",
        "  process.stdout.write('OLD_CONVERSATION_SAVED\\n');",
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
        `args = ["${escapeToml(mainScript)}"]`,
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
        rows: 14,
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
      child.write("请记住 PCT_OLD_SECRET\r");
      await waitForScreenText(() => screenWrites, screen, "OLD_CONVERSATION_SAVED");
      child.write("\x0e");
      await waitForScreenText(() => screenWrites, screen, "new conversation · ready");
      child.write("新对话还能看到吗\r");
      await waitForScreenText(() => screenWrites, screen, "CONVERSATION_ISOLATED");
      expect(screen.snapshot()).not.toContain("CONVERSATION_LEAK");

      const mainDir = join(workspace, ".parallel-codex", "sessions", "main");
      const state = await readJson(join(mainDir, "conversation.json"), MainConversationStateSchema);
      const records = await readRecentJsonLines(join(mainDir, "chat.jsonl"), ChatRecordSchema, 20);
      expect(records.find((record) => record.text.includes("PCT_OLD_SECRET"))?.conversation_id).toBeUndefined();
      expect(records.find((record) => record.text === "新对话还能看到吗")?.conversation_id).toBe(state.id);
      const prompt = await readTextIfExists(join(mainDir, "main-codex", "prompt.md"));
      expect(prompt).not.toContain("PCT_OLD_SECRET");
      expect(prompt).toContain(`conversation_id exactly equals "${state.id}"`);

      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 10000);

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
        "  process.stdout.write([",
        "    '# Result',",
        "    '',",
        "    '- See [review.md](/tmp/review.md:1)',",
        "    '- Run `npm test`, then **ship it**.',",
        "    '',",
        "    '> Ready for review.',",
        "    '',",
        "    '```ts',",
        "    'const mode = \\\"complex\\\";',",
        "    '```'",
        "  ].join('\\n') + '\\n');",
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
      await waitForScreenText(() => screenWrites, screen, "const mode");

      const snapshot = screen.snapshot();
      const responseLines = screen
        .styledSnapshotLines()
        .filter((line) => /Result|review\.md|npm test|const mode/.test(line.chunks.map((chunk) => chunk.text).join("")));
      const responseChunks = responseLines.flatMap((line) => line.chunks);
      const headingText = responseChunks
        .filter((chunk) => chunk.style.color === TUI_THEME_PRESETS.codex.accent && chunk.style.bold)
        .map((chunk) => chunk.text)
        .join("");
      const linkText = responseChunks
        .filter((chunk) => chunk.style.color === TUI_THEME_PRESETS.codex.accent && chunk.style.underline)
        .map((chunk) => chunk.text)
        .join("") ?? "";
      const codeText = responseChunks
        .filter((chunk) => (
          chunk.style.backgroundColor === TUI_THEME_PRESETS.codex.rail &&
          chunk.style.color === TUI_THEME_PRESETS.codex.warning
        ))
        .map((chunk) => chunk.text)
        .join("") ?? "";
      const strongText = responseChunks
        .filter((chunk) => chunk.style.bold && chunk.style.color === TUI_THEME_PRESETS.codex.text)
        .map((chunk) => chunk.text)
        .join("") ?? "";

      expect(snapshot).toContain("Result");
      expect(snapshot).toContain("• See review.md");
      expect(snapshot).toContain("• Run npm test, then ship it.");
      expect(snapshot).toContain("│ Ready for review.");
      expect(snapshot).toContain("| const mode = \"complex\";");
      expect(snapshot).not.toContain("/tmp/review.md:1");
      expect(snapshot).not.toContain("[review.md]");
      expect(snapshot).not.toContain("`npm test`");
      expect(snapshot).not.toContain("**ship it**");
      expect(snapshot).not.toContain("# Result");
      expect(snapshot).not.toContain("```ts");
      expect(headingText).toContain("Result");
      expect(linkText).toContain("review.md");
      expect(codeText).toContain("npm test");
      expect(codeText).toContain('const mode = "complex";');
      expect(strongText).toContain("ship it");
      expect(snapshot).toContain("route simple");
      expect(snapshot).not.toContain("@ route");
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("shows Main first-output progress after the Router decision", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-main-progress-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-main-progress-app-"));
    const mainScript = join(appRoot, "delayed-main.cjs");
    const screen = new NativeTerminalScreen({ cols: 120, rows: 12, scrollback: 1000 });
    let screenWrites = Promise.resolve();
    const observedScreens: string[] = [];

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      mainScript,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => {",
        "  setTimeout(() => {",
        "    process.stdout.write('Delayed Main');",
        "    setTimeout(() => process.stdout.write(' response\\n'), 600);",
        "  }, 3200);",
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
        `args = ["${escapeToml(mainScript)}"]`,
        "firstOutputTimeoutMs = 5000",
        "idleTimeoutMs = 5000",
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
        cols: 120,
        rows: 12,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );
    child.onData((chunk) => {
      screenWrites = screenWrites.then(async () => {
        await screen.write(chunk);
        observedScreens.push(screen.snapshot());
      });
    });

    try {
      await waitForScreenText(() => screenWrites, screen, "> | message");
      child.write("hello\r");
      await waitForScreenText(() => screenWrites, screen, "Delayed Main response");
      const observedStatusLines = Array.from(new Set(
        observedScreens.flatMap((snapshot) => snapshot
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.includes("main/codex") || line.includes("route")))
      ));
      const observedStatusText = observedStatusLines.join("\n");
      const waitingStatusLine = observedStatusLines.find((line) => line.includes("waiting output")) ?? "";
      expect(waitingStatusLine).toMatch(
        /main\/codex · waiting output · \d+s \/ 5s first · route simple · forced(?:\n|$)/
      );
      expect(observedStatusText).toContain("main/codex · responding");
      expect(observedStatusText).not.toContain("main/codex · run ·");
    } finally {
      child.kill("SIGTERM");
    }
  }, 20000);

  it("shows live Router wait progress and the timeout cause after fallback reaches Main", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-router-timeout-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-router-timeout-app-"));
    const routerScript = join(appRoot, "stalled-router.cjs");
    const mainScript = join(appRoot, "fake-main.cjs");
    const screen = new NativeTerminalScreen({ cols: 120, rows: 12, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      routerScript,
      "process.stderr.write('Router connection established\\n'); setInterval(() => {}, 1000);\n"
    );
    await writeFile(
      mainScript,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => process.stdout.write('Fallback chat response\\n'));"
      ].join("\n")
    );
    await writeFile(
      join(appRoot, ".parallel-codex", "config.toml"),
      [
        "[router]",
        'defaultMode = "auto"',
        "",
        "[router.codex]",
        `command = "${escapeToml(process.execPath)}"`,
        `args = ["${escapeToml(routerScript)}"]`,
        "timeoutMs = 5000",
        "firstOutputTimeoutMs = 1200",
        "idleTimeoutMs = 1600",
        'fallback = "simple"',
        "",
        "[router.codex.env]",
        'HTTPS_PROXY = "http://user:secret@127.0.0.1:7890"',
        "",
        "[workers.codex]",
        `command = "${escapeToml(process.execPath)}"`,
        `args = ["${escapeToml(mainScript)}"]`,
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
        cols: 120,
        rows: 12,
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
      child.write("hello\r");
      await waitForScreenText(() => screenWrites, screen, "route diagnostics");
      child.write("\x13");
      await waitForScreenText(() => screenWrites, screen, "parallel-codex-tui · status");
      await waitForScreenText(
        () => screenWrites,
        screen,
        "route diagnostics · runner node · via 127.0.0.1:7890 · 0s / 5s total · 1.6s idle"
      );
      await waitForScreenText(
        () => screenWrites,
        screen,
        "route diagnostics · runner node · via 127.0.0.1:7890 · 1s / 5s total · 1.6s idle"
      );
      await waitForScreenText(
        () => screenWrites,
        screen,
        "route retry 2/2 · runner node · via 127.0.0.1:7890 · 500ms backoff"
      );
      await waitForScreenText(
        () => screenWrites,
        screen,
        "route diagnostics · try 2 · runner node · via 127.0.0.1:7890"
      );
      await waitForScreenText(
        () => screenWrites,
        screen,
        "route failed · 1 Main · 2 Parallel · R retry · Esc cancel"
      );
      expect(screen.snapshot()).toContain("route simple · fallback · timeout");
      child.write("\x13");
      await waitForScreenText(() => screenWrites, screen, "parallel-codex-tui · status");
      await waitForScreenText(
        () => screenWrites,
        screen,
        "route simple · fallback · try 2 · idle timeout after stderr · via 127.0.0.1:7890"
      );
      child.write("\x13");
      await waitForScreenText(
        () => screenWrites,
        screen,
        "route failed · 1 Main · 2 Parallel · R retry · Esc cancel"
      );
      expect(screen.snapshot()).toContain("route simple · fallback · timeout");
      expect(screen.snapshot()).not.toContain("Fallback chat response");
      child.write("1");
      await waitForScreenText(() => screenWrites, screen, "Fallback chat response");
      await waitForScreenText(() => screenWrites, screen, "route simple · fallback · timeout");
      child.write("\x13");
      await waitForScreenText(() => screenWrites, screen, "parallel-codex-tui · status");
      await waitForScreenText(
        () => screenWrites,
        screen,
        "route simple · fallback · user Main · try 2 · idle timeout after stderr · via 127.0.0.1:7890"
      );

      const snapshot = screen.snapshot();
      const routes = await readTextIfExists(join(appRoot, ".parallel-codex", "router", "routes.jsonl"));
      expect(snapshot).toContain("route simple · fallback · user Main · try 2 · idle timeout after stderr · via 127.0.0.1:7890");
      expect(snapshot).not.toContain("Codex router failed:");
      expect(snapshot).not.toContain(routerScript);
      expect(routes).toContain("Router connection established");
      expect(routes).not.toContain("user:secret");
      expect(routes).toContain('"proxy_source":"router-config"');
      expect(routes).toContain('"proxy_variable":"HTTPS_PROXY"');
      expect(routes).toContain('"proxy_endpoint":"127.0.0.1:7890"');
      expect(routes).toContain('"router_timeout_kind":"idle"');
      expect(routes).toContain('"router_timeout_ms":5000');
      expect(routes).toContain('"router_first_output_timeout_ms":1200');
      expect(routes).toContain('"router_idle_timeout_ms":1600');
      expect(routes).toContain('"router_max_attempts":2');
      expect(routes).toContain('"router_retry_delay_ms":500');
      expect(routes).toContain('"router_failure_stage":"streaming"');
      expect(routes).toContain('"router_first_output_ms":');
      expect(routes).toContain('"router_first_stderr_ms":');
      expect(routes).toContain('"router_stderr_bytes":');
      expect(routes).toContain('"router_attempt":1');
      expect(routes).toContain('"router_fallback_resolution":"auto-retry"');
      expect(routes).toContain('"router_attempt":2');
      expect(routes).toContain('"router_fallback_resolution":"main"');
    } finally {
      child.kill("SIGTERM");
    }
  }, 20000);

  it("scrolls long chat history without leaving the chat view", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-chat-scroll-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-chat-scroll-app-"));
    const mainScript = join(appRoot, "history-main.cjs");
    const screen = new NativeTerminalScreen({ cols: 80, rows: 12, scrollback: 1000 });
    let screenWrites = Promise.resolve();

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      mainScript,
      [
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  const prefix = input.includes('second-scroll-turn') ? 'second' : 'history';",
        "  process.stdout.write(Array.from({ length: 30 }, (_, index) => `${prefix} line ${index + 1}`).join('\\n') + '\\n');",
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
        `args = ["${escapeToml(mainScript)}"]`,
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
        cols: 80,
        rows: 12,
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
      child.write("show history\r");
      await waitForScreenText(() => screenWrites, screen, "history line 30");
      await waitForScreenText(() => screenWrites, screen, "message · scroll");

      child.write("\x1b[A\x1b[A\x1b[A");
      await waitForScreenText(() => screenWrites, screen, "back 3/");
      expect(screen.snapshot()).toContain("history line 27");
      expect(screen.snapshot().split("\n")[0]).toContain("chat");

      child.write("\x1b[5~");
      await waitForScreenText(() => screenWrites, screen, "back 11/");
      expect(screen.snapshot()).toContain("history line 11");

      child.write("\x1b[6~");
      await waitForScreenText(() => screenWrites, screen, "back 3/");
      child.write("\x1b[B\x1b[B\x1b[B");
      await waitForScreenText(() => screenWrites, screen, "history line 30");
      expect(screen.snapshot()).toContain("message · scroll");
      expect(screen.snapshot().split("\n")[0]).toContain("chat");

      child.write("\x1b[A\x1b[A\x1b[A");
      await waitForScreenText(() => screenWrites, screen, "back 3/");
      child.write("second-scroll-turn\r");
      await waitForScreenText(() => screenWrites, screen, "second line 30");
      await waitForScreenText(() => screenWrites, screen, "message · scroll");
      expect(screen.snapshot()).not.toContain("back ");
      expect(screen.snapshot()).toContain("message · scroll");
    } finally {
      child.kill("SIGTERM");
    }
  }, 10000);

  it("restores persisted workspace chat after restarting the CLI", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-chat-restore-"));
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-chat-restore-app-"));
    const mainScript = join(appRoot, "restore-main.cjs");
    const chatPath = join(workspace, ".parallel-codex", "sessions", "main", "chat.jsonl");

    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeFile(
      mainScript,
      [
        "process.stdin.resume();",
        "process.stdin.on('end', () => process.stdout.write('已记录蓝色\\n'));"
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
        `args = ["${escapeToml(mainScript)}"]`,
        "",
        "[pairing]",
        'main = "codex"',
        'judge = "codex"',
        'actor = "codex"',
        'critic = "codex"'
      ].join("\n") + "\n"
    );

    const firstScreen = new NativeTerminalScreen({ cols: 80, rows: 12, scrollback: 1000 });
    let firstWrites = Promise.resolve();
    const firstExits: number[] = [];
    const first = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
      {
        cwd: process.cwd(),
        cols: 80,
        rows: 12,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );
    first.onData((chunk) => {
      firstWrites = firstWrites.then(() => firstScreen.write(chunk));
    });
    first.onExit(({ exitCode }) => firstExits.push(exitCode));

    try {
      await waitForScreenText(() => firstWrites, firstScreen, "> | message");
      first.write("记住蓝色\r");
      await waitForScreenText(() => firstWrites, firstScreen, "已记录蓝色");
      await waitForFileText(chatPath, "记住蓝色");
      first.write("\x03");
      await waitForExit(firstExits);

      const secondScreen = new NativeTerminalScreen({ cols: 80, rows: 12, scrollback: 1000 });
      let secondWrites = Promise.resolve();
      const secondExits: number[] = [];
      const second = spawn(
        process.execPath,
        ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace],
        {
          cwd: process.cwd(),
          cols: 80,
          rows: 12,
          name: "xterm-256color",
          env: { ...process.env, TERM: "xterm-256color" }
        }
      );
      second.onData((chunk) => {
        secondWrites = secondWrites.then(() => secondScreen.write(chunk));
      });
      second.onExit(({ exitCode }) => secondExits.push(exitCode));

      try {
        await waitForScreenText(() => secondWrites, secondScreen, "> 记住蓝色");
        await waitForScreenText(() => secondWrites, secondScreen, "已记录蓝色");
        expect(secondScreen.snapshot().match(/> 记住蓝色/g)).toHaveLength(1);
        expect(secondScreen.snapshot().match(/已记录蓝色/g)).toHaveLength(1);
        second.write("\x03");
        await waitForExit(secondExits);
      } finally {
        if (secondExits.length === 0) {
          second.kill("SIGTERM");
        }
      }
    } finally {
      if (firstExits.length === 0) {
        first.kill("SIGTERM");
      }
    }
  }, 15000);
});

function escapeToml(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
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

async function waitForFileText(path: string, text: string): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if ((await readTextIfExists(path)).includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text} in ${path}`);
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
