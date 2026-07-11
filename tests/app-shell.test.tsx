import React from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { AppShell, appShellErrorLineTheme, appShellErrorRow } from "../src/tui/AppShell.js";
import { displayWidth } from "../src/tui/display-width.js";
import { configureTuiTheme, resetTuiTheme, TUI_THEME_PRESETS } from "../src/tui/theme.js";

afterEach(() => {
  resetTuiTheme();
});

describe("AppShell", () => {
  it("keeps error rows semantic across terminal widths", () => {
    const errors = [
      ["permission", "Error: Permission denied"],
      ["session", "No native session for Critic (claude) · run once before attach"],
      ["network", "Codex router timed out after 30000ms while connecting through proxy 127.0.0.1:7890"],
      ["proxy", "无法连接代理服务器，请检查端口和网络设置"],
      ["control", "\x1b[31mError:\x1b[0m Permission\ndenied"]
    ] as const;
    const invalid: string[] = [];

    for (const [name, error] of errors) {
      for (let width = 8; width <= 80; width += 1) {
        const row = appShellErrorRow(error, width);
        if (
          row.text.includes("...") ||
          row.text.includes("\x1b") ||
          row.text.includes("\n") ||
          displayWidth(row.text) + row.trailingWidth > width - 2
        ) {
          invalid.push(`${name}:${width}:${row.text}`);
        }
      }
    }

    expect(invalid).toEqual([]);
    expect(appShellErrorRow(
      "Codex router timed out after 30000ms while connecting through proxy 127.0.0.1:7890",
      80
    ).text).toContain("proxy");
  });

  it("themes error rows with the active danger surface", () => {
    configureTuiTheme({ theme: "paper" });

    expect(appShellErrorLineTheme()).toEqual({
      backgroundColor: TUI_THEME_PRESETS.paper.dangerSurface,
      color: TUI_THEME_PRESETS.paper.danger
    });
  });

  it("keeps error rows inside the same reserved terminal width as other chrome rows", () => {
    const { lastFrame } = render(
      <AppShell
        view="chat"
        cwd="/tmp/project"
        taskId="task-20260710-000000-error"
        statusText="workers 1"
        terminalWidth={80}
        input={<TextLine text="> | message · ^W logs · Tab · ^O attach" />}
        error="No native session for Critic (mock) · run once before attach"
      >
        <TextLine text="ready" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const errorLine = frame
      .split("\n")
      .find((line) => line.includes("No native session for Critic")) ?? "";

    const errorRow = appShellErrorRow("No native session for Critic (mock) · run once before attach", 80);

    expect(errorLine).toContain("error · No native session for Critic (mock) · run once before attach");
    expect(displayWidth(errorRow.text) + errorRow.trailingWidth + 1).toBe(79);
    expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(79);
  });

  it("normalizes generic error prefixes in the app error rail", () => {
    const { lastFrame } = render(
      <AppShell
        view="chat"
        cwd="/tmp/project"
        taskId={null}
        statusText="idle"
        terminalWidth={48}
        input={<TextLine text="> | message" />}
        error="Error: Permission denied"
      >
        <TextLine text="ready" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const errorLine = frame
      .split("\n")
      .find((line) => line.includes("Permission denied")) ?? "";

    expect(errorLine).toContain("error · Permission denied");
    expect(errorLine).not.toContain("Error: Permission denied");
    expect(displayWidth(errorLine)).toBeLessThanOrEqual(47);
  });

  it("omits empty task labels from roomy idle headers", () => {
    const { lastFrame } = render(
      <AppShell
        view="chat"
        cwd="/tmp/project"
        taskId={null}
        statusText="idle"
        terminalWidth={80}
        input={<TextLine text="> | message" />}
      >
        <TextLine text="Ready" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const headerRow = frame.split("\n")[0] ?? "";

    expect(headerRow).toContain("parallel-codex-tui");
    expect(headerRow).toContain("chat");
    expect(headerRow).toContain("project");
    expect(headerRow).toContain("^C exit");
    expect(headerRow).not.toContain("task none");
    expect(headerRow).not.toContain("none");
  });

  it("labels Router diagnostics as routes in the application header", () => {
    const { lastFrame } = render(
      <AppShell
        view="router"
        cwd="/tmp/project"
        taskId={null}
        statusText=""
        terminalWidth={80}
        input={<TextLine text="routes · scroll · ^G refresh · Esc chat" />}
      >
        <TextLine text="Router diagnostics" />
      </AppShell>
    );

    const header = (lastFrame() ?? "").split("\n")[0] ?? "";
    expect(header).toContain("parallel-codex-tui · routes");
    expect(header).toContain("project");
  });

  it("renders a structured worker interface with header, full-width content, input, and status", () => {
    const { lastFrame } = render(
      <AppShell
        view="worker"
        cwd="/tmp/project"
        taskId="task-1"
        statusText="workers 2 | critic/mock done"
        input={<TextLine text="Input area" />}
      >
        <TextLine text="Role artifacts" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n")[0] ?? "";

    expect(frame).toContain("parallel-codex-tui");
    expect(frame).toContain("logs");
    expect(firstLine).toContain("parallel-codex-tui · logs");
    expect(frame).toContain("^C exit");
    expect(frame).toContain("project");
    expect(frame).not.toContain("/tmp/project");
    expect(frame).not.toContain("Worker logs");
    expect(frame).not.toContain("Workers");
    expect(frame).not.toContain("> Critic/mock");
    expect(frame).toContain("Role artifacts");
    expect(frame).toContain("Input area");
    expect(frame).toContain("2 workers");
    expect(frame).toContain("@ critic/mock");
    expect(frame).toContain("critic/mock");
    expect(frame).not.toContain("w2");
    expect(frame).not.toContain("workers 2 | critic/mock done");
  });

  it("shows detach guidance instead of outer exit while attached to a native agent", () => {
    const { lastFrame } = render(
      <AppShell
        view="native"
        cwd="/tmp/project"
        taskId="task-1"
        statusText="task-1 | worker done"
        input={<TextLine text="Native input" />}
      >
        <TextLine text="Native terminal" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";

    expect(frame).toContain("native");
    expect(frame).toContain("^] logs");
    expect(frame).not.toContain("^] detach");
    expect(frame).not.toContain("Native agent");
    expect(frame).not.toContain("^C exit");
  });

  it("can hide the status bar without leaking status text", () => {
    const { lastFrame } = render(
      <AppShell
        view="worker"
        cwd="/tmp/project"
        taskId="task-1"
        statusText="workers 2 | critic/mock done"
        showStatusBar={false}
        input={<TextLine text="Input area" />}
      >
        <TextLine text="Role artifacts" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";

    expect(frame).toContain("parallel-codex-tui");
    expect(frame).toContain("Role artifacts");
    expect(frame).toContain("Input area");
    expect(frame).not.toContain("2 workers");
    expect(frame).not.toContain("@ critic/mock");
  });

  it("uses a lightweight task marker in roomy headers for long task ids", () => {
    const { lastFrame } = render(
      <AppShell
        view="worker"
        cwd="/workspace/tetris"
        taskId="task-20260630-093326-1980"
        statusText="task"
        input={<TextLine text="Input area" />}
      >
        <TextLine text="Worker output" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";

    expect(frame).toContain("#093326-1980");
    expect(frame).not.toContain("task 093326-1980");
    expect(frame).not.toContain("task task-20260630-093326-1980");
    expect(frame).toContain("tetris");
  });

  it("uses a single-line short header in narrow terminals", () => {
    const { lastFrame } = render(
      <AppShell
        view="worker"
        cwd="/workspace/tetris"
        taskId="task-20260630-093326-1980"
        statusText="task"
        terminalWidth={50}
        input={<TextLine text="Input area" />}
      >
        <TextLine text="Worker output" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";

    expect(frame).toContain("pct");
    expect(frame).toContain("logs");
    expect(frame).toContain("093326-1980");
    expect(frame).toContain("tetris");
    expect(frame).toContain("^C");
    expect(frame).not.toContain("parallel-codex-tui");
    expect(frame).not.toContain("Worker logs");
  });

  it("uses an ultra compact header below forty columns", () => {
    const { lastFrame } = render(
      <AppShell
        view="worker"
        cwd="/workspace/tetris"
        taskId="task-20260630-093326-1980"
        statusText="task"
        terminalWidth={36}
        input={<TextLine text="Input area" />}
      >
        <TextLine text="Worker output" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";

    expect(frame).toContain("pct");
    expect(frame).toContain("logs");
    expect(frame).toContain("093326");
    expect(frame).toContain("^C");
    expect(frame).not.toContain("093326-1980");
    expect(frame).not.toContain("tetris");
  });

  it("uses an unbordered tiny header below twenty four columns", () => {
    const { lastFrame } = render(
      <AppShell
        view="chat"
        cwd="/tmp/project"
        taskId={null}
        statusText="idle"
        terminalWidth={20}
        input={<TextLine text="> | message" />}
      >
        <TextLine text="Ready" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n")[0] ?? "";

    expect(firstLine).toContain("pct");
    expect(firstLine).toContain("chat");
    expect(firstLine).toContain("^C");
    expect(frame).not.toContain("pc  cha  non");
    expect(frame).not.toContain("┌");
    expect(frame).not.toContain("│");
    expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(20);
  });

  it("keeps nano headers from clipping words below sixteen columns", () => {
    const { lastFrame } = render(
      <AppShell
        view="chat"
        cwd="/tmp/project"
        taskId={null}
        statusText="idle"
        terminalWidth={12}
        input={<TextLine text="> ...age|" />}
      >
        <TextLine text="Ready" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n")[0] ?? "";

    expect(firstLine).toContain("pct");
    expect(firstLine).toContain("^C");
    expect(firstLine).not.toContain("pc  ch");
    expect(firstLine).not.toContain("chat");
    expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(12);
  });

  it("keeps an identifying header at eight columns", () => {
    const { lastFrame } = render(
      <AppShell
        view="chat"
        cwd="/tmp/project"
        taskId={null}
        statusText="idle"
        terminalWidth={8}
        input={<TextLine text=">|msg" />}
      >
        <TextLine text="Ready" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n")[0] ?? "";

    expect(firstLine).toContain("pct");
    expect(firstLine).not.toContain("^C");
    expect(firstLine.trim()).not.toHaveLength(0);
    expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(8);
  });

  it("hides task ids before clipping worker headers in tiny terminals", () => {
    const { lastFrame } = render(
      <AppShell
        view="worker"
        cwd="/tmp/project"
        taskId="task-20260705-000000-tiny"
        statusText="workers 1 | done 1 | critic/mock done"
        terminalWidth={16}
        input={<TextLine text="logs · scroll" />}
      >
        <TextLine text="critic 1/1" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n")[0] ?? "";

    expect(firstLine).toContain("pct");
    expect(firstLine).toContain("logs");
    expect(firstLine).toContain("^C");
    expect(firstLine).not.toContain("pc  lo");
    expect(firstLine).not.toContain("000");
    expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(16);
  });

  it("uses an intentional native label in tiny headers instead of ellipsis", () => {
    const { lastFrame } = render(
      <AppShell
        view="native"
        cwd="/tmp/project"
        taskId="task-20260705-000000-native"
        statusText="workers 1 | done 1 | actor/mock done"
        terminalWidth={20}
        input={<TextLine text="native · ^]" />}
      >
        <TextLine text="actor/mock" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n")[0] ?? "";

    expect(firstLine).toContain("pct");
    expect(firstLine).toContain("nat");
    expect(firstLine).toContain("^]");
    expect(firstLine).not.toContain("n...");
    expect(firstLine).not.toContain("000");
    expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(20);
  });

  it("hides clipped task fragments at twenty columns", () => {
    const { lastFrame } = render(
      <AppShell
        view="worker"
        cwd="/tmp/project"
        taskId="task-20260630-093326-1980"
        statusText="workers 1 | done 1 | actor/mock done"
        terminalWidth={20}
        input={<TextLine text="logs · Pg · ^O" />}
      >
        <TextLine text="actor 1/1" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n")[0] ?? "";

    expect(firstLine).toContain("pct");
    expect(firstLine).toContain("logs");
    expect(firstLine).toContain("^C");
    expect(firstLine).not.toContain("093");
    expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(20);
  });

  it("hides clipped task fragments at twenty two columns", () => {
    const { lastFrame } = render(
      <AppShell
        view="worker"
        cwd="/tmp/project"
        taskId="task-20260630-093326-1980"
        statusText="workers 1 | done 1 | actor/mock done"
        terminalWidth={22}
        input={<TextLine text="logs · Pg · ^O" />}
      >
        <TextLine text="actor 1/1" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const firstLine = frame.split("\n")[0] ?? "";

    expect(firstLine).toContain("pct");
    expect(firstLine).toContain("logs");
    expect(firstLine).toContain("^C");
    expect(firstLine).not.toContain("09...");
    expect(firstLine).not.toContain("093");
    expect(Math.max(...frame.split("\n").map((line) => displayWidth(line)))).toBeLessThanOrEqual(22);
  });

  it("keeps the native label intentional at twenty four columns", () => {
    const { lastFrame } = render(
      <AppShell
        view="native"
        cwd="/tmp/project"
        taskId="task-20260705-000000-native"
        statusText="workers 1 | done 1 | actor/mock done"
        terminalWidth={24}
        input={<TextLine text="native · ^]" />}
      >
        <TextLine text="actor/mock" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const headerRow = frame.split("\n")[0] ?? "";

    expect(headerRow).toContain("pct");
    expect(headerRow).toContain("nat");
    expect(headerRow).toContain("000");
    expect(headerRow).toContain("^]");
    expect(headerRow).not.toContain("n...");
    expect(headerRow).not.toContain("0...");
  });

  it("does not show a clipped none task label in very narrow headers", () => {
    const { lastFrame } = render(
      <AppShell
        view="chat"
        cwd="/tmp/project"
        taskId={null}
        statusText="idle"
        terminalWidth={24}
        input={<TextLine text="> | message" />}
      >
        <TextLine text="Ready" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    expect(frame).toContain("pct");
    expect(frame).toContain("chat");
    expect(frame).toContain("^C");
    expect(frame).not.toContain(" non ");
    expect(frame).not.toContain(" none ");
  });

  it("keeps long narrow native headers to a single lightweight row", () => {
    const { lastFrame } = render(
      <AppShell
        view="native"
        cwd="/tmp/pct-cli-native-compact-long-project"
        taskId="task-20260705-000000-native-compact"
        statusText="workers 1 | done 1 | actor/mock done"
        terminalWidth={42}
        input={<TextLine text="native · ^] logs" />}
      >
        <TextLine text="Native terminal" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const headerRow = frame.split("\n")[0] ?? "";

    expect(headerRow).toContain("pct");
    expect(headerRow).toContain("native");
    expect(headerRow).toContain("^]");
    expect(frame).not.toContain("│");
    expect(frame).not.toContain("compact-long-project");
  });

  it("budgets narrow headers by display width for Chinese project and task names", () => {
    const { lastFrame } = render(
      <AppShell
        view="worker"
        cwd="/tmp/并行编码终端超级长项目名称测试"
        taskId="task-20260705-中文任务后缀超级长超级长超级长"
        statusText="workers 1 | done 1 | actor/codex done"
        terminalWidth={42}
        input={<TextLine text="logs · scroll" />}
      >
        <TextLine text="Worker output" />
      </AppShell>
    );

    const frame = lastFrame() ?? "";
    const headerContent = frame.split("\n")[0] ?? "";

    expect(headerContent).toContain("pct");
    expect(headerContent).toContain("logs");
    expect(headerContent).toContain("...");
    expect(frame).not.toContain("│");
    expect(frame).not.toContain("并行编码终端超级长项目名称测试");
    expect(frame).not.toContain("中文任务后缀超级长超级长超级长");
    expect(displayWidth(headerContent)).toBeLessThanOrEqual(42);
  });
});

function TextLine({ text }: { text: string }) {
  return <Text>{text}</Text>;
}
