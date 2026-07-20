import { z } from "zod";

export const RouteModeSchema = z.enum(["simple", "complex"]);
export const EngineNameSchema = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, "Worker id must start with a lowercase letter and contain only lowercase letters, digits or _");
export const WorkerRoleSchema = z.enum(["main", "judge", "actor", "critic"]);
export const RouterFailureStageSchema = z.enum([
  "spawn",
  "input",
  "waiting-output",
  "streaming",
  "exit",
  "response"
]);
export const RouterFallbackResolutionSchema = z.enum([
  "main",
  "parallel",
  "retry",
  "auto-retry",
  "cancelled",
  "configured"
]);
export const RouterFailureKindSchema = z.enum([
  "timeout",
  "auth",
  "rate-limit",
  "proxy",
  "network",
  "unavailable",
  "invalid-output",
  "exit",
  "input",
  "unknown"
]);
export const RouterProxySourceSchema = z.enum(["router-config", "environment"]);
export const RouterTimeoutKindSchema = z.enum(["first-output", "idle", "total"]);
export const RouterRecoveryTriggerSchema = z.enum(["retry", "auto-retry"]);
export const TaskIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^task-[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const TaskSessionIdSchema = z.union([z.literal("main"), TaskIdSchema]);
export const ConversationIdSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^conversation-[A-Za-z0-9][A-Za-z0-9._-]*$/);

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
  "paused",
  "done",
  "failed",
  "cancelled"
]);

export const TaskStatusTransitionSchema = z.object({
  id: z.string().min(1),
  from: TaskStateSchema,
  to: TaskStateSchema,
  at: z.string().datetime()
}).refine((transition) => transition.from !== transition.to, {
  message: "Task status transition must change state"
});

export const WorkerStateSchema = z.enum([
  "idle",
  "starting",
  "running",
  "waiting",
  "done",
  "failed",
  "cancelled"
]);

export const FeatureStateSchema = z.enum([
  "created",
  "queued",
  "actor_running",
  "actor_done",
  "critic_running",
  "critic_done",
  "revision_needed",
  "integrating",
  "verifying",
  "paused",
  "approved",
  "failed",
  "cancelled"
]);

export const RouteDecisionSchema = z.object({
  mode: RouteModeSchema,
  reason: z.string().min(1),
  source: z.enum(["codex", "forced", "fallback"]).optional(),
  duration_ms: z.number().nonnegative().optional(),
  router_dispatch_ms: z.number().nonnegative().optional(),
  router_spawn_ms: z.number().nonnegative().optional(),
  router_first_output_ms: z.number().nonnegative().optional(),
  router_first_stdout_ms: z.number().nonnegative().optional(),
  router_first_stderr_ms: z.number().nonnegative().optional(),
  router_process_ms: z.number().nonnegative().optional(),
  router_parse_ms: z.number().nonnegative().optional(),
  router_stdout_bytes: z.number().int().nonnegative().optional(),
  router_stderr_bytes: z.number().int().nonnegative().optional(),
  router_command: z.string().min(1).max(80).optional(),
  router_failure_stage: RouterFailureStageSchema.optional(),
  router_failure_kind: RouterFailureKindSchema.optional(),
  router_attempt: z.number().int().positive().optional(),
  router_total_duration_ms: z.number().nonnegative().optional(),
  router_fallback_resolution: RouterFallbackResolutionSchema.optional(),
  router_timeout_kind: RouterTimeoutKindSchema.optional(),
  router_recovered_from: RouterFailureKindSchema.optional(),
  router_recovered_via: RouterRecoveryTriggerSchema.optional(),
  router_recovered_timeout_kind: RouterTimeoutKindSchema.optional(),
  router_recovered_failure_stage: RouterFailureStageSchema.optional(),
  proxy_configured: z.boolean().optional(),
  proxy_source: RouterProxySourceSchema.optional(),
  proxy_variable: z.string().regex(/^(?:HTTP|HTTPS|ALL)_PROXY$/i).optional(),
  proxy_endpoint: z.string().min(1).max(255).optional(),
  suggested_roles: z.array(WorkerRoleSchema).default([]),
  judge_engine: EngineNameSchema.default("codex"),
  actor_engine: EngineNameSchema.default("codex"),
  critic_engine: EngineNameSchema.default("claude")
});

export const TaskMetaSchema = z.object({
  id: TaskIdSchema,
  title: z.string().min(1).max(160),
  created_at: z.string().datetime(),
  cwd: z.string().min(1),
  mode: RouteModeSchema,
  status: TaskStateSchema,
  archived_at: z.string().datetime().optional(),
  status_transition: TaskStatusTransitionSchema.optional().catch(undefined)
}).transform((meta) => {
  if (meta.status_transition && meta.status_transition.to !== meta.status) {
    const nextMeta = { ...meta };
    delete nextMeta.status_transition;
    return nextMeta;
  }
  return meta;
});

