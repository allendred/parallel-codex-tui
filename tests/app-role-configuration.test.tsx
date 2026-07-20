import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import type { RoleConfigurationSnapshot } from "../src/core/role-configuration.js";
import type { Orchestrator } from "../src/orchestrator/orchestrator.js";
import { App } from "../src/tui/App.js";

describe("App role configuration", () => {
  it("opens with Ctrl+E, changes a provider, saves the next-request scope and returns to chat", async () => {
    const testInput = installTestInputStream();
    const config = defaultConfig("/tmp/pct-role-ui");
    config.workers.codex.model.name = "gpt";
    config.workers.codex.model.provider = "openai";
    config.workers.claude.model.name = "sonnet";
    config.workers.claude.model.provider = "anthropic";
    const initial = roleSnapshot();
    const roleConfigurationSnapshot = vi.fn(async () => initial);
    const updateRoleConfiguration = vi.fn(async (input: { roles: RoleConfigurationSnapshot["future"] }) => ({
      ...initial,
      next: structuredClone(input.roles)
    }));
    const view = render(
      <App
        config={config}
        orchestrator={{ roleConfigurationSnapshot, updateRoleConfiguration } as unknown as Orchestrator}
        cwd="/tmp/pct-role-ui"
      />
    );

    try {
      await waitForFrame(view.lastFrame, "ready");
      await settleEffects();
      testInput.send(view.stdin, "\u0005");
      await waitForFrame(view.lastFrame, "Role & model control");
      expect(view.lastFrame()).toContain("> Main");
      expect(view.lastFrame()).toContain("codex · openai/gpt");

      testInput.send(view.stdin, "\x1b[C");
      await waitForFrame(view.lastFrame, "claude · anthropic/sonnet");
      testInput.send(view.stdin, "\r");
      await waitForFrame(view.lastFrame, "next request will consume this matrix once");

      expect(updateRoleConfiguration).toHaveBeenCalledWith(expect.objectContaining({
        scope: "next",
        taskId: null,
        roles: expect.objectContaining({ main: { engine: "claude", model: "sonnet" } })
      }));

      testInput.send(view.stdin, "\u0005");
      await waitForFrame(view.lastFrame, "ready");
      expect(view.lastFrame()).not.toContain("Role & model control");
    } finally {
      view.unmount();
      await settleEffects();
      testInput.restore();
    }
  });
});

function roleSnapshot(): RoleConfigurationSnapshot {
  const roles = {
    main: { engine: "codex", model: "gpt" },
    judge: { engine: "codex", model: "gpt" },
    actor: { engine: "codex", model: "gpt" },
    critic: { engine: "claude", model: "sonnet" }
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

async function waitForFrame(lastFrame: () => string | undefined, text: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((lastFrame() ?? "").includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${text}\nFrame:\n${lastFrame() ?? ""}`);
}

async function settleEffects(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function installTestInputStream(): {
  restore: () => void;
  send: (stream: EventEmitter, value: string) => void;
} {
  const prototype = EventEmitter.prototype as EventEmitter & {
    read?: () => string | null;
    ref?: () => void;
    unref?: () => void;
  };
  const chunks: string[] = [];
  const originalRead = prototype.read;
  const originalRef = prototype.ref;
  const originalUnref = prototype.unref;
  prototype.read = () => chunks.shift() ?? null;
  prototype.ref = () => {};
  prototype.unref = () => {};
  return {
    send: (stream, value) => {
      chunks.push(value);
      stream.emit("readable");
    },
    restore: () => {
      prototype.read = originalRead;
      prototype.ref = originalRef;
      prototype.unref = originalUnref;
    }
  };
}
