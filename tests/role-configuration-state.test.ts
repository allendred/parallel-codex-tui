import { describe, expect, it } from "vitest";
import type { RoleConfigurationSnapshot } from "../src/core/role-configuration.js";
import {
  cycleRoleProvider,
  moveRoleConfigurationSelection,
  nextRoleConfigurationScope,
  roleConfigurationScopeHasOverride,
  roleConfigurationSelectionForScope,
  updateRoleModel
} from "../src/tui/role-configuration-state.js";

describe("role configuration state", () => {
  it("cycles scopes while skipping current Task when none is active", () => {
    expect(nextRoleConfigurationScope("next", 1, false)).toBe("future");
    expect(nextRoleConfigurationScope("future", 1, false)).toBe("next");
    expect(nextRoleConfigurationScope("next", 1, true)).toBe("task");
  });

  it("cycles providers and resets the selected role to that profile model", () => {
    const snapshot = roleSnapshot();
    const changed = cycleRoleProvider(snapshot.future, "critic", snapshot.providers, 1);
    expect(changed.critic).toEqual({ engine: "claude", model: "sonnet" });
    expect(changed.actor).toEqual(snapshot.future.actor);
  });

  it("skips nonassignable providers unless the role already uses one", () => {
    const snapshot = roleSnapshot();
    snapshot.providers.splice(1, 0, {
      id: "mock",
      model: "deterministic",
      modelProvider: "local",
      assignable: false
    });

    expect(cycleRoleProvider(snapshot.future, "main", snapshot.providers, 1).main.engine).toBe("claude");

    snapshot.future.main = { engine: "mock", model: "deterministic" };
    expect(cycleRoleProvider(snapshot.future, "main", snapshot.providers, 1).main.engine).toBe("claude");
  });

  it("edits one model without mutating the source matrix", () => {
    const snapshot = roleSnapshot();
    const changed = updateRoleModel(snapshot.future, "actor", "gpt-custom");
    expect(changed.actor.model).toBe("gpt-custom");
    expect(snapshot.future.actor.model).toBe("gpt");
  });

  it("selects inherited values and reports only persisted overrides", () => {
    const snapshot = roleSnapshot();
    expect(roleConfigurationSelectionForScope(snapshot, "next")).toEqual(snapshot.future);
    expect(roleConfigurationScopeHasOverride(snapshot, "next")).toBe(false);
    snapshot.next = updateRoleModel(snapshot.future, "main", "once");
    expect(roleConfigurationScopeHasOverride(snapshot, "next")).toBe(true);
    expect(roleConfigurationSelectionForScope(snapshot, "next").main.model).toBe("once");
  });

  it("wraps role selection in both directions", () => {
    expect(moveRoleConfigurationSelection(0, -1)).toBe(3);
    expect(moveRoleConfigurationSelection(3, 1)).toBe(0);
  });
});

function roleSnapshot(): RoleConfigurationSnapshot {
  const roles = {
    main: { engine: "codex", model: "gpt" },
    judge: { engine: "codex", model: "gpt" },
    actor: { engine: "codex", model: "gpt" },
    critic: { engine: "codex", model: "gpt" }
  };
  return {
    baseline: structuredClone(roles),
    future: structuredClone(roles),
    next: null,
    task: null,
    activeTurn: null,
    providers: [
      { id: "codex", model: "gpt", modelProvider: "openai", assignable: true },
      { id: "claude", model: "sonnet", modelProvider: "anthropic", assignable: true }
    ]
  };
}
