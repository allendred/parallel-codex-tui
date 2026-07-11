import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { StatusBar, statusRailLayout, statusSegmentLabelTheme, statusSegmentValueTheme } from "../src/tui/StatusBar.js";
import { displayWidth } from "../src/tui/display-width.js";
import { formatRouteStatus, formatStatusLine } from "../src/tui/status-line.js";
import { TUI_THEME_PRESETS } from "../src/tui/theme.js";

describe("StatusBar", () => {
  it("keeps representative status rows semantic across terminal widths", () => {
    const states = [
      ["done", "workers 3 | done 3"],
      ["mixed", "workers 12 | fail 2 run 3 wait 1 done 6 | critic/claude done"],
      ["fallback", "workers 3 | done 3 | route complex · fallback · timeout · 120s"],
      ["proxy-timeout", "workers 3 | done 3 | route simple · fallback · proxy timeout · 30s"],
      ["proxy", "workers 3 | done 3 | route simple · fallback · proxy"],
      ["auth", "workers 3 | done 3 | route simple · fallback · auth"],
      ["rate-limit", "workers 3 | done 3 | route simple · fallback · rate limit"],
      ["checking", "route checking · 30s max"],
      ["follow-up", "workers 3 | done 3 | route follow-up · 20s max"],
      ["wave", "wave 2/3 · verification 0/1 | workers 4 | run 1 done 3"],
      ["roles", "judge done | actor run | critic wait"],
      ["provider", "workers 1 | fail 1 | actor/super-long-third-party-provider-name fail"]
    ] as const;
    const invalid: string[] = [];

    for (const [name, text] of states) {
      for (let width = 8; width <= 100; width += 1) {
        const view = render(<StatusBar text={text} terminalWidth={width} />);
        const frame = view.lastFrame() ?? "";
        if (frame.split("\n").length !== 1 || displayWidth(frame) > width || frame.includes("...")) {
          invalid.push(`${name}:${width}:${displayWidth(frame)}:${frame}`);
        }
        view.unmount();
      }
    }

    expect(invalid).toEqual([]);
  });

  it("keeps active route evidence visible ahead of stale worker counts at every compact width", () => {
    const missing: string[] = [];

    for (let width = 8; width < 56; width += 1) {
      for (const [name, text] of [
        ["checking", "route checking · 30s max"],
        ["follow-up", "workers 3 | done 3 | route follow-up · 20s max"]
      ] as const) {
        const view = render(<StatusBar text={text} terminalWidth={width} />);
        const frame = view.lastFrame() ?? "";
        if (!frame.includes("r:")) {
          missing.push(`${name}:${width}:${frame}`);
        }
        view.unmount();
      }
    }

    expect(missing).toEqual([]);
  });

  it("keeps a successful completed-task route readable at compact widths", () => {
    const view = render(
      <StatusBar
        text="workers 3 | done 3 | route simple · 13s"
        terminalWidth={40}
      />
    );
    const frame = view.lastFrame() ?? "";

    expect(frame.trim()).toBe("3 workers · 3 done · simple · 13s");
    expect(displayWidth(frame)).toBeLessThanOrEqual(40);
    view.unmount();
  });

  it("uses intentional route abbreviations and atomic worker identities in nano terminals", () => {
    const frame = (text: string, terminalWidth: number): string => {
      const view = render(<StatusBar text={text} terminalWidth={terminalWidth} />);
      const value = view.lastFrame() ?? "";
      view.unmount();
      return value;
    };

    expect(frame("route checking · 30s max", 8)).toContain("r:30s");
    expect(frame("route checking · 30s max", 13)).toContain("r:check 30s");
    expect(frame("workers 3 | done 3 | route follow-up · 20s max", 8)).toContain("r:20s");
    expect(frame("workers 3 | done 3 | route complex · fallback · timeout · 120s", 8)).toContain("r:time");
    expect(frame("workers 3 | done 3 | route simple · fallback · proxy timeout · 30s", 8)).toContain("r:p:to");
    expect(frame("workers 3 | done 3 | route simple · fallback · proxy", 8)).toContain("r:pxy");
    expect(frame("workers 3 | done 3 | route simple · fallback · auth", 8)).toContain("r:auth");
    expect(frame("workers 3 | done 3 | route simple · fallback · rate limit", 8)).toContain("r:rate");

    const selected = frame("workers 12 | fail 2 run 3 wait 1 done 6 | critic/claude done", 24);
    expect(selected).not.toContain("@");
    expect(selected).not.toContain("...");
  });

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

  it("renders feature wave progress as named chrome instead of a selected worker", () => {
    const wide = render(
      <StatusBar
        text="a1b2 | wave 1/3 · actor 2/4 | workers 4 | run 2 done 2"
        terminalWidth={80}
      />
    );
    const wideFrame = wide.lastFrame() ?? "";
    expect(wideFrame).toContain("wave 1/3 · actor 2/4");
    expect(wideFrame).not.toContain("@ wave");
    wide.unmount();

    const narrow = render(
      <StatusBar
        text="a1b2 | wave 1/3 · actor 2/4 | workers 4 | run 2 done 2"
        terminalWidth={34}
      />
    );
    const narrowFrame = narrow.lastFrame() ?? "";
    expect(narrowFrame).toContain("wave 1/3 a2/4");
    expect(narrowFrame).toContain("w4");
    expect(displayWidth(narrowFrame)).toBeLessThanOrEqual(34);
    narrow.unmount();

    const integration = render(
      <StatusBar
        text="a1b2 | wave 2/3 · integration 0/1 | workers 4 | done 4"
        terminalWidth={38}
      />
    );
    const integrationFrame = integration.lastFrame() ?? "";
    expect(integrationFrame).toContain("wave 2/3 i0/1");
    expect(displayWidth(integrationFrame)).toBeLessThanOrEqual(38);
    integration.unmount();

    const verification = render(
      <StatusBar
        text="a1b2 | wave 2/3 · verification 0/1 | workers 1 | run 1"
        terminalWidth={38}
      />
    );
    const verificationFrame = verification.lastFrame() ?? "";
    expect(verificationFrame).toContain("wave 2/3 v0/1");
    expect(displayWidth(verificationFrame)).toBeLessThanOrEqual(38);
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

  it("shows the current simple Main turn without historical worker counts", () => {
    const task = formatStatusLine({
      taskId: "task-20260707-033720-fefc",
      main: "done",
      workers: [
        { label: "Judge (codex)", status: "done/process-exited" },
        { label: "Actor (codex)", status: "done/process-exited" },
        { label: "Critic (codex)", status: "done/process-exited" }
      ]
    });
    const route = formatRouteStatus({
      mode: "simple",
      reason: "Simple task question.",
      suggested_roles: [],
      judge_engine: "codex",
      actor_engine: "codex",
      critic_engine: "codex",
      source: "codex",
      duration_ms: 13000
    });
    const { lastFrame } = render(
      <StatusBar text={`${task} | ${route}`} terminalWidth={80} />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("chat done");
    expect(frame).toContain("route simple · 13s");
    expect(frame).not.toContain("workers");
    expect(frame).not.toContain("done 3");
  });

  it("keeps fallback route evidence visible by compacting its details in narrow terminals", () => {
    const { lastFrame } = render(
      <StatusBar
        text="093326-1980 | workers 4 | fail 1 done 3 | route complex · fallback · timeout · 120s | actor/codex fail"
        terminalWidth={24}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("f1");
    expect(frame).toContain("r:timeout");
    expect(frame).not.toContain("fallback");
    expect(frame).not.toContain("120s");
    expect(displayWidth(frame)).toBeLessThanOrEqual(24);
  });

  it("keeps an active follow-up route wait visible ahead of stale worker counts", () => {
    const { lastFrame } = render(
      <StatusBar
        text="093326-1980 | workers 3 | done 3 | route follow-up · 20s max"
        terminalWidth={24}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("r:follow-up · 20s max");
    expect(frame).not.toContain("w3");
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
