import type { TextProps } from "ink";

type InkBackground = NonNullable<TextProps["backgroundColor"]>;
type InkColor = NonNullable<TextProps["color"]>;

const bg = (value: InkBackground) => value;
const fg = (value: InkColor) => value;

export interface TuiTheme {
  chrome: InkBackground;
  surface: InkBackground;
  rail: InkBackground;
  successSurface: InkBackground;
  dangerSurface: InkBackground;
  text: InkColor;
  muted: InkColor;
  accent: InkColor;
  warning: InkColor;
  success: InkColor;
  danger: InkColor;
}

export type TuiThemeName = "codex" | "graphite" | "paper";
export type TuiThemeOverrides = Partial<Record<keyof TuiTheme, string>>;

export const TUI_THEME_NAMES: TuiThemeName[] = ["codex", "graphite", "paper"];

export const TUI_THEME_PRESETS: Record<TuiThemeName, TuiTheme> = {
  codex: {
    chrome: bg("ansi256(23)"),
    surface: bg("ansi256(235)"),
    rail: bg("ansi256(236)"),
    successSurface: bg("ansi256(22)"),
    dangerSurface: bg("ansi256(52)"),
    text: fg("white"),
    muted: fg("gray"),
    accent: fg("ansi256(81)"),
    warning: fg("ansi256(221)"),
    success: fg("ansi256(114)"),
    danger: fg("ansi256(203)")
  },
  graphite: {
    chrome: bg("ansi256(238)"),
    surface: bg("ansi256(234)"),
    rail: bg("ansi256(236)"),
    successSurface: bg("ansi256(22)"),
    dangerSurface: bg("ansi256(52)"),
    text: fg("white"),
    muted: fg("gray"),
    accent: fg("ansi256(110)"),
    warning: fg("ansi256(222)"),
    success: fg("ansi256(149)"),
    danger: fg("ansi256(203)")
  },
  paper: {
    chrome: bg("ansi256(255)"),
    surface: bg("ansi256(254)"),
    rail: bg("ansi256(250)"),
    successSurface: bg("ansi256(194)"),
    dangerSurface: bg("ansi256(224)"),
    text: fg("black"),
    muted: fg("ansi256(240)"),
    accent: fg("blue"),
    warning: fg("ansi256(136)"),
    success: fg("green"),
    danger: fg("red")
  }
};

const DEFAULT_TUI_THEME_NAME: TuiThemeName = "codex";
const TUI_THEME_FIELDS: Array<keyof TuiTheme> = [
  "chrome",
  "surface",
  "rail",
  "successSurface",
  "dangerSurface",
  "text",
  "muted",
  "accent",
  "warning",
  "success",
  "danger"
];

export let TUI_THEME: TuiTheme = TUI_THEME_PRESETS[DEFAULT_TUI_THEME_NAME];

export function resolveTuiTheme(options: { theme?: string; colors?: TuiThemeOverrides } = {}): TuiTheme {
  const name = isTuiThemeName(options.theme) ? options.theme : DEFAULT_TUI_THEME_NAME;
  return {
    ...TUI_THEME_PRESETS[name],
    ...normalizeTuiThemeOverrides(options.colors)
  };
}

export function configureTuiTheme(options: { theme?: string; colors?: TuiThemeOverrides } = {}): TuiTheme {
  TUI_THEME = resolveTuiTheme(options);
  return TUI_THEME;
}

export function resetTuiTheme(): TuiTheme {
  TUI_THEME = TUI_THEME_PRESETS[DEFAULT_TUI_THEME_NAME];
  return TUI_THEME;
}

function isTuiThemeName(value: string | undefined): value is TuiThemeName {
  return TUI_THEME_NAMES.includes(value as TuiThemeName);
}

function normalizeTuiThemeOverrides(colors: TuiThemeOverrides | undefined): Partial<TuiTheme> {
  const normalized: Partial<TuiTheme> = {};
  if (!colors) {
    return normalized;
  }

  for (const field of TUI_THEME_FIELDS) {
    const value = colors[field]?.trim();
    if (value) {
      normalized[field] = value as TuiTheme[typeof field];
    }
  }
  return normalized;
}
