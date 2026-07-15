import React from "react";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import type { RouteDecision } from "../src/domain/schemas.js";
import type {
  HandleRequestInput,
  HandleRequestResult,
  Orchestrator,
  WorkerLogRef
} from "../src/orchestrator/orchestrator.js";
import {
  App,
  chatMessageDisplayLines,
  routeDecisionChatMessage
} from "../src/tui/App.js";
import { displayWidth } from "../src/tui/display-width.js";

describe("App Router reason", () => {
  it("reconciles a terminal resize that lands while the root resize listener mounts", async () => {
    const testInput = installTestInputStream();
    const stdout = process.stdout as NodeJS.WriteStream & {
      columns: number;
      rows: number;
    };
    const previousColumns = stdout.columns;
    const previousRows = stdout.rows;
    const originalOn = stdout.on;
    let intercepted = false;
    stdout.columns = 100;
    stdout.rows = 30;
    stdout.on = function on(
      this: NodeJS.WriteStream,
      event: string | symbol,
      listener: (...args: unknown[]) => void
    ) {
      if (event === "resize" && listener.name === "updateTerminalSize") {
        intercepted = true;
        stdout.columns = 24;
        stdout.rows = 12;
      }
      return Reflect.apply(originalOn, this, [event, listener]) as NodeJS.WriteStream;
    } as typeof stdout.on;

    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-resize-race")}
        orchestrator={{} as Orchestrator}
        cwd="/tmp/pct-resize-workspace"
      />
    );

    try {
      await settleEffects();
      const frame = view.lastFrame() ?? "";
      expect(intercepted).toBe(true);
      expect(frame).not.toContain("^G routes");
      expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(24);
    } finally {
      view.unmount();
      testInput.restore();
      stdout.on = originalOn;
      stdout.columns = previousColumns;
      stdout.rows = previousRows;
    }
  });

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

  it("keeps wrapped Router reasons indented inside the rail", () => {
    const route: RouteDecision = {
      mode: "complex",
      reason: "用户要求跨工作区实现多个功能，并且需要保留当前任务上下文与原生会话。",
      source: "codex",
      suggested_roles: ["judge", "actor", "critic"],
      judge_engine: "codex",
      actor_engine: "codex",
      critic_engine: "claude"
    };

    const lines = chatMessageDisplayLines([{
      from: "system",
      kind: "route",
      text: routeDecisionChatMessage(route)
    }], 30, 10);
    const reasonLines = lines.slice(1);

    expect(reasonLines.length).toBeGreaterThan(1);
    expect(reasonLines.every((line) => line.text.startsWith("  "))).toBe(true);
    expect(reasonLines.every((line) => line.background === "rail")).toBe(true);
    expect(Math.max(...lines.map((line) => displayWidth(line.text)))).toBeLessThanOrEqual(28);
  });

  it("indents wrapped Router header continuations in nano terminals", () => {
    const route: RouteDecision = {
      mode: "complex",
      reason: "Implementation request.",
      source: "codex",
      suggested_roles: ["judge", "actor", "critic"],
      judge_engine: "codex",
      actor_engine: "codex",
      critic_engine: "claude"
    };

    const lines = chatMessageDisplayLines([{
      from: "system",
      kind: "route",
      text: routeDecisionChatMessage(route)
    }], 16, 10);
    const reasonStart = lines.findIndex((line) => line.text.includes("Implementation"));
    const headerLines = lines.slice(0, reasonStart);

    expect(headerLines.length).toBeGreaterThan(1);
    expect(headerLines[0]?.text.startsWith("route")).toBe(true);
    expect(headerLines.slice(1).every((line) => line.text.startsWith("  "))).toBe(true);
    expect(Math.max(...lines.map((line) => displayWidth(line.text)))).toBeLessThanOrEqual(14);
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
      expect(routingFrame).toContain("main/claude · run");
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

  it("shows the live Main first-output budget after the Router decision", async () => {
    const testInput = installTestInputStream();
    const root = await mkdtemp(join(tmpdir(), "pct-app-main-progress-"));
    const statusPath = join(root, "status.json");
    const completion = deferred<HandleRequestResult>();
    const route: RouteDecision = {
      mode: "simple",
      reason: "Short conversation without project work.",
      source: "codex",
      duration_ms: 12_000,
      suggested_roles: [],
      judge_engine: "mock",
      actor_engine: "mock",
      critic_engine: "mock"
    };
    await writeFile(statusPath, JSON.stringify({
      worker_id: "main-claude",
      role: "main",
      engine: "claude",
      state: "starting",
      phase: "process-starting",
      last_event_at: new Date(Date.now() - 12_000).toISOString(),
      summary: "Starting claude"
    }));
    const handleRequest = vi.fn((input: HandleRequestInput) => {
      input.onRoute?.(route);
      input.onStatus?.({ taskId: "main", main: "running" });
      input.onWorker?.({
        id: "main-claude",
        role: "main",
        engine: "claude",
        label: "Main (claude)",
        logPath: join(root, "output.log"),
        statusPath
      });
      return completion.promise;
    });
    const view = render(
      <App
        config={defaultConfig(root)}
        orchestrator={{ handleRequest } as unknown as Orchestrator}
        cwd={root}
      />
    );

    try {
      await waitForFrame(view.lastFrame, "ready");
      await settleEffects();
      testInput.send(view.stdin, "hello\r");

      await waitForFrame(view.lastFrame, "waiting output");
      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("main/claude · waiting output");
      expect(frame).toContain("/ 2m first");
      expect(frame).toContain("route simple");
    } finally {
      completion.resolve({
        mode: "simple",
        taskId: null,
        summary: "Final Main answer.",
        workers: []
      });
      view.unmount();
      testInput.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not let a stale active-worker poll overwrite a terminal Main state", async () => {
    const testInput = installTestInputStream();
    const root = await mkdtemp(join(tmpdir(), "pct-app-main-terminal-precedence-"));
    const statusPath = join(root, "status.json");
    const completion = deferred<HandleRequestResult>();
    const route: RouteDecision = {
      mode: "simple",
      reason: "Short conversation without project work.",
      source: "codex",
      duration_ms: 12,
      suggested_roles: [],
      judge_engine: "mock",
      actor_engine: "mock",
      critic_engine: "mock"
    };
    await writeFile(statusPath, JSON.stringify({
      worker_id: "main-claude",
      role: "main",
      engine: "claude",
      state: "running",
      phase: "process-output",
      last_event_at: new Date(Date.now() - 2_000).toISOString(),
      summary: "Working"
    }));
    const handleRequest = vi.fn((input: HandleRequestInput) => {
      input.onRoute?.(route);
      input.onStatus?.({ taskId: "main", main: "starting" });
      input.onWorker?.({
        id: "main-claude",
        role: "main",
        engine: "claude",
        label: "Main (claude)",
        logPath: join(root, "output.log"),
        statusPath
      });
      input.onStatus?.({ taskId: "main", main: "done" });
      return completion.promise;
    });
    const view = render(
      <App
        config={defaultConfig(root)}
        orchestrator={{ handleRequest } as unknown as Orchestrator}
        cwd={root}
      />
    );

    try {
      await waitForFrame(view.lastFrame, "ready");
      await settleEffects();
      testInput.send(view.stdin, "hello\r");
      await waitForFrame(view.lastFrame, "main/claude · done");
      await new Promise((resolve) => setTimeout(resolve, 1_200));

      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("main/claude · done");
      expect(frame).not.toContain("responding");
    } finally {
      completion.resolve({
        mode: "simple",
        taskId: null,
        summary: "Final Main answer.",
        workers: []
      });
      view.unmount();
      testInput.restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows a newer native-session fallback to recover from a failed Main attempt", async () => {
    const testInput = installTestInputStream();
    const root = await mkdtemp(join(tmpdir(), "pct-app-main-native-fallback-"));
    const completion = deferred<HandleRequestResult>();
    const route: RouteDecision = {
      mode: "simple",
      reason: "Short conversation without project work.",
      source: "codex",
      duration_ms: 12,
      suggested_roles: [],
      judge_engine: "mock",
      actor_engine: "mock",
      critic_engine: "mock"
    };
    const handleRequest = vi.fn((input: HandleRequestInput) => {
      input.onRoute?.(route);
      input.onStatus?.({ taskId: "main", main: "failed" });
      input.onWorker?.({
        id: "main-claude",
        role: "main",
        engine: "claude",
        label: "Main (claude)",
        logPath: join(root, "output.log"),
        statusPath: join(root, "status.json"),
        runtimeStatus: {
          worker_id: "main-claude",
          role: "main",
          engine: "claude",
          state: "starting",
          phase: "native-resume-fallback",
          last_event_at: new Date().toISOString(),
          summary: "Starting fresh session"
        }
      });
      return completion.promise;
    });
    const view = render(
      <App
        config={defaultConfig(root)}
        orchestrator={{ handleRequest } as unknown as Orchestrator}
        cwd={root}
      />
    );

    try {
      await waitForFrame(view.lastFrame, "ready");
      await settleEffects();
      testInput.send(view.stdin, "hello\r");
      await waitForFrame(view.lastFrame, "waiting output");

      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("main/claude · waiting output");
      expect(frame).not.toContain("main/claude fail");
    } finally {
      completion.resolve({
        mode: "simple",
        taskId: null,
        summary: "Final Main answer.",
        workers: []
      });
      view.unmount();
      testInput.restore();
      await rm(root, { recursive: true, force: true });
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

  it("keeps previous worker logs available while running a complex follow-up", async () => {
    const testInput = installTestInputStream();
    const completion = deferred<HandleRequestResult>();
    const root = await mkdtemp(join(tmpdir(), "pct-app-follow-up-worker-logs-"));
    const logPath = join(root, "turn-1-output.log");
    const followUpLogPath = join(root, "turn-2-output.log");
    const route: RouteDecision = {
      mode: "complex",
      reason: "Implementation follow-up for the active task.",
      source: "codex",
      suggested_roles: ["judge", "actor", "critic"],
      judge_engine: "mock",
      actor_engine: "codex",
      critic_engine: "mock"
    };
    const previousWorker: WorkerLogRef = {
      id: "actor-codex",
      role: "actor",
      engine: "codex",
      label: "Actor (codex)",
      logPath,
      statusPath: join(root, "turn-1-status.json")
    };
    const followUpWorker: WorkerLogRef = {
      id: "actor-codex-0002",
      role: "actor",
      engine: "codex",
      label: "Actor (codex) · Turn 2",
      logPath: followUpLogPath,
      statusPath: join(root, "turn-2-status.json")
    };
    const routeTaskFollowUp = vi.fn((input: HandleRequestInput & { taskId: string }) => {
      input.onRoute?.(route);
      return Promise.resolve({
        mode: "complex" as const,
        taskId: "task-worker-log-history",
        reason: route.reason,
        route
      });
    });
    const handleTaskTurn = vi.fn((input: HandleRequestInput) => {
      input.onWorker?.(followUpWorker);
      return completion.promise;
    });
    const canRetryTask = vi.fn(async () => false);

    await writeFile(logPath, "previous actor log remains visible\n");
    await writeFile(followUpLogPath, "follow-up actor log is also visible\n");
    const view = render(
      <App
        config={defaultConfig(root)}
        orchestrator={{ routeTaskFollowUp, handleTaskTurn, canRetryTask } as unknown as Orchestrator}
        cwd={root}
        initialTaskId="task-worker-log-history"
        initialWorkers={[previousWorker]}
      />
    );

    try {
      await waitForFrame(view.lastFrame, "ready");
      await settleEffects();
      testInput.send(view.stdin, "status?\r");
      await waitForFrame(view.lastFrame, route.reason);

      testInput.send(view.stdin, "\x17");
      await waitForFrame(view.lastFrame, "previous actor log remains visible");
      expect(view.lastFrame()).toContain("actor/codex · 1/2");

      testInput.send(view.stdin, "\t");
      await waitForFrame(view.lastFrame, "follow-up actor log is also visible");
      expect(view.lastFrame()).toContain("actor/codex · Turn 2 · 2/2");
    } finally {
      completion.resolve({
        mode: "complex",
        taskId: "task-worker-log-history",
        summary: "The follow-up completed.",
        workers: []
      });
      await settleEffects();
      view.unmount();
      await settleEffects();
      testInput.restore();
      await rm(root, { recursive: true, force: true });
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
