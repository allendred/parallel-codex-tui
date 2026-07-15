import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { TaskSessionDetails } from "../src/core/task-session-details.js";
import { displayWidth } from "../src/tui/display-width.js";
import * as detailModule from "../src/tui/TaskSessionDetailView.js";

describe("TaskSessionDetailView", () => {
  it("renders Project, Task, Turn, Worker, model, and Native session hierarchy", () => {
    const view = render(<detailModule.TaskSessionDetailView
      details={fixture()}
      selectedWorkerIndex={1}
      height={12}
      terminalWidth={140}
    />);
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("Session hierarchy");
    expect(frame).toContain("project · tetris · /Volumes/111/tetris");
    expect(frame).toContain("task · Build Tetris · failed · 2 turns · 2 workers");
    expect(frame).toContain("Turn 1 · 07-15 01:00 · Build the board");
    expect(frame).toContain("Actor · codex/gpt-5.4 · Board · done");
    expect(frame).toContain("native · 019f-actor · cwd /Volumes/111/tetris/.workers/actor");
    expect(frame).toContain("> Critic · claude/sonnet · failed");
    view.unmount();
  });

  it("keeps the selected older or newer Worker visible and every row bounded", () => {
    const overflow: string[] = [];
    for (let width = 8; width <= 140; width += 1) {
      for (const line of detailModule.taskSessionDetailDisplayLines(fixture(), 1, 8, width)) {
        if (displayWidth(line.text) > Math.max(1, width - 2)) {
          overflow.push(`${width}:${displayWidth(line.text)}:${line.text}`);
        }
      }
    }
    expect(overflow).toEqual([]);
    expect(
      detailModule.taskSessionDetailDisplayLines(fixture(), 1, 7, 80)
        .some((line) => line.workerIndex === 1 && line.kind === "worker" && line.text.startsWith("> "))
    ).toBe(true);
    expect(detailModule.moveTaskSessionDetailSelection(1, 1, 2, true)).toBe(0);
  });

  it("keeps a selected Worker visible when one Turn contains more rows than the viewport", () => {
    const details = fixture();
    const template = details.workers[0]!;
    const workers = Array.from({ length: 12 }, (_, index) => ({
      ...template,
      id: `actor-codex-0001-feature-${index}`,
      featureId: `0001-feature-${index}`,
      featureTitle: `Feature ${index}`
    }));
    details.workers = workers;
    details.turns = [{
      turnId: "0001",
      createdAt: "2026-07-15T01:00:00.000Z",
      request: "Build many features",
      workers
    }];

    const lines = detailModule.taskSessionDetailDisplayLines(details, 11, 8, 100);

    expect(lines.some((line) => (
      line.kind === "worker"
      && line.workerIndex === 11
      && line.text.startsWith("> ")
    ))).toBe(true);
  });
});

function fixture(): TaskSessionDetails {
  const actor: TaskSessionDetails["workers"][number] = {
    id: "actor-codex-0001-board",
    turnId: "0001",
    featureId: "0001-board",
    featureTitle: "Board",
    role: "actor",
    engine: "codex",
    model: "gpt-5.4",
    state: "done",
    phase: "completed",
    summary: "Board built",
    lastActivityAt: "2026-07-15T01:10:00.000Z",
    dir: "/Volumes/111/tetris/.workers/actor",
    statusPath: "/Volumes/111/tetris/.workers/actor/status.json",
    outputLogPath: "/Volumes/111/tetris/.workers/actor/output.log",
    nativeSession: {
      sessionId: "019f-actor",
      cwd: "/Volumes/111/tetris/.workers/actor",
      writableDirs: [],
      createdAt: "2026-07-15T01:01:00.000Z",
      lastUsedAt: "2026-07-15T01:10:00.000Z",
      source: "manual"
    }
  };
  const critic: TaskSessionDetails["workers"][number] = {
    id: "critic-claude-0002",
    turnId: "0002",
    role: "critic",
    engine: "claude",
    model: "sonnet",
    state: "failed",
    phase: "review",
    summary: "Controls need work",
    lastActivityAt: "2026-07-15T02:10:00.000Z",
    dir: "/Volumes/111/tetris/.workers/critic",
    statusPath: "/Volumes/111/tetris/.workers/critic/status.json",
    outputLogPath: "/Volumes/111/tetris/.workers/critic/output.log",
    nativeSession: {
      sessionId: "019f-critic",
      cwd: "/Volumes/111/tetris/.workers/critic",
      writableDirs: [],
      createdAt: "2026-07-15T02:01:00.000Z",
      lastUsedAt: "2026-07-15T02:10:00.000Z",
      source: "manual"
    }
  };
  return {
    task: {
      id: "task-detail",
      title: "Build Tetris",
      created_at: "2026-07-15T01:00:00.000Z",
      cwd: "/Volumes/111/tetris",
      mode: "complex",
      status: "failed",
      turnCount: 2,
      workerCount: 2,
      nativeSessionCount: 2
    },
    projectName: "tetris",
    projectPath: "/Volumes/111/tetris",
    turns: [
      {
        turnId: "0001",
        createdAt: "2026-07-15T01:00:00.000Z",
        request: "Build the board",
        workers: [actor]
      },
      {
        turnId: "0002",
        createdAt: "2026-07-15T02:00:00.000Z",
        request: "Review controls",
        workers: [critic]
      }
    ],
    workers: [actor, critic]
  } satisfies TaskSessionDetails;
}
