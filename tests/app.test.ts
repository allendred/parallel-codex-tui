import React from "react";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { appContentHeight, chatEmptyStateTheme, chatEmptyStateTrailingFillWidth, chatLineTheme, chatLineTrailingFillWidth, chatMessageDisplayLines, chatViewportBlankLineTheme, ChatView, nativeAttachExitLine, nativeAttachStartingTheme, nativeAttachTerminalColumns, nativeAttachTitleDisplay, nativeTerminalScrollDisplay } from "../src/tui/App.js";
import { displayWidth } from "../src/tui/display-width.js";
import { configureTuiTheme, resetTuiTheme, TUI_THEME_PRESETS } from "../src/tui/theme.js";

afterEach(() => {
  resetTuiTheme();
});

describe("App layout sizing", () => {
  it("budgets content height so shell chrome stays visible in short terminals", () => {
    expect(appContentHeight(24)).toBe(21);
    expect(appContentHeight(24, true)).toBe(20);
    expect(appContentHeight(10)).toBe(7);
    expect(appContentHeight(8)).toBe(5);
    expect(appContentHeight(6)).toBe(3);
  });

  it("returns the status row to content when the status bar is hidden", () => {
    expect(appContentHeight(24, false, false)).toBe(22);
    expect(appContentHeight(24, true, false)).toBe(21);
    expect(appContentHeight(10, false, false)).toBe(8);
  });
});

describe("nativeAttachTitleDisplay", () => {
  it("themes the native attach starting placeholder with the active palette", () => {
    configureTuiTheme({ theme: "paper" });

    expect(nativeAttachStartingTheme()).toEqual({
      backgroundColor: TUI_THEME_PRESETS.paper.surface,
      color: TUI_THEME_PRESETS.paper.muted,
      dimColor: true
    });
  });

  it("sizes the embedded native terminal to the padded content width", () => {
    expect(nativeAttachTerminalColumns(120)).toBe(118);
    expect(nativeAttachTerminalColumns(24)).toBe(22);
    expect(nativeAttachTerminalColumns(1)).toBe(1);
  });

  it("keeps native process exit lines from wrapping in narrow terminals", () => {
    expect(nativeAttachExitLine(7, 40)).toBe("[process exited with code 7]");
    expect(nativeAttachExitLine(7, 18)).toBe("[exit 7]");
    expect(nativeAttachExitLine(7, 6)).toBe("exit:7");
  });

  it("keeps native attach titles readable in roomy terminals", () => {
    expect(nativeAttachTitleDisplay("Actor (mock)", "native-layout", null, 120)).toBe(
      "native actor/mock · native-layout"
    );
    expect(nativeAttachTitleDisplay("Actor (mock)", "native-audit-session-very-long-id", null, 120)).toBe(
      "native actor/mock · native-audit-..."
    );
  });

  it("keeps native attach titles on one compact line in narrow terminals", () => {
    const title = nativeAttachTitleDisplay(
      "Actor (mock)",
      "native-snap-session-long-id",
      null,
      42
    );

    expect(title).toContain("native actor/mock");
    expect(title).toContain("...");
    expect(title).not.toContain("Native attach:");
    expect(title).not.toContain("(");
    expect(title.length).toBeLessThanOrEqual(40);
  });

  it("includes closed process state without forcing a long title", () => {
    expect(nativeAttachTitleDisplay("Critic (codex)", "abcdef1234567890", 2, 36)).toBe("native critic/codex · exit:2");
  });

  it("adds native terminal scroll state to attach titles when scrollback exists", () => {
    expect(nativeTerminalScrollDisplay(0, 80, 120)).toBe("tail");
    expect(nativeTerminalScrollDisplay(12, 80, 120)).toBe("back 12/80");
    expect(nativeTerminalScrollDisplay(80, 80, 120)).toBe("top");
    expect(nativeTerminalScrollDisplay(12, 80, 24)).toBe("12/80");
    expect(nativeTerminalScrollDisplay(0, 0, 120)).toBeNull();
    expect(nativeAttachTitleDisplay("Actor (mock)", "native-layout", null, 120, "tail")).toBe(
      "native actor/mock · native-layout · tail"
    );
    expect(nativeAttachTitleDisplay("Actor (mock)", "native-snap-session-long-id", null, 42, "back 3/40")).toContain("back 3/40");
  });

  it("keeps native attach titles within ultra narrow display width", () => {
    for (const width of [10, 12, 16, 20, 24]) {
      const title = nativeAttachTitleDisplay("Actor (mock)", "native-snap-session-long-id", null, width);
      expect(displayWidth(title)).toBeLessThanOrEqual(Math.max(1, width - 2));
      expect(title).not.toContain("native actor/mock native-snap-session-long-id");
    }
  });

  it("prioritizes native attach exit state in ultra narrow titles", () => {
    expect(nativeAttachTitleDisplay("Critic (codex)", "abcdef1234567890", 2, 10)).toBe("exit:2");
    expect(nativeAttachTitleDisplay("Critic (codex)", "abcdef1234567890", 2, 16)).toBe("critic exit:2");

    for (const width of [10, 12, 16, 20, 24]) {
      const title = nativeAttachTitleDisplay("Critic (codex)", "abcdef1234567890", 2, width);
      expect(title).toContain("exit:2");
      expect(displayWidth(title)).toBeLessThanOrEqual(Math.max(1, width - 2));
    }
  });
});

