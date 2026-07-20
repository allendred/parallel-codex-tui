import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/core/config.js";
import type { MainConversationSummary } from "../src/core/session-manager.js";
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
          statusPath: "/tmp/preloaded-task/critic-codex/status.json",
          runtimeStatus: {
            worker_id: "critic-codex",
            role: "critic",
            engine: "codex",
            state: "done",
            phase: "process-exited",
            last_event_at: "2026-07-07T03:37:20.000Z",
            summary: "approved"
          }
        }]}
        initialCanRetryTask={false}
      />
    );

    try {
      expect(view.lastFrame()).toContain("workers 1 · done");
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
      await waitForFrame(view.lastFrame, "new conversation · ready");

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
      await waitForFrame(view.lastFrame, "new conversation · ready");

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

  it("starts a fresh Main conversation with Ctrl+N even when no Task is active", async () => {
    const testInput = installTestInputStream();
    const startMainConversation = vi.fn(async () => undefined);
    const activateTaskSession = vi.fn(async () => null);
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-main-conversation")}
        orchestrator={{} as Orchestrator}
        cwd="/tmp/pct-workspace"
        initialMessages={[{ from: "system", text: "preserved earlier chat" }]}
        startMainConversation={startMainConversation}
        activateTaskSession={activateTaskSession}
      />
    );

    try {
      await settleEffects();
      expect(view.lastFrame()).toContain("^N new");
      testInput.send(view.stdin, "\x0e");
      await waitForFrame(view.lastFrame, "new conversation · ready");

      expect(startMainConversation).toHaveBeenCalledOnce();
      expect(activateTaskSession).toHaveBeenCalledWith(null);
      expect(view.lastFrame()).toContain("preserved earlier chat");
    } finally {
      view.unmount();
      testInput.restore();
    }
  });

  it("opens Main conversations from the Session center and restores the selected scope", async () => {
    const testInput = installTestInputStream();
    const previousId = "conversation-20260718-100000-previous";
    const conversations = [
      {
        id: "conversation-20260719-120000-current",
        title: "Current conversation",
        createdAt: "2026-07-19T12:00:00.000Z",
        lastActivityAt: "2026-07-19T12:01:00.000Z",
        messageCount: 2,
        userMessageCount: 1,
        nativeSessionCount: 1,
        current: true
      },
      {
        id: previousId,
        title: "Previous conversation",
        createdAt: "2026-07-18T10:00:00.000Z",
        lastActivityAt: "2026-07-18T10:02:00.000Z",
        messageCount: 4,
        userMessageCount: 2,
        nativeSessionCount: 1,
        current: false
      }
    ];
    const activateMainConversation = vi.fn(async () => ({
      conversation: { ...conversations[1]!, current: true },
      restoredNativeSessions: 1,
      changed: true
    }));
    const activateTaskSession = vi.fn(async () => null);
    const persistChatMessage = vi.fn(async () => undefined);
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-conversation-sessions")}
        orchestrator={{} as Orchestrator}
        cwd="/tmp/pct-workspace"
        loadTaskSessions={async () => []}
        loadMainConversations={async () => conversations}
        activateMainConversation={activateMainConversation}
        activateTaskSession={activateTaskSession}
        persistChatMessage={persistChatMessage}
      />
    );

    try {
      await settleEffects();
      testInput.send(view.stdin, "\x14");
      await waitForFrame(view.lastFrame, "Task sessions");
      testInput.send(view.stdin, "c");
      await waitForFrame(view.lastFrame, "Main conversations");
      await waitForFrame(view.lastFrame, "2 conversations · 6 messages · 2 native");
      testInput.send(view.stdin, "\x1b[B");
      await waitForFrame(view.lastFrame, ">   Previous conversation");
      testInput.send(view.stdin, "\r");
      await waitForFrame(view.lastFrame, "conversation restored · Previous conversation · 1 native");

      expect(activateMainConversation).toHaveBeenCalledWith(previousId);
      expect(activateTaskSession).toHaveBeenCalledWith(null);
      expect(persistChatMessage).toHaveBeenCalledWith(
        expect.objectContaining({ text: "conversation restored · Previous conversation · 1 native" }),
        undefined
      );
      expect((view.lastFrame() ?? "").split("\n")[0]).toContain("· chat ·");
    } finally {
      view.unmount();
      testInput.restore();
    }
  });

  it("manages a historical Main conversation without allowing current deletion", async () => {
    const testInput = installTestInputStream();
    const previousId = "conversation-20260718-100000-managed";
    let conversations: MainConversationSummary[] = [
      {
        id: "conversation-20260719-120000-current",
        title: "Current conversation",
        createdAt: "2026-07-19T12:00:00.000Z",
        lastActivityAt: "2026-07-19T12:01:00.000Z",
        messageCount: 2,
        userMessageCount: 1,
        nativeSessionCount: 1,
        current: true
      },
      {
        id: previousId,
        title: "Previous conversation",
        createdAt: "2026-07-18T10:00:00.000Z",
        lastActivityAt: "2026-07-18T10:02:00.000Z",
        messageCount: 4,
        userMessageCount: 2,
        nativeSessionCount: 1,
        current: false
      }
    ];
    const loadMainConversations = vi.fn(async (options?: { includeArchived?: boolean }) => (
      conversations.filter((conversation) => options?.includeArchived || !conversation.archivedAt)
    ));
    const renameMainConversation = vi.fn(async (id: string | null, title: string) => {
      conversations = conversations.map((conversation) => conversation.id === id
        ? { ...conversation, title }
        : conversation);
    });
    const setMainConversationArchived = vi.fn(async (id: string | null, archived: boolean) => {
      conversations = conversations.map((conversation) => {
        if (conversation.id !== id) {
          return conversation;
        }
        if (archived) {
          return { ...conversation, archivedAt: "2026-07-19T13:00:00.000Z" };
        }
        const { archivedAt: _archivedAt, ...active } = conversation;
        return active;
      });
    });
    const deleteMainConversation = vi.fn(async (id: string | null) => {
      conversations = conversations.filter((conversation) => conversation.id !== id);
    });
    const exportMainConversation = vi.fn(async () => "/tmp/main-conversation-export");
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-conversation-management")}
        orchestrator={{} as Orchestrator}
        cwd="/tmp/pct-workspace"
        loadTaskSessions={async () => []}
        loadMainConversations={loadMainConversations}
        renameMainConversation={renameMainConversation}
        setMainConversationArchived={setMainConversationArchived}
        deleteMainConversation={deleteMainConversation}
        exportMainConversation={exportMainConversation}
      />
    );

    try {
      await settleEffects();
      testInput.send(view.stdin, "\x14");
      await waitForFrame(view.lastFrame, "Task sessions");
      testInput.send(view.stdin, "c");
      await waitForFrame(view.lastFrame, "Main conversations");
      testInput.send(view.stdin, "\x1b[B");
      await waitForFrame(view.lastFrame, ">   Previous conversation");

      testInput.send(view.stdin, "r");
      await waitForFrame(view.lastFrame, "rename · Previous conversation · Enter save · Esc cancel");
      testInput.send(
        view.stdin,
        `\x01${"\x1b[3~".repeat(Array.from("Previous conversation").length)}整理后的对话\r`
      );
      await waitForFrame(view.lastFrame, "Renamed · 整理后的对话");
      expect(renameMainConversation).toHaveBeenCalledWith(previousId, "整理后的对话");

      testInput.send(view.stdin, "a");
      await waitForFrame(view.lastFrame, "Archived · 整理后的对话");
      expect(setMainConversationArchived).toHaveBeenCalledWith(previousId, true);
      testInput.send(view.stdin, "h");
      await waitForFrame(view.lastFrame, "Main conversations · archived shown");
      await waitForFrame(view.lastFrame, "Archived conversations shown");
      testInput.send(view.stdin, "\x1b[B");
      await waitForFrame(view.lastFrame, ">   整理后的对话 · archived");
      testInput.send(view.stdin, "a");
      await waitForFrame(view.lastFrame, "Unarchived · 整理后的对话");
      expect(setMainConversationArchived).toHaveBeenLastCalledWith(previousId, false);

      testInput.send(view.stdin, "e");
      await waitForFrame(view.lastFrame, "Exported · /tmp/main-conversation-export");
      expect(exportMainConversation).toHaveBeenCalledWith(previousId);
      testInput.send(view.stdin, "d");
      await waitForFrame(view.lastFrame, "press D again · Esc cancel");
      testInput.send(view.stdin, "d");
      await waitForFrame(view.lastFrame, "Deleted · 整理后的对话");
      expect(deleteMainConversation).toHaveBeenCalledWith(previousId);

      testInput.send(view.stdin, "d");
      await waitForFrame(view.lastFrame, "Restore another Main conversation before deleting the current one");
      expect(deleteMainConversation).toHaveBeenCalledTimes(1);
      expect(loadMainConversations).toHaveBeenCalledWith({ includeArchived: true });
    } finally {
      view.unmount();
      testInput.restore();
    }
  });
});

