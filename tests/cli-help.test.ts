import { describe, expect, it } from "vitest";
import { buildCliHelpText } from "../src/cli-help.js";

describe("buildCliHelpText", () => {
  it("renders the theme list from the provided theme names", () => {
    const help = buildCliHelpText(["alpha", "beta"]);

    expect(help).toContain("Temporarily use a TUI theme: alpha, beta");
    expect(help).not.toContain("codex, graphite, paper");
  });
});
