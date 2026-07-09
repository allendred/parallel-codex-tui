import { afterEach, describe, expect, it } from "vitest";
import {
  terminalOutputBlankLineTheme,
  terminalOutputEmptyText,
  terminalOutputEmptyTheme,
  terminalOutputTrailingFillWidth,
  terminalOutputTextProps
} from "../src/tui/TerminalOutput.js";
import { configureTuiTheme, resetTuiTheme, TUI_THEME_PRESETS } from "../src/tui/theme.js";

afterEach(() => {
  resetTuiTheme();
});

describe("TerminalOutput theme helpers", () => {
  it("themes outer empty native output states without changing native ANSI chunk colors", () => {
    configureTuiTheme({ theme: "paper" });

    expect(terminalOutputEmptyText()).toBe("No native output yet.");
    expect(terminalOutputEmptyTheme()).toEqual({
      backgroundColor: TUI_THEME_PRESETS.paper.surface,
      color: TUI_THEME_PRESETS.paper.muted,
      dimColor: true
    });
    expect(terminalOutputBlankLineTheme()).toEqual({
      backgroundColor: TUI_THEME_PRESETS.paper.surface
    });
    expect(terminalOutputTextProps({})).toMatchObject({
      backgroundColor: TUI_THEME_PRESETS.paper.surface,
      color: TUI_THEME_PRESETS.paper.text
    });
    expect(terminalOutputTextProps({
      backgroundColor: "ansi256(4)",
      color: "ansi256(2)",
      bold: true
    })).toMatchObject({
      backgroundColor: "ansi256(4)",
      color: "ansi256(2)",
      bold: true
    });
  });

  it("computes themed trailing fill for short native output rows by display width", () => {
    expect(terminalOutputTrailingFillWidth({
      chunks: [{ text: "native", style: {} }]
    }, 10)).toBe(4);
    expect(terminalOutputTrailingFillWidth({
      chunks: [{ text: "你好", style: {} }]
    }, 8)).toBe(4);
    expect(terminalOutputTrailingFillWidth({
      chunks: [{ text: "already wide", style: {} }]
    }, 4)).toBe(0);
    expect(terminalOutputTrailingFillWidth({
      chunks: []
    }, 4)).toBe(4);
  });
});
