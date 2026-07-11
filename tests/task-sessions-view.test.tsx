import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { TaskIndexSummary } from "../src/core/session-index.js";
import { displayWidth } from "../src/tui/display-width.js";
import * as sessionsModule from "../src/tui/TaskSessionsView.js";

describe("TaskSessionsView", () => {
  it("summarizes persisted tasks and distinguishes selection from the active task", () => {
    const TaskSessionsView = (
      sessionsModule as typeof sessionsModule & {
        TaskSessionsView?: React.ComponentType<Record<string, unknown>>;
      }
    ).TaskSessionsView;

    expect(TaskSessionsView).toBeTypeOf("function");
    const view = render(React.createElement(TaskSessionsView!, {
      tasks: tasks(),
      activeTaskId: "task-repair",
      selectedIndex: 2,
      height: 8,
      terminalWidth: 110
    }));
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("Task sessions");
    expect(frame).toContain("4 tasks · 1 running · 1 done · 1 failed · 1 cancelled");
    expect(frame).toContain("> * Repair routing · failed · 2 turns · 3 workers · 2 native · 07-02 01:00");
    expect(frame).toContain("  Build board · done");
    view.unmount();
  });

  it("keeps every row bounded and brings a selected older task into view", () => {
    const displayLines = (
      sessionsModule as typeof sessionsModule & {
        taskSessionsDisplayLines?: (
          tasks: TaskIndexSummary[],
          activeTaskId: string | null,
          selectedIndex: number,
          height: number,
          terminalWidth: number,
          state?: { loading?: boolean; error?: string | null }
        ) => Array<{ text: string; taskIndex?: number }>;
      }
    ).taskSessionsDisplayLines;

    expect(displayLines).toBeTypeOf("function");
    const many = Array.from({ length: 16 }, (_, index) => task({
      id: `task-${index}`,
      title: `Feature session ${String(index).padStart(2, "0")}`,
      status: index === 15 ? "failed" : "done",
      createdAt: `2026-07-${String(index + 1).padStart(2, "0")}T01:00:00.000Z`
    }));
    const overflow: string[] = [];
    for (let width = 8; width <= 110; width += 1) {
      for (const line of displayLines?.(many, "task-0", 15, 6, width) ?? []) {
        if (displayWidth(line.text) > Math.max(1, width - 2)) {
          overflow.push(`${width}:${displayWidth(line.text)}:${line.text}`);
        }
      }
    }

    const visible = displayLines?.(many, "task-0", 15, 6, 80) ?? [];
    expect(overflow).toEqual([]);
    expect(visible.some((line) => line.taskIndex === 15 && line.text.startsWith("> "))).toBe(true);
    expect(visible.some((line) => line.taskIndex === 0)).toBe(false);
  });
});

function tasks(): TaskIndexSummary[] {
  return [
    task({ id: "task-running", title: "Implement sessions", status: "actor_running", createdAt: "2026-07-04T01:00:00.000Z" }),
    task({ id: "task-board", title: "Build board", status: "done", createdAt: "2026-07-03T01:00:00.000Z" }),
    task({
      id: "task-repair",
      title: "Repair routing",
      status: "failed",
      createdAt: "2026-07-02T01:00:00.000Z",
      turnCount: 2,
      workerCount: 3,
      nativeSessionCount: 2
    }),
    task({ id: "task-cancelled", title: "Cancelled work", status: "cancelled", createdAt: "2026-07-01T01:00:00.000Z" })
  ];
}

function task(input: {
  id: string;
  title: string;
  status: TaskIndexSummary["status"];
  createdAt: string;
  turnCount?: number;
  workerCount?: number;
  nativeSessionCount?: number;
}): TaskIndexSummary {
  return {
    id: input.id,
    title: input.title,
    created_at: input.createdAt,
    cwd: "/tmp/project",
    mode: "complex",
    status: input.status,
    turnCount: input.turnCount ?? 1,
    workerCount: input.workerCount ?? 1,
    nativeSessionCount: input.nativeSessionCount ?? 0
  };
}
