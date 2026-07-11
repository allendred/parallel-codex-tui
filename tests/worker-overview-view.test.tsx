import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { WorkerLogRef } from "../src/orchestrator/orchestrator.js";
import { displayWidth } from "../src/tui/display-width.js";
import * as overviewModule from "../src/tui/WorkerOverviewView.js";

describe("WorkerOverviewView", () => {
  it("summarizes every worker and keeps the selected role obvious", () => {
    const WorkerOverviewView = (
      overviewModule as typeof overviewModule & {
        WorkerOverviewView?: React.ComponentType<Record<string, unknown>>;
      }
    ).WorkerOverviewView;

    expect(WorkerOverviewView).toBeTypeOf("function");
    const view = render(React.createElement(WorkerOverviewView!, {
      workers: workers(),
      selectedIndex: 2,
      height: 8,
      terminalWidth: 100
    }));
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("Workers");
    expect(frame).toContain("4 workers · 1 running · 1 done · 1 failed · 1 waiting · 2 sessions");
    expect(frame).toContain("Actor (codex) · Build board");
    expect(frame).toContain("> Critic (claude) · Review routing");
    expect(frame).toContain("failed · review · session · Needs revision");
    view.unmount();
  });

  it("keeps all rows inside narrow terminals and scrolls the selection into view", () => {
    const displayLines = (
      overviewModule as typeof overviewModule & {
        workerOverviewDisplayLines?: (
          workers: WorkerLogRef[],
          selectedIndex: number,
          height: number,
          terminalWidth: number
        ) => Array<{ text: string; workerIndex?: number }>;
      }
    ).workerOverviewDisplayLines;

    expect(displayLines).toBeTypeOf("function");
    const manyWorkers = Array.from({ length: 14 }, (_, index) => worker({
      id: `actor-${index}`,
      label: `Actor (codex) · Feature ${String(index).padStart(2, "0")}`,
      state: index === 13 ? "running" : "done",
      phase: "implementation",
      summary: `Completed feature ${index}`
    }));
    const overflow: string[] = [];

    for (let width = 8; width <= 100; width += 1) {
      for (const line of displayLines?.(manyWorkers, 13, 6, width) ?? []) {
        if (displayWidth(line.text) > Math.max(1, width - 2)) {
          overflow.push(`${width}:${displayWidth(line.text)}:${line.text}`);
        }
      }
    }

    const visible = displayLines?.(manyWorkers, 13, 6, 80) ?? [];
    expect(overflow).toEqual([]);
    expect(visible.some((line) => line.workerIndex === 13 && line.text.startsWith("> "))).toBe(true);
    expect(visible.some((line) => line.workerIndex === 0)).toBe(false);
  });
});

function workers(): WorkerLogRef[] {
  return [
    worker({
      id: "judge",
      label: "Judge (codex)",
      state: "done",
      phase: "requirements",
      summary: "Plan ready",
      sessionId: "judge-session"
    }),
    worker({
      id: "actor",
      label: "Actor (codex) · Build board",
      state: "running",
      phase: "implementation",
      summary: "Editing controls"
    }),
    worker({
      id: "critic",
      label: "Critic (claude) · Review routing",
      role: "critic",
      engine: "claude",
      state: "failed",
      phase: "review",
      summary: "Needs revision",
      sessionId: "critic-session"
    }),
    worker({
      id: "actor-waiting",
      label: "Actor (codex) · Follow-up",
      state: "waiting",
      phase: "dependencies",
      summary: "Waiting for feature 1"
    })
  ];
}

function worker(input: {
  id: string;
  label: string;
  role?: "judge" | "actor" | "critic" | "main";
  engine?: "codex" | "claude" | "mock";
  state: "idle" | "starting" | "running" | "waiting" | "done" | "failed" | "cancelled";
  phase: string;
  summary: string;
  sessionId?: string;
}): WorkerLogRef {
  const role = input.role ?? (input.id === "judge" ? "judge" : "actor");
  const engine = input.engine ?? "codex";
  return {
    id: input.id,
    role,
    engine,
    label: input.label,
    logPath: `/tmp/${input.id}/output.log`,
    statusPath: `/tmp/${input.id}/status.json`,
    runtimeStatus: {
      worker_id: input.id,
      role,
      engine,
      state: input.state,
      phase: input.phase,
      last_event_at: "2026-07-11T08:00:00.000Z",
      summary: input.summary,
      ...(input.sessionId ? { native_session_id: input.sessionId } : {})
    }
  };
}
