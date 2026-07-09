import type { TextProps } from "ink";

type InkBackground = NonNullable<TextProps["backgroundColor"]>;
type InkColor = NonNullable<TextProps["color"]>;

const bg = (value: InkBackground) => value;
const fg = (value: InkColor) => value;

export const TUI_THEME = {
  chrome: bg("ansi256(24)"),
  surface: bg("ansi256(235)"),
  rail: bg("ansi256(236)"),
  successSurface: bg("ansi256(22)"),
  dangerSurface: bg("ansi256(52)"),
  text: fg("white"),
  muted: fg("gray"),
  accent: fg("cyan"),
  warning: fg("yellow"),
  success: fg("green"),
  danger: fg("red")
} as const;
