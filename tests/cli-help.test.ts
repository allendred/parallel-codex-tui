import { describe, expect, it } from "vitest";
import { buildCliHelpText } from "../src/cli-help.js";

describe("buildCliHelpText", () => {
  it("renders the theme list from the provided theme names", () => {
    const help = buildCliHelpText(["alpha", "beta"]);

    expect(help).toContain("Temporarily use a TUI theme: alpha, beta");
    expect(help).toContain("List built-in TUI theme palettes");
    expect(help).toContain("combine with --theme to filter");
    expect(help).toContain("theme palette");
    expect(help).toContain("--probe-router");
    expect(help).toContain("live Codex Router request");
    expect(help).not.toContain("codex, graphite, paper");
  });
});
