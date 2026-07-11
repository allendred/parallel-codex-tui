import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import type { Orchestrator, WorkerLogRef } from "../src/orchestrator/orchestrator.js";
import { App } from "../src/tui/App.js";

describe("App initial task restore", () => {
  it("opens preloaded worker logs before the asynchronous restore fallback resolves", async () => {
    const testInput = installTestInputStream();
    const workerRestore = deferred<WorkerLogRef[]>();
    const retryRestore = deferred<boolean>();
    const orchestrator = {
      listTaskWorkers: () => workerRestore.promise,
      canRetryTask: () => retryRestore.promise
    } as unknown as Orchestrator;
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-preloaded-restore")}
        orchestrator={orchestrator}
        cwd="/tmp/pct-workspace"
        initialTaskId="task-20260707-033720-fefc"
        initialWorkers={[{
          id: "critic-codex",
          role: "critic",
          engine: "codex",
          label: "Critic (codex)",
          logPath: "/tmp/preloaded-task/critic-codex/output.log",
          statusPath: "/tmp/preloaded-task/critic-codex/status.json"
        }]}
        initialCanRetryTask={false}
      />
    );

    try {
      await settleEffects();
      testInput.send(view.stdin, "\x17");
      await waitForFrame(view.lastFrame, "· logs ·");

      const frame = view.lastFrame() ?? "";
      expect(frame).toContain("critic/codex · 1/1");
      expect(frame).not.toContain("No workers yet");
    } finally {
      view.unmount();
      testInput.restore();
    }
  });

  it("does not restore old workers after Ctrl+N clears the active task", async () => {
    const testInput = installTestInputStream();
    const workerRestore = deferred<WorkerLogRef[]>();
    const retryRestore = deferred<boolean>();
    const orchestrator = {
      listTaskWorkers: () => workerRestore.promise,
      canRetryTask: () => retryRestore.promise
    } as unknown as Orchestrator;
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-restore")}
        orchestrator={orchestrator}
        cwd="/tmp/pct-workspace"
        initialTaskId="task-20260707-033720-fefc"
      />
    );

    try {
      await waitForFrame(view.lastFrame, "message · ^N");
      await settleEffects();
      expect(view.stdin.listenerCount("readable")).toBeGreaterThan(0);
      expect(typeof (view.stdin as EventEmitter & { read?: () => string | null }).read).toBe("function");
      testInput.send(view.stdin, "\x0e");
      await waitForFrame(view.lastFrame, "new task · ready");

      workerRestore.resolve([{
        id: "critic-codex",
        role: "critic",
        engine: "codex",
        label: "Critic (codex)",
        logPath: "/tmp/old-task/critic-codex/output.log",
        statusPath: "/tmp/old-task/critic-codex/status.json"
      }]);
      retryRestore.resolve(false);
      await settleEffects();

      const frame = view.lastFrame() ?? "";
      expect(frame.split("\n")[0]).not.toContain("#033720-fefc");
      expect(frame).not.toContain("^W logs");
      expect(frame).not.toContain("^O attach");
    } finally {
      view.unmount();
      testInput.restore();
    }
  });

  it("does not restore old retry state after Ctrl+N clears the active task", async () => {
    const testInput = installTestInputStream();
    const workerRestore = deferred<WorkerLogRef[]>();
    const retryRestore = deferred<boolean>();
    const orchestrator = {
      listTaskWorkers: () => workerRestore.promise,
      canRetryTask: () => retryRestore.promise
    } as unknown as Orchestrator;
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-retry-restore")}
        orchestrator={orchestrator}
        cwd="/tmp/pct-workspace"
        initialTaskId="task-20260707-033720-fefc"
      />
    );

    try {
      await waitForFrame(view.lastFrame, "message · ^N");
      await settleEffects();
      testInput.send(view.stdin, "\x0e");
      await waitForFrame(view.lastFrame, "new task · ready");

      workerRestore.resolve([]);
      retryRestore.resolve(true);
      await settleEffects();

      const frame = view.lastFrame() ?? "";
      expect(frame.split("\n")[0]).not.toContain("#033720-fefc");
      expect(frame).not.toContain("^R retry");
    } finally {
      view.unmount();
      testInput.restore();
    }
  });
});

describe("App empty worker shortcuts", () => {
  it("keeps Ctrl+W in chat with a dismissible no-worker explanation", async () => {
    const testInput = installTestInputStream();
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-empty-logs")}
        orchestrator={{} as Orchestrator}
        cwd="/tmp/pct-workspace"
      />
    );

    try {
      await waitForFrame(view.lastFrame, "ready");
      await settleEffects();
      testInput.send(view.stdin, "\x17");
      await waitForFrame(view.lastFrame, "No workers yet · start a complex task before opening logs");

      expect((view.lastFrame() ?? "").split("\n")[0]).toContain("· chat ·");
      testInput.send(view.stdin, "\x1b");
      await waitForFrameWithout(view.lastFrame, "No workers yet");
    } finally {
      view.unmount();
      testInput.restore();
    }
  });

  it("dismisses a no-worker attach explanation with Escape", async () => {
    const testInput = installTestInputStream();
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-empty-attach")}
        orchestrator={{} as Orchestrator}
        cwd="/tmp/pct-workspace"
      />
    );

    try {
      await waitForFrame(view.lastFrame, "ready");
      await settleEffects();
      testInput.send(view.stdin, "\x0f");
      await waitForFrame(view.lastFrame, "No workers yet · start a complex task before attaching");

      testInput.send(view.stdin, "\x1b");
      await waitForFrameWithout(view.lastFrame, "No workers yet");
    } finally {
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
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if ((lastFrame() ?? "").includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${text}\nFrame:\n${lastFrame() ?? ""}`);
}

async function waitForFrameWithout(lastFrame: () => string | undefined, text: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (!(lastFrame() ?? "").includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting to remove ${text}\nFrame:\n${lastFrame() ?? ""}`);
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
      if (originalRead) {
        prototype.read = originalRead;
      } else {
        delete prototype.read;
      }
      if (originalRef) {
        prototype.ref = originalRef;
      } else {
        delete prototype.ref;
      }
      if (originalUnref) {
        prototype.unref = originalUnref;
      } else {
        delete prototype.unref;
      }
    }
  };
}
