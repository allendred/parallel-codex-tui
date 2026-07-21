import { z } from "zod";
import {
  EngineNameSchema,
  RouteDecisionSchema,
  TaskIdSchema,
  WorkerModelNameSchema,
  WorkerRoleSchema,
  WorkerStatusSchema
} from "../domain/schemas.js";
import type { RoleExecutionSelection } from "../core/role-configuration.js";
import type {
  HandleRequestResult,
  RouteStartInfo,
  WorkerLogRef,
  WorkerRunStatus
} from "../orchestrator/orchestrator.js";
import type { RouterExecutionProgress } from "../core/router.js";

const RoleExecutionTargetSchema = z.object({
  engine: EngineNameSchema,
  model: WorkerModelNameSchema
}).strict();

const RoleExecutionSelectionSchema = z.object({
  main: RoleExecutionTargetSchema,
  judge: RoleExecutionTargetSchema,
  actor: RoleExecutionTargetSchema,
  critic: RoleExecutionTargetSchema
}).strict();

const SupervisorRequestBaseSchema = z.object({
  version: z.literal(1),
  run_id: z.string().min(1),
  app_root: z.string().min(1),
  workspace_root: z.string().min(1),
  data_dir: z.string().min(1),
  created_at: z.string().datetime()
});

export const SupervisorRunRequestSchema = z.discriminatedUnion("kind", [
  SupervisorRequestBaseSchema.extend({
    kind: z.literal("handle-request"),
    request: z.string().min(1),
    cwd: z.string().min(1),
    route: RouteDecisionSchema.optional(),
    role_selection: RoleExecutionSelectionSchema.optional()
  }).strict(),
  SupervisorRequestBaseSchema.extend({
    kind: z.literal("handle-task-turn"),
    request: z.string().min(1),
    cwd: z.string().min(1),
    task_id: TaskIdSchema,
    route: RouteDecisionSchema.optional(),
    role_selection: RoleExecutionSelectionSchema.optional()
  }).strict(),
  SupervisorRequestBaseSchema.extend({
    kind: z.literal("answer-task-question"),
    request: z.string().min(1),
    cwd: z.string().min(1),
    task_id: TaskIdSchema,
    route: RouteDecisionSchema.optional(),
    role_selection: RoleExecutionSelectionSchema.optional()
  }).strict(),
  SupervisorRequestBaseSchema.extend({
    kind: z.literal("retry-task"),
    cwd: z.string().min(1),
    task_id: TaskIdSchema
  }).strict(),
  SupervisorRequestBaseSchema.extend({
    kind: z.literal("resume-feature"),
    cwd: z.string().min(1),
    task_id: TaskIdSchema,
    feature_id: z.string().min(1)
  }).strict()
]);

export type SupervisorRunRequest = z.infer<typeof SupervisorRunRequestSchema>;
export type SupervisorRunKind = SupervisorRunRequest["kind"];

export const SupervisorRunStatusSchema = z.enum([
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled"
]);
export type SupervisorRunStatus = z.infer<typeof SupervisorRunStatusSchema>;

const WorkerLogRefSchema = z.object({
  id: z.string().min(1),
  featureId: z.string().min(1).optional(),
  role: WorkerRoleSchema,
  engine: EngineNameSchema,
  label: z.string(),
  logPath: z.string().min(1),
  statusPath: z.string().min(1),
  runtimeStatus: WorkerStatusSchema.optional()
}).strict();

export const SupervisorRunResultSchema = z.object({
  mode: z.enum(["simple", "complex"]),
  taskId: TaskIdSchema.nullable(),
  summary: z.string(),
  workers: z.array(WorkerLogRefSchema)
}).strict();

export const SupervisorRunStateSchema = z.object({
  version: z.literal(1),
  run_id: z.string().min(1),
  kind: z.enum([
    "handle-request",
    "handle-task-turn",
    "answer-task-question",
    "retry-task",
    "resume-feature"
  ]),
  status: SupervisorRunStatusSchema,
  app_root: z.string().min(1),
  workspace_root: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  started_at: z.string().datetime().optional(),
  finished_at: z.string().datetime().optional(),
  task_id: TaskIdSchema.nullable().optional(),
  pid: z.number().int().positive().optional(),
  process_start_token: z.string().min(1).optional(),
  result: SupervisorRunResultSchema.optional(),
  error: z.string().optional()
}).strict();

export type SupervisorRunState = z.infer<typeof SupervisorRunStateSchema>;

export const SupervisorEventTypeSchema = z.enum([
  "route-start",
  "route-progress",
  "route",
  "status",
  "worker"
]);

export const SupervisorRunEventSchema = z.object({
  version: z.literal(1),
  sequence: z.number().int().nonnegative(),
  at: z.string().datetime(),
  type: SupervisorEventTypeSchema,
  payload: z.unknown()
}).strict();

export type SupervisorRunEvent = z.infer<typeof SupervisorRunEventSchema>;

export const SupervisorCommandSchema = z.discriminatedUnion("type", [
  z.object({
    version: z.literal(1),
    id: z.string().min(1),
    at: z.string().datetime(),
    type: z.literal("cancel-run")
  }).strict(),
  z.object({
    version: z.literal(1),
    id: z.string().min(1),
    at: z.string().datetime(),
    type: z.literal("cancel-feature"),
    task_id: TaskIdSchema,
    feature_id: z.string().min(1)
  }).strict(),
  z.object({
    version: z.literal(1),
    id: z.string().min(1),
    at: z.string().datetime(),
    type: z.literal("pause-feature"),
    task_id: TaskIdSchema,
    feature_id: z.string().min(1)
  }).strict()
]);

export type SupervisorCommand = z.infer<typeof SupervisorCommandSchema>;

export const SupervisorControllerSchema = z.object({
  version: z.literal(1),
  controller_id: z.string().min(1),
  pid: z.number().int().positive(),
  acquired_at: z.string().datetime(),
  process_start_token: z.string().min(1).optional()
}).strict();

export type SupervisorController = z.infer<typeof SupervisorControllerSchema>;

export interface SupervisorRunCallbacks {
  onRouteStart?: (state: RouteStartInfo) => void;
  onRouteProgress?: (state: RouterExecutionProgress) => void;
  onRoute?: (route: z.infer<typeof RouteDecisionSchema>) => void;
  onStatus?: (status: WorkerRunStatus) => void;
  onWorker?: (worker: WorkerLogRef) => void;
}

export function supervisorEventPayload(
  event: SupervisorRunEvent
): RouteStartInfo | RouterExecutionProgress | z.infer<typeof RouteDecisionSchema> | WorkerRunStatus | WorkerLogRef {
  switch (event.type) {
    case "route":
      return RouteDecisionSchema.parse(event.payload);
    case "worker":
      return WorkerLogRefSchema.parse(event.payload) as WorkerLogRef;
    case "route-progress":
      return z.object({ phase: z.enum([
        "dispatching",
        "starting",
        "retrying",
        "waiting-output",
        "receiving-stderr",
        "receiving-response",
        "parsing",
        "stopping"
      ]) }).parse(event.payload) as RouterExecutionProgress;
    case "route-start":
      return event.payload as RouteStartInfo;
    case "status":
      return event.payload as WorkerRunStatus;
  }
}

export function asSupervisorRunResult(value: unknown): HandleRequestResult {
  return SupervisorRunResultSchema.parse(value) as HandleRequestResult;
}

export function roleSelectionFromRequest(request: SupervisorRunRequest): RoleExecutionSelection | undefined {
  return "role_selection" in request ? request.role_selection : undefined;
}
