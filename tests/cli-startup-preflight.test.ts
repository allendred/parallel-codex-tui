import { describe, expect, it } from "vitest";
import { startupPreflightMessages } from "../src/cli-startup-preflight.js";

describe("startupPreflightMessages", () => {
  it("keeps a healthy startup quiet", () => {
    expect(startupPreflightMessages({
      ok: true,
      lines: [
        "workspace permissions: ok (read/write/search)",
        "codex: ok",
        "codex capabilities: ok (exec sandbox/add-dir)",
        "workers.codex proxy: direct (no proxy configured)",
        "native workspace trust: interactive (confirm only workspaces you trust when prompted)"
      ]
    })).toEqual([]);
  });

  it("summarizes actionable failures without flooding chat", () => {
    expect(startupPreflightMessages({
      ok: false,
      lines: [
        "workspace permissions: denied (/tmp/project; need read/write/search)",
        "codex: missing",
        "claude capabilities: incompatible (--resume missing)",
        "workers.codex proxy: unreachable (127.0.0.1:7890)",
        "workers.codex.model.env.OPENAI_API_KEY: missing env OPENAI_API_KEY"
      ]
    })).toEqual([{
      from: "system",
      text: expect.stringMatching(/^Startup preflight needs attention .* 1 more .* --doctor before starting workers$/)
    }]);
  });

  it("surfaces non-blocking compatibility warnings", () => {
    expect(startupPreflightMessages({
      ok: true,
      lines: ["codex capabilities: warning (help not recognized; compatibility unverified)"]
    })[0]?.text).toContain("Startup preflight warning");
  });
});
