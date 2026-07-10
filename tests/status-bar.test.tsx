import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { StatusBar, statusRailLayout, statusSegmentLabelTheme, statusSegmentValueTheme } from "../src/tui/StatusBar.js";
import { displayWidth } from "../src/tui/display-width.js";
import { TUI_THEME_PRESETS } from "../src/tui/theme.js";

describe("StatusBar", () => {
  it("keeps status labels quiet while values carry semantic emphasis", () => {
    expect(statusSegmentLabelTheme("run")).toEqual({
      backgroundColor: TUI_THEME_PRESETS.codex.rail,
      color: TUI_THEME_PRESETS.codex.muted
    });
    expect(statusSegmentLabelTheme("fail")).toEqual({
      backgroundColor: TUI_THEME_PRESETS.codex.rail,
      color: TUI_THEME_PRESETS.codex.muted
    });
    expect(statusSegmentValueTheme("run")).toEqual({
      backgroundColor: TUI_THEME_PRESETS.codex.rail,
      color: TUI_THEME_PRESETS.codex.accent,
      bold: true
    });
    expect(statusSegmentValueTheme("done")).toEqual({
      backgroundColor: TUI_THEME_PRESETS.codex.rail,
      color: TUI_THEME_PRESETS.codex.success
    });
    expect(statusSegmentValueTheme("fail")).toEqual({
      backgroundColor: TUI_THEME_PRESETS.codex.rail,
      color: TUI_THEME_PRESETS.codex.danger,
      bold: true
    });
    expect(statusSegmentValueTheme("wait")).toEqual({
      backgroundColor: TUI_THEME_PRESETS.codex.rail,
      color: TUI_THEME_PRESETS.codex.warning
    });
  });

  it("renders readable status segments in roomy terminals", () => {
    const { lastFrame } = render(
      <StatusBar
        text="20260702-000000-wheel | workers 3 | fail 1 run 1 done 1 | critic/claude done"
        terminalWidth={80}
      />
    );

    const frame = lastFrame() ?? "";

    expect(frame).not.toContain("20260702-000000-wheel");
    expect(frame).toContain("3 workers");
    expect(frame).toContain("1 running");
    expect(frame).toContain("1 done");
    expect(frame).toContain("1 failed");
    expect(frame).toContain("@ critic/claude");
    expect(frame).not.toContain("workers 3");
    expect(frame).not.toContain("run 1");
    expect(frame).not.toContain("fail 1");
    expect(frame).not.toContain("selected critic/claude");
    expect(frame).not.toContain("current critic/claude");
    expect(frame).not.toContain("w3");
    expect(frame).not.toContain("r1");
    expect(frame).not.toContain("d1");
    expect(frame).not.toContain("f1");
    expect(frame.indexOf("1 failed")).toBeLessThan(frame.indexOf("1 running"));
    expect(frame.indexOf("1 failed")).toBeLessThan(frame.indexOf("1 done"));
  });

  it("fills an explicitly sized status rail without stdout columns", () => {
    const { lastFrame } = render(
      <StatusBar
        text="workers 1 | done 1"
        terminalWidth={40}
      />
    );

    const frame = lastFrame() ?? "";
    const layout = statusRailLayout(40, displayWidth("w1 d1"));
    expect(frame).toContain("w1 d1");
    expect(layout).toEqual({ leadingWidth: 1, trailingWidth: 33 });
    expect(layout.leadingWidth + displayWidth("w1 d1") + layout.trailingWidth).toBe(39);
  });

  it("keeps status segments compact in narrow terminals", () => {
    const { lastFrame } = render(
      <StatusBar
        text="20260702-000000-wheel | workers 3 | fail 1 run 1 done 1 | critic/claude done"
        terminalWidth={42}
      />
    );

    const frame = lastFrame() ?? "";

    expect(frame).toContain("w3");
    expect(frame).toContain("r1");
    expect(frame).toContain("d1");
    expect(frame).toContain("f1");
    expect(frame).toContain("@ critic");
    expect(frame).not.toContain("workers 3");
    expect(frame).not.toContain("selected critic/claude");
    expect(frame).not.toContain("critic/claude");
  });

  it("truncates long selected worker labels in narrow terminals", () => {
    const { lastFrame } = render(
      <StatusBar
        text="workers 1 | done 1 | actor/super-long-third-party-provider-name done"
        terminalWidth={32}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("w1");
    expect(frame).toContain("d1");
    expect(frame).toContain("@ actor");
    expect(frame).not.toContain("@ actor/");
    expect(frame).not.toContain("...");
    expect(frame).not.toContain("third-party-provider-name");
    expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(32);
  });

  it("truncates long Chinese selected worker labels by display width", () => {
    const { lastFrame } = render(
      <StatusBar
        text="workers 1 | done 1 | actor/第三方模型提供商超级长名称 done"
        terminalWidth={32}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("w1");
    expect(frame).toContain("d1");
    expect(frame).toContain("@ actor");
    expect(frame).not.toContain("@ actor/");
    expect(frame).not.toContain("...");
    expect(frame).not.toContain("第三方模型提供商超级长名称");
    expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(32);
  });

  it("keeps the compact worker status on one row in ultra narrow terminals", () => {
    const { lastFrame } = render(
      <StatusBar
        text="workers 4 | fail 1 done 3 | judge/codex done"
        terminalWidth={24}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("w4 f1 d3 @ judge");
    expect(frame).not.toContain("judge/codex");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(24);
  });

  it("drops the selected worker label in nano terminals when counts already fit", () => {
    const { lastFrame } = render(
      <StatusBar
        text="workers 4 | fail 1 done 3 | judge/codex done"
        terminalWidth={20}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("w4 f1 d3");
    expect(frame).not.toContain("@");
    expect(frame).not.toContain("judge");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(20);
  });

  it("drops clipped selected worker fragments below the full-label threshold", () => {
    const { lastFrame } = render(
      <StatusBar
        text="workers 4 | fail 1 done 3 | actor/codex fail"
        terminalWidth={22}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("w4 f1 d3");
    expect(frame).not.toContain("@");
    expect(frame).not.toContain("actor/");
    expect(frame).not.toContain("...");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(22);
  });

  it("keeps large worker counts inside nano terminal widths", () => {
    for (const width of [8, 10, 12, 14, 18, 22]) {
      const { lastFrame, unmount } = render(
        <StatusBar
          text="workers 123 | done 99 | fail 12 | actor/codex-with-long-name fail"
          terminalWidth={width}
        />
      );

      const frame = lastFrame() ?? "";
      expect(frame).toContain("f12");
      expect(frame.split("\n")).toHaveLength(1);
      expect(displayWidth(frame)).toBeLessThanOrEqual(width);
      unmount();
    }
  });

  it("drops lower priority role runtime segments before overflowing tiny widths", () => {
    const tiny = render(
      <StatusBar
        text="093326-1980 | judge done | actor run | critic wait"
        terminalWidth={10}
      />
    );
    const tinyFrame = tiny.lastFrame() ?? "";
    expect(tinyFrame).toContain("a:run");
    expect(tinyFrame).not.toContain("j:done");
    expect(displayWidth(tinyFrame)).toBeLessThanOrEqual(10);
    tiny.unmount();

    const compact = render(
      <StatusBar
        text="093326-1980 | judge done | actor run | critic wait"
        terminalWidth={16}
      />
    );
    const compactFrame = compact.lastFrame() ?? "";
    expect(compactFrame).toContain("a:run");
    expect(compactFrame).toContain("c:wait");
    expect(displayWidth(compactFrame)).toBeLessThanOrEqual(16);
    compact.unmount();
  });

  it("renders simple chat runtime status without selected-worker chrome", () => {
    const { lastFrame } = render(
      <StatusBar
        text="main | main run"
        terminalWidth={80}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("chat run");
    expect(frame).not.toContain("@ main");
    expect(frame).not.toContain("selected main");
  });

  it("renders route evidence as a quiet named segment instead of selected-worker chrome", () => {
    const { lastFrame } = render(
      <StatusBar
        text="main | main done | route simple · 42ms"
        terminalWidth={80}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("chat done");
    expect(frame).toContain("route simple · 42ms");
    expect(frame).not.toContain("@ route");
  });

  it("keeps fallback route evidence visible by compacting its details in narrow terminals", () => {
    const { lastFrame } = render(
      <StatusBar
        text="093326-1980 | workers 4 | fail 1 done 3 | route complex · fallback · 120s | actor/codex fail"
        terminalWidth={24}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("f1");
    expect(frame).toContain("r:fallback");
    expect(frame).not.toContain("120s");
    expect(displayWidth(frame)).toBeLessThanOrEqual(24);
  });

  it("renders role runtime statuses as roles instead of repeated selected workers", () => {
    const { lastFrame } = render(
      <StatusBar
        text="093326-1980 | judge done | actor run | critic wait"
        terminalWidth={80}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("judge done");
    expect(frame).toContain("actor run");
    expect(frame).toContain("critic wait");
    expect(frame).not.toContain("j:done");
    expect(frame).not.toContain("a:run");
    expect(frame).not.toContain("c:wait");
    expect(frame).not.toContain("@ judge");
    expect(frame).not.toContain("selected judge");
  });

  it("keeps worker counts readable in medium-width terminals when they fit", () => {
    const { lastFrame } = render(
      <StatusBar
        text="093326-1980 | workers 4 | fail 1 done 3 | actor/codex fail"
        terminalWidth={80}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("4 workers");
    expect(frame).toContain("1 failed");
    expect(frame).toContain("3 done");
    expect(frame).toContain("@ actor/codex");
    expect(frame).not.toContain("w4");
    expect(frame).not.toContain("f1");
    expect(displayWidth(frame)).toBeLessThanOrEqual(80);
  });

  it("keeps role runtime statuses compact in ultra narrow terminals", () => {
    const { lastFrame } = render(
      <StatusBar
        text="093326-1980 | judge done | actor run | critic wait"
        terminalWidth={24}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("j:done a:run c:wait");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(24);
  });

  it("can show the task segment when explicitly requested", () => {
    const { lastFrame } = render(
      <StatusBar
        text="20260702-000000-wheel | workers 3 | done 3"
        showTask
      />
    );

    const frame = lastFrame() ?? "";

    expect(frame).toContain("20260702-000000-wheel");
    expect(frame).toContain("3 workers");
    expect(frame).toContain("3 done");
    expect(frame).not.toContain("w3");
    expect(frame).not.toContain("d3");
  });

  it("keeps idle status visually quiet", () => {
    const { lastFrame } = render(<StatusBar text="idle" />);

    const frame = lastFrame() ?? "";

    expect(frame).not.toContain("status");
    expect(frame).not.toContain("idle");
  });

  it("omits the task segment in ultra narrow terminals", () => {
    const { lastFrame } = render(
      <StatusBar
        text="20260702-000000-wheel | workers 3 | fail 1 run 1 done 1 | critic/claude done"
        terminalWidth={36}
        showTask
      />
    );

    const frame = lastFrame() ?? "";

    expect(frame).toContain("w3");
    expect(frame).toContain("d1");
    expect(frame).toContain("f1");
    expect(frame).toContain("@ critic");
    expect(frame).not.toContain("critic/claude");
    expect(frame).not.toContain("20260702-000000-wheel");
  });

  it("falls back to idle when only a hidden task segment is present", () => {
    const { lastFrame } = render(<StatusBar text="task-1" />);

    const frame = lastFrame() ?? "";

    expect(frame).not.toContain("status");
    expect(frame).not.toContain("idle");
    expect(frame).not.toContain("task-1");
  });

  it("keeps hidden task-only idle status quiet in nano terminals", () => {
    const { lastFrame } = render(<StatusBar text="task-20260630-093326-1980" terminalWidth={10} />);

    const frame = lastFrame() ?? "";
    expect(frame).not.toContain("status");
    expect(frame).not.toContain("idle");
    expect(frame).not.toContain("093326");
    expect(displayWidth(frame)).toBeLessThanOrEqual(10);
  });
});
