import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import type { Orchestrator, WorkerLogRef } from "../src/orchestrator/orchestrator.js";
import { App } from "../src/tui/App.js";
import type { NativeAttachLaunch, NativeAttachProcessRef } from "../src/workers/native-attach.js";

describe("App native attach lifecycle", () => {
  it("kills an active native attach process when the outer App unmounts", async () => {
    const testInput = installTestInputStream();
    const worker = testWorker();
    const processRef = testProcessRef();
    const startNativeAttach = vi.fn(() => processRef);
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-native-lifecycle")}
        orchestrator={testOrchestrator(worker)}
        cwd="/tmp/pct-native-workspace"
        initialTaskId="task-native-lifecycle"
        initialWorkers={[worker]}
        prepareNativeAttach={async () => testLaunch()}
        startNativeAttach={startNativeAttach}
      />
    );
    let unmounted = false;

    try {
      await openNativeAttach(view, testInput);
      view.unmount();
      unmounted = true;
      await settleEffects();

      expect(startNativeAttach).toHaveBeenCalledOnce();
      expect(processRef.kill).toHaveBeenCalledOnce();
    } finally {
      if (!unmounted) {
        view.unmount();
      }
      testInput.restore();
    }
  });

  it("does not start native attach after the outer App unmounts during preparation", async () => {
    const testInput = installTestInputStream();
    const worker = testWorker();
    const launch = deferred<NativeAttachLaunch>();
    const startNativeAttach = vi.fn(() => testProcessRef());
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-native-prepare-lifecycle")}
        orchestrator={testOrchestrator(worker)}
        cwd="/tmp/pct-native-workspace"
        initialTaskId="task-native-prepare-lifecycle"
        initialWorkers={[worker]}
        prepareNativeAttach={() => launch.promise}
        startNativeAttach={startNativeAttach}
      />
    );

    try {
      await waitForFrame(view.lastFrame, "ready");
      await settleEffects();
      testInput.send(view.stdin, "\x17");
      await waitForFrame(view.lastFrame, "· logs ·");
      testInput.send(view.stdin, "\x0f");
      await settleEffects();
      view.unmount();
      await settleEffects();
      launch.resolve(testLaunch());
      await settleEffects();

      expect(startNativeAttach).not.toHaveBeenCalled();
    } finally {
      testInput.restore();
    }
  });

  it("starts only the latest native attach request when preparation overlaps", async () => {
    const testInput = installTestInputStream();
    const worker = testWorker();
    const firstLaunch = deferred<NativeAttachLaunch>();
    const secondLaunch = deferred<NativeAttachLaunch>();
    const processRef = testProcessRef();
    const prepareNativeAttach = vi.fn()
      .mockReturnValueOnce(firstLaunch.promise)
      .mockReturnValueOnce(secondLaunch.promise);
    const startNativeAttach = vi.fn(() => processRef);
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-native-overlap")}
        orchestrator={testOrchestrator(worker)}
        cwd="/tmp/pct-native-workspace"
        initialTaskId="task-native-overlap"
        initialWorkers={[worker]}
        prepareNativeAttach={prepareNativeAttach}
        startNativeAttach={startNativeAttach}
      />
    );
    let unmounted = false;

    try {
      await waitForFrame(view.lastFrame, "ready");
      await settleEffects();
      testInput.send(view.stdin, "\x17");
      await waitForFrame(view.lastFrame, "· logs ·");
      testInput.send(view.stdin, "\x0f");
      await settleEffects();
      testInput.send(view.stdin, "\x0f");
      await settleEffects();
      expect(prepareNativeAttach).toHaveBeenCalledTimes(2);

      firstLaunch.resolve(testLaunch());
      await settleEffects();
      expect(startNativeAttach).not.toHaveBeenCalled();

      secondLaunch.resolve(testLaunch());
      await waitForFrame(view.lastFrame, "waiting for output");
      expect(startNativeAttach).toHaveBeenCalledOnce();

      view.unmount();
      unmounted = true;
      await settleEffects();
      expect(processRef.kill).toHaveBeenCalledOnce();
    } finally {
      if (!unmounted) {
        view.unmount();
      }
      testInput.restore();
    }
  });
});

async function openNativeAttach(
  view: ReturnType<typeof render>,
  testInput: ReturnType<typeof installTestInputStream>
): Promise<void> {
  await waitForFrame(view.lastFrame, "ready");
  await settleEffects();
  testInput.send(view.stdin, "\x17");
  await waitForFrame(view.lastFrame, "· logs ·");
  testInput.send(view.stdin, "\x0f");
  await waitForFrame(view.lastFrame, "waiting for output");
}

function testWorker(): WorkerLogRef {
  return {
    id: "actor-codex",
    role: "actor",
    engine: "codex",
    label: "Actor (codex)",
    logPath: "/tmp/pct-native-worker/output.log",
    statusPath: "/tmp/pct-native-worker/status.json",
    runtimeStatus: {
      worker_id: "actor-codex",
      role: "actor",
      engine: "codex",
      state: "done",
      phase: "process-exited",
      last_event_at: "2026-07-12T00:00:00.000Z",
      summary: "done",
      native_session_id: "native-lifecycle"
    }
  };
}

function testOrchestrator(worker: WorkerLogRef): Orchestrator {
  return {
    listTaskWorkers: async () => [worker],
    canRetryTask: async () => false
  } as unknown as Orchestrator;
}

function testLaunch(): NativeAttachLaunch {
  return {
    command: "mock-native",
    args: [],
    cwd: "/tmp/pct-native-workspace",
    sessionId: "native-lifecycle",
    label: "Actor (codex)"
  };
}

function testProcessRef(): NativeAttachProcessRef & {
  kill: ReturnType<typeof vi.fn>;
} {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn()
  };
}

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
  await new Promise((resolve) => setTimeout(resolve, 30));
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
