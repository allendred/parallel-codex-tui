import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { RoleConfigurationSnapshot } from "../src/core/role-configuration.js";
import { roleConfigurationDisplayLines, RoleConfigurationView } from "../src/tui/RoleConfigurationView.js";
import { displayWidth } from "../src/tui/display-width.js";

describe("RoleConfigurationView", () => {
  it("shows the selected role, provider, model, scope and active Turn evidence", () => {
    const snapshot = roleSnapshot();
    const lines = roleConfigurationDisplayLines({
      snapshot,
      draft: snapshot.task,
      scope: "task",
      selectedRoleIndex: 2,
      hasActiveTask: true,
      notice: "Saved · current Task retries and follow-ups will use this matrix"
    }, 100);
    const text = lines.map((line) => line.text).join("\n");

    expect(text).toContain("scope · current task · retries and follow-ups");
    expect(text).toContain("> Actor");
    expect(text).toContain("claude · anthropic/sonnet");
    expect(text).toContain("active turn · main/codex/gpt");
    expect(text).toContain("Saved · current Task retries and follow-ups");
  });

  it("renders a deliberate unavailable current-Task state", () => {
    const snapshot = roleSnapshot();
    const lines = roleConfigurationDisplayLines({
      snapshot,
      draft: snapshot.future,
      scope: "task",
      selectedRoleIndex: 0,
      hasActiveTask: false
    }, 80);
    expect(lines.map((line) => line.text).join("\n")).toContain("No active Task");
  });

  it("fills the viewport without overflowing narrow terminals", () => {
    const snapshot = roleSnapshot();
    const view = render(
      <RoleConfigurationView
        snapshot={snapshot}
        draft={snapshot.future}
        scope="future"
        selectedRoleIndex={3}
        height={12}
        terminalWidth={42}
      />
    );
    const rows = (view.lastFrame() ?? "").split("\n");
    expect(rows).toHaveLength(12);
    expect(rows.every((row) => displayWidth(row) <= 40)).toBe(true);
    view.unmount();
  });
});

function roleSnapshot(): RoleConfigurationSnapshot {
  const future = {
    main: { engine: "codex", model: "gpt" },
    judge: { engine: "codex", model: "gpt" },
    actor: { engine: "codex", model: "gpt" },
    critic: { engine: "claude", model: "sonnet" }
  };
  return {
    baseline: structuredClone(future),
    future: structuredClone(future),
    next: null,
    task: structuredClone(future),
    activeTurn: structuredClone(future),
    providers: [
      { id: "codex", model: "gpt", modelProvider: "openai", assignable: true },
      { id: "claude", model: "sonnet", modelProvider: "anthropic", assignable: true }
    ]
  };
}
