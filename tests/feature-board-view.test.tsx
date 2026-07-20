import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { CollaborationTimeline } from "../src/core/collaboration-timeline.js";
import { displayWidth } from "../src/tui/display-width.js";
import * as boardModule from "../src/tui/FeatureBoardView.js";

describe("FeatureBoardView", () => {
  it("summarizes feature progress, review debt, and unresolved dependencies", () => {
    const FeatureBoardView = (
      boardModule as typeof boardModule & {
        FeatureBoardView?: React.ComponentType<Record<string, unknown>>;
      }
    ).FeatureBoardView;

    expect(FeatureBoardView).toBeTypeOf("function");
    const view = render(React.createElement(FeatureBoardView!, {
      timeline: fixture(),
      selectedIndex: 1,
      notice: "Cancel Game UI? Active peers will finish; integration stays blocked.",
      height: 10,
      terminalWidth: 100
    }));
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("Feature board");
    expect(frame).toContain("3 features · 1 approved · 1 active · 1 revision · 1 blocked");
    expect(frame).toContain("T0001 · Game Engine · revision pending · 1 open finding");
    expect(frame).toContain("> T0001 · Game UI · actor running · blocked by Game Engine");
    expect(frame).toContain("deps Game Engine");
    expect(frame).toContain("finding · Board collision remains");
    expect(frame).toContain("Cancel Game UI? Active peers will finish; integration stays blocked.");
    view.unmount();
  });

  it("moves selection deterministically and keeps selected features visible", () => {
    const moveSelection = (
      boardModule as typeof boardModule & {
        moveFeatureBoardSelection?: (
          current: number,
          delta: number,
          count: number,
          wrap?: boolean
        ) => number;
      }
    ).moveFeatureBoardSelection;
    const displayLines = (
      boardModule as typeof boardModule & {
        featureBoardDisplayLines?: (
          timeline: CollaborationTimeline,
          selectedIndex: number,
          height: number,
          terminalWidth: number
        ) => Array<{ text: string; featureIndex?: number }>;
      }
    ).featureBoardDisplayLines;

    expect(moveSelection).toBeTypeOf("function");
    expect(moveSelection?.(0, -1, 3)).toBe(0);
    expect(moveSelection?.(0, -1, 3, true)).toBe(2);
    expect(moveSelection?.(2, 1, 3, true)).toBe(0);
    expect(displayLines).toBeTypeOf("function");

    const many = fixture();
    many.features = Array.from({ length: 8 }, (_, index) => ({
      ...many.features[2]!,
      id: `0001-feature-${index}`,
      title: `Feature ${index}`
    }));
    const visible = displayLines?.(many, 7, 5, 80) ?? [];
    expect(visible.some((line) => line.featureIndex === 7 && line.text.startsWith("> "))).toBe(true);
    expect(visible.some((line) => line.featureIndex === 0)).toBe(false);
  });

  it("distinguishes queued and completed workers from active feature runs", () => {
    const displayLines = (
      boardModule as typeof boardModule & {
        featureBoardDisplayLines?: (
          timeline: CollaborationTimeline,
          selectedIndex: number,
          height: number,
          terminalWidth: number
        ) => Array<{ text: string }>;
      }
    ).featureBoardDisplayLines;
    const timeline = fixture();
    timeline.features[0]!.state = "queued";
    timeline.features[1]!.state = "paused";
    timeline.features[2]!.state = "critic_running";

    const text = (displayLines?.(timeline, 0, 10, 100) ?? []).map((line) => line.text).join("\n");

    expect(text).toContain("3 features · 1 active · 1 paused");
    expect(text).toContain("Game Engine · queued");
    expect(text).toContain("Game UI · paused");
    expect(text).toContain("Game Help · critic running");
  });

  it("shows each Feature's persisted Actor and Critic engines", () => {
    const displayLines = (
      boardModule as typeof boardModule & {
        featureBoardDisplayLines?: (
          timeline: CollaborationTimeline,
          selectedIndex: number,
          height: number,
          terminalWidth: number
        ) => Array<{ text: string }>;
      }
    ).featureBoardDisplayLines;
    const timeline = fixture();
    timeline.features[1]!.actorEngine = "codex";
    timeline.features[1]!.criticEngine = "claude";

    const text = (displayLines?.(timeline, 1, 10, 120) ?? []).map((line) => line.text).join("\n");

    expect(text).toContain("actor codex/default · critic claude/default");
  });

  it("keeps every rendered row inside narrow terminal widths", () => {
    const displayLines = (
      boardModule as typeof boardModule & {
        featureBoardDisplayLines?: (
          timeline: CollaborationTimeline,
          selectedIndex: number,
          height: number,
          terminalWidth: number
        ) => Array<{ text: string }>;
      }
    ).featureBoardDisplayLines;
    const overflow: string[] = [];

    expect(displayLines).toBeTypeOf("function");
    for (let width = 8; width <= 100; width += 1) {
      for (const line of displayLines?.(fixture(), 1, 10, width, {
        notice: "Cancel Game UI? Active peers will finish; integration stays blocked."
      }) ?? []) {
        if (displayWidth(line.text) > Math.max(1, width - 2)) {
          overflow.push(`${width}:${displayWidth(line.text)}:${line.text}`);
        }
      }
    }
    expect(overflow).toEqual([]);
  });
});

function fixture(): CollaborationTimeline {
  return {
    taskId: "task-feature-board",
    features: [
      {
        id: "0001-engine",
        title: "Game Engine",
        description: "Implement game rules",
        dependsOn: [],
        turnId: "0001",
        state: "revision_needed",
        updatedAt: "2026-07-11T08:00:00.000Z",
        findings: 2,
        replies: 2,
        resolvedFindings: 1,
        unresolvedFindings: 1,
        latestFinding: "Board collision remains",
        artifactRefs: []
      },
      {
        id: "0001-ui",
        title: "Game UI",
        description: "Render board and controls",
        dependsOn: ["engine"],
        turnId: "0001",
        state: "actor_running",
        updatedAt: "2026-07-11T08:01:00.000Z",
        findings: 0,
        replies: 0,
        artifactRefs: []
      },
      {
        id: "0001-docs",
        title: "Game Help",
        description: "Document controls",
        dependsOn: [],
        turnId: "0001",
        state: "approved",
        updatedAt: "2026-07-11T08:02:00.000Z",
        findings: 1,
        replies: 1,
        latestReply: "Controls documented",
        artifactRefs: []
      }
    ],
    events: []
  };
}
