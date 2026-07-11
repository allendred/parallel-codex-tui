import { describe, expect, it } from "vitest";
import {
  ChatRecordSchema,
  EventRecordSchema,
  FeatureStatusSchema,
  NativeSessionSchema,
  RouteDecisionSchema,
  TaskMetaSchema,
  TurnMetaSchema,
  WorkerStatusSchema
} from "../src/domain/schemas.js";

describe("domain schemas", () => {
  it("validates persisted workspace chat records", () => {
    const result = ChatRecordSchema.parse({
      time: "2026-07-10T12:00:00.000Z",
      from: "user",
      text: "继续优化",
      task_id: "task-20260710-120000-chat"
    });

    expect(result.from).toBe("user");
    expect(result.task_id).toBe("task-20260710-120000-chat");
  });

  it("validates a complex route decision", () => {
    const result = RouteDecisionSchema.parse({
      mode: "complex",
      reason: "Requires code changes and review.",
      router_timeout_kind: "idle",
      router_fallback_resolution: "auto-retry",
      suggested_roles: ["judge", "actor", "critic"],
      judge_engine: "codex",
      actor_engine: "codex",
      critic_engine: "claude"
    });

    expect(result.mode).toBe("complex");
    expect(result.router_timeout_kind).toBe("idle");
    expect(result.router_fallback_resolution).toBe("auto-retry");
    expect(result.suggested_roles).toEqual(["judge", "actor", "critic"]);
  });

  it("validates task metadata", () => {
    const result = TaskMetaSchema.parse({
      id: "task-20260630-033000-a1b2",
      title: "Implement wrapper",
      created_at: "2026-06-30T03:30:00.000Z",
      cwd: "/tmp/project",
      mode: "complex",
      status: "created"
    });

    expect(result.status).toBe("created");
  });

  it("validates worker status", () => {
    const result = WorkerStatusSchema.parse({
      worker_id: "actor-codex",
      role: "actor",
      engine: "codex",
      state: "running",
      phase: "editing",
      last_event_at: "2026-06-30T03:36:00.000Z",
      summary: "Editing files",
      native_session_id: "019f17e4-d12c-7c41-95cd-bc3e2a9b0574"
    });

    expect(result.role).toBe("actor");
    expect(result.native_session_id).toBe("019f17e4-d12c-7c41-95cd-bc3e2a9b0574");
  });

  it("validates feature checkpoint status", () => {
    const result = FeatureStatusSchema.parse({
      feature_id: "0001-ui",
      task_id: "task-20260630-033000-a1b2",
      turn_id: "0001",
      title: "Game UI",
      description: "Render the board",
      depends_on: [],
      state: "actor_running",
      updated_at: "2026-06-30T03:36:00.000Z"
    });

    expect(result.state).toBe("actor_running");
    expect(result.title).toBe("Game UI");
  });

  it("validates turn metadata", () => {
    const result = TurnMetaSchema.parse({
      task_id: "task-20260630-033000-a1b2",
      turn_id: "0002",
      created_at: "2026-06-30T03:40:00.000Z",
      request_path: "turns/0002/user.md"
    });

    expect(result.turn_id).toBe("0002");
  });

  it("validates native worker session metadata", () => {
    const result = NativeSessionSchema.parse({
      engine: "claude",
      role: "critic",
      worker_id: "critic-claude",
      session_id: "abc123",
      scope: "task",
      cwd: "/tmp/project",
      created_at: "2026-06-30T03:36:00.000Z",
      last_used_at: "2026-06-30T03:40:00.000Z",
      source: "output-detected"
    });

    expect(result.scope).toBe("task");
    expect(result.source).toBe("output-detected");
  });

  it("validates JSONL event records", () => {
    const result = EventRecordSchema.parse({
      time: "2026-06-30T03:30:00.000Z",
      type: "worker.started",
      message: "Judge started",
      worker: "judge-codex",
      engine: "codex"
    });

    expect(result.type).toBe("worker.started");
  });
});
