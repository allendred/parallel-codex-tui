import type { TaskState } from "../domain/schemas.js";

const TASK_STATE_TRANSITIONS: Record<TaskState, ReadonlySet<TaskState>> = {
  created: new Set(["routed", "paused", "failed", "cancelled"]),
  routed: new Set(["judging", "paused", "failed", "cancelled"]),
  judging: new Set(["ready_for_pair", "paused", "failed", "cancelled"]),
  ready_for_pair: new Set(["actor_running", "paused", "done", "failed", "cancelled"]),
  actor_running: new Set(["critic_running", "verifying", "paused", "failed", "cancelled"]),
  critic_running: new Set(["revision_needed", "integrating", "paused", "failed", "cancelled"]),
  revision_needed: new Set(["actor_running", "paused", "failed", "cancelled"]),
  integrating: new Set(["actor_running", "verifying", "paused", "done", "failed", "cancelled"]),
  verifying: new Set(["revision_needed", "integrating", "paused", "done", "failed", "cancelled"]),
  paused: new Set(["routed", "judging", "ready_for_pair", "failed", "cancelled"]),
  done: new Set(["routed", "cancelled"]),
  failed: new Set(["routed", "judging", "ready_for_pair"]),
  cancelled: new Set(["routed", "judging", "ready_for_pair"])
};

export function taskStateTransitionAllowed(from: TaskState, to: TaskState): boolean {
  return from === to || TASK_STATE_TRANSITIONS[from].has(to);
}
