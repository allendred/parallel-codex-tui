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
    expect(Object.keys(TUI_THEME_PRESETS)).toEqual(["codex", "graphite", "paper", "aurora", "studio"]);
    expect(resolveTuiTheme({ theme: "codex" })).toMatchObject({
      chrome: "ansi256(233)",
      surface: "ansi256(234)",
      rail: "ansi256(236)",
      text: "ansi256(253)",
      muted: "ansi256(247)",
      accent: "ansi256(81)"
    });
    expect(resolveTuiTheme({ theme: "graphite" })).toMatchObject({
      chrome: "ansi256(236)",
      surface: "ansi256(233)",
      rail: "ansi256(238)",
      text: "ansi256(255)",
      muted: "ansi256(249)",
      accent: "ansi256(117)"
    });
    expect(resolveTuiTheme({ theme: "paper" })).toMatchObject({
      chrome: "ansi256(254)",
      surface: "ansi256(231)",
      rail: "ansi256(255)",
      text: "ansi256(235)",
      muted: "ansi256(240)",
      accent: "ansi256(25)"
    });
    expect(resolveTuiTheme({ theme: "aurora" })).toMatchObject({
      chrome: "ansi256(19)",
      surface: "ansi256(233)",
      rail: "ansi256(53)",
      text: "ansi256(255)",
      muted: "ansi256(109)",
      accent: "ansi256(159)"
    });
    expect(resolveTuiTheme({ theme: "studio" })).toMatchObject({
      chrome: "ansi256(236)",
      surface: "ansi256(235)",
      rail: "ansi256(238)",
      text: "ansi256(254)",
      muted: "ansi256(249)",
      accent: "ansi256(147)"
    });
  });

  it("keeps semantic colors distinct across the bundled palettes", () => {
    expect(resolveTuiTheme({ theme: "codex" })).toMatchObject({
      successSurface: "ansi256(22)",
      dangerSurface: "ansi256(52)",
      warning: "ansi256(179)",
      success: "ansi256(114)",
      danger: "ansi256(210)"
    });
    expect(resolveTuiTheme({ theme: "graphite" })).toMatchObject({
      successSurface: "ansi256(22)",
      dangerSurface: "ansi256(52)",
      warning: "ansi256(214)",
      success: "ansi256(150)",
      danger: "ansi256(217)"
    });
    expect(resolveTuiTheme({ theme: "paper" })).toMatchObject({
      successSurface: "ansi256(194)",
      dangerSurface: "ansi256(224)",
      warning: "ansi256(94)",
      success: "ansi256(22)",
      danger: "ansi256(124)"
    });
    expect(resolveTuiTheme({ theme: "aurora" })).toMatchObject({
      successSurface: "ansi256(22)",
      dangerSurface: "ansi256(52)",
      warning: "ansi256(222)",
      success: "ansi256(121)",
      danger: "ansi256(210)"
    });
    expect(resolveTuiTheme({ theme: "studio" })).toMatchObject({
      successSurface: "ansi256(22)",
      dangerSurface: "ansi256(52)",
      warning: "ansi256(215)",
      success: "ansi256(151)",
      danger: "ansi256(217)"
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

  it("keeps bundled palette text readable against its rendered surfaces", () => {
    for (const name of TUI_THEME_NAMES) {
      const theme = resolveTuiTheme({ theme: name });
      const pairs = [
        ["text/surface", theme.text, theme.surface],
        ["muted/surface", theme.muted, theme.surface],
        ["accent/chrome", theme.accent, theme.chrome],
        ["warning/surface", theme.warning, theme.surface],
        ["success/successSurface", theme.success, theme.successSurface],
        ["danger/dangerSurface", theme.danger, theme.dangerSurface]
      ] as const;

      for (const [label, foreground, background] of pairs) {
        expect(
          ansi256ContrastRatio(foreground, background),
          `${name} ${label}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps every bundled palette readable on the surfaces used by the TUI", () => {
    for (const name of TUI_THEME_NAMES) {
      const theme = resolveTuiTheme({ theme: name });
      const pairs = [
        ["text/chrome", theme.text, theme.chrome],
        ["muted/chrome", theme.muted, theme.chrome],
        ["accent/chrome", theme.accent, theme.chrome],
        ["text/surface", theme.text, theme.surface],
        ["muted/surface", theme.muted, theme.surface],
        ["accent/surface", theme.accent, theme.surface],
        ["warning/surface", theme.warning, theme.surface],
        ["success/surface", theme.success, theme.surface],
        ["text/rail", theme.text, theme.rail],
        ["muted/rail", theme.muted, theme.rail],
        ["accent/rail", theme.accent, theme.rail],
        ["warning/rail", theme.warning, theme.rail],
        ["success/rail", theme.success, theme.rail],
        ["danger/rail", theme.danger, theme.rail],
        ["success/successSurface", theme.success, theme.successSurface],
        ["danger/dangerSurface", theme.danger, theme.dangerSurface]
      ] as const;

      for (const [label, foreground, background] of pairs) {
        expect(
          ansi256ContrastRatio(foreground, background),
          `${name} ${label}`
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("provides one shared theme-name normalizer", () => {
    expect(normalizeTuiThemeName("  graphite  ")).toBe("graphite");
    expect(normalizeTuiThemeName("  aurora  ")).toBe("aurora");
    expect(normalizeTuiThemeName("  studio  ")).toBe("studio");
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

function ansi256ContrastRatio(foreground: string, background: string): number {
  const foregroundLuminance = relativeLuminance(ansi256Rgb(foreground));
  const backgroundLuminance = relativeLuminance(ansi256Rgb(background));
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function ansi256Rgb(color: string): [number, number, number] {
  const index = Number(color.match(/^ansi256\((\d+)\)$/)?.[1]);
  if (!Number.isInteger(index) || index < 16 || index > 255) {
    throw new Error(`Expected ANSI-256 palette color, received ${color}`);
  }

  if (index >= 232) {
    const channel = 8 + ((index - 232) * 10);
    return [channel, channel, channel];
  }

  const cubeIndex = index - 16;
  const levels = [0, 95, 135, 175, 215, 255];
  return [
    levels[Math.floor(cubeIndex / 36)] ?? 0,
    levels[Math.floor(cubeIndex / 6) % 6] ?? 0,
    levels[cubeIndex % 6] ?? 0
  ];
}

function relativeLuminance([red, green, blue]: [number, number, number]): number {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * (r ?? 0)) + (0.7152 * (g ?? 0)) + (0.0722 * (b ?? 0));
}
