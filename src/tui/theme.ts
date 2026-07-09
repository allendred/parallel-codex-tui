import type { TextProps } from "ink";
import { foregroundColorNames } from "chalk";

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

export const TUI_THEME_NAMES = Object.freeze(["codex", "graphite", "paper"] as const);
export const TUI_THEME_FIELDS = Object.freeze([
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
] as const satisfies readonly (keyof TuiTheme)[]);

export type TuiThemeName = typeof TUI_THEME_NAMES[number];
export type TuiThemeField = typeof TUI_THEME_FIELDS[number];
export type TuiThemeOverrides = Partial<Record<TuiThemeField, string>>;

export const TUI_THEME_PRESETS: Readonly<Record<TuiThemeName, Readonly<TuiTheme>>> = Object.freeze({
  codex: freezeTuiTheme({
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
  }),
  graphite: freezeTuiTheme({
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
  }),
  paper: freezeTuiTheme({
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
  })
});

const DEFAULT_TUI_THEME_NAME: TuiThemeName = "codex";

export let TUI_THEME: TuiTheme = TUI_THEME_PRESETS[DEFAULT_TUI_THEME_NAME];

export function resolveTuiTheme(options: { theme?: string; colors?: TuiThemeOverrides } = {}): TuiTheme {
  const theme = normalizeTuiThemeName(options.theme);
  const name = theme ?? DEFAULT_TUI_THEME_NAME;
  return freezeTuiTheme({
    ...TUI_THEME_PRESETS[name],
    ...normalizeTuiThemeOverrides(options.colors)
  });
}

export function configureTuiTheme(options: { theme?: string; colors?: TuiThemeOverrides } = {}): TuiTheme {
  TUI_THEME = resolveTuiTheme(options);
  return TUI_THEME;
}

export function resetTuiTheme(): TuiTheme {
  TUI_THEME = TUI_THEME_PRESETS[DEFAULT_TUI_THEME_NAME];
  return TUI_THEME;
}

export function isTuiThemeColorValue(value: string): boolean {
  const color = value.trim();
  if (!color) {
    return false;
  }

  if ((foregroundColorNames as readonly string[]).includes(color)) {
    return true;
  }

  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color)) {
    return true;
  }

  const ansiMatch = color.match(/^ansi256\(\s*(\d+)\s*\)$/);
  if (ansiMatch) {
    return isByteColorValue(ansiMatch[1] ?? "");
  }

  const rgbMatch = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgbMatch) {
    return [rgbMatch[1], rgbMatch[2], rgbMatch[3]].every((part) => isByteColorValue(part ?? ""));
  }

  return false;
}

export function isTuiThemeName(value: string | null | undefined): value is TuiThemeName {
  return TUI_THEME_NAMES.includes(value as TuiThemeName);
}

export function normalizeTuiThemeName(value: string | null | undefined): TuiThemeName | null {
  const name = value?.trim();
  return isTuiThemeName(name) ? name : null;
}

function isByteColorValue(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 255;
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

function freezeTuiTheme(theme: TuiTheme): Readonly<TuiTheme> {
  return Object.freeze(theme);
}
