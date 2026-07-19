import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { MainConversationSummary } from "../src/core/session-manager.js";
import {
  mainConversationsDisplayLines,
  MainConversationsView,
  moveMainConversationSelection
} from "../src/tui/MainConversationsView.js";
import { displayWidth } from "../src/tui/display-width.js";

describe("MainConversationsView", () => {
  it("renders current, historical, and legacy conversations with stable metadata", () => {
    const view = render(
      <MainConversationsView
        conversations={conversations()}
        selectedIndex={1}
        height={8}
        terminalWidth={100}
      />
    );
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("Main conversations");
    expect(frame).toContain("3 conversations · 8 messages · 2 native");
    expect(frame).toContain("  * Current work · 2 messages · 1 native · 07-19 12:00");
    expect(frame).toContain(">   Previous design · 5 messages · 1 native · 07-18 10:00");
    expect(frame).toContain("legacy notes · 1 message · 0 native");
  });

  it("keeps narrow rows within the terminal width", () => {
    for (const width of [12, 20, 32, 52]) {
      const lines = mainConversationsDisplayLines(conversations(), 1, 7, width);
      expect(lines.every((line) => displayWidth(line.text) <= Math.max(1, width - 2))).toBe(true);
    }
  });

  it("moves and wraps selection without leaving the list", () => {
    expect(moveMainConversationSelection(0, -1, 3)).toBe(0);
    expect(moveMainConversationSelection(2, 1, 3)).toBe(2);
    expect(moveMainConversationSelection(2, 1, 3, true)).toBe(0);
    expect(moveMainConversationSelection(0, -1, 3, true)).toBe(2);
    expect(moveMainConversationSelection(4, 1, 0, true)).toBe(0);
  });
});

function conversations(): MainConversationSummary[] {
  return [
    {
      id: "conversation-20260719-120000-current",
      title: "Current work",
      createdAt: "2026-07-19T12:00:00.000Z",
      lastActivityAt: "2026-07-19T12:00:00.000Z",
      messageCount: 2,
      userMessageCount: 1,
      nativeSessionCount: 1,
      current: true
    },
    {
      id: "conversation-20260718-100000-previous",
      title: "Previous design",
      createdAt: "2026-07-18T09:00:00.000Z",
      lastActivityAt: "2026-07-18T10:00:00.000Z",
      messageCount: 5,
      userMessageCount: 3,
      nativeSessionCount: 1,
      current: false
    },
    {
      id: null,
      title: "legacy notes",
      createdAt: "2026-07-10T08:00:00.000Z",
      lastActivityAt: "2026-07-10T08:00:00.000Z",
      messageCount: 1,
      userMessageCount: 1,
      nativeSessionCount: 0,
      current: false
    }
  ];
}
