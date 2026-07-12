import { describe, expect, it } from "vitest";
import { taskStateTransitionAllowed } from "../src/core/task-state-machine.js";
import type { TaskState } from "../src/domain/schemas.js";

describe("task state machine", () => {
  it.each<[TaskState, TaskState]>([
    ["created", "routed"],
    ["routed", "judging"],
    ["judging", "ready_for_pair"],
    ["ready_for_pair", "actor_running"],
    ["actor_running", "critic_running"],
    ["critic_running", "revision_needed"],
    ["revision_needed", "actor_running"],
    ["critic_running", "integrating"],
    ["integrating", "verifying"],
    ["verifying", "revision_needed"],
    ["verifying", "integrating"],
    ["integrating", "actor_running"],
    ["integrating", "done"],
    ["ready_for_pair", "done"],
    ["done", "routed"],
    ["failed", "judging"],
    ["cancelled", "ready_for_pair"],
    ["actor_running", "cancelled"],
    ["verifying", "failed"]
  ])("allows %s -> %s", (from, to) => {
    expect(taskStateTransitionAllowed(from, to)).toBe(true);
  });

  it.each<[TaskState, TaskState]>([
    ["created", "done"],
    ["routed", "critic_running"],
    ["judging", "integrating"],
    ["actor_running", "done"],
    ["revision_needed", "integrating"],
    ["verifying", "done"],
    ["done", "actor_running"],
    ["failed", "done"],
    ["cancelled", "critic_running"]
  ])("rejects %s -> %s", (from, to) => {
    expect(taskStateTransitionAllowed(from, to)).toBe(false);
  });

  it("keeps repeated writes idempotent", () => {
    expect(taskStateTransitionAllowed("critic_running", "critic_running")).toBe(true);
  });
});