export const WorkerStatusSchema = z.object({
  worker_id: z.string().min(1),
  feature_id: z.string().min(1).optional(),
  feature_title: z.string().min(1).optional(),
  role: WorkerRoleSchema,
  engine: EngineNameSchema,
  model_name: z.string().optional(),
  model_provider: z.string().optional(),
  state: WorkerStateSchema,
  phase: z.string().min(1),
  last_event_at: z.string().datetime(),
  summary: z.string(),
  native_session_id: z.string().min(1).optional()
});

export const FeatureStatusSchema = z.object({
  feature_id: z.string().min(1),
  task_id: TaskIdSchema,
  turn_id: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().default(""),
  depends_on: z.array(z.string().min(1)).default([]),
  state: FeatureStateSchema,
  updated_at: z.string().datetime()
});

export const FeatureAssignmentSchema = z.object({
  version: z.literal(1),
  actor_engine: EngineNameSchema,
  critic_engine: EngineNameSchema,
  updated_at: z.string().datetime()
});

export const TurnMetaSchema = z.object({
  task_id: TaskIdSchema,
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

export const RetiredNativeSessionSchema = NativeSessionSchema.extend({
  retired_at: z.string().datetime(),
  retired_reason: z.string().min(1)
});

export const MainConversationStateSchema = z.object({
  version: z.literal(1),
  id: ConversationIdSchema,
  created_at: z.string().datetime(),
  previous_id: ConversationIdSchema.optional()
});

export const MainConversationArchiveSchema = z.object({
  version: z.literal(1),
  id: ConversationIdSchema.nullable(),
  created_at: z.string().datetime(),
  last_activated_at: z.string().datetime(),
  title: z.string().min(1).max(160).optional(),
  archived_at: z.string().datetime().optional()
});

export const ChatRecordSchema = z.object({
  time: z.string().datetime(),
  from: z.enum(["user", "system"]),
  text: z.string(),
  task_id: TaskIdSchema.optional(),
  conversation_id: ConversationIdSchema.optional()
});

export const EventRecordSchema = z.object({
  time: z.string().datetime(),
  type: z.string().min(1),
  message: z.string().optional(),
  worker: z.string().optional(),
  engine: EngineNameSchema.optional(),
  task_id: TaskSessionIdSchema.optional(),
  transition_id: z.string().min(1).optional(),
  from_state: TaskStateSchema.optional(),
  to_state: TaskStateSchema.optional()
});

export type RouteMode = z.infer<typeof RouteModeSchema>;
export type RouterFailureStage = z.infer<typeof RouterFailureStageSchema>;
export type RouterFallbackResolution = z.infer<typeof RouterFallbackResolutionSchema>;
export type RouterFailureKind = z.infer<typeof RouterFailureKindSchema>;
export type RouterRecoveryTrigger = z.infer<typeof RouterRecoveryTriggerSchema>;
export type EngineName = z.infer<typeof EngineNameSchema>;
export type WorkerRole = z.infer<typeof WorkerRoleSchema>;
export type TaskState = z.infer<typeof TaskStateSchema>;
export type TaskStatusTransition = z.infer<typeof TaskStatusTransitionSchema>;
export type WorkerState = z.infer<typeof WorkerStateSchema>;
export type FeatureState = z.infer<typeof FeatureStateSchema>;
export type RouterProxySource = z.infer<typeof RouterProxySourceSchema>;
export type RouterTimeoutKind = z.infer<typeof RouterTimeoutKindSchema>;
export type RouteDecision = z.infer<typeof RouteDecisionSchema>;
export type TaskMeta = z.infer<typeof TaskMetaSchema>;
export type WorkerStatus = z.infer<typeof WorkerStatusSchema>;
export type FeatureStatus = z.infer<typeof FeatureStatusSchema>;
export type FeatureAssignment = z.infer<typeof FeatureAssignmentSchema>;
export type TurnMeta = z.infer<typeof TurnMetaSchema>;
export type NativeSession = z.infer<typeof NativeSessionSchema>;
export type RetiredNativeSession = z.infer<typeof RetiredNativeSessionSchema>;
export type NativeSessionSource = z.infer<typeof NativeSessionSourceSchema>;
export type MainConversationState = z.infer<typeof MainConversationStateSchema>;
export type MainConversationArchive = z.infer<typeof MainConversationArchiveSchema>;
export type EventRecord = z.infer<typeof EventRecordSchema>;
export type ChatRecord = z.infer<typeof ChatRecordSchema>;
