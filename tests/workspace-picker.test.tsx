import React from "react";
import { EventEmitter } from "node:events";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { WorkspacePicker } from "../src/cli-workspace-picker.js";

describe("WorkspacePicker", () => {
  it("locks input and shows progress after a workspace selection is submitted", async () => {
    const testInput = installTestInputStream();
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    const view = render(
      <WorkspacePicker
        cwd="/tmp/current"
        choices={[{
          path: "/tmp/next-project",
          exists: true,
          lastUsedAt: "2026-07-12T00:00:00.000Z"
        }]}
        terminalHeight={12}
        terminalWidth={80}
        onCancel={onCancel}
        onSelect={onSelect}
      />
    );

    try {
      expect(view.lastFrame()).toContain("Open project");
      await nextRender();
      testInput.send(view.stdin, "\r");
      await nextRender();
      expect(onSelect).toHaveBeenCalledTimes(1);
      testInput.send(view.stdin, "\x1b");
      testInput.send(view.stdin, "\r");
      await nextRender();

      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith("/tmp/next-project");
      expect(onCancel).not.toHaveBeenCalled();
      expect(view.lastFrame()).toContain("Opening project");
      expect(view.lastFrame()).toContain("opening next-project");
    } finally {
      view.unmount();
      testInput.restore();
    }
  });

  it("locks a newly entered workspace path after submission", async () => {
    const testInput = installTestInputStream();
    const onCancel = vi.fn();
    const onSelect = vi.fn();
    const view = render(
      <WorkspacePicker
        cwd="/tmp/current"
        choices={[]}
        terminalHeight={10}
        terminalWidth={60}
        onCancel={onCancel}
        onSelect={onSelect}
      />
    );

    try {
      await nextRender();
      testInput.send(view.stdin, "/tmp/中文项目");
      await nextRender();
      testInput.send(view.stdin, "\r");
      await nextRender();
      testInput.send(view.stdin, "\x1b");
      await nextRender();

      expect(onSelect).toHaveBeenCalledOnce();
      expect(onSelect).toHaveBeenCalledWith("/tmp/中文项目");
      expect(onCancel).not.toHaveBeenCalled();
      expect(view.lastFrame()).toContain("Opening project");
      expect(view.lastFrame()).toContain("opening 中文项目");
      expect(view.lastFrame()).not.toContain("|");
    } finally {
      view.unmount();
      testInput.restore();
    }
  });
});

async function nextRender(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
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
