import { afterEach, describe, expect, it } from "vitest";
import {
  TUI_THEME,
  configureTuiTheme,
  resetTuiTheme,
  resolveTuiTheme,
  TUI_THEME_PRESETS
} from "../src/tui/theme.js";
import { workerOutputLineTheme } from "../src/tui/WorkerOutputView.js";

describe("TUI theme", () => {
  afterEach(() => {
    resetTuiTheme();
  });

  it("provides named palettes for the main terminal surfaces", () => {
    expect(Object.keys(TUI_THEME_PRESETS)).toEqual(["codex", "graphite", "paper"]);
    expect(resolveTuiTheme({ theme: "codex" }).chrome).toBe("ansi256(23)");
    expect(resolveTuiTheme({ theme: "graphite" }).accent).toBe("ansi256(110)");
    expect(resolveTuiTheme({ theme: "paper" }).text).toBe("black");
  });

  it("falls back to the default palette for unknown theme names", () => {
    expect(resolveTuiTheme({ theme: "unknown" })).toEqual(TUI_THEME_PRESETS.codex);
  });

  it("merges user color overrides over the selected palette", () => {
    expect(resolveTuiTheme({
      theme: "paper",
      colors: {
        chrome: "ansi256(236)",
        accent: "magenta"
      }
    })).toMatchObject({
      chrome: "ansi256(236)",
      accent: "magenta",
      text: "black"
    });
  });

  it("lets rendered worker themes follow the active palette", () => {
    resetTuiTheme();
    expect(workerOutputLineTheme("group").backgroundColor).toBe(TUI_THEME_PRESETS.codex.chrome);

    configureTuiTheme({ theme: "paper", colors: { chrome: "ansi256(255)", text: "black" } });

    expect(TUI_THEME.chrome).toBe("ansi256(255)");
    expect(workerOutputLineTheme("group")).toMatchObject({
      backgroundColor: "ansi256(255)",
      color: "black"
    });
  });
});
