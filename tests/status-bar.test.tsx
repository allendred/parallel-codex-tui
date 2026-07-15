import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { StatusBar, statusBarDisplayText, statusRailLayout, statusSegmentLabelTheme, statusSegmentValueTheme } from "../src/tui/StatusBar.js";
import { displayWidth } from "../src/tui/display-width.js";
import { formatRouteStatus, formatSelectedWorkerStatus, formatStatusLine } from "../src/tui/status-line.js";
import { TUI_THEME_PRESETS } from "../src/tui/theme.js";

describe("StatusBar", () => {
  it("keeps representative status rows semantic across terminal widths", () => {
    const states = [
      ["done", "workers 3 | done 3"],
      ["mixed", "workers 12 | fail 2 run 3 wait 1 done 6 | critic/claude done"],
      ["fallback", "workers 3 | done 3 | route complex · fallback · timeout · 120s"],
      ["proxy-timeout", "workers 3 | done 3 | route simple · fallback · timeout via proxy · 30s"],
      ["structured-proxy-timeout", "workers 3 | done 3 | route simple · fallback · timeout waiting output · via proxy.test:8443 · 30s"],
      ["first-output-timeout", "workers 3 | done 3 | route simple · fallback · first output timeout · direct · 15s"],
      ["idle-timeout", "workers 3 | done 3 | route simple · fallback · idle timeout after stderr · via proxy.test:8443 · 25s"],
      ["proxy", "workers 3 | done 3 | route simple · fallback · proxy"],
      ["auth", "workers 3 | done 3 | route simple · fallback · auth"],
      ["rate-limit", "workers 3 | done 3 | route simple · fallback · rate limit"],
      ["checking", "route checking · 30s max"],
      ["checking-progress", "route checking · 7s / 30s"],
      ["diagnostics-progress", "route diagnostics · via proxy.test:8443 · 7s / 30s"],
      ["receiving-progress", "route receiving · direct · 7s / 30s"],
      ["custom-router", "route waiting output · runner acme-router · direct · 7s / 30s"],
      ["retrying", "route retry 2/2 · via proxy.test:8443 · 500ms backoff"],
      ["follow-up", "workers 3 | done 3 | route follow-up · 20s max"],
      ["main-first-output", "main | main/claude waiting output · 12s / 2m first | route simple · via 127.0.0.1:7890 · 12s"],
      ["main-responding", "main | main/claude responding · 4s / 5m idle | route simple · via 127.0.0.1:7890 · 12s"],
      ["main-failed", "main | main/claude fail | route simple · via 127.0.0.1:7890 · 12s"],
      ["main-unicode-proxy", "main | main/claude waiting output · 12s / 2m first | route simple · via 代理.local:7890 · 12s"],
      ["wave", "wave 2/3 · verification 0/1 | workers 4 | run 1 done 3"],
      ["roles", "judge done | actor run | critic wait"],
      ["stopped", "workers 4 | stop 3 done 1 | actor/codex stop | route complex · via 127.0.0.1:7890 · 15s"],
      ["provider", "workers 1 | fail 1 | actor/super-long-third-party-provider-name fail"]
    ] as const;
    const invalid: string[] = [];

    for (const [name, text] of states) {
      for (let width = 8; width <= 136; width += 1) {
        const layout = statusBarDisplayText(text, width);
        if (displayWidth(layout) > Math.max(1, width - 2) || layout.includes("...")) {
          invalid.push(`${name}:${width}:${displayWidth(layout)}:${layout}`);
        }
        if (width <= 100) {
          const view = render(<StatusBar text={text} terminalWidth={width} />);
          const frame = view.lastFrame() ?? "";
          if (frame.split("\n").length !== 1 || displayWidth(frame) > width || frame.includes("...")) {
            invalid.push(`${name}:${width}:${displayWidth(frame)}:${frame}`);
          }
          view.unmount();
        }
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
        if (!frame.includes("r:") && !frame.includes("route ")) {
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

    expect(frame.trim()).toBe("wk3 done simple · 13s");
    expect(displayWidth(frame)).toBeLessThanOrEqual(40);
    view.unmount();
  });

  it("removes a redundant completed count in roomy terminals without hiding partial completion", () => {
    const completed = render(
      <StatusBar
        text="workers 3 | done 3 | route simple · 13s"
        terminalWidth={80}
      />
    );
    const partial = render(
      <StatusBar
        text="workers 3 | done 2"
        terminalWidth={80}
      />
    );

    expect((completed.lastFrame() ?? "").trim()).toBe("workers 3 · done · route simple · 13s");
    expect(partial.lastFrame()).toContain("workers 3 · done 2");
    completed.unmount();
    partial.unmount();
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
    expect(frame("route checking · 7s / 30s", 8)).toContain("r:7s");
    expect(frame("route checking · 7s / 30s", 13)).toContain("r:7/30s");
    expect(frame("route waiting output · direct · 7s / 15s first · 30s total", 13)).toContain("r:7/15s");
    expect(frame("workers 3 | done 3 | route follow-up · 20s max", 8)).toContain("r:20s");
    expect(frame("workers 3 | done 3 | route complex · fallback · timeout · 120s", 8)).toContain("r:time");
    expect(frame("workers 3 | done 3 | route simple · fallback · timeout via proxy · 30s", 8)).toContain("r:p:to");
    expect(frame("workers 3 | done 3 | route simple · fallback · timeout waiting output · via proxy.test:8443 · 30s", 8)).toContain("r:w:to");
    expect(frame("workers 3 | done 3 | route simple · fallback · timeout after stderr · via proxy.test:8443 · 30s", 8)).toContain("r:e:to");
    expect(frame("workers 3 | done 3 | route simple · fallback · first output timeout · direct · 15s", 8)).toContain("r:f:to");
    expect(frame("workers 3 | done 3 | route simple · fallback · idle timeout after stderr · via proxy.test:8443 · 25s", 8)).toContain("r:i:to");
    expect(frame("route diagnostics · via proxy.test:8443 · 7s / 30s", 13)).toContain("r:diag 7s");
    expect(frame("route diagnostics · via proxy.test:8443 · 7s / 30s total · 15s idle", 13)).toContain("r:diag 7s");
    expect(frame("route receiving · direct · 7s / 30s", 13)).toContain("r:recv 7s");
    expect(frame("route retry 2/2 · via proxy.test:8443 · 500ms backoff", 8)).toContain("r:2/2");
    expect(frame("route retry 2/2 · via proxy.test:8443 · 500ms backoff", 13)).toContain("r:retry 2/2");
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
    expect(statusSegmentValueTheme("stop")).toEqual({
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
    expect(frame).toContain("workers 3");
    expect(frame).toContain("run 1");
    expect(frame).toContain("done 1");
    expect(frame).toContain("fail 1");
    expect(frame).toContain("critic/claude · done");
    expect(frame).not.toContain("3 workers");
    expect(frame).not.toContain("selected critic/claude");
    expect(frame).not.toContain("current critic/claude");
    expect(frame).not.toContain("w3");
    expect(frame).not.toContain("r1");
    expect(frame).not.toContain("d1");
    expect(frame).not.toContain("f1");
    expect(frame.indexOf("fail 1")).toBeLessThan(frame.indexOf("run 1"));
    expect(frame.indexOf("fail 1")).toBeLessThan(frame.indexOf("done 1"));
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
    expect(narrowFrame).toContain("wk4");
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
    const layout = statusRailLayout(40, displayWidth("wk1 done"));
    expect(frame).toContain("wk1 done");
    expect(layout).toEqual({ leadingWidth: 1, trailingWidth: 30 });
    expect(layout.leadingWidth + displayWidth("wk1 done") + layout.trailingWidth).toBe(39);
  });

  it("keeps status segments compact in narrow terminals", () => {
    const { lastFrame } = render(
      <StatusBar
        text="20260702-000000-wheel | workers 3 | fail 1 run 1 done 1 | critic/claude done"
        terminalWidth={42}
      />
    );

    const frame = lastFrame() ?? "";

    expect(frame).toContain("wk3");
    expect(frame).toContain("r1");
    expect(frame).toContain("d1");
    expect(frame).toContain("f1");
    expect(frame).toContain("critic/claude:done");
    expect(frame).not.toContain("workers 3");
    expect(frame).not.toContain("selected critic/claude");
    expect(frame).not.toContain("@ critic");
  });

  it("truncates long selected worker labels in narrow terminals", () => {
    const { lastFrame } = render(
      <StatusBar
        text="workers 1 | done 1 | actor/super-long-third-party-provider-name done"
        terminalWidth={32}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("wk1 done actor:done");
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
    expect(frame).toContain("wk1 done actor:done");
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
    expect(frame).toContain("wk4 f1 d3 judge:done");
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
    expect(frame).toContain("wk4 f1 d3");
    expect(frame).not.toContain("@");
    expect(frame).not.toContain("judge");
    expect(frame.split("\n")).toHaveLength(1);
    expect(displayWidth(frame)).toBeLessThanOrEqual(20);
  });

  it("keeps an active selected worker before lower-priority completed counts", () => {
    const { lastFrame } = render(
      <StatusBar
        text="workers 4 | fail 1 done 3 | actor/codex fail"
        terminalWidth={22}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("actor:fail");
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

  it("renders the Main role with the same identity grammar as workers", () => {
    const { lastFrame } = render(
      <StatusBar
        text="main | main run"
        terminalWidth={80}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("main · run");
    expect(frame).not.toContain("chat run");
    expect(frame).not.toContain("selected main");
  });

  it("renders the actual Main engine and keeps its runtime state visible", () => {
    const { lastFrame } = render(
      <StatusBar
        text="main | main/claude starting | route simple · 42ms"
        terminalWidth={80}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("main/claude · starting");
    expect(frame).toContain("route simple · 42ms");
    expect(frame).not.toContain("@ main/claude");
  });

  it("keeps Main first-output progress distinct from completed Router evidence", () => {
    const { lastFrame } = render(
      <StatusBar
        text="main | main/claude waiting output · 12s / 2m first | route simple · via 127.0.0.1:7890 · 12s"
        terminalWidth={136}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("main/claude · waiting output · 12s / 2m first");
    expect(frame).toContain("route simple · via 127.0.0.1:7890 · 12s");
    expect(displayWidth(frame)).toBeLessThanOrEqual(136);
  });

  it("prioritizes active Main progress over completed Router detail as width shrinks", () => {
    const text = "main | main/claude waiting output · 12s / 2m first | route simple · via 127.0.0.1:7890 · 12s";
    const frame = (terminalWidth: number): string => {
      const view = render(<StatusBar text={text} terminalWidth={terminalWidth} />);
      const value = view.lastFrame() ?? "";
      view.unmount();
      return value;
    };

    expect(frame(80)).toContain("main/claude:waiting output · 12s / 2m first");
    expect(frame(80)).toContain("r:simple · 12s");
    expect(frame(56)).toContain("main/claude:waiting output · 12s / 2m first");
    expect(frame(40)).toContain("main/claude:wait 12s/2m");
    expect(frame(24)).toContain("main:wait 12s/2m");
    expect(frame(16)).toContain("main:wait");
    expect(frame(8)).toContain("main");

    for (const width of [80, 56, 40, 24, 16, 8]) {
      expect(frame(width)).not.toContain("...");
      expect(displayWidth(frame(width))).toBeLessThanOrEqual(width);
    }
  });

  it("keeps a streaming Main response ahead of completed Router detail", () => {
    const text = "main | main/claude responding · 4s / 5m idle | route simple · via 127.0.0.1:7890 · 12s";
    const view = render(<StatusBar text={text} terminalWidth={40} />);
    const frame = view.lastFrame() ?? "";
    view.unmount();

    expect(frame).toContain("main/claude:reply 4s/5m");
    expect(frame).not.toContain("...");
    expect(displayWidth(frame)).toBeLessThanOrEqual(40);
  });

  it("keeps a failed Main ahead of completed Router detail", () => {
    const text = "main | main/claude fail | route simple · via 127.0.0.1:7890 · 12s";
    const view = render(<StatusBar text={text} terminalWidth={16} />);
    const frame = view.lastFrame() ?? "";
    view.unmount();

    expect(frame).toContain("main:fail");
    expect(frame).not.toContain("...");
    expect(displayWidth(frame)).toBeLessThanOrEqual(16);
  });

  it("degrades Main engine identity cleanly in narrow terminals", () => {
    const frame = (terminalWidth: number): string => {
      const view = render(
        <StatusBar text="main | main/claude run" terminalWidth={terminalWidth} />
      );
      const value = view.lastFrame() ?? "";
      view.unmount();
      return value;
    };

    expect(frame(24)).toContain("main/claude:run");
    expect(frame(18)).toContain("main/claude:run");
    expect(frame(10)).toContain("main:run");
    expect(frame(10)).not.toContain("main/");
    expect(frame(8)).toContain("main");
  });

  it("keeps complete fallback evidence beside Main identity at 120 columns", () => {
    const route = "route simple · fallback · user Main · try 2 · idle timeout after stderr · via 127.0.0.1:7890 · 4s total";
    const { lastFrame } = render(
      <StatusBar
        text={`main | main/codex done | ${route}`}
        terminalWidth={120}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("main · done");
    expect(frame).not.toContain("@");
    expect(frame).toContain(route);
    expect(displayWidth(frame)).toBeLessThanOrEqual(120);
  });

  it("renders route evidence as a quiet named segment instead of selected-worker chrome", () => {
    const { lastFrame } = render(
      <StatusBar
        text="main | main done | route simple · 42ms"
        terminalWidth={80}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("main · done");
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
    expect(frame).toContain("main · done");
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
    expect(frame).toContain("judge · done");
    expect(frame).toContain("actor · run");
    expect(frame).toContain("critic · wait");
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
    expect(frame).toContain("workers 4");
    expect(frame).toContain("fail 1");
    expect(frame).toContain("done 3");
    expect(frame).toContain("actor/codex · fail");
    expect(frame).not.toContain("wk4");
    expect(frame).not.toContain("f1");
    expect(displayWidth(frame)).toBeLessThanOrEqual(80);
  });

  it("keeps stopped workers in the summary beside the selected worker", () => {
    const { lastFrame } = render(
      <StatusBar
        text="070751-5bb0 | workers 4 | stop 3 done 1 | actor/codex stop | route complex · via 127.0.0.1:7890 · 15s"
        terminalWidth={188}
      />
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("workers 4");
    expect(frame).toContain("stop 3");
    expect(frame).toContain("done 1");
    expect(frame).toContain("actor/codex · stop");
    expect(frame).toContain("route complex · via 127.0.0.1:7890 · 15s");
    expect(displayWidth(frame)).toBeLessThanOrEqual(188);
  });

  it("keeps the same readable grammar when the selected worker has a long feature title", () => {
    const state = {
      taskId: "task-20260714-070751-5bb0",
      workers: [
        { label: "Judge (codex)", status: "done/process-exited" },
        {
          label: "Actor (codex) · Input reliability and terminal interaction",
          status: "cancelled/process-cancelled"
        },
        { label: "Critic (claude) · Input reliability and terminal interaction", status: "waiting/review" },
        { label: "Actor (codex) · Gameplay correctness", status: "waiting/queued" }
      ]
    };
    const text = [
      formatStatusLine(state),
      "route complex",
      formatSelectedWorkerStatus(state, 1)
    ].filter(Boolean).join(" | ");
    const view = render(<StatusBar text={text} terminalWidth={80} />);
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("workers 4");
    expect(frame).toContain("stop 1");
    expect(frame).toContain("wait 2");
    expect(frame).toContain("done 1");
    expect(frame).toContain("route complex");
    expect(frame).toContain("actor/codex · stop");
    expect(frame).not.toContain("wk4");
    expect(frame).not.toContain("r:complex");
    expect(frame).not.toContain("Input reliability");
    expect(displayWidth(frame)).toBeLessThanOrEqual(80);
    view.unmount();
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
    expect(frame).toContain("workers 3");
    expect(frame).toContain("done");
    expect(frame).not.toContain("wk3");
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

    expect(frame).toContain("wk3");
    expect(frame).toContain("d1");
    expect(frame).toContain("f1");
    expect(frame).toContain("critic/claude:done");
    expect(frame).not.toContain("@ critic");
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
