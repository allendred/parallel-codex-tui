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
          terminalWidth: number,
          activity?: {
            nowMs: number;
            policies: Record<string, { timeoutMs?: number; idleTimeoutMs?: number; firstOutputTimeoutMs?: number }>;
          }
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
      for (const line of displayLines?.(manyWorkers, 13, 6, width, activityOptions()) ?? []) {
        if (displayWidth(line.text) > Math.max(1, width - 2)) {
          overflow.push(`${width}:${displayWidth(line.text)}:${line.text}`);
        }
      }
    }

    const visible = displayLines?.(manyWorkers, 13, 6, 80, activityOptions()) ?? [];
    expect(overflow).toEqual([]);
    expect(visible.some((line) => line.workerIndex === 13 && line.text.startsWith("> "))).toBe(true);
    expect(visible.some((line) => line.workerIndex === 0)).toBe(false);
  });

  it("turns Worker heartbeat timestamps into live first-output and idle deadlines", () => {
    const activityLine = (
      overviewModule as typeof overviewModule & {
        workerOverviewActivityLine?: (
          worker: WorkerLogRef,
          nowMs: number,
          policy: { timeoutMs?: number; idleTimeoutMs?: number; firstOutputTimeoutMs?: number }
        ) => { text: string; tone: string } | null;
      }
    ).workerOverviewActivityLine;

    expect(activityLine).toBeTypeOf("function");
    expect(activityLine?.(
      worker({
        id: "healthy",
        label: "Actor (codex)",
        state: "running",
        phase: "process-output",
        summary: "working"
      }),
      Date.parse("2026-07-11T08:01:00.000Z"),
      { idleTimeoutMs: 5 * 60 * 1000 }
    )).toEqual({
      text: "activity · output 1m ago · idle timeout in 4m",
      tone: "muted"
    });
    expect(activityLine?.(
      worker({
        id: "running",
        label: "Actor (codex)",
        state: "running",
        phase: "process-output",
        summary: "still working"
      }),
      Date.parse("2026-07-11T08:04:10.000Z"),
      { idleTimeoutMs: 5 * 60 * 1000 }
    )).toEqual({
      text: "activity · output 4m 10s ago · idle timeout in 50s",
      tone: "warning"
    });
    expect(activityLine?.(
      worker({
        id: "total-before-first-output",
        label: "Critic (codex)",
        role: "critic",
        state: "starting",
        phase: "process-starting",
        summary: "starting"
      }),
      Date.parse("2026-07-11T08:00:45.000Z"),
      { timeoutMs: 60_000, firstOutputTimeoutMs: 2 * 60 * 1000 }
    )).toEqual({
      text: "activity · started 45s ago · no first output timeout",
      tone: "muted"
    });
    expect(activityLine?.(
      worker({
        id: "starting",
        label: "Critic (codex)",
        role: "critic",
        state: "starting",
        phase: "process-starting",
        summary: "starting"
      }),
      Date.parse("2026-07-11T08:01:45.000Z"),
      { firstOutputTimeoutMs: 2 * 60 * 1000 }
    )).toEqual({
      text: "activity · started 1m 45s ago · first output timeout in 15s",
      tone: "warning"
    });
    expect(activityLine?.(
      worker({
        id: "overdue",
        label: "Actor (codex)",
        state: "running",
        phase: "process-output",
        summary: "quiet"
      }),
      Date.parse("2026-07-11T08:05:05.000Z"),
      { idleTimeoutMs: 5 * 60 * 1000 }
    )).toEqual({
      text: "activity · no output for 5m 5s · idle timeout overdue 5s",
      tone: "danger"
    });
    expect(activityLine?.(
      worker({
        id: "stopping",
        label: "Actor (codex)",
        state: "running",
        phase: "process-stopping",
        summary: "stopping process tree"
      }),
      Date.parse("2026-07-11T08:00:02.000Z"),
      { idleTimeoutMs: 5 * 60 * 1000 }
    )).toEqual({
      text: "activity · stopping process tree · 2s elapsed",
      tone: "warning"
    });
    expect(activityLine?.(workers()[0]!, Date.parse("2026-07-11T08:10:00.000Z"), {
      idleTimeoutMs: 5 * 60 * 1000
    })).toBeNull();
  });

  it("shows activity only for the selected active Worker", () => {
    const WorkerOverviewView = (
      overviewModule as typeof overviewModule & {
        WorkerOverviewView?: React.ComponentType<Record<string, unknown>>;
      }
    ).WorkerOverviewView;
    const view = render(React.createElement(WorkerOverviewView!, {
      workers: workers(),
      selectedIndex: 1,
      height: 8,
      terminalWidth: 100,
      nowMs: Date.parse("2026-07-11T08:04:10.000Z"),
      activityPolicies: activityOptions().policies
    }));
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("> Actor (codex) · Build board");
    expect(frame).toContain("activity · output 4m 10s ago · idle timeout in 50s");
    expect(frame.match(/activity ·/g)).toHaveLength(1);
    view.unmount();
  });
});

function activityOptions() {
  return {
    nowMs: Date.parse("2026-07-11T08:04:10.000Z"),
    policies: {
      codex: { idleTimeoutMs: 5 * 60 * 1000, firstOutputTimeoutMs: 2 * 60 * 1000 },
      claude: { idleTimeoutMs: 5 * 60 * 1000, firstOutputTimeoutMs: 2 * 60 * 1000 },
      mock: {}
    }
  };
}

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
