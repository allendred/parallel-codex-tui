import type { TuiTheme, TuiThemeField } from "./theme.js";

export const TUI_THEME_MIN_CONTRAST_RATIO = 4.5;

type ThemeContrastPair = readonly [foreground: TuiThemeField, background: TuiThemeField];

export const TUI_THEME_RENDERED_CONTRAST_PAIRS = Object.freeze([
  ["text", "chrome"],
  ["muted", "chrome"],
  ["accent", "chrome"],
  ["text", "surface"],
  ["muted", "surface"],
  ["accent", "surface"],
  ["warning", "surface"],
  ["success", "surface"],
  ["text", "rail"],
  ["muted", "rail"],
  ["accent", "rail"],
  ["warning", "rail"],
  ["success", "rail"],
  ["danger", "rail"],
  ["success", "successSurface"],
  ["danger", "dangerSurface"]
] as const satisfies readonly ThemeContrastPair[]);

export interface TuiThemeContrastMeasurement {
  foreground: TuiThemeField;
  background: TuiThemeField;
  ratio: number;
}

export interface TuiThemeContrastAudit {
  measurements: readonly TuiThemeContrastMeasurement[];
  issues: readonly TuiThemeContrastMeasurement[];
  minimumRatio: number;
}

const ANSI_16_RGB = Object.freeze([
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255]
] as const satisfies readonly (readonly [number, number, number])[]);

const NAMED_COLOR_INDEX: Readonly<Record<string, number>> = Object.freeze({
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  blackBright: 8,
  gray: 8,
  grey: 8,
  redBright: 9,
  greenBright: 10,
  yellowBright: 11,
  blueBright: 12,
  magentaBright: 13,
  cyanBright: 14,
  whiteBright: 15
});

export function auditTuiThemeContrast(theme: TuiTheme): TuiThemeContrastAudit {
  const measurements = TUI_THEME_RENDERED_CONTRAST_PAIRS.map(([foreground, background]) => ({
    foreground,
    background,
    ratio: tuiThemeContrastRatio(theme[foreground], theme[background])
  }));

  return Object.freeze({
    measurements: Object.freeze(measurements),
    issues: Object.freeze(measurements.filter(({ ratio }) => ratio < TUI_THEME_MIN_CONTRAST_RATIO)),
    minimumRatio: Math.min(...measurements.map(({ ratio }) => ratio))
  });
}

export function tuiThemeContrastRatio(foreground: string, background: string): number {
  const foregroundRgb = tuiThemeColorRgb(foreground);
  const backgroundRgb = tuiThemeColorRgb(background);
  if (!foregroundRgb || !backgroundRgb) {
    throw new Error(`Cannot measure TUI theme contrast: ${foreground} on ${background}`);
  }

  const foregroundLuminance = relativeLuminance(foregroundRgb);
  const backgroundLuminance = relativeLuminance(backgroundRgb);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function tuiThemeColorRgb(color: string): readonly [number, number, number] | null {
  const namedIndex = NAMED_COLOR_INDEX[color];
  if (namedIndex !== undefined) {
    return ANSI_16_RGB[namedIndex] ?? null;
  }

  const ansiMatch = color.match(/^ansi256\(\s*(\d+)\s*\)$/);
  if (ansiMatch) {
    return ansi256Rgb(Number(ansiMatch[1]));
  }

  const rgbMatch = color.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgbMatch) {
    const rgb = [Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3])] as const;
    return rgb.every(isByte) ? rgb : null;
  }

  const shortHexMatch = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (shortHexMatch) {
    return [
      Number.parseInt(`${shortHexMatch[1]}${shortHexMatch[1]}`, 16),
      Number.parseInt(`${shortHexMatch[2]}${shortHexMatch[2]}`, 16),
      Number.parseInt(`${shortHexMatch[3]}${shortHexMatch[3]}`, 16)
    ];
  }

  const longHexMatch = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!longHexMatch) {
    return null;
  }

  return [
    Number.parseInt(longHexMatch[1] ?? "0", 16),
    Number.parseInt(longHexMatch[2] ?? "0", 16),
    Number.parseInt(longHexMatch[3] ?? "0", 16)
  ];
}

function ansi256Rgb(index: number): readonly [number, number, number] | null {
  if (!Number.isInteger(index) || index < 0 || index > 255) {
    return null;
  }
  if (index < 16) {
    return ANSI_16_RGB[index] ?? null;
  }
  if (index >= 232) {
    const channel = 8 + ((index - 232) * 10);
    return [channel, channel, channel];
  }

  const cubeIndex = index - 16;
  const levels = [0, 95, 135, 175, 215, 255] as const;
  return [
    levels[Math.floor(cubeIndex / 36)] ?? 0,
    levels[Math.floor(cubeIndex / 6) % 6] ?? 0,
    levels[cubeIndex % 6] ?? 0
  ];
}

function relativeLuminance([red, green, blue]: readonly [number, number, number]): number {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * (r ?? 0)) + (0.7152 * (g ?? 0)) + (0.0722 * (b ?? 0));
}

function isByte(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 255;
}
