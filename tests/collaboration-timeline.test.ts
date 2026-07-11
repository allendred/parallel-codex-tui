import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureDir, writeJson, writeText } from "../src/core/file-store.js";
import { SessionManager } from "../src/core/session-manager.js";

describe("collaboration timeline", () => {
  it("merges feature dialogue, mailbox counts, final state, and Wave events", async () => {
    const root = await mkdtemp(join(tmpdir(), "pct-collaboration-timeline-"));
    const manager = new SessionManager({
      projectRoot: root,
      dataDir: ".parallel-codex",
      now: () => new Date("2026-07-11T07:00:00.000Z"),
      randomId: () => "timeline"
    });
    const task = await manager.createTask({
      request: "并行实现界面与引擎",
      cwd: root,
      route: {
        mode: "complex",
        reason: "Project work.",
        suggested_roles: ["judge", "actor", "critic"],
        judge_engine: "mock",
        actor_engine: "mock",
        critic_engine: "mock"
      }
    });
    const uiDir = join(task.dir, "features", "0001-ui");
    const engineDir = join(task.dir, "features", "0001-engine");
    await Promise.all([
      ensureDir(uiDir),
      ensureDir(engineDir),
      ensureDir(join(task.dir, "dialogue"))
    ]);
    await writeJson(join(uiDir, "status.json"), {
      feature_id: "0001-ui",
      task_id: task.id,
      turn_id: "0001",
      title: "Game UI",
      description: "Render the game board and controls",
      depends_on: ["engine"],
      state: "approved",
      updated_at: "2026-07-11T07:05:00.000Z"
    });
    await writeJson(join(engineDir, "status.json"), {
      feature_id: "0001-engine",
      task_id: task.id,
      turn_id: "0001",
      state: "revision_needed",
      updated_at: "2026-07-11T07:04:00.000Z"
    });
    await writeText(join(engineDir, "spec.md"), "# Feature Mailbox\n\nTitle: Game Engine\n");
    await writeText(join(uiDir, "critic-findings.jsonl"), [
      JSON.stringify({ id: "C-001", summary: "Align board" }),
      "{partial"
    ].join("\n"));
    await writeText(join(uiDir, "actor-replies.jsonl"), `${JSON.stringify({
      finding_id: "C-001",
      notes: "Board alignment fixed"
    })}\n`);
    await writeText(join(engineDir, "critic-findings.jsonl"), "");
    await writeText(join(engineDir, "actor-replies.jsonl"), "");
    await writeText(join(task.dir, "dialogue", "actor-critic.jsonl"), [
      JSON.stringify(dialogue("2026-07-11T07:00:00.000Z", "0001-ui", "feature.created", "actor", "Mailbox ready")),
      "{partial",
      JSON.stringify(dialogue(
        "2026-07-11T07:01:00.000Z",
        "0001-ui",
        "actor.completed",
        "actor",
        "Implementation ready",
        { worklog: join(uiDir, "actor-worklog.md") }
      )),
      JSON.stringify(dialogue("2026-07-11T07:02:00.000Z", "0001-ui", "critic.revision_requested", "critic", "Fix alignment"))
    ].join("\n"));
    await writeText(task.eventsPath, [
      JSON.stringify({
        time: "2026-07-11T07:03:00.000Z",
        type: "feature.wave_reviewed",
        message: "Wave 1/1 Critic decision: revision",
        task_id: task.id
      }),
      JSON.stringify({
        time: "2026-07-11T07:06:00.000Z",
        type: "task.done",
        message: "Task moved to done",
        task_id: task.id
      })
    ].join("\n"));

    const readTimeline = (
      manager as SessionManager & {
        readCollaborationTimeline?: (taskId: string) => Promise<{
          taskId: string;
          features: Array<Record<string, unknown>>;
          events: Array<Record<string, unknown>>;
        }>;
      }
    ).readCollaborationTimeline;

    expect(readTimeline).toBeTypeOf("function");
    const timeline = await readTimeline?.call(manager, task.id);
    expect(timeline?.taskId).toBe(task.id);
    expect(timeline?.features).toEqual([
      expect.objectContaining({
        id: "0001-engine",
        title: "Game Engine",
        description: "",
        dependsOn: [],
        state: "revision_needed",
        findings: 0,
        replies: 0
      }),
      expect.objectContaining({
        id: "0001-ui",
        title: "Game UI",
        description: "Render the game board and controls",
        dependsOn: ["engine"],
        state: "approved",
        findings: 1,
        replies: 1,
        latestFinding: "Align board",
        latestReply: "Board alignment fixed"
      })
    ]);
    expect(timeline?.events.map((event) => event.type)).toEqual([
      "feature.created",
      "actor.completed",
      "critic.revision_requested",
      "feature.wave_reviewed",
      "feature.state",
      "feature.state"
    ]);
    expect(timeline?.events).toContainEqual(expect.objectContaining({
      featureId: "0001-ui",
      role: "critic",
      action: "revision requested",
      message: "Fix alignment · Align board",
      findings: 1,
      replies: 1
    }));
    expect(timeline?.events).toContainEqual(expect.objectContaining({
      type: "actor.completed",
      artifactRefs: [{ label: "worklog", path: join(uiDir, "actor-worklog.md") }]
    }));
    expect(timeline?.events).toContainEqual(expect.objectContaining({
      type: "feature.state",
      featureId: "0001-ui",
      artifactRefs: expect.arrayContaining([
        { label: "status", path: join(uiDir, "status.json") },
        { label: "critic findings", path: join(uiDir, "critic-findings.jsonl") },
        { label: "actor replies", path: join(uiDir, "actor-replies.jsonl") }
      ])
    }));
    expect(timeline?.events.some((event) => event.type === "task.done")).toBe(false);
  });
});

function dialogue(
  time: string,
  featureId: string,
  type: string,
  role: "actor" | "critic",
  message: string,
  paths: Record<string, string> = {}
): Record<string, unknown> {
  return {
    time,
    feature_id: featureId,
    turn_id: "0001",
    type,
    role,
    message,
    paths
  };
}
