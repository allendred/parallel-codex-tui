import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { statusDetailDisplayLines, StatusDetailView } from "../src/tui/StatusDetailView.js";
import { displayWidth } from "../src/tui/display-width.js";

describe("StatusDetailView", () => {
  const workers = [{
    id: "actor-openai_compat-0001-input",
    featureId: "0001-input",
    role: "actor" as const,
    engine: "openai_compat",
    label: "Actor (openai_compat) · Input reliability",
    logPath: "/tmp/output.log",
    statusPath: "/tmp/status.json",
    runtimeStatus: {
      worker_id: "actor-openai_compat-0001-input",
      feature_id: "0001-input",
      feature_title: "Input reliability",
      role: "actor" as const,
      engine: "openai_compat",
      model_name: "vendor-coder-v2",
      model_provider: "acme",
      state: "running" as const,
      phase: "process-output",
      last_event_at: "2026-07-15T15:30:00.000Z",
      summary: "正在修复中文输入并验证连续多轮交互",
      native_session_id: "native-provider-session-1234"
    }
  }];

  it("shows full route and selected provider details outside the compact footer", () => {
    const lines = statusDetailDisplayLines({
      cwd: "/Volumes/111/parallel-codex-workspace/tetris",
      taskId: "task-20260715-070751-5bb0",
      mode: "complex",
      busy: true,
      canRetry: false,
      taskStatus: "070751-5bb0 | workers 1 | run 1",
      routeStatus: "route complex · via 127.0.0.1:7890 · 15s",
      routeReason: "这个请求包含多个可以并行开发和审查的功能点，因此交给 Judge 与 Actor/Critic。",
      pairing: { main: "codex", judge: "codex", actor: "codex", critic: "claude" },
      configStatus: "config · roles/workers changed · restart required",
      configRestartRequired: true,
      workers,
      selectedWorkerIndex: 0
    }, 100, 20);
    const text = lines.map((line) => line.text).join("\n");

    expect(text).toContain("task · 070751-5bb0 · complex · running");
    expect(text).toContain("route complex · via 127.0.0.1:7890 · 15s");
    expect(text).toContain("actual roles · main/codex · judge/codex · actor/codex · critic/claude");
    expect(text).toContain("config · roles/workers changed · restart required");
    expect(text).toContain("selected · actor/openai_compat · running · Input reliability");
    expect(text).toContain("model · acme/vendor-coder-v2");
    expect(text).toContain("session · native-provider-session-1234");
    expect(text).toContain("reason · 这个请求包含多个可以并行开发和审查的功能点");
  });

  it("fills the viewport and keeps every row inside the terminal width", () => {
    const view = render(
      <StatusDetailView
        cwd="/Volumes/111/parallel-codex-workspace/tetris"
        taskId="task-20260715-070751-5bb0"
        mode="complex"
        busy={false}
        canRetry={false}
        taskStatus="070751-5bb0 | workers 1 | done 1"
        routeStatus="route complex · 15s"
        routeReason="完成真实任务，并保留历史 Worker 日志。"
        pairing={{ main: "codex", judge: "codex", actor: "codex", critic: "claude" }}
        workers={workers}
        selectedWorkerIndex={0}
        height={12}
        terminalWidth={48}
      />
    );
    const rows = (view.lastFrame() ?? "").split("\n");

    expect(rows).toHaveLength(12);
    expect(rows.every((row) => displayWidth(row) <= 46)).toBe(true);
    view.unmount();
  });

  it("shows the actual per-role provider and model matrix when available", () => {
    const lines = statusDetailDisplayLines({
      cwd: "/tmp/project",
      taskId: "task-20260720-models",
      mode: "complex",
      busy: false,
      canRetry: true,
      taskStatus: "workers 4 | stop 1 | done 3",
      routeStatus: "route complex",
      pairing: { main: "codex", judge: "codex", actor: "codex", critic: "claude" },
      roleSelection: {
        main: { engine: "claude", model: "haiku" },
        judge: { engine: "codex", model: "gpt-5.6" },
        actor: { engine: "codex", model: "gpt-5.6-codex" },
        critic: { engine: "claude", model: "sonnet" }
      },
      workers: [],
      selectedWorkerIndex: 0
    }, 180, 12);

    expect(lines.map((line) => line.text).join("\n")).toContain(
      "actual roles · main/claude/haiku · judge/codex/gpt-5.6 · actor/codex/gpt-5.6-codex · critic/claude/sonnet"
    );
  });

  it("separates actual, one-shot next, and future role matrices", () => {
    const future = {
      main: { engine: "codex", model: "gpt-future" },
      judge: { engine: "codex", model: "gpt-future" },
      actor: { engine: "codex", model: "gpt-future" },
      critic: { engine: "claude", model: "sonnet-future" }
    } as const;
    const next = {
      ...future,
      actor: { engine: "claude", model: "opus-next" }
    } as const;
    const lines = statusDetailDisplayLines({
      cwd: "/tmp/project",
      taskId: null,
      mode: null,
      busy: false,
      canRetry: false,
      taskStatus: "",
      routeStatus: "",
      pairing: { main: "codex", judge: "codex", actor: "codex", critic: "claude" },
      roleSelection: future,
      roleConfigurationSnapshot: {
        baseline: future,
        future,
        next,
        task: null,
        activeTurn: null,
        providers: []
      },
      workers: [],
      selectedWorkerIndex: 0
    }, 180, 12);
    const text = lines.map((line) => line.text).join("\n");

    expect(text).toContain("actual roles · main/codex/gpt-future");
    expect(text).toContain("next roles (one shot) · main/codex/gpt-future");
    expect(text).toContain("actor/claude/opus-next");
    expect(text).toContain("future roles · main/codex/gpt-future");
  });
});
