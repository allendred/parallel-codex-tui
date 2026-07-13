import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import type { RouteDecision } from "../src/domain/schemas.js";
import type {
  HandleRequestInput,
  HandleRequestResult,
  Orchestrator
} from "../src/orchestrator/orchestrator.js";
import {
  App,
  chatMessageDisplayLines,
  routeDecisionChatMessage
} from "../src/tui/App.js";

describe("App Router reason", () => {
  it("renders the transient route as a distinct rail with an indented reason", () => {
    const route: RouteDecision = {
      mode: "simple",
      reason: "Short conversation without project work.",
      source: "codex",
      suggested_roles: [],
      judge_engine: "mock",
      actor_engine: "mock",
      critic_engine: "mock"
    };

    expect(chatMessageDisplayLines([{
      from: "system",
      kind: "route",
      text: routeDecisionChatMessage(route)
    }], 80, 10)).toMatchObject([
      {
        text: "route · simple · codex",
        background: "rail",
        spans: [
          { text: "route", tone: "heading" },
          { text: " · ", tone: "muted" },
          { text: "simple", tone: "success" },
          { text: " · codex", tone: "muted" }
        ]
      },
      {
        text: "  Short conversation without project work.",
        background: "rail",
        spans: [{ text: "  Short conversation without project work.", tone: "muted" }]
      }
    ]);
  });

  it("shows the Router reason before the selected execution path finishes", async () => {
    const testInput = installTestInputStream();
    const completion = deferred<HandleRequestResult>();
    const route: RouteDecision = {
      mode: "simple",
      reason: "Short conversation without project work.",
      source: "codex",
      duration_ms: 42,
      suggested_roles: [],
      judge_engine: "mock",
      actor_engine: "mock",
      critic_engine: "mock"
    };
    const handleRequest = vi.fn((input: HandleRequestInput) => {
      input.onRoute?.(route);
      input.onStatus?.({ taskId: "main", main: "running" });
      return completion.promise;
    });
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-route-reason")}
        orchestrator={{ handleRequest } as unknown as Orchestrator}
        cwd="/tmp/pct-route-workspace"
      />
    );

    try {
      await waitForFrame(view.lastFrame, "ready");
      await settleEffects();
      testInput.send(view.stdin, "hello\r");

      await waitForFrame(view.lastFrame, "Short conversation without project work.");
      const routingFrame = view.lastFrame() ?? "";
      expect(routingFrame).toContain("route · simple · codex");
      expect(routingFrame).not.toContain("Final Main answer.");

      completion.resolve({
        mode: "simple",
        taskId: null,
        summary: "Final Main answer.",
        workers: []
      });
      await waitForFrame(view.lastFrame, "Final Main answer.");
      const finalFrame = view.lastFrame() ?? "";
      expect(finalFrame).not.toContain("Short conversation without project work.");
    } finally {
      completion.resolve({
        mode: "simple",
        taskId: null,
        summary: "Final Main answer.",
        workers: []
      });
      view.unmount();
      testInput.restore();
    }
  });

  it("announces a follow-up route once before the task answer finishes", async () => {
    const testInput = installTestInputStream();
    const completion = deferred<HandleRequestResult>();
    const route: RouteDecision = {
      mode: "simple",
      reason: "Question about the active task state.",
      source: "codex",
      duration_ms: 31,
      suggested_roles: [],
      judge_engine: "mock",
      actor_engine: "mock",
      critic_engine: "mock"
    };
    const routeTaskFollowUp = vi.fn((input: HandleRequestInput & { taskId: string }) => {
      input.onRoute?.(route);
      return Promise.resolve({
        mode: "simple" as const,
        taskId: null,
        reason: route.reason,
        route
      });
    });
    const answerTaskQuestion = vi.fn(() => completion.promise);
    const canRetryTask = vi.fn(async () => false);
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-follow-up-route-reason")}
        orchestrator={{ routeTaskFollowUp, answerTaskQuestion, canRetryTask } as unknown as Orchestrator}
        cwd="/tmp/pct-route-workspace"
        initialTaskId="task-route-reason"
        initialWorkers={[]}
      />
    );

    try {
      await waitForFrame(view.lastFrame, "ready");
      await settleEffects();
      testInput.send(view.stdin, "status?\r");

      await waitForFrame(view.lastFrame, "Question about the active task state.");
      const routingFrame = view.lastFrame() ?? "";
      expect(routingFrame.match(/Question about the active task state\./g)).toHaveLength(1);
      expect(answerTaskQuestion).toHaveBeenCalledOnce();

      completion.resolve({
        mode: "simple",
        taskId: "task-route-reason",
        summary: "The active task is still running.",
        workers: []
      });
      await waitForFrame(view.lastFrame, "The active task is still running.");
    } finally {
      completion.resolve({
        mode: "simple",
        taskId: "task-route-reason",
        summary: "The active task is still running.",
        workers: []
      });
      view.unmount();
      testInput.restore();
    }
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
