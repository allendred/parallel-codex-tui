import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { CollaborationTimeline } from "../src/core/collaboration-timeline.js";
import { displayWidth } from "../src/tui/display-width.js";
import * as timelineModule from "../src/tui/CollaborationTimelineView.js";

describe("CollaborationTimelineView", () => {
  it("renders a live all-feature timeline with role, revision, mailbox, and Wave evidence", () => {
    const CollaborationTimelineView = (
      timelineModule as typeof timelineModule & {
        CollaborationTimelineView?: React.ComponentType<Record<string, unknown>>;
      }
    ).CollaborationTimelineView;

    expect(CollaborationTimelineView).toBeTypeOf("function");
    const view = render(React.createElement(CollaborationTimelineView!, {
      timeline: fixture(),
      featureIndex: -1,
      height: 14,
      terminalWidth: 90
    }));
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("Collaboration timeline");
    expect(frame).toContain("all · 2 features · approved 1 · revision 1 · 6 events");
    expect(frame).toContain("Critic · Game UI");
    expect(frame).toContain("revision requested · Fix alignment · 1 finding · 1 reply");
    expect(frame).toContain("Supervisor · Wave");
    expect(frame).toContain("wave reviewed · Wave 1/1 Critic decision: revision");
    expect(frame).toContain("feature approved");
    view.unmount();
  });

  it("filters by feature and cycles all/feature scopes deterministically", () => {
    const CollaborationTimelineView = (
      timelineModule as typeof timelineModule & {
        CollaborationTimelineView?: React.ComponentType<Record<string, unknown>>;
        nextCollaborationFeatureIndex?: (current: number, delta: number, featureCount: number) => number;
      }
    ).CollaborationTimelineView;
    const nextFeature = (
      timelineModule as typeof timelineModule & {
        nextCollaborationFeatureIndex?: (current: number, delta: number, featureCount: number) => number;
      }
    ).nextCollaborationFeatureIndex;

    expect(nextFeature).toBeTypeOf("function");
    expect(nextFeature?.(-1, 1, 2)).toBe(0);
    expect(nextFeature?.(0, 1, 2)).toBe(1);
    expect(nextFeature?.(1, 1, 2)).toBe(-1);
    expect(nextFeature?.(-1, -1, 2)).toBe(1);

    const view = render(React.createElement(CollaborationTimelineView!, {
      timeline: fixture(),
      featureIndex: 1,
      height: 14,
      terminalWidth: 90
    }));
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Game UI · approved · 3 events · 1 finding · 1 reply");
    expect(frame).not.toContain("Game Engine · revision pending");
    view.unmount();
  });

  it("selects events and filters the timeline to unresolved feature evidence", () => {
    const eventsForScope = (
      timelineModule as typeof timelineModule & {
        collaborationTimelineEvents?: (
          timeline: CollaborationTimeline,
          featureIndex: number,
          unresolvedOnly: boolean
        ) => CollaborationTimeline["events"];
      }
    ).collaborationTimelineEvents;
    const moveSelection = (
      timelineModule as typeof timelineModule & {
        moveCollaborationEventSelection?: (
          events: CollaborationTimeline["events"],
          selectedEventId: string | null,
          delta: number
        ) => string | null;
      }
    ).moveCollaborationEventSelection;
    const selectionOffset = (
      timelineModule as typeof timelineModule & {
        collaborationSelectionScrollOffset?: (
          events: CollaborationTimeline["events"],
          selectedEventId: string | null,
          terminalWidth: number
        ) => number;
      }
    ).collaborationSelectionScrollOffset;

    expect(eventsForScope).toBeTypeOf("function");
    expect(moveSelection).toBeTypeOf("function");
    expect(selectionOffset).toBeTypeOf("function");
    const unresolved = eventsForScope?.(fixture(), -1, true) ?? [];
    expect(unresolved.map((event) => event.id)).toEqual([
      "07:00-feature.created",
      "07:01-actor.completed",
      "07:03-feature.wave_reviewed",
      "07:04-feature.state"
    ]);
    expect(eventsForScope?.(fixture(), 1, true)).toEqual([]);
    expect(moveSelection?.(fixture().events, null, -1)).toBe("07:04-feature.state");
    expect(moveSelection?.(fixture().events, "07:04-feature.state", 1)).toBeNull();
    expect(selectionOffset?.(fixture().events, "07:01-actor.completed", 90)).toBe(8);
    expect(selectionOffset?.(fixture().events, "07:01-actor.completed", 20)).toBe(4);
    expect(selectionOffset?.(fixture().events, null, 90)).toBe(0);

    const view = render(React.createElement(timelineModule.CollaborationTimelineView, {
      timeline: fixture(),
      featureIndex: -1,
      unresolvedOnly: true,
      selectedEventId: "07:01-actor.completed",
      height: 14,
      terminalWidth: 90
    }));
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("unresolved · 4 events");
    expect(frame).toContain("> 07:01:00 · T0001 · Actor · Game Engine");
    expect(frame).not.toContain("feature approved");
    view.unmount();

    const emptyView = render(React.createElement(timelineModule.CollaborationTimelineView, {
      timeline: fixture(),
      featureIndex: 1,
      unresolvedOnly: true,
      height: 8,
      terminalWidth: 90
    }));
    expect(emptyView.lastFrame()).toContain("no unresolved collaboration events in this scope");
    emptyView.unmount();
  });

  it("renders the selected event's complete evidence and artifact paths in detail mode", () => {
    const view = render(React.createElement(timelineModule.CollaborationTimelineView, {
      timeline: fixture(),
      featureIndex: -1,
      selectedEventId: "07:02-critic.revision_requested",
      detailOpen: true,
      height: 18,
      terminalWidth: 100
    }));
    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Collaboration event");
    expect(frame).toContain("revision requested");
    expect(frame).toContain("message · Fix alignment");
    expect(frame).toContain("artifact · critic findings");
    expect(frame).toContain("/tmp/task/features/0001-ui/critic-findings.jsonl");
    view.unmount();
  });

  it("keeps every generated timeline row inside narrow terminal widths", () => {
    const displayLines = (
      timelineModule as typeof timelineModule & {
        collaborationTimelineDisplayLines?: (
          timeline: CollaborationTimeline,
          featureIndex: number,
          terminalWidth: number,
          options?: {
            selectedEventId?: string | null;
            detailOpen?: boolean;
            unresolvedOnly?: boolean;
          }
        ) => Array<{ text: string }>;
      }
    ).collaborationTimelineDisplayLines;
    expect(displayLines).toBeTypeOf("function");

    const overflow: string[] = [];
    for (let width = 8; width <= 100; width += 1) {
      for (const line of [
        ...(displayLines?.(fixture(), -1, width) ?? []),
        ...(displayLines?.(fixture(), -1, width, {
          selectedEventId: "07:02-critic.revision_requested",
          detailOpen: true
        }) ?? [])
      ]) {
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
    taskId: "task-20260711-070000-timeline",
    features: [
      {
        id: "0001-engine",
        title: "Game Engine",
        turnId: "0001",
        state: "revision_needed",
        updatedAt: "2026-07-11T07:04:00.000Z",
        findings: 0,
        replies: 0,
        artifactRefs: []
      },
      {
        id: "0001-ui",
        title: "Game UI",
        turnId: "0001",
        state: "approved",
        updatedAt: "2026-07-11T07:05:00.000Z",
        findings: 1,
        replies: 1,
        artifactRefs: []
      }
    ],
    events: [
      event("07:00", "feature.created", "actor", "mailbox created", "Mailbox ready", "0001-engine", "Game Engine"),
      event("07:01", "actor.completed", "actor", "implementation completed", "Engine ready", "0001-engine", "Game Engine"),
      event(
        "07:02",
        "critic.revision_requested",
        "critic",
        "revision requested",
        "Fix alignment",
        "0001-ui",
        "Game UI",
        1,
        1,
        [{ label: "critic findings", path: "/tmp/task/features/0001-ui/critic-findings.jsonl" }]
      ),
      event("07:03", "feature.wave_reviewed", "supervisor", "wave reviewed", "Wave 1/1 Critic decision: revision"),
      event("07:04", "feature.state", "supervisor", "revision pending", "Game Engine · revision needed", "0001-engine", "Game Engine"),
      event("07:05", "feature.state", "supervisor", "feature approved", "Game UI · approved", "0001-ui", "Game UI", 1, 1)
    ]
  };
}

function event(
  hhmm: string,
  type: string,
  role: "actor" | "critic" | "supervisor",
  action: string,
  message: string,
  featureId?: string,
  featureTitle?: string,
  findings = 0,
  replies = 0,
  artifactRefs: Array<{ label: string; path: string }> = []
) {
  return {
    id: `${hhmm}-${type}`,
    time: `2026-07-11T${hhmm}:00.000Z`,
    type,
    role,
    action,
    message,
    ...(featureId ? { featureId, turnId: "0001" } : {}),
    ...(featureTitle ? { featureTitle } : {}),
    findings,
    replies,
    artifacts: artifactRefs.map((artifact) => artifact.label),
    artifactRefs
  };
}
