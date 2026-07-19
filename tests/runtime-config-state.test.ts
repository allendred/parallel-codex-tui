import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import { runtimeConfigChange } from "../src/tui/runtime-config-state.js";

describe("runtimeConfigChange", () => {
  it("marks Router-only changes as live for the next request", () => {
    const active = defaultConfig("/tmp/project");
    const latest = structuredClone(active);
    latest.router.codex.timeoutMs += 1000;

    expect(runtimeConfigChange(active, latest)).toEqual({
      kind: "router",
      detail: "config · router changed · active on next request",
      compact: "config router live"
    });
  });

  it("requires restart when role or Worker configuration changes", () => {
    const active = defaultConfig("/tmp/project");
    const latestPairing = structuredClone(active);
    latestPairing.pairing.critic = "codex";
    const latestRole = structuredClone(active);
    latestRole.roles.actor.instructions.push("Run focused tests.");

    expect(runtimeConfigChange(active, latestPairing)?.kind).toBe("restart");
    expect(runtimeConfigChange(active, latestRole)?.kind).toBe("restart");
    expect(runtimeConfigChange(active, structuredClone(active))).toBeNull();
  });
});