describe("App empty worker shortcuts", () => {
  it("exports a sanitized diagnostics bundle with Ctrl+X", async () => {
    const testInput = installTestInputStream();
    const exportDiagnostics = vi.fn(async () => "/tmp/pct-workspace/.parallel-codex/diagnostics/bundle");
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-diagnostics")}
        orchestrator={{} as Orchestrator}
        cwd="/tmp/pct-workspace"
        exportDiagnostics={exportDiagnostics}
      />
    );

    try {
      await waitForFrame(view.lastFrame, "ready");
      await settleEffects();
      testInput.send(view.stdin, "\x18");
      await waitForFrame(view.lastFrame, "diagnostics exported");

      expect(exportDiagnostics).toHaveBeenCalledOnce();
      expect(view.lastFrame()).toContain("/diagnostics/bundle");
    } finally {
      view.unmount();
      testInput.restore();
    }
  });

  it("copies the visible chat with Ctrl+Y while mouse scrolling stays configured", async () => {
    const testInput = installTestInputStream();
    const copyToClipboard = vi.fn(async () => {});
    const view = render(
      <App
        config={defaultConfig("/tmp/pct-app-copy")}
        orchestrator={{} as Orchestrator}
        cwd="/tmp/pct-workspace"
        initialMessages={[{ from: "system", text: "visible clipboard target" }]}
        copyToClipboard={copyToClipboard}
      />
    );

    try {
      await waitForFrame(view.lastFrame, "visible clipboard target");
      await settleEffects();
      testInput.send(view.stdin, "\x19");
      await waitForFrame(view.lastFrame, "copied visible chat");

      expect(copyToClipboard).toHaveBeenCalledOnce();
      expect(copyToClipboard).toHaveBeenCalledWith(expect.stringContaining("visible clipboard target"));
    } finally {
      view.unmount();
      testInput.restore();
    }
  });

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
