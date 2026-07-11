import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawn } from "node-pty";
import { appendJsonLine, writeJson, writeText } from "../src/core/file-store.js";
import { RouteDecisionSchema, TaskMetaSchema, WorkerStatusSchema } from "../src/domain/schemas.js";
import { NativeTerminalScreen } from "../src/tui/terminal-screen.js";

describe("CLI collaboration timeline smoke", () => {
  it("inspects and filters live collaboration evidence from Worker overview", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "pct-cli-collaboration-app-"));
    const workspace = await mkdtemp(join(tmpdir(), "pct-cli-collaboration-workspace-"));
    const taskId = "task-20260711-070000-timeline";
    const taskDir = join(workspace, ".parallel-codex", "sessions", taskId);
    const dialoguePath = join(taskDir, "dialogue", "actor-critic.jsonl");
    await mkdir(join(appRoot, ".parallel-codex"), { recursive: true });
    await writeText(join(appRoot, ".parallel-codex", "config.toml"), [
      "[router]",
      'defaultMode = "complex"',
      "",
      "[pairing]",
      'main = "mock"',
      'judge = "mock"',
      'actor = "mock"',
      'critic = "mock"',
      ""
    ].join("\n"));
    await writeJson(join(taskDir, "meta.json"), TaskMetaSchema.parse({
      id: taskId,
      title: "Timeline fixture",
      created_at: "2026-07-11T07:00:00.000Z",
      cwd: workspace,
      mode: "complex",
      status: "done"
    }));
    await writeJson(join(taskDir, "route.json"), RouteDecisionSchema.parse({
      mode: "complex",
      reason: "Timeline fixture",
      source: "forced",
      duration_ms: 0,
      suggested_roles: ["judge", "actor", "critic"],
      judge_engine: "mock",
      actor_engine: "mock",
      critic_engine: "mock"
    }));
    await writeJson(join(taskDir, "actor-mock", "status.json"), WorkerStatusSchema.parse({
      worker_id: "actor-mock",
      role: "actor",
      engine: "mock",
      state: "done",
      phase: "implementation-complete",
      last_event_at: "2026-07-11T07:06:00.000Z",
      summary: "Two features completed"
    }));
    await writeText(join(taskDir, "actor-mock", "output.log"), "Actor fixture output\n");
    await writeFeature(taskDir, taskId, "0001-engine", "Game Engine", "revision_needed", "2026-07-11T07:04:00.000Z", false);
    await writeFeature(taskDir, taskId, "0001-ui", "Game UI", "approved", "2026-07-11T07:06:00.000Z", true);
    await writeText(dialoguePath, [
      JSON.stringify(dialogue("2026-07-11T07:00:00.000Z", "0001-engine", "feature.created", "actor", "Engine mailbox ready")),
      JSON.stringify(dialogue("2026-07-11T07:01:00.000Z", "0001-engine", "actor.completed", "actor", "Engine implementation ready")),
      JSON.stringify(dialogue("2026-07-11T07:02:00.000Z", "0001-ui", "critic.revision_requested", "critic", "Fix board alignment")),
      JSON.stringify(dialogue("2026-07-11T07:05:00.000Z", "0001-ui", "critic.completed", "critic", "UI review approved"))
    ].join("\n") + "\n");
    await writeText(join(taskDir, "events.jsonl"), `${JSON.stringify({
      time: "2026-07-11T07:03:00.000Z",
      type: "feature.wave_reviewed",
      message: "Wave 1/1 Critic decision: revision",
      task_id: taskId
    })}\n`);

    const screen = new NativeTerminalScreen({ cols: 100, rows: 16, scrollback: 1000 });
    const exits: number[] = [];
    let screenWrites = Promise.resolve();
    const child = spawn(
      process.execPath,
      ["./node_modules/.bin/tsx", "src/cli.tsx", "--app-root", appRoot, "--workspace", workspace, "--task", taskId],
      {
        cwd: process.cwd(),
        cols: 100,
        rows: 16,
        name: "xterm-256color",
        env: { ...process.env, TERM: "xterm-256color" }
      }
    );
    child.onData((chunk) => {
      screenWrites = screenWrites.then(() => screen.write(chunk));
    });
    child.onExit(({ exitCode }) => exits.push(exitCode));

    try {
      await waitForScreenText(() => screenWrites, screen, "^B workers");
      child.write("\x02");
      await waitForScreenText(() => screenWrites, screen, "C timeline");

      child.write("f");
      await waitForScreenText(() => screenWrites, screen, "Feature board");
      await waitForScreenText(() => screenWrites, screen, "2 features · 1 approved · 1 revision");
      await waitForScreenText(() => screenWrites, screen, "features · Up/Dn select · Enter timeline · R refresh · Esc workers");
      child.write("\x1b[B");
      await waitForScreenText(() => screenWrites, screen, "> T0001 · Game UI · approved");
      child.write("\r");
      await waitForScreenText(() => screenWrites, screen, "Game UI · approved · 4 events · 1 finding · 1 reply");
      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "Feature board");
      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "parallel-codex-tui · workers");

      child.write("c");
      await waitForScreenText(() => screenWrites, screen, "Collaboration timeline");
      await waitForScreenText(() => screenWrites, screen, "all · 2 features · approved 1 · revision 1 · 7 events");
      await waitForScreenText(
        () => screenWrites,
        screen,
        "timeline · Up/Dn event · Enter detail · Tab feature · U unresolved · R refresh · Esc workers"
      );
      let snapshot = screen.snapshot();
      expect(snapshot.split("\n")[0]).toContain("timeline");
      expect(snapshot).toContain(
        "timeline · Up/Dn event · Enter detail · Tab feature · U unresolved · R refresh · Esc workers"
      );
      expect(snapshot).toContain("Supervisor · Game UI");

      child.write("\t");
      await waitForScreenText(() => screenWrites, screen, "Game Engine · revision pending · 4 events");
      child.write("\t");
      await waitForScreenText(() => screenWrites, screen, "Game UI · approved · 4 events · 1 finding · 1 reply");
      snapshot = screen.snapshot();
      expect(snapshot).not.toContain("Engine implementation ready");
      expect(snapshot).toContain("Fix board alignment");
      expect(snapshot).toContain("Align board");

      await appendJsonLine(dialoguePath, dialogue(
        "2026-07-11T07:07:00.000Z",
        "0001-ui",
        "actor.completed",
        "actor",
        "UI revision completed"
      ));
      child.write("r");
      await waitForScreenText(() => screenWrites, screen, "Game UI · approved · 5 events · 1 finding · 1 reply");
      await waitForScreenText(() => screenWrites, screen, "UI revision completed");

      child.write("\x1b[A");
      await waitForScreenText(() => screenWrites, screen, "> 07:06:00 · T0001 · Supervisor · Game UI");
      child.write("\r");
      await waitForScreenText(() => screenWrites, screen, "Collaboration event");
      await waitForScreenText(() => screenWrites, screen, "artifact · status");
      await waitForScreenText(() => screenWrites, screen, "status.json");

      child.write("\r");
      await waitForScreenText(() => screenWrites, screen, "Collaboration timeline");
      child.write("u");
      await waitForScreenText(() => screenWrites, screen, "Game UI · approved · unresolved · 0 events");
      await waitForScreenText(() => screenWrites, screen, "no unresolved collaboration events in this scope");
      child.write("u");
      await waitForScreenText(() => screenWrites, screen, "Game UI · approved · 5 events · 1 finding · 1 reply");

      child.write("\x1b");
      await waitForScreenText(() => screenWrites, screen, "parallel-codex-tui · workers");
      child.write("\x03");
      await waitForExit(exits);
      expect(exits[0]).toBe(0);
    } finally {
      if (exits.length === 0) {
        child.kill("SIGTERM");
      }
    }
  }, 20000);
});

