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
    expect(catalog).toContain("codex: chrome=ansi256(234), surface=ansi256(235), rail=ansi256(238), accent=ansi256(81)");
    expect(catalog).toContain("graphite: chrome=ansi256(236), surface=ansi256(233), rail=ansi256(238), accent=ansi256(75)");
    expect(catalog).toContain("paper: chrome=ansi256(254), surface=ansi256(231), rail=ansi256(255), accent=ansi256(25)");
    expect(catalog).toContain("preview:");
    expect(catalog).toContain("semantic:");
    expect(catalog).toContain("\u001b[48;5;234m");
    expect(catalog).toContain("\u001b[48;5;231m");
  });
});
