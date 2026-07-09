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

export const TUI_THEME_NAMES = Object.freeze(["codex", "graphite", "paper", "aurora", "studio"] as const);
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
    chrome: bg("ansi256(17)"),
    surface: bg("ansi256(235)"),
    rail: bg("ansi256(236)"),
    successSurface: bg("ansi256(22)"),
    dangerSurface: bg("ansi256(52)"),
    text: fg("ansi256(255)"),
    muted: fg("ansi256(247)"),
    accent: fg("ansi256(117)"),
    warning: fg("ansi256(215)"),
    success: fg("ansi256(114)"),
    danger: fg("ansi256(203)")
  }),
  graphite: freezeTuiTheme({
    chrome: bg("ansi256(236)"),
    surface: bg("ansi256(233)"),
    rail: bg("ansi256(238)"),
    successSurface: bg("ansi256(22)"),
    dangerSurface: bg("ansi256(52)"),
    text: fg("ansi256(255)"),
    muted: fg("ansi256(246)"),
    accent: fg("ansi256(110)"),
    warning: fg("ansi256(214)"),
    success: fg("ansi256(150)"),
    danger: fg("ansi256(210)")
  }),
  paper: freezeTuiTheme({
    chrome: bg("ansi256(254)"),
    surface: bg("ansi256(231)"),
    rail: bg("ansi256(255)"),
    successSurface: bg("ansi256(194)"),
    dangerSurface: bg("ansi256(224)"),
    text: fg("ansi256(235)"),
    muted: fg("ansi256(242)"),
    accent: fg("ansi256(31)"),
    warning: fg("ansi256(136)"),
    success: fg("ansi256(28)"),
    danger: fg("ansi256(160)")
  }),
  aurora: freezeTuiTheme({
    chrome: bg("ansi256(24)"),
    surface: bg("ansi256(233)"),
    rail: bg("ansi256(30)"),
    successSurface: bg("ansi256(29)"),
    dangerSurface: bg("ansi256(52)"),
    text: fg("ansi256(255)"),
    muted: fg("ansi256(109)"),
    accent: fg("ansi256(159)"),
    warning: fg("ansi256(222)"),
    success: fg("ansi256(121)"),
    danger: fg("ansi256(210)")
  }),
  studio: freezeTuiTheme({
    chrome: bg("ansi256(236)"),
    surface: bg("ansi256(235)"),
    rail: bg("ansi256(238)"),
    successSurface: bg("ansi256(22)"),
    dangerSurface: bg("ansi256(52)"),
    text: fg("ansi256(254)"),
    muted: fg("ansi256(248)"),
    accent: fg("ansi256(147)"),
    warning: fg("ansi256(215)"),
    success: fg("ansi256(151)"),
    danger: fg("ansi256(210)")
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
  return normalizeTuiThemeColorValue(value) !== null;
}

export function normalizeTuiThemeColorValue(value: string | null | undefined): string | null {
  const color = value?.trim();
  if (!color) {
    return null;
  }
  if ((foregroundColorNames as readonly string[]).includes(color)) {
    return color;
  }

  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color)) {
    return color.toLowerCase();
  }

  const ansiMatch = color.match(/^ansi256\(\s*(\d+)\s*\)$/);
  if (ansiMatch) {
    const value = normalizeByteColorValue(ansiMatch[1] ?? "");
    return value !== null ? `ansi256(${value})` : null;
  }

  const rgbMatch = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgbMatch) {
    const parts = [rgbMatch[1] ?? "", rgbMatch[2] ?? "", rgbMatch[3] ?? ""].map(normalizeByteColorValue);
    return parts.every((value) => value !== null) ? `rgb(${parts.join(",")})` : null;
  }

  return null;
}

export function isTuiThemeName(value: string | null | undefined): value is TuiThemeName {
  return TUI_THEME_NAMES.includes(value as TuiThemeName);
}

export function normalizeTuiThemeName(value: string | null | undefined): TuiThemeName | null {
  const name = value?.trim();
  return isTuiThemeName(name) ? name : null;
}

function normalizeByteColorValue(value: string): string | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 255 ? String(number) : null;
}

function normalizeTuiThemeOverrides(colors: TuiThemeOverrides | undefined): Partial<TuiTheme> {
  const normalized: Partial<TuiTheme> = {};
  if (!colors) {
    return normalized;
  }

  for (const field of TUI_THEME_FIELDS) {
    const value = normalizeTuiThemeColorValue(colors[field]);
    if (value) {
      normalized[field] = value as TuiTheme[typeof field];
    }
  }
  return normalized;
}

function freezeTuiTheme(theme: TuiTheme): Readonly<TuiTheme> {
  return Object.freeze(theme);
}
