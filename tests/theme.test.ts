import { afterEach, describe, expect, it } from "vitest";
import {
  TUI_THEME,
  configureTuiTheme,
  isTuiThemeColorValue,
  normalizeTuiThemeColorValue,
  normalizeTuiThemeName,
  resetTuiTheme,
  resolveTuiTheme,
  TUI_THEME_FIELDS,
  TUI_THEME_NAMES,
  TUI_THEME_PRESETS
} from "../src/tui/theme.js";
import { workerOutputLineTheme } from "../src/tui/WorkerOutputView.js";

describe("TUI theme", () => {
  afterEach(() => {
    resetTuiTheme();
  });

  it("provides named palettes for the main terminal surfaces", () => {
    expect(Object.isFrozen(TUI_THEME_NAMES)).toBe(true);
    expect(TUI_THEME_NAMES).toEqual(Object.keys(TUI_THEME_PRESETS));
    expect(Object.isFrozen(TUI_THEME_FIELDS)).toBe(true);
    expect(TUI_THEME_FIELDS).toEqual(Object.keys(TUI_THEME_PRESETS.codex));
    expect(Object.isFrozen(TUI_THEME_PRESETS)).toBe(true);
    expect(TUI_THEME_NAMES.every((name) => Object.isFrozen(TUI_THEME_PRESETS[name]))).toBe(true);
    expect(Object.keys(TUI_THEME_PRESETS)).toEqual(["codex", "graphite", "paper"]);
    expect(resolveTuiTheme({ theme: "codex" }).chrome).toBe("ansi256(23)");
    expect(resolveTuiTheme({ theme: "graphite" }).accent).toBe("ansi256(110)");
    expect(resolveTuiTheme({ theme: "paper" }).text).toBe("black");
  });

  it("falls back to the default palette for unknown theme names", () => {
    expect(resolveTuiTheme({ theme: "unknown" })).toEqual(TUI_THEME_PRESETS.codex);
  });

  it("normalizes theme names before selecting a palette", () => {
    expect(resolveTuiTheme({ theme: "  paper  " }).text).toBe("black");
  });

  it("provides one shared theme-name normalizer", () => {
    expect(normalizeTuiThemeName("  graphite  ")).toBe("graphite");
    expect(normalizeTuiThemeName("unknown")).toBeNull();
    expect(normalizeTuiThemeName("   ")).toBeNull();
    expect(normalizeTuiThemeName(null)).toBeNull();
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
    expect(Object.isFrozen(resolveTuiTheme({ theme: "paper" }))).toBe(true);
  });

  it("recognizes the color formats Ink can render", () => {
    expect(isTuiThemeColorValue("redBright")).toBe(true);
    expect(isTuiThemeColorValue("#005cc5")).toBe(true);
    expect(isTuiThemeColorValue("#0af")).toBe(true);
    expect(isTuiThemeColorValue("ansi256(238)")).toBe(true);
    expect(isTuiThemeColorValue("ansi256( 238 )")).toBe(true);
    expect(isTuiThemeColorValue("rgb(232, 131, 136)")).toBe(true);

    expect(isTuiThemeColorValue("not-a-color")).toBe(false);
    expect(isTuiThemeColorValue("ansi256(256)")).toBe(false);
    expect(isTuiThemeColorValue("rgb(300, 1, 1)")).toBe(false);
    expect(isTuiThemeColorValue("#00zz00")).toBe(false);
  });

  it("provides one shared theme-color normalizer", () => {
    expect(normalizeTuiThemeColorValue("  ansi256(238)  ")).toBe("ansi256(238)");
    expect(normalizeTuiThemeColorValue("ansi256( 238 )")).toBe("ansi256(238)");
    expect(normalizeTuiThemeColorValue("rgb(232, 131, 136)")).toBe("rgb(232,131,136)");
    expect(normalizeTuiThemeColorValue("not-a-color")).toBeNull();
    expect(normalizeTuiThemeColorValue("   ")).toBeNull();
    expect(normalizeTuiThemeColorValue(null)).toBeNull();
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
