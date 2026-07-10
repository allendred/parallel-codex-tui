import { describe, expect, it } from "vitest";
import { formatTuiThemeCatalog, formatTuiThemePreview } from "../src/tui/theme-preview.js";
import { resolveTuiTheme } from "../src/tui/theme.js";

describe("formatTuiThemePreview", () => {
  it("renders deterministic ANSI swatches for the effective theme", () => {
    const preview = formatTuiThemePreview(
      resolveTuiTheme({
        theme: "paper",
        colors: {
          accent: "#aabbcc",
          chrome: "ansi256(1)"
        }
      })
    ).join("\n");

    expect(preview).toContain("preview:");
    expect(preview).toContain("semantic:");
    expect(preview).toContain("chrome");
    expect(preview).toContain("accent");
    expect(preview).toContain("\u001b[48;5;1m");
    expect(preview).toContain("\u001b[48;5;231m");
    expect(preview).toContain("\u001b[38;2;170;187;204m");
    expect(preview).toContain("\u001b[0m");
  });

  it("renders a catalog with every bundled theme and copyable palette values", () => {
    const catalog = formatTuiThemeCatalog().join("\n");

    expect(catalog).toContain("parallel-codex-tui themes");
    expect(catalog).toContain("codex: chrome=ansi256(233), surface=ansi256(234), rail=ansi256(236), accent=ansi256(81)");
    expect(catalog).toContain("graphite: chrome=ansi256(236), surface=ansi256(233), rail=ansi256(238), accent=ansi256(110)");
    expect(catalog).toContain("paper: chrome=ansi256(254), surface=ansi256(231), rail=ansi256(255), accent=ansi256(25)");
    expect(catalog).toContain("aurora: chrome=ansi256(24), surface=ansi256(233), rail=ansi256(30), accent=ansi256(159)");
    expect(catalog).toContain("studio: chrome=ansi256(236), surface=ansi256(235), rail=ansi256(238), accent=ansi256(147)");
    expect(catalog).toContain("  palette:");
    expect(catalog).toContain("    chrome=ansi256(233), surface=ansi256(234), rail=ansi256(236)");
    expect(catalog).toContain("    text=ansi256(253), muted=ansi256(245), accent=ansi256(81)");
    expect(catalog).toContain("    successSurface=ansi256(22), success=ansi256(114), warning=ansi256(179)");
    expect(catalog).toContain("    dangerSurface=ansi256(52), danger=ansi256(203)");
    expect(catalog).toContain("    chrome=ansi256(254), surface=ansi256(231), rail=ansi256(255)");
    expect(catalog).toContain("    text=ansi256(235), muted=ansi256(242), accent=ansi256(25)");
    expect(catalog).toContain("    successSurface=ansi256(194), success=ansi256(22), warning=ansi256(94)");
    expect(catalog).toContain("    dangerSurface=ansi256(224), danger=ansi256(124)");
    expect(catalog).toContain("    chrome=ansi256(24), surface=ansi256(233), rail=ansi256(30)");
    expect(catalog).toContain("    text=ansi256(255), muted=ansi256(109), accent=ansi256(159)");
    expect(catalog).toContain("    successSurface=ansi256(22), success=ansi256(121), warning=ansi256(222)");
    expect(catalog).toContain("    dangerSurface=ansi256(52), danger=ansi256(210)");
    expect(catalog).toContain("    chrome=ansi256(236), surface=ansi256(235), rail=ansi256(238)");
    expect(catalog).toContain("    text=ansi256(254), muted=ansi256(248), accent=ansi256(147)");
    expect(catalog).toContain("    successSurface=ansi256(22), success=ansi256(151), warning=ansi256(215)");
    expect(catalog).toContain("    dangerSurface=ansi256(52), danger=ansi256(210)");
    expect(catalog).toContain("preview:");
    expect(catalog).toContain("semantic:");
    expect(catalog).toContain("\u001b[48;5;234m");
    expect(catalog).toContain("\u001b[48;5;231m");
  });
});