describe("ChatView", () => {
  it("themes the empty chat state with the active surface", () => {
    configureTuiTheme({ theme: "paper" });

    expect(chatEmptyStateTheme()).toEqual({
      backgroundColor: TUI_THEME_PRESETS.paper.surface,
      bold: true,
      color: TUI_THEME_PRESETS.paper.success
    });
  });

  it("computes themed trailing fill for compact empty chat state rows", () => {
    expect(chatEmptyStateTrailingFillWidth("/workspace/tetris", "task-20260630-093326-1980", 40)).toBe(10);
    expect(chatEmptyStateTrailingFillWidth("/workspace/tetris", null, 40)).toBe(24);
    expect(chatEmptyStateTrailingFillWidth("/tmp/并行编码终端超级长项目名称测试", "task-20260705-中文任务后缀超级长", 24)).toBe(1);
    expect(chatEmptyStateTrailingFillWidth("/workspace/tetris", null, 10)).toBe(2);
  });

  it("themes chat viewport spacer rows with the active surface", () => {
    configureTuiTheme({ theme: "paper" });

    expect(chatViewportBlankLineTheme()).toEqual({
      backgroundColor: TUI_THEME_PRESETS.paper.surface
    });
  });

  it("uses active theme colors for chat message roles", () => {
    configureTuiTheme({ theme: "paper" });

    expect(chatLineTheme({ from: "user", text: "> 你好", continuation: false })).toEqual({
      backgroundColor: TUI_THEME_PRESETS.paper.surface,
      color: TUI_THEME_PRESETS.paper.accent
    });
    expect(chatLineTheme({ from: "system", text: "继续优化中。", continuation: false })).toEqual({
      backgroundColor: TUI_THEME_PRESETS.paper.surface,
      color: TUI_THEME_PRESETS.paper.text
    });
    expect(chatLineTheme({ from: "system", text: "", continuation: false })).toEqual({
      backgroundColor: TUI_THEME_PRESETS.paper.surface,
      color: TUI_THEME_PRESETS.paper.muted,
      dimColor: true
    });
  });

  it("computes themed trailing fill for short chat message rows by display width", () => {
    expect(chatLineTrailingFillWidth({ from: "user", text: "> hi", continuation: false }, 12)).toBe(6);
    expect(chatLineTrailingFillWidth({ from: "system", text: "你好", continuation: false }, 12)).toBe(6);
    expect(chatLineTrailingFillWidth({ from: "system", text: "already wide", continuation: false }, 12)).toBe(0);
    expect(chatLineTrailingFillWidth({ from: "system", text: "", continuation: false }, 12)).toBe(9);
  });

  it("renders a compact empty state instead of startup-log prose", () => {
    const { lastFrame } = render(
      React.createElement(ChatView, {
        messages: [],
        cwd: "/workspace/tetris",
        activeTaskId: "task-20260630-093326-1980"
      })
    );

    const frame = lastFrame() ?? "";

    expect(frame).toContain("ready · tetris · 093326-1980");
    expect(frame).not.toContain("ws · tetris");
    expect(frame).not.toContain("task · 093326-1980");
    expect(frame).not.toContain("Ready");
    expect(frame).not.toContain("workspace tetris");
    expect(frame).not.toContain("task      093326-1980");
    expect(frame).not.toContain("parallel-codex-tui ready");
    expect(frame).not.toContain("workspace:");
    expect(frame).not.toContain("active task:");
  });

  it("bottom-aligns the empty state when a chat viewport height is provided", () => {
    const { lastFrame } = render(
      React.createElement(ChatView, {
        messages: [],
        cwd: "/workspace/tetris",
        activeTaskId: "task-20260630-093326-1980",
        terminalWidth: 40,
        viewportHeight: 6
      })
    );

    const lines = (lastFrame() ?? "").split("\n");

    expect(lines).toHaveLength(6);
    expect(lines.slice(0, 5).every((line) => line.trim() === "")).toBe(true);
    expect(lines[5]).toBe("ready · tetris · 093326-1980");
  });

  it("bottom-aligns real chat messages when a viewport height is provided", () => {
    const { lastFrame } = render(
      React.createElement(ChatView, {
        messages: [
          { from: "user", text: "你好" },
          { from: "system", text: "继续优化中。" }
        ],
        cwd: "/tmp/project",
        activeTaskId: null,
        terminalWidth: 40,
        viewportHeight: 5
      })
    );

    const lines = (lastFrame() ?? "").split("\n");

    expect(lines).toHaveLength(5);
    expect(lines.slice(0, 3).every((line) => line.trim() === "")).toBe(true);
    expect(lines.slice(-2)).toEqual(["> 你好", "继续优化中。"]);
  });

  it("omits the task row in the empty state when no task is active", () => {
    const { lastFrame } = render(
      React.createElement(ChatView, {
        messages: [],
        cwd: "/workspace/tetris",
        activeTaskId: null,
        terminalWidth: 80
      })
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("ready · tetris");
    expect(frame).not.toContain("Ready");
    expect(frame).not.toContain("workspace tetris");
    expect(frame).not.toContain("task");
    expect(frame).not.toContain("none");
  });

  it("keeps no-task empty state minimal in nano terminals", () => {
    const { lastFrame } = render(
      React.createElement(ChatView, {
        messages: [],
        cwd: "/workspace/tetris",
        activeTaskId: null,
        terminalWidth: 12
      })
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("tetris");
    expect(frame).not.toContain("ready");
    expect(frame).not.toContain("ws");
    expect(frame).not.toContain("Ready");
    expect(frame).not.toContain("task");
    expect(frame).not.toContain("none");
    expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(10);
  });

  it("keeps active-task empty state meaningful in nano terminals", () => {
    const twenty = render(
      React.createElement(ChatView, {
        messages: [],
        cwd: "/workspace/tetris",
        activeTaskId: "task-20260630-093326-1980",
        terminalWidth: 20
      })
    );

    try {
      const frame = twenty.lastFrame() ?? "";
      expect(frame).toContain("ready · tetris");
      expect(frame).not.toContain("ready · tetris · 0");
      expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(18);
    } finally {
      twenty.unmount();
    }

    const twelve = render(
      React.createElement(ChatView, {
        messages: [],
        cwd: "/workspace/tetris",
        activeTaskId: "task-20260630-093326-1980",
        terminalWidth: 12
      })
    );

    try {
      const frame = twelve.lastFrame() ?? "";
      expect(frame).toContain("tetris");
      expect(frame).not.toContain("ready");
      expect(frame).not.toContain("task");
      expect(frame).not.toContain("...");
      expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(10);
    } finally {
      twelve.unmount();
    }

    const ten = render(
      React.createElement(ChatView, {
        messages: [],
        cwd: "/workspace/tetris",
        activeTaskId: "task-20260630-093326-1980",
        terminalWidth: 10
      })
    );

    try {
      const frame = ten.lastFrame() ?? "";
      expect(frame).toContain("tetris");
      expect(frame).not.toContain("task");
      expect(frame).not.toContain("...");
      expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(8);
    } finally {
      ten.unmount();
    }
  });

  it("truncates long empty-state workspace and task labels in narrow terminals", () => {
    const { lastFrame } = render(
      React.createElement(ChatView, {
        messages: [],
        cwd: "/tmp/parallel-codex-workspace-with-a-very-long-project-name-for-header-testing",
        activeTaskId: "task-20260705-123456-extra-long-task-suffix",
        terminalWidth: 24
      })
    );

    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");

    expect(frame).toContain("ready · 123456-extr...");
    expect(frame).not.toContain("ws · parallel-codex...");
    expect(frame).not.toContain("task · 123456-extra...");
    expect(frame).not.toContain("Ready");
    expect(frame).not.toContain("workspaparallel");
    expect(frame).not.toContain("workspace-with-a-very-long-project");
    expect(Math.max(...lines.map((line) => displayWidth(line)))).toBeLessThanOrEqual(22);
  });

  it("truncates Chinese empty-state labels by display width in narrow terminals", () => {
    const { lastFrame } = render(
      React.createElement(ChatView, {
        messages: [],
        cwd: "/tmp/并行编码终端超级长项目名称测试",
        activeTaskId: "task-20260705-中文任务后缀超级长",
        terminalWidth: 24
      })
    );

    const frame = lastFrame() ?? "";
    const lines = frame.split("\n");

    expect(frame).toContain("ready");
    expect(frame).toContain("...");
    expect(frame).not.toContain("Ready");
    expect(frame).not.toContain("并行编码终端超级长项目名称测试");
    expect(frame).not.toContain("中文任务后缀超级长");
    expect(Math.max(...lines.map((line) => displayWidth(line)))).toBeLessThanOrEqual(22);
  });

  it("keeps real conversation messages after input starts", () => {
    const { lastFrame } = render(
      React.createElement(ChatView, {
        messages: [
          { from: "user", text: "你好" },
          { from: "system", text: "简单对话通道没有收到可显示回复。" }
        ],
        cwd: "/tmp/project",
        activeTaskId: null
      })
    );

    const frame = lastFrame() ?? "";

    expect(frame).toContain("> 你好");
    expect(frame).toContain("简单对话通道没有收到可显示回复。");
    expect(frame).not.toContain("ready");
  });

  it("compacts complex task summaries for the chat surface", () => {
    const lines = chatMessageDisplayLines(
      [
        {
          from: "system",
          text: [
            "Complex task completed.",
            "",
            "Requirements:",
            "# Requirements",
            "",
            "- Build a playable falling-blocks game.",
            "",
            "Actor work:",
            "# Worklog",
            "",
            "- Implemented board controls and scoring.",
            "",
            "Critic review:",
            "# Review",
            "",
            "APPROVED",
            "",
            "No blockers.",
            "",
            "Critic findings:",
            "(empty)"
          ].join("\n")
        }
      ],
      80,
      8
    );

    expect(lines.map((line) => line.text)).toEqual([
      "done · complex task completed",
      "requirements · Build a playable falling-blocks game.",
      "actor · Implemented board controls and scoring.",
      "review · APPROVED",
      "findings · none"
    ]);
    expect(lines.some((line) => line.text.includes("Requirements:"))).toBe(false);
    expect(lines.some((line) => line.text.includes("# Worklog"))).toBe(false);
    expect(lines.some((line) => line.text.includes("(empty)"))).toBe(false);
  });

  it("indents wrapped complex summary continuations in narrow chat views", () => {
    const lines = chatMessageDisplayLines(
      [
        {
          from: "system",
          text: [
            "Complex task completed.",
            "",
            "Requirements:",
            "- Build a playable falling-blocks game with scoring, preview, hold, keyboard controls, and smoke tests.",
            "",
            "Actor work:",
            "- Implemented the browser game runtime.",
            "",
            "Critic review:",
            "APPROVED",
            "",
            "Critic findings:",
            "(empty)"
          ].join("\n")
        }
      ],
      34,
      12
    );

    const wrapped = lines.map((line) => line.text);
    expect(wrapped).toContain("requirements · Build a playable");
    expect(wrapped).toContain("  falling-blocks game with");
    expect(wrapped).toContain("  scoring, preview, hold,");
    expect(wrapped.some((line) => line.startsWith("falling-blocks"))).toBe(false);
    expect(wrapped.some((line) => line.startsWith("scoring,"))).toBe(false);
  });

  it("wraps long chat messages by display width with aligned user continuations", () => {
    const messages = [
      {
        from: "user" as const,
        text: "继续优化这个并行编码终端界面让 worker 日志在窄屏下也不要乱"
      },
      {
        from: "system" as const,
        text: "第一行系统回复很长，需要稳定换行。\n第二行也要保留。"
      }
    ];

    const lines = chatMessageDisplayLines(messages, 28, 12);

    expect(lines.some((line) => line.text.startsWith("> 继续优化"))).toBe(true);
    expect(lines.some((line) => line.from === "user" && line.continuation && line.text.startsWith("  "))).toBe(true);
    expect(lines.some((line) => line.text.includes("第二行也要保留。"))).toBe(true);
    expect(Math.max(...lines.map((line) => displayWidth(line.text)))).toBeLessThanOrEqual(26);
  });

  it("keeps the latest chat display lines when a response is taller than the viewport budget", () => {
    const lines = chatMessageDisplayLines(
      [
        { from: "system", text: Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n") }
      ],
      40,
      5
    );

    expect(lines.map((line) => line.text)).toEqual(["line 16", "line 17", "line 18", "line 19", "line 20"]);
  });
});
