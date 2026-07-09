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
    expect(resolveTuiTheme({ theme: "codex" })).toMatchObject({
      chrome: "ansi256(234)",
      surface: "ansi256(235)",
      rail: "ansi256(238)",
      text: "ansi256(255)",
      muted: "ansi256(250)",
      accent: "ansi256(81)"
    });
    expect(resolveTuiTheme({ theme: "graphite" })).toMatchObject({
      chrome: "ansi256(236)",
      surface: "ansi256(233)",
      rail: "ansi256(238)",
      text: "ansi256(255)",
      muted: "ansi256(248)",
      accent: "ansi256(75)"
    });
    expect(resolveTuiTheme({ theme: "paper" })).toMatchObject({
      chrome: "ansi256(254)",
      surface: "ansi256(231)",
      rail: "ansi256(255)",
      text: "ansi256(235)",
      muted: "ansi256(244)",
      accent: "ansi256(25)"
    });
  });

  it("keeps semantic colors distinct across the bundled palettes", () => {
    expect(resolveTuiTheme({ theme: "codex" })).toMatchObject({
      successSurface: "ansi256(22)",
      dangerSurface: "ansi256(52)",
      warning: "ansi256(214)",
      success: "ansi256(115)",
      danger: "ansi256(203)"
    });
    expect(resolveTuiTheme({ theme: "graphite" })).toMatchObject({
      successSurface: "ansi256(22)",
      dangerSurface: "ansi256(52)",
      warning: "ansi256(221)",
      success: "ansi256(150)",
      danger: "ansi256(203)"
    });
    expect(resolveTuiTheme({ theme: "paper" })).toMatchObject({
      successSurface: "ansi256(194)",
      dangerSurface: "ansi256(224)",
      warning: "ansi256(130)",
      success: "ansi256(28)",
      danger: "ansi256(160)"
    });
  });

  it("falls back to the default palette for unknown theme names", () => {
    expect(resolveTuiTheme({ theme: "unknown" })).toEqual(TUI_THEME_PRESETS.codex);
  });

  it("normalizes theme names before selecting a palette", () => {
    expect(resolveTuiTheme({ theme: "  paper  " }).text).toBe("ansi256(235)");
  });

  it("keeps bundled palette surface layers visually separated", () => {
    for (const name of TUI_THEME_NAMES) {
      const theme = resolveTuiTheme({ theme: name });

      expect(new Set([theme.chrome, theme.surface, theme.rail]).size).toBe(3);
      expect(theme.successSurface).not.toBe(theme.surface);
      expect(theme.dangerSurface).not.toBe(theme.surface);
      expect(theme.accent).not.toBe(theme.muted);
      expect(theme.warning).not.toBe(theme.success);
      expect(theme.success).not.toBe(theme.danger);
    }
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
      text: "ansi256(235)"
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
    expect(normalizeTuiThemeColorValue("  #ABC  ")).toBe("#abc");
    expect(normalizeTuiThemeColorValue("#AABBCC")).toBe("#aabbcc");
    expect(normalizeTuiThemeColorValue("  ansi256(238)  ")).toBe("ansi256(238)");
    expect(normalizeTuiThemeColorValue("ansi256( 238 )")).toBe("ansi256(238)");
    expect(normalizeTuiThemeColorValue("ansi256(001)")).toBe("ansi256(1)");
    expect(normalizeTuiThemeColorValue("rgb(232, 131, 136)")).toBe("rgb(232,131,136)");
    expect(normalizeTuiThemeColorValue("rgb(001, 002, 003)")).toBe("rgb(1,2,3)");
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
