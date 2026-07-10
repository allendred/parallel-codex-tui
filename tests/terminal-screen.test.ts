import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

const execFileAsync = promisify(execFile);

describe("NativeTerminalScreen", () => {
  it("renders the current terminal screen without raw ANSI controls", async () => {
    const screen = new NativeTerminalScreen({ cols: 20, rows: 4 });

    await screen.write("old line\r\nstill old");
    await screen.write("\x1b[2J\x1b[Hnew screen");

    expect(screen.snapshot()).toBe("new screen");
  });

  it("applies cursor movement and line clearing to the screen buffer", async () => {
    const screen = new NativeTerminalScreen({ cols: 20, rows: 4 });

    await screen.write("first\r\nsecond");
    await screen.write("\x1b[1;1H\x1b[2Ktitle");

    expect(screen.snapshotLines()).toEqual(["title", "second"]);
  });

  it("keeps terminal colors and text attributes in styled snapshots", async () => {
    const screen = new NativeTerminalScreen({ cols: 40, rows: 4 });

    await screen.write("\x1b[31mred\x1b[0m plain \x1b[1;3;4;38;2;1;2;3mrich\x1b[0m");

    expect(screen.styledSnapshotLines()).toEqual([
      {
        chunks: [
          { text: "red", style: { color: "ansi256(1)" } },
          { text: " plain ", style: {} },
          {
            text: "rich",
            style: {
              bold: true,
              color: "#010203",
              italic: true,
              underline: true
            }
          }
        ]
      }
    ]);
  });

  it("marks the current terminal cursor cell in styled snapshots", async () => {
    const screen = new NativeTerminalScreen({ cols: 20, rows: 4 });

    await screen.write("prompt> abc\x1b[2D");

    expect(screen.styledSnapshotLines({ showCursor: true })).toEqual([
      {
        chunks: [
          { text: "prompt> a", style: {} },
          { text: "b", style: { cursor: true, inverse: true } },
          { text: "c", style: {} }
        ]
      }
    ]);
  });

  it("does not truncate trailing wide Chinese characters", async () => {
    const screen = new NativeTerminalScreen({ cols: 40, rows: 4 });

    await screen.write("做个俄罗斯方块的游戏");

    expect(screen.snapshot()).toBe("做个俄罗斯方块的游戏");
  });

  it("can scroll back through native terminal history", async () => {
    const screen = new NativeTerminalScreen({ cols: 20, rows: 3, scrollback: 10 });

    await screen.write("line 1\r\nline 2\r\nline 3\r\nline 4\r\nline 5");
    expect(screen.snapshotLines()).toEqual(["line 3", "line 4", "line 5"]);
    expect(screen.scrollState()).toEqual({ offset: 0, maxOffset: 2 });

    screen.scrollLines(-2);

    expect(screen.snapshotLines()).toEqual(["line 1", "line 2", "line 3"]);
    expect(screen.scrollState()).toEqual({ offset: 2, maxOffset: 2 });
  });

  it("scrolls by larger wheel increments through native terminal history", async () => {
    const screen = new NativeTerminalScreen({ cols: 20, rows: 4, scrollback: 100 });

    await screen.write(Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join("\r\n"));
    expect(screen.snapshot()).toContain("line 40");

    screen.scrollLines(-20);

    expect(screen.snapshot()).toContain("line 17");
  });

  it("resizes the headless terminal without discarding its current screen", async () => {
    const screen = new NativeTerminalScreen({ cols: 12, rows: 2 });
    const resizable = screen as NativeTerminalScreen & {
      resize?: (cols: number, rows: number) => void;
      dimensions?: () => { cols: number; rows: number };
    };
    await screen.write("resize me");

    expect(resizable.resize).toBeTypeOf("function");
    expect(resizable.dimensions).toBeTypeOf("function");
    resizable.resize?.(20, 4);

    expect(resizable.dimensions?.()).toEqual({ cols: 20, rows: 4 });
    expect(screen.snapshot()).toContain("resize me");
  });

  it("can be imported by the tsx runtime used by npm run dev", async () => {
    const { stdout } = await execFileAsync(
      "npx",
      [
        "tsx",
        "--eval",
        "import { NativeTerminalScreen } from './src/tui/terminal-screen.ts'; const screen = new NativeTerminalScreen({ cols: 10, rows: 2 }); screen.write('ok').then(() => console.log(screen.snapshot()));"
      ],
      {
        cwd: process.cwd()
      }
    );

    expect(stdout.trim()).toBe("ok");
  });
});
