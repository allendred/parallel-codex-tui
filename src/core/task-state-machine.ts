import type { TaskState } from "../domain/schemas.js";

const TASK_STATE_TRANSITIONS: Record<TaskState, ReadonlySet<TaskState>> = {
  created: new Set(["routed", "failed", "cancelled"]),
  routed: new Set(["judging", "failed", "cancelled"]),
  judging: new Set(["ready_for_pair", "failed", "cancelled"]),
  ready_for_pair: new Set(["actor_running", "done", "failed", "cancelled"]),
  actor_running: new Set(["critic_running", "verifying", "failed", "cancelled"]),
  critic_running: new Set(["revision_needed", "integrating", "failed", "cancelled"]),
  revision_needed: new Set(["actor_running", "failed", "cancelled"]),
  integrating: new Set(["actor_running", "verifying", "done", "failed", "cancelled"]),
  verifying: new Set(["revision_needed", "integrating", "failed", "cancelled"]),
  done: new Set(["routed", "cancelled"]),
  failed: new Set(["routed", "judging", "ready_for_pair"]),
  cancelled: new Set(["routed", "judging", "ready_for_pair"])
};

export function taskStateTransitionAllowed(from: TaskState, to: TaskState): boolean {
  return from === to || TASK_STATE_TRANSITIONS[from].has(to);
}
