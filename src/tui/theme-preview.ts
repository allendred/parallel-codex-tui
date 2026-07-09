import type { TuiTheme } from "./theme.js";

type AnsiColorMode = "background" | "foreground";

const ANSI_RESET = "\u001b[0m";
const NAMED_ANSI_FOREGROUND_CODES: Readonly<Record<string, number>> = Object.freeze({
  black: 30,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
  grey: 90,
  blackBright: 90,
  redBright: 91,
  greenBright: 92,
  yellowBright: 93,
  blueBright: 94,
  magentaBright: 95,
  cyanBright: 96,
  whiteBright: 97
});

export function formatTuiThemePreview(theme: TuiTheme): string[] {
  return [
    `preview: ${[
      themeSwatch("chrome", theme.chrome, theme.text),
      themeSwatch("surface", theme.surface, theme.text),
      themeSwatch("rail", theme.rail, theme.text)
    ].join(" ")}`,
    `semantic: ${[
      themeSwatch("success", theme.successSurface, theme.success),
      themeSwatch("danger", theme.dangerSurface, theme.danger),
      themeSwatch("accent", theme.surface, theme.accent),
      themeSwatch("warning", theme.surface, theme.warning),
      themeSwatch("muted", theme.surface, theme.muted)
    ].join(" ")}`
  ];
}

function themeSwatch(label: string, backgroundColor: string, foregroundColor: string): string {
  return `${ansiOpen(backgroundColor, "background")}${ansiOpen(foregroundColor, "foreground")} ${label} ${ANSI_RESET}`;
}

function ansiOpen(color: string, mode: AnsiColorMode): string {
  const ansi256Match = color.match(/^ansi256\((\d+)\)$/);
  if (ansi256Match) {
    return `\u001b[${modePrefix(mode)};5;${ansi256Match[1]}m`;
  }

  const rgbMatch = color.match(/^rgb\((\d+),(\d+),(\d+)\)$/);
  if (rgbMatch) {
    return `\u001b[${modePrefix(mode)};2;${rgbMatch[1]};${rgbMatch[2]};${rgbMatch[3]}m`;
  }

  const hexRgb = hexToRgb(color);
  if (hexRgb) {
    return `\u001b[${modePrefix(mode)};2;${hexRgb.join(";")}m`;
  }

  const namedCode = NAMED_ANSI_FOREGROUND_CODES[color];
  if (namedCode !== undefined) {
    return `\u001b[${mode === "background" ? namedCode + 10 : namedCode}m`;
  }

  return "";
}

function modePrefix(mode: AnsiColorMode): 38 | 48 {
  return mode === "background" ? 48 : 38;
}

function hexToRgb(color: string): [number, number, number] | null {
  const shortMatch = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (shortMatch) {
    return [
      Number.parseInt(`${shortMatch[1]}${shortMatch[1]}`, 16),
      Number.parseInt(`${shortMatch[2]}${shortMatch[2]}`, 16),
      Number.parseInt(`${shortMatch[3]}${shortMatch[3]}`, 16)
    ];
  }

  const longMatch = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!longMatch) {
    return null;
  }

  return [
    Number.parseInt(longMatch[1] ?? "0", 16),
    Number.parseInt(longMatch[2] ?? "0", 16),
    Number.parseInt(longMatch[3] ?? "0", 16)
  ];
}