async function writeFeature(
  taskDir: string,
  taskId: string,
  featureId: string,
  title: string,
  state: "approved" | "revision_needed",
  updatedAt: string,
  mailboxEvidence: boolean
): Promise<void> {
  const featureDir = join(taskDir, "features", featureId);
  await writeJson(join(featureDir, "status.json"), {
    feature_id: featureId,
    task_id: taskId,
    turn_id: "0001",
    title,
    description: `${title} implementation`,
    depends_on: featureId === "0001-ui" ? ["engine"] : [],
    state,
    updated_at: updatedAt
  });
  await writeText(join(featureDir, "spec.md"), `# Feature Mailbox\n\nTitle: ${title}\n`);
  await writeText(
    join(featureDir, "critic-findings.jsonl"),
    mailboxEvidence ? `${JSON.stringify({ id: "C-001", summary: "Align board" })}\n` : ""
  );
  await writeText(
    join(featureDir, "actor-replies.jsonl"),
    mailboxEvidence ? `${JSON.stringify({ finding_id: "C-001", resolution: "fixed" })}\n` : ""
  );
}

function dialogue(
  time: string,
  featureId: string,
  type: string,
  role: "actor" | "critic",
  message: string
): Record<string, unknown> {
  return {
    time,
    feature_id: featureId,
    turn_id: "0001",
    type,
    role,
    message,
    paths: {}
  };
}

async function waitForScreenText(
  screenWritesRef: () => Promise<void>,
  screen: NativeTerminalScreen,
  text: string
): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    await screenWritesRef();
    if (screen.snapshot().includes(text)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${text}\nSnapshot:\n${screen.snapshot()}`);
}

async function waitForExit(exits: number[]): Promise<void> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (exits.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for TUI to exit");
}
