import { describe, expect, it } from "vitest";
import { formatTuiThemePreview } from "../src/tui/theme-preview.js";
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
});
