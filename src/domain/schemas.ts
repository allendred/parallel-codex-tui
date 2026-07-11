import { z } from "zod";

export const RouteModeSchema = z.enum(["simple", "complex"]);
export const EngineNameSchema = z.enum(["codex", "claude", "mock"]);
export const WorkerRoleSchema = z.enum(["main", "judge", "actor", "critic"]);
export const RouterFailureStageSchema = z.enum([
  "spawn",
  "input",
  "waiting-output",
  "streaming",
  "exit",
  "response"
]);

export const TaskStateSchema = z.enum([
  "created",
  "routed",
  "judging",
  "ready_for_pair",
  "actor_running",
  "critic_running",
  "revision_needed",
  "integrating",
  "verifying",
  "done",
  "failed",
  "cancelled"
]);

export const WorkerStateSchema = z.enum([
  "idle",
  "starting",
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled"
]);

export const RouteDecisionSchema = z.object({
  mode: RouteModeSchema,
  reason: z.string().min(1),
  source: z.enum(["codex", "forced", "fallback"]).optional(),
  duration_ms: z.number().nonnegative().optional(),
  router_spawn_ms: z.number().nonnegative().optional(),
  router_first_output_ms: z.number().nonnegative().optional(),
  router_first_stdout_ms: z.number().nonnegative().optional(),
  router_first_stderr_ms: z.number().nonnegative().optional(),
  router_process_ms: z.number().nonnegative().optional(),
  router_stdout_bytes: z.number().int().nonnegative().optional(),
  router_stderr_bytes: z.number().int().nonnegative().optional(),
  router_failure_stage: RouterFailureStageSchema.optional(),
  suggested_roles: z.array(WorkerRoleSchema).default([]),
  judge_engine: EngineNameSchema.default("codex"),
  actor_engine: EngineNameSchema.default("codex"),
  critic_engine: EngineNameSchema.default("claude")
});

export const TaskMetaSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  created_at: z.string().datetime(),
  cwd: z.string().min(1),
  mode: RouteModeSchema,
  status: TaskStateSchema
});

export const WorkerStatusSchema = z.object({
  worker_id: z.string().min(1),
  feature_id: z.string().min(1).optional(),
  feature_title: z.string().min(1).optional(),
  role: WorkerRoleSchema,
  engine: EngineNameSchema,
  state: WorkerStateSchema,
  phase: z.string().min(1),
  last_event_at: z.string().datetime(),
  summary: z.string(),
  native_session_id: z.string().min(1).optional()
});

export const TurnMetaSchema = z.object({
  task_id: z.string().min(1),
  turn_id: z.string().regex(/^\d{4}$/),
  created_at: z.string().datetime(),
  request_path: z.string().min(1)
});

export const NativeSessionSourceSchema = z.enum(["output-detected", "config", "manual", "claude-project-log", "unknown"]);

export const NativeSessionSchema = z.object({
  engine: EngineNameSchema,
  role: WorkerRoleSchema,
  worker_id: z.string().min(1),
  session_id: z.string().min(1),
  scope: z.enum(["main", "task"]),
  cwd: z.string().min(1),
  writable_dirs: z.array(z.string().min(1)).optional(),
  created_at: z.string().datetime(),
  last_used_at: z.string().datetime(),
  source: NativeSessionSourceSchema
});

export const ChatRecordSchema = z.object({
  time: z.string().datetime(),
  from: z.enum(["user", "system"]),
  text: z.string(),
  task_id: z.string().min(1).optional()
});

export const EventRecordSchema = z.object({
  time: z.string().datetime(),
  type: z.string().min(1),
  message: z.string().optional(),
  worker: z.string().optional(),
  engine: EngineNameSchema.optional(),
  task_id: z.string().optional()
});

export type RouteMode = z.infer<typeof RouteModeSchema>;
export type RouterFailureStage = z.infer<typeof RouterFailureStageSchema>;
export type EngineName = z.infer<typeof EngineNameSchema>;
export type WorkerRole = z.infer<typeof WorkerRoleSchema>;
export type TaskState = z.infer<typeof TaskStateSchema>;
export type WorkerState = z.infer<typeof WorkerStateSchema>;
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
export type TaskMeta = z.infer<typeof TaskMetaSchema>;
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;
export type TurnMeta = z.infer<typeof TurnMetaSchema>;
export type NativeSession = z.infer<typeof NativeSessionSchema>;
export type NativeSessionSource = z.infer<typeof NativeSessionSourceSchema>;
export type EventRecord = z.infer<typeof EventRecordSchema>;
export type ChatRecord = z.infer<typeof ChatRecordSchema>;
