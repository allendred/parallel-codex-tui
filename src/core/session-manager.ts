import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  appendJsonLine,
  appendText,
  ensureDir,
  pathExists,
  readJson,
  readRecentJsonLines,
  readTextIfExists,
  removeIfExists,
  writeJson,
  writeText
} from "./file-store.js";
import { runWithLeaseFinalization } from "./lease-finalization.js";
import { sanitizePersistedMainMessage } from "./main-response.js";
import { formatTaskTimestamp, taskDir, taskSessionIdIsValid } from "./paths.js";
import { sessionsRoot } from "./paths.js";
import type { SessionIndex } from "./session-index.js";
import { loadCollaborationTimeline, type CollaborationTimeline } from "./collaboration-timeline.js";
import { taskStateTransitionAllowed } from "./task-state-machine.js";
import { processIsAlive, readProcessStartToken } from "./process-identity.js";
import {
  claimTaskRunLease,
  inspectTaskRunLease,
  TaskRunLeaseConflictError,
  terminateOwnedWorkerProcess,
  type TaskRunLease,
  type WorkerProcessTermination
} from "./process-ownership.js";
import {
  type ChatRecord,
  ChatRecordSchema,
  type EngineName,
  type EventRecord,
  EventRecordSchema,
  FeatureStatusSchema,
  type NativeSession,
  NativeSessionSchema,
  type RouteDecision,
  RouteDecisionSchema,
  RetiredNativeSessionSchema,
  type TaskMeta,
  TaskMetaSchema,
  TaskIdSchema,
  type TaskState,
  type TurnMeta,
  TurnMetaSchema,
  type WorkerRole,
  WorkerStatusSchema,
  type WorkerStatus
} from "../domain/schemas.js";

export interface SessionManagerOptions {
  projectRoot: string;
  dataDir: string;
  now?: () => Date;
  randomId?: () => string;
  index?: SessionIndex;
  claimTaskRunLease?: (dir: string) => Promise<TaskRunLease>;
}

export interface CreateTaskInput {
  request: string;
  cwd: string;
  route: RouteDecision;
}

export interface CreateTaskOptions {
  retainCreationClaim?: boolean;
}

export interface TaskSession {
  id: string;
  dir: string;
  metaPath: string;
  routePath: string;
  eventsPath: string;
}

export interface InitializeWorkerInput {
  workerId: string;
  featureId?: string;
  featureTitle?: string;
  role: WorkerRole;
  engine: EngineName;
  prompt: string;
  preserveOutput?: boolean;
}

export interface WorkerFiles {
  workerId: string;
  dir: string;
  promptPath: string;
  outputLogPath: string;
  statusPath: string;
}

export interface AppendTurnInput {
  request: string;
  route: RouteDecision;
}

export interface AppendChatMessageInput {
  from: ChatRecord["from"];
  text: string;
  taskId?: string;
}

export interface TaskTurn {
  turnId: string;
  dir: string;
  metaPath: string;
  userPath: string;
  routePath: string;
}

export interface InterruptedTaskRecovery {
  taskId: string;
  previousState: TaskState;
  workersRecovered: number;
  featuresRecovered: number;
  processesTerminated: number;
  turnsPublished?: number;
  turnsRepaired?: number;
  turnsAbandoned?: number;
}

export interface InterruptedMainSessionRecovery {
  workersRecovered: number;
  processesTerminated: number;
}

export interface PendingTaskCreationRecovery {
  published: number;
  abandoned: number;
  active: number;
  publishedTaskIds: string[];
}

export interface TaskSessionExport {
  taskId: string;
  path: string;
  createdAt: string;
}

type BlockingProcessTermination = Extract<WorkerProcessTermination, "unverifiable" | "still-running">;

interface PendingTurnDirectory {
  name: string;
  turnId: string;
  dir: string;
}

interface TurnReconciliationSummary {
  published: number;
  repaired: number;
  abandoned: number;
}

interface PendingTaskCreationDirectory {
  taskId: string;
  stagingDir: string;
  finalDir: string;
  claimPath: string;
}

export interface InterruptedTaskRecoveryBlock {
  workerId: string;
  processPath: string;
  reason: BlockingProcessTermination;
}

export class InterruptedTaskRecoveryBlockedError extends Error {
  constructor(
    readonly taskId: string,
    readonly blocks: InterruptedTaskRecoveryBlock[],
    subject = `task ${taskId}`
  ) {
    const details = blocks
      .map((block) => `${block.workerId} (${block.reason}; ${block.processPath})`)
      .join(", ");
    const stateLabel = subject === `task ${taskId}` ? "Task" : subject;
    super(
      `Startup recovery blocked for ${subject}: ${details}. `
      + `${stateLabel} state and checkpoints were left unchanged to prevent concurrent workers. `
      + "Verify or stop each recorded process, then restart parallel-codex-tui."
    );
    this.name = "InterruptedTaskRecoveryBlockedError";
  }
}

const TERMINAL_TASK_STATES = new Set<TaskState>(["done", "paused", "failed", "cancelled"]);
const ACTIVE_WORKER_STATES = new Set<WorkerStatus["state"]>(["idle", "starting", "running", "waiting"]);
const ACTIVE_FEATURE_STATES = new Set([
  "queued",
  "actor_running",
  "actor_done",
  "critic_running",
  "critic_done",
  "revision_needed",
  "integrating",
  "verifying"
]);
const PENDING_TURN_DIRECTORY = /^\.turn-(\d{4})-.+\.pending$/;
const PENDING_TASK_CREATION_CLAIM = /^\.(task-.+)\.creating\.json$/;
const CompletionContractSchema = z.object({
  version: z.literal(1),
  final_judge_required: z.literal(true)
});
const FinalAcceptanceEvidenceSchema = z.object({
  decision: z.literal("approved")
}).passthrough();
const FinalAcceptanceValidationSchema = z.object({
  version: z.literal(1),
  state: z.literal("valid"),
  decision: z.literal("approved"),
  issues: z.array(z.string()).length(0)
});
const TaskCreationOwnerSchema = z.object({
  version: z.literal(1),
  task_id: TaskIdSchema,
  pid: z.number().int().positive(),
  started_at: z.string().datetime(),
  process_start_token: z.string().min(1).optional()
});
type TaskCreationOwner = z.infer<typeof TaskCreationOwnerSchema>;

export class SessionManager {
  private readonly projectRoot: string;
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly index?: SessionIndex;
  private readonly claimTaskRunLease: (dir: string) => Promise<TaskRunLease>;

  constructor(options: SessionManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => Math.random().toString(16).slice(2, 6));
    this.index = options.index;
    this.claimTaskRunLease = options.claimTaskRunLease ?? claimTaskRunLease;
  }

  async createTask(input: CreateTaskInput, options: CreateTaskOptions = {}): Promise<TaskSession> {
    const createdAt = this.now();
    const baseId = `task-${formatTaskTimestamp(createdAt)}-${this.randomId()}`;
    const creation = await this.claimUniqueTaskDirectory(baseId, createdAt);
    const { taskId: id, stagingDir, finalDir } = creation;
    const meta: TaskMeta = {
      id,
      title: titleFromRequest(input.request),
      created_at: createdAt.toISOString(),
      cwd: input.cwd,
      mode: input.route.mode,
      status: "created"
    };

    const stagingTask: TaskSession = {
      id,
      dir: stagingDir,
      metaPath: join(stagingDir, "meta.json"),
      routePath: join(stagingDir, "route.json"),
      eventsPath: join(stagingDir, "events.jsonl")
    };
    const task = this.taskFromId(id);
    let published = false;

    try {
      await writeJson(stagingTask.metaPath, TaskMetaSchema.parse(meta));
      await writeText(join(stagingDir, "user-request.md"), `${input.request.trim()}\n`);
      await writeJson(stagingTask.routePath, RouteDecisionSchema.parse(input.route));
      const turn = await this.writeTurn(stagingTask, "0001", input.request, input.route, createdAt, false);
      await this.appendEvent(stagingTask, "task.created", "Task session created");
      await rename(stagingDir, finalDir);
      published = true;
      await this.updateTaskStatus(task, "routed");
      await this.index?.upsertTurn(task.id, await readJson(join(task.dir, "turns", turn.turnId, "turn.json"), TurnMetaSchema));
      await this.index?.setActiveTaskId(id);
      if (!options.retainCreationClaim) {
        await removeIfExists(creation.claimPath);
      }
      return task;
    } catch (error) {
      try {
        if (!published) {
          await rm(stagingDir, { recursive: true, force: true });
        }
        await removeIfExists(creation.claimPath);
      } catch {
        // Startup reconciliation can finish cleanup when immediate cleanup is unavailable.
      }
      throw error;
    }
  }

  async releaseTaskCreationClaim(task: Pick<TaskSession, "id">): Promise<void> {
    await removeIfExists(this.taskCreationClaimPath(task.id));
  }

  private async claimUniqueTaskDirectory(baseId: string, createdAt: Date): Promise<PendingTaskCreationDirectory> {
    const root = sessionsRoot(this.projectRoot, this.dataDir);
    await ensureDir(root);
    const processStartToken = await readProcessStartToken(process.pid);
    for (let attempt = 1; ; attempt += 1) {
      const id = attempt === 1 ? baseId : `${baseId}-${String(attempt).padStart(4, "0")}`;
      const claimPath = this.taskCreationClaimPath(id);
      const stagingDir = join(root, `.${id}.creating`);
      const finalDir = taskDir(this.projectRoot, this.dataDir, id);
      const owner = TaskCreationOwnerSchema.parse({
        version: 1,
        task_id: id,
        pid: process.pid,
        started_at: createdAt.toISOString(),
        ...(processStartToken ? { process_start_token: processStartToken } : {})
      });
      if (!(await writeJsonExclusive(claimPath, owner))) {
        continue;
      }
      try {
        if (await pathExists(finalDir)) {
          await removeIfExists(claimPath);
          continue;
        }
        await mkdir(stagingDir);
        return { taskId: id, stagingDir, finalDir, claimPath };
      } catch (error) {
        await removeIfExists(claimPath);
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          continue;
        }
        throw error;
      }
    }
  }

  private taskCreationClaimPath(taskId: string): string {
    return join(sessionsRoot(this.projectRoot, this.dataDir), `.${taskId}.creating.json`);
  }

  mainSessionDir(): string {
    return join(this.projectRoot, this.dataDir, "sessions", "main");
  }

  async reconcileInterruptedMainSession(): Promise<InterruptedMainSessionRecovery | null> {
    const main = this.taskFromId("main");
    if (!(await pathExists(main.dir))) {
      return null;
    }

    let recoveryLease: TaskRunLease;
    try {
      recoveryLease = await this.claimTaskRunLease(main.dir);
    } catch (error) {
      if (error instanceof TaskRunLeaseConflictError) {
        return null;
      }
      throw error;
    }

    return runWithLeaseFinalization("Main session startup recovery", recoveryLease, async () => {
      const workers = await this.reconcileTaskWorkers(main, "Main session");
      if (workers.recovered === 0 && workers.terminated === 0) {
        return null;
      }
      await this.appendEvent(
        main,
        "main.recovered_after_restart",
        `Recovered interrupted Main session; ${workers.recovered} active workers marked cancelled and ${workers.terminated} processes terminated`
      );
      return {
        workersRecovered: workers.recovered,
        processesTerminated: workers.terminated
      };
    });
  }

  async appendChatMessage(input: AppendChatMessageInput): Promise<void> {
    const record = ChatRecordSchema.parse({
      time: this.now().toISOString(),
      from: input.from,
      text: input.text,
      task_id: input.taskId
    });
    await appendJsonLine(join(this.mainSessionDir(), "chat.jsonl"), record);
  }

  async readChatHistory(limit = 200): Promise<ChatRecord[]> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(1000, Math.max(0, Math.trunc(limit)))
      : 200;
    const records = await readRecentJsonLines(
      join(this.mainSessionDir(), "chat.jsonl"),
      ChatRecordSchema,
      boundedLimit
    );
    return records.map((record) => ({
      ...record,
      text: sanitizePersistedMainMessage(record.from, record.text)
    }));
  }

  async readScopedChatHistory(taskId: string | null, limit = 200): Promise<ChatRecord[]> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(1000, Math.max(0, Math.trunc(limit)))
      : 200;
    const records = await readRecentJsonLines(
      join(this.mainSessionDir(), "chat.jsonl"),
      ChatRecordSchema,
      boundedLimit,
      {
        filter: (record) => taskId
          ? record.task_id === taskId
          : !record.task_id
      }
    );
    return records.map((record) => ({
      ...record,
      text: sanitizePersistedMainMessage(record.from, record.text)
    }));
  }

  taskFromId(taskId: string): TaskSession {
    const dir = taskDir(this.projectRoot, this.dataDir, taskId);
    return {
      id: taskId,
      dir,
      metaPath: join(dir, "meta.json"),
      routePath: join(dir, "route.json"),
      eventsPath: join(dir, "events.jsonl")
    };
  }

  async readCollaborationTimeline(taskId: string): Promise<CollaborationTimeline> {
    const task = this.taskFromId(taskId);
    if (!(await this.hasTask(taskId))) {
      throw new Error(`Task session not found: ${taskId}`);
    }
    return loadCollaborationTimeline(taskId, task.dir);
  }

  async hasTask(taskId: string): Promise<boolean> {
    if (!taskSessionIdIsValid(taskId) || taskId === "main") {
      return false;
    }
    const task = this.taskFromId(taskId);
    const meta = await readTaskMetaIfValid(task.metaPath);
    return meta?.id === taskId;
  }

  async renameTask(taskId: string, title: string): Promise<TaskMeta> {
    const normalizedTitle = normalizeTaskTitle(title);
    return this.withTaskManagementLease(taskId, "rename", async (task, meta) => {
      const next = TaskMetaSchema.parse({ ...meta, title: normalizedTitle });
      await writeJson(task.metaPath, next);
      await this.index?.upsertTask(next);
      await this.appendEvent(task, "task.renamed", `Task renamed to ${normalizedTitle}`);
      return next;
    });
  }

  async setTaskArchived(taskId: string, archived: boolean): Promise<TaskMeta> {
    return this.withTaskManagementLease(taskId, archived ? "archive" : "unarchive", async (task, meta) => {
      this.assertTerminalTask(meta, archived ? "archive" : "unarchive");
      if (archived && await this.index?.activeTaskId() === taskId) {
        throw new Error(`Cannot archive active task ${taskId}. Start a new task first.`);
      }
      const { archived_at: _archivedAt, ...withoutArchive } = meta;
      const next = TaskMetaSchema.parse(archived
        ? { ...withoutArchive, archived_at: this.now().toISOString() }
        : withoutArchive);
      await writeJson(task.metaPath, next);
      await this.index?.upsertTask(next);
      await this.appendEvent(
        task,
        archived ? "task.archived" : "task.unarchived",
        archived ? "Task session archived" : "Task session restored from archive"
      );
      return next;
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    if (await this.index?.activeTaskId() === taskId) {
      throw new Error(`Cannot delete active task ${taskId}. Start a new task first.`);
    }
    const deletedDir = await this.withTaskManagementLease(taskId, "delete", async (task, meta) => {
      this.assertTerminalTask(meta, "delete");
      if (await this.index?.activeTaskId() === taskId) {
        throw new Error(`Cannot delete active task ${taskId}. Start a new task first.`);
      }
      const target = join(
        sessionsRoot(this.projectRoot, this.dataDir),
        `.${taskId}.deleted-${randomUUID()}`
      );
      await rename(task.dir, target);
      try {
        await this.index?.deleteTask(taskId);
      } catch (error) {
        try {
          await rename(target, task.dir);
        } catch (rollbackError) {
          throw new Error(
            `Task index deletion failed and session rollback also failed: ${errorMessage(error)}; ${errorMessage(rollbackError)}`,
            { cause: new AggregateError([error, rollbackError]) }
          );
        }
        throw error;
      }
      return target;
    });
    await rm(deletedDir, { force: true, recursive: true });
  }

  async exportTask(taskId: string): Promise<TaskSessionExport> {
    return this.withTaskManagementLease(taskId, "export", async (task, meta) => {
      this.assertTerminalTask(meta, "export");
      const createdAt = this.now().toISOString();
      const exportsRoot = join(this.projectRoot, this.dataDir, "exports");
      await ensureDir(exportsRoot);
      const staging = await mkdtemp(join(exportsRoot, `.${taskId}-`));
      const suffix = basename(staging).slice(-6);
      const stamp = createdAt.replace(/[^0-9]/g, "").slice(0, 14);
      const destination = join(exportsRoot, `${taskId}-${stamp}-${suffix}`);
      try {
        await this.appendEvent(task, "task.exported", "Task session exported");
        await writeJson(join(staging, "manifest.json"), {
          format: "parallel-codex-task-export-v1",
          exported_at: createdAt,
          source_workspace: this.projectRoot,
          session_path: "session",
          task: await this.readMeta(task)
        });
        await cp(task.dir, join(staging, "session"), {
          recursive: true,
          preserveTimestamps: true,
          verbatimSymlinks: true,
          filter: (source) => !isTransientTaskLeasePath(task.dir, source)
        });
        await rename(staging, destination);
      } catch (error) {
        await rm(staging, { force: true, recursive: true });
        throw error;
      }
      return { taskId, path: destination, createdAt };
    });
  }

  async reconcilePendingTaskCreations(): Promise<PendingTaskCreationRecovery> {
    const report: PendingTaskCreationRecovery = {
      published: 0,
      abandoned: 0,
      active: 0,
      publishedTaskIds: []
    };
    for (const pending of await this.pendingTaskCreationDirectories()) {
      const owner = await readTaskCreationOwnerIfValid(pending.claimPath);
      if (owner?.task_id === pending.taskId && await taskCreationOwnerIsActive(owner)) {
        report.active += 1;
        continue;
      }

      const finalTask = this.taskFromId(pending.taskId);
      const finalMeta = await readTaskMetaIfValid(finalTask.metaPath);
      if (finalMeta) {
        await this.projectPublishedTaskCreation(pending.taskId, finalMeta);
        if (await pathExists(pending.stagingDir)) {
          await this.quarantinePendingTaskCreation(pending);
          report.abandoned += 1;
        } else {
          report.published += 1;
          report.publishedTaskIds.push(pending.taskId);
        }
        await removeIfExists(pending.claimPath);
        continue;
      }

      const snapshot = await this.readCompletePendingTaskCreation(pending);
      if (snapshot) {
        if (!(await pathExists(pending.finalDir))) {
          try {
            await rename(pending.stagingDir, pending.finalDir);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== "ENOENT" && code !== "EEXIST") {
              throw error;
            }
          }
        }
        const publishedMeta = await readTaskMetaIfValid(finalTask.metaPath);
        if (publishedMeta) {
          await removeIfExists(pending.claimPath);
          await this.projectPublishedTaskCreation(pending.taskId, publishedMeta);
          report.published += 1;
          report.publishedTaskIds.push(pending.taskId);
          continue;
        }
      }

      const racedMeta = await readTaskMetaIfValid(finalTask.metaPath);
      if (racedMeta) {
        await removeIfExists(pending.claimPath);
        await this.projectPublishedTaskCreation(pending.taskId, racedMeta);
        report.published += 1;
        report.publishedTaskIds.push(pending.taskId);
        continue;
      }

      let archived = false;
      if (await pathExists(pending.stagingDir)) {
        archived = await this.quarantinePendingTaskCreation(pending);
      }
      if (!archived) {
        const concurrentlyPublishedMeta = await readTaskMetaIfValid(finalTask.metaPath);
        if (concurrentlyPublishedMeta) {
          await removeIfExists(pending.claimPath);
          await this.projectPublishedTaskCreation(pending.taskId, concurrentlyPublishedMeta);
          report.published += 1;
          report.publishedTaskIds.push(pending.taskId);
          continue;
        }
      }
      await removeIfExists(pending.claimPath);
      report.abandoned += 1;
    }
    return report;
  }

  async reconcileInterruptedTasks(): Promise<InterruptedTaskRecovery[]> {
    const root = sessionsRoot(this.projectRoot, this.dataDir);
    if (!(await pathExists(root))) {
      return [];
    }

    const entries = await readdir(root, { withFileTypes: true });
    const recovered: InterruptedTaskRecovery[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !TaskIdSchema.safeParse(entry.name).success) {
        continue;
      }
      const task = this.taskFromId(entry.name);
      if (await this.taskCreationClaimIsActive(task.id)) {
        continue;
      }
      const meta = await readTaskMetaIfValid(task.metaPath);
      if (!meta || meta.id !== task.id) {
        continue;
      }
      const needsTaskRecovery = await this.taskNeedsRecovery(task, meta);
      const needsTransitionRepair = await this.taskStatusTransitionNeedsRepair(task, meta);
      const needsTurnReconciliation = (await this.pendingTurnDirectories(task)).length > 0;
      if (!needsTaskRecovery && !needsTransitionRepair && !needsTurnReconciliation) {
        continue;
      }
      let recoveryLease: TaskRunLease;
      try {
        recoveryLease = await this.claimTaskRunLease(task.dir);
      } catch (error) {
        if (error instanceof TaskRunLeaseConflictError) {
          continue;
        }
        throw error;
      }

      const recovery = await runWithLeaseFinalization(
        `Task ${task.id} startup recovery`,
        recoveryLease,
        async (): Promise<InterruptedTaskRecovery | null> => {
          const claimedMeta = await readTaskMetaIfValid(task.metaPath);
          if (!claimedMeta) {
            return null;
          }
          const turns = await this.reconcilePendingTurns(task);
          const claimedNeedsTaskRecovery = await this.taskNeedsRecovery(task, claimedMeta);
          const claimedNeedsTransitionRepair = await this.taskStatusTransitionNeedsRepair(task, claimedMeta);
          if (!claimedNeedsTaskRecovery && !claimedNeedsTransitionRepair) {
            return null;
          }
          if (claimedNeedsTransitionRepair) {
            await this.syncTaskStatusTransition(task, claimedMeta);
          }
          if (!claimedNeedsTaskRecovery) {
            return null;
          }
          const workers = await this.reconcileTaskWorkers(task);
          const featuresRecovered = await this.reconcileTaskFeatures(task);
          await this.updateTaskStatus(task, "cancelled");
          await this.appendEvent(
            task,
            claimedMeta.status === "done" ? "task.recovered_incomplete_done" : "task.recovered_after_restart",
            claimedMeta.status === "done"
              ? `Recovered incomplete done task; ${workers.recovered} active workers and ${featuresRecovered} active features marked cancelled, checkpoints preserved`
              : `Recovered interrupted task from ${claimedMeta.status}; ${workers.recovered} active workers and ${featuresRecovered} active features marked cancelled, checkpoints preserved`
          );
          return {
            taskId: task.id,
            previousState: claimedMeta.status,
            workersRecovered: workers.recovered,
            featuresRecovered,
            processesTerminated: workers.terminated,
            ...(turns.published > 0 ? { turnsPublished: turns.published } : {}),
            ...(turns.repaired > 0 ? { turnsRepaired: turns.repaired } : {}),
            ...(turns.abandoned > 0 ? { turnsAbandoned: turns.abandoned } : {})
          };
        }
      );
      if (recovery) {
        recovered.push(recovery);
      }
    }
    return recovered;
  }

  async latestTask(): Promise<TaskSession | null> {
    const root = sessionsRoot(this.projectRoot, this.dataDir);
    if (!(await pathExists(root))) {
      return null;
    }

    const entries = await readdir(root, { withFileTypes: true });
    const tasks: TaskMeta[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !TaskIdSchema.safeParse(entry.name).success) {
        continue;
      }
      const metaPath = join(root, entry.name, "meta.json");
      if (await pathExists(metaPath)) {
        const meta = await readTaskMetaIfValid(metaPath);
        if (!meta) {
          continue;
        }
        if (meta.id === entry.name && meta.mode === "complex" && !meta.archived_at) {
          tasks.push(meta);
        }
      }
    }

    const latest = tasks.sort((left, right) => (
      left.created_at.localeCompare(right.created_at)
      || left.id.localeCompare(right.id)
    )).at(-1);
    if (!latest) {
      return null;
    }

    const dir = taskDir(this.projectRoot, this.dataDir, latest.id);
    return {
      id: latest.id,
      dir,
      metaPath: join(dir, "meta.json"),
      routePath: join(dir, "route.json"),
      eventsPath: join(dir, "events.jsonl")
    };
  }

  async appendTurn(task: TaskSession, input: AppendTurnInput): Promise<TaskTurn> {
    await this.indexTaskFromFiles(task);
    await this.backfillInitialTurn(task, input.route);
    const turnId = await this.nextTurnId(task);
    const turn = await this.writeTurn(task, turnId, input.request, input.route, this.now());
    await this.appendEvent(task, "turn.created", `Turn ${turnId} created`);
    if (await readTaskMetaIfValid(task.metaPath)) {
      await this.updateTaskStatus(task, "routed");
    }
    return turn;
  }

  async latestTurn(task: Pick<TaskSession, "id" | "dir">): Promise<TaskTurn | null> {
    const root = join(task.dir, "turns");
    if (!(await pathExists(root))) {
      return null;
    }
    const entries = await readdir(root, { withFileTypes: true });
    const turnId = entries
      .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .at(-1);

    if (!turnId) {
      return null;
    }

    return this.turnFiles(task, turnId);
  }

  async readLatestRoute(task: TaskSession): Promise<RouteDecision | null> {
    const latestTaskRoute = await readRouteDecisionIfValid(join(task.dir, "latest-route.json"));
    if (latestTaskRoute) {
      return latestTaskRoute;
    }
    const latestTurn = await this.latestTurn(task);
    if (latestTurn) {
      const latestRoute = await readRouteDecisionIfValid(latestTurn.routePath);
      if (latestRoute) {
        return latestRoute;
      }
    }
    return readRouteDecisionIfValid(task.routePath);
  }

  async recordLatestRoute(task: Pick<TaskSession, "dir">, route: RouteDecision): Promise<void> {
    await writeJson(join(task.dir, "latest-route.json"), RouteDecisionSchema.parse(route));
  }

  async readMeta(task: TaskSession): Promise<TaskMeta> {
    return readJson(task.metaPath, TaskMetaSchema);
  }

  async updateTaskStatus(task: TaskSession, status: TaskMeta["status"]): Promise<void> {
    const meta = await this.readMeta(task);
    if (meta.status !== status && await this.taskStatusTransitionNeedsRepair(task, meta)) {
      await this.syncTaskStatusTransition(task, meta);
    }
    if (meta.status === status) {
      await this.syncTaskStatusTransition(task, meta);
      return;
    }
    const completeEvidence = status === "done" || meta.status === "done"
      ? await this.hasCompleteTaskEvidence(task)
      : false;
    if (meta.status === "done" && completeEvidence) {
      throw new Error(`Task ${task.id} is completely done and cannot move backward to ${status}.`);
    }
    if (!taskStateTransitionAllowed(meta.status, status)) {
      throw new Error(`Task ${task.id} cannot move from ${meta.status} to ${status}.`);
    }
    if (status === "done" && !completeEvidence) {
      throw new Error(`Task ${task.id} cannot move to done before latest-turn completion evidence is published.`);
    }
    const nextMeta = TaskMetaSchema.parse({
      ...meta,
      status,
      status_transition: {
        id: randomUUID(),
        from: meta.status,
        to: status,
        at: this.now().toISOString()
      }
    });
    await writeJson(task.metaPath, nextMeta);
    await this.syncTaskStatusTransition(task, nextMeta);
  }

  async initializeWorker(task: TaskSession, input: InitializeWorkerInput): Promise<WorkerFiles> {
    const dir = join(task.dir, input.workerId);
    const promptPath = join(dir, "prompt.md");
    const outputLogPath = join(dir, "output.log");
    const statusPath = join(dir, "status.json");
    const status: WorkerStatus = {
      worker_id: input.workerId,
      ...(input.featureId ? { feature_id: input.featureId } : {}),
      ...(input.featureTitle ? { feature_title: input.featureTitle } : {}),
      role: input.role,
      engine: input.engine,
      state: "idle",
      phase: "initialized",
      last_event_at: this.now().toISOString(),
      summary: "Worker initialized"
    };

    await ensureDir(dir);
    await this.clearWorkerArtifacts(dir, input.role);
    await writeText(promptPath, input.prompt);
    if (await pathExists(outputLogPath)) {
      const continuation = input.preserveOutput ? "retry" : "resume";
      await appendText(outputLogPath, `\n--- ${continuation} ${this.now().toISOString()} ---\n`);
    } else {
      await writeText(outputLogPath, "");
    }
    await writeJson(statusPath, status);
    await this.index?.upsertWorker(task.id, status, {
      dir,
      statusPath,
      outputLogPath
    });

    return {
      workerId: input.workerId,
      dir,
      promptPath,
      outputLogPath,
      statusPath
    };
  }

  async readNativeSession(worker: Pick<WorkerFiles, "dir">): Promise<NativeSession | null> {
    const path = join(worker.dir, "native-session.json");
    const retired = await readRetiredNativeSessionIfValid(join(worker.dir, "native-session.retired.json"));
    if (!(await pathExists(path))) {
      if (retired) {
        await this.finalizeNativeSessionRetirement(worker, retired.session_id);
      }
      return null;
    }
    let active: NativeSession;
    try {
      active = await readJson(path, NativeSessionSchema);
    } catch {
      await removeIfExists(path);
      await this.clearWorkerStatusNativeSession(worker);
      await this.index?.deleteNativeSession(this.taskIdFromWorkerDir(worker.dir), this.workerIdFromWorkerDir(worker.dir));
      return null;
    }
    if (retired?.session_id === active.session_id) {
      await this.finalizeNativeSessionRetirement(worker, active.session_id);
      return null;
    }
    await this.syncNativeSessionProjection(worker, active);
    return active;
  }

  async hasRetiredNativeSession(worker: Pick<WorkerFiles, "dir">): Promise<boolean> {
    return Boolean(await readRetiredNativeSessionIfValid(join(worker.dir, "native-session.retired.json")));
  }

  async reconcileNativeSessionState(): Promise<number> {
    const root = sessionsRoot(this.projectRoot, this.dataDir);
    if (!(await pathExists(root))) {
      return 0;
    }

    let reconciled = 0;
    const sessionEntries = await readdir(root, { withFileTypes: true });
    for (const sessionEntry of sessionEntries) {
      if (
        !sessionEntry.isDirectory()
        || (sessionEntry.name !== "main" && !TaskIdSchema.safeParse(sessionEntry.name).success)
      ) {
        continue;
      }
      const sessionDir = join(root, sessionEntry.name);
      const lease = await inspectTaskRunLease(sessionDir);
      if (lease.state === "active") {
        continue;
      }

      const workerEntries = await readdir(sessionDir, { withFileTypes: true });
      for (const workerEntry of workerEntries) {
        if (!workerEntry.isDirectory()) {
          continue;
        }
        const worker = { dir: join(sessionDir, workerEntry.name) };
        const activePath = join(worker.dir, "native-session.json");
        const retiredPath = join(worker.dir, "native-session.retired.json");
        const statusPath = join(worker.dir, "status.json");
        const [hasActive, hasRetired, hasStatus] = await Promise.all([
          pathExists(activePath),
          pathExists(retiredPath),
          pathExists(statusPath)
        ]);
        if (!hasActive && !hasRetired && !hasStatus) {
          continue;
        }
        const retired = await readRetiredNativeSessionIfValid(retiredPath);
        const active = await readNativeSessionIfValid(activePath);
        if (retired && (!active || active.session_id === retired.session_id)) {
          await this.finalizeNativeSessionRetirement(worker, retired.session_id);
          reconciled += 1;
          continue;
        }
        if (active) {
          await this.syncNativeSessionProjection(worker, active);
          continue;
        }
        await removeIfExists(activePath);
        await this.clearWorkerStatusNativeSession(worker);
        await this.index?.deleteNativeSession(
          this.taskIdFromWorkerDir(worker.dir),
          this.workerIdFromWorkerDir(worker.dir)
        );
      }
    }
    return reconciled;
  }

  async writeNativeSession(worker: Pick<WorkerFiles, "dir">, record: NativeSession): Promise<void> {
    const active = NativeSessionSchema.parse(record);
    await writeJson(join(worker.dir, "native-session.json"), active);
    await this.syncNativeSessionProjection(worker, active);
  }

  async retireNativeSession(worker: Pick<WorkerFiles, "dir">, reason: string): Promise<void> {
    const nativeSessionPath = join(worker.dir, "native-session.json");
    if (!(await pathExists(nativeSessionPath))) {
      return;
    }
    const record = await readNativeSessionIfValid(nativeSessionPath);
    if (!record) {
      await removeIfExists(nativeSessionPath);
      await this.clearWorkerStatusNativeSession(worker);
      await this.index?.deleteNativeSession(this.taskIdFromWorkerDir(worker.dir), this.workerIdFromWorkerDir(worker.dir));
      return;
    }

    await writeJson(join(worker.dir, "native-session.retired.json"), {
      ...record,
      retired_at: this.now().toISOString(),
      retired_reason: reason
    });
    await removeIfExists(nativeSessionPath);
    await this.clearWorkerStatusNativeSession(worker);
    await this.index?.deleteNativeSession(this.taskIdFromWorkerDir(worker.dir), record.worker_id);
  }

  async appendEvent(task: Pick<TaskSession, "id" | "dir">, type: string, message: string): Promise<void> {
    const event: EventRecord = {
      time: this.now().toISOString(),
      type,
      message,
      task_id: task.id
    };

    await appendJsonLine(join(task.dir, "events.jsonl"), event);
  }

  private async withTaskManagementLease<Result>(
    taskId: string,
    operation: string,
    run: (task: TaskSession, meta: TaskMeta) => Promise<Result>
  ): Promise<Result> {
    const id = TaskIdSchema.parse(taskId);
    const task = this.taskFromId(id);
    if (!(await this.hasTask(id))) {
      throw new Error(`Task session not found: ${id}`);
    }
    const lease = await this.claimTaskRunLease(task.dir);
    return runWithLeaseFinalization(`Task ${operation}`, lease, async () => {
      const meta = await this.readMeta(task);
      if (meta.id !== id) {
        throw new Error(`Task session metadata does not match ${id}.`);
      }
      return run(task, meta);
    });
  }

  private assertTerminalTask(meta: TaskMeta, operation: string): void {
    if (!TERMINAL_TASK_STATES.has(meta.status)) {
      throw new Error(`Cannot ${operation} task ${meta.id} while it is ${meta.status}.`);
    }
  }

  private async syncTaskStatusTransition(task: TaskSession, meta: TaskMeta): Promise<void> {
    const transition = meta.status_transition;
    if (transition && !(await this.hasTaskStatusTransitionEvent(task, transition.id))) {
      const event = EventRecordSchema.parse({
        time: transition.at,
        type: `task.${transition.to}`,
        message: `Task moved from ${transition.from} to ${transition.to}`,
        task_id: task.id,
        transition_id: transition.id,
        from_state: transition.from,
        to_state: transition.to
      });
      await appendJsonLine(task.eventsPath, event);
    }
    await this.index?.upsertTask(meta);
  }

  private async hasTaskStatusTransitionEvent(task: TaskSession, transitionId: string): Promise<boolean> {
    const events = await readTextIfExists(task.eventsPath);
    for (const line of events.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const event = EventRecordSchema.safeParse(JSON.parse(line));
        if (event.success && event.data.transition_id === transitionId) {
          return true;
        }
      } catch {
        // A corrupt audit row does not invalidate later transition evidence.
      }
    }
    return false;
  }

  private async nextTurnId(task: Pick<TaskSession, "id" | "dir">): Promise<string> {
    const latest = await this.latestTurn(task);
    if (!latest) {
      return (await pathExists(join(task.dir, "user-request.md"))) ? "0002" : "0001";
    }
    return String(Number(latest.turnId) + 1).padStart(4, "0");
  }

  private async taskNeedsRecovery(task: TaskSession, meta: TaskMeta): Promise<boolean> {
    if (!TERMINAL_TASK_STATES.has(meta.status)) {
      return true;
    }
    if (meta.status !== "done" || await this.hasCompleteTaskEvidence(task)) {
      return false;
    }
    const latestTurn = await this.latestTurn(task);
    return Boolean(
      latestTurn
      && (
        latestTurn.turnId !== "0001"
        || await this.hasIntegratedLatestTurnCheckpoint(task)
      )
    );
  }

  private async taskStatusTransitionNeedsRepair(task: TaskSession, meta: TaskMeta): Promise<boolean> {
    const transitionId = meta.status_transition?.id;
    return Boolean(transitionId && !(await this.hasTaskStatusTransitionEvent(task, transitionId)));
  }

  private async hasIntegratedLatestTurnCheckpoint(task: TaskSession): Promise<boolean> {
    const latestTurn = await this.latestTurn(task);
    if (!latestTurn) {
      return false;
    }
    const root = join(task.dir, "workspaces", `turn-${latestTurn.turnId}`);
    if (!(await pathExists(root))) {
      return false;
    }
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^wave-\d{4}$/.test(entry.name)) {
        continue;
      }
      try {
        const value: unknown = JSON.parse(await readTextIfExists(join(root, entry.name, "integration.json")));
        if (
          value
          && typeof value === "object"
          && !Array.isArray(value)
          && (value as Record<string, unknown>).state === "integrated"
        ) {
          return true;
        }
      } catch {
        // A corrupt integration record is not proof that live commit completed.
      }
    }
    return false;
  }

  private async hasCompleteTaskEvidence(task: TaskSession): Promise<boolean> {
    const latestTurn = await this.latestTurn(task);
    if (!latestTurn) {
      return false;
    }
    if (!(await readTextIfExists(join(latestTurn.dir, "supervisor-summary.md"))).trim()) {
      return false;
    }

    const completionContractPath = join(latestTurn.dir, "completion-contract.json");
    if (await pathExists(completionContractPath)) {
      try {
        await readJson(completionContractPath, CompletionContractSchema);
        await readJson(join(latestTurn.dir, "final-acceptance.json"), FinalAcceptanceEvidenceSchema);
        await readJson(join(latestTurn.dir, "final-acceptance-validation.json"), FinalAcceptanceValidationSchema);
      } catch {
        return false;
      }
    }

    const featuresRoot = join(task.dir, "features");
    if (!(await pathExists(featuresRoot))) {
      return true;
    }
    const entries = await readdir(featuresRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const belongsToLatestTurn = entry.name === latestTurn.turnId
        || entry.name.startsWith(`${latestTurn.turnId}-`);
      const statusPath = join(featuresRoot, entry.name, "status.json");
      try {
        const status = await readJson(statusPath, FeatureStatusSchema);
        const statusIsLatestTurn = status.turn_id === latestTurn.turnId;
        if (belongsToLatestTurn !== statusIsLatestTurn) {
          return false;
        }
        if (
          statusIsLatestTurn
          && (
            status.feature_id !== entry.name
            || status.task_id !== task.id
            || status.state !== "approved"
          )
        ) {
          return false;
        }
      } catch {
        if (belongsToLatestTurn) {
          return false;
        }
      }
    }
    return true;
  }

  private async reconcileTaskWorkers(
    task: TaskSession,
    recoverySubject = `task ${task.id}`
  ): Promise<{ recovered: number; terminated: number }> {
    const entries = await readdir(task.dir, { withFileTypes: true });
    const workerDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ workerId: entry.name, dir: join(task.dir, entry.name) }));
    let terminated = 0;
    const blocks: InterruptedTaskRecoveryBlock[] = [];
    for (const worker of workerDirs) {
      const dir = worker.dir;
      const processResult = await terminateOwnedWorkerProcess(dir);
      if (processResult === "terminated") {
        terminated += 1;
      }
      if (processResult === "unverifiable" || processResult === "still-running") {
        blocks.push({
          workerId: worker.workerId,
          processPath: join(dir, "process.json"),
          reason: processResult
        });
      }
    }
    if (blocks.length > 0) {
      await this.appendEvent(
        task,
        task.id === "main" ? "main.recovery_blocked" : "task.recovery_blocked",
        `Startup recovery blocked by ${blocks.map((block) => `${block.workerId}:${block.reason}`).join(", ")}; ${recoverySubject} state left unchanged`
      );
      throw new InterruptedTaskRecoveryBlockedError(task.id, blocks, recoverySubject);
    }

    let recovered = 0;
    for (const worker of workerDirs) {
      const dir = worker.dir;
      const statusPath = join(dir, "status.json");
      const status = await readWorkerStatusIfValid(statusPath);
      if (!status || !ACTIVE_WORKER_STATES.has(status.state)) {
        continue;
      }
      const nextStatus: WorkerStatus = WorkerStatusSchema.parse({
        ...status,
        state: "cancelled",
        phase: "orphaned-after-restart",
        last_event_at: this.now().toISOString(),
        summary: "Previous TUI exited before this worker finished; checkpoint is ready to retry"
      });
      await writeJson(statusPath, nextStatus);
      const outputLogPath = join(dir, "output.log");
      await appendText(outputLogPath, "\nRecovered after previous TUI exit; worker marked cancelled for checkpoint retry.\n");
      await this.index?.upsertWorker(task.id, nextStatus, { dir, statusPath, outputLogPath });
      recovered += 1;
    }
    return { recovered, terminated };
  }

  private async reconcileTaskFeatures(task: TaskSession): Promise<number> {
    const root = join(task.dir, "features");
    if (!(await pathExists(root))) {
      return 0;
    }
    const entries = await readdir(root, { withFileTypes: true });
    let recovered = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const statusPath = join(root, entry.name, "status.json");
      if (!(await pathExists(statusPath))) {
        continue;
      }
      try {
        const status = await readJson(statusPath, FeatureStatusSchema);
        if (!ACTIVE_FEATURE_STATES.has(status.state)) {
          continue;
        }
        await writeJson(statusPath, FeatureStatusSchema.parse({
          ...status,
          state: "cancelled",
          updated_at: this.now().toISOString()
        }));
        recovered += 1;
      } catch {
        // Corrupt feature evidence must not prevent other task checkpoints from being recovered.
      }
    }
    return recovered;
  }

  private async indexTaskFromFiles(task: TaskSession): Promise<void> {
    if (!this.index || !(await pathExists(task.metaPath))) {
      return;
    }
    const meta = await readTaskMetaIfValid(task.metaPath);
    if (meta?.id === task.id) {
      await this.index.upsertTask(meta);
    }
  }

  private async pendingTaskCreationDirectories(): Promise<PendingTaskCreationDirectory[]> {
    const root = sessionsRoot(this.projectRoot, this.dataDir);
    if (!(await pathExists(root))) {
      return [];
    }
    const entries = await readdir(root, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const match = entry.isFile() ? entry.name.match(PENDING_TASK_CREATION_CLAIM) : null;
      if (!match?.[1]) {
        return [];
      }
      const taskId = match[1];
      if (!TaskIdSchema.safeParse(taskId).success) {
        return [];
      }
      return [{
        taskId,
        stagingDir: join(root, `.${taskId}.creating`),
        finalDir: taskDir(this.projectRoot, this.dataDir, taskId),
        claimPath: join(root, entry.name)
      }];
    }).sort((left, right) => left.taskId.localeCompare(right.taskId));
  }

  private async taskCreationClaimIsActive(taskId: string): Promise<boolean> {
    const owner = await readTaskCreationOwnerIfValid(this.taskCreationClaimPath(taskId));
    return Boolean(owner?.task_id === taskId && await taskCreationOwnerIsActive(owner));
  }

  private async readCompletePendingTaskCreation(
    pending: PendingTaskCreationDirectory
  ): Promise<{ meta: TaskMeta; turn: TurnMeta } | null> {
    return this.readCompleteTaskCreation(pending.stagingDir, pending.taskId);
  }

  private async readCompleteTaskCreation(
    directory: string,
    taskId: string
  ): Promise<{ meta: TaskMeta; turn: TurnMeta } | null> {
    try {
      const firstTurnDir = join(directory, "turns", "0001");
      const [meta, route, request, turn, turnRoute, turnRequest] = await Promise.all([
        readTaskMetaIfValid(join(directory, "meta.json")),
        readRouteDecisionIfValid(join(directory, "route.json")),
        readTextIfExists(join(directory, "user-request.md")),
        readTurnMetaIfValid(join(firstTurnDir, "turn.json")),
        readRouteDecisionIfValid(join(firstTurnDir, "route.json")),
        readTextIfExists(join(firstTurnDir, "user.md"))
      ]);
      if (
        !meta
        || !route
        || !turn
        || !turnRoute
        || !request.trim()
        || request.trim() !== turnRequest.trim()
        || meta.id !== taskId
        || meta.mode !== route.mode
        || turn.task_id !== taskId
        || turn.turn_id !== "0001"
        || turn.request_path !== "turns/0001/user.md"
        || turnRoute.mode !== route.mode
      ) {
        return null;
      }
      return { meta, turn };
    } catch {
      return null;
    }
  }

  private async projectPublishedTaskCreation(taskId: string, meta: TaskMeta): Promise<void> {
    if (!this.index) {
      return;
    }
    await this.index.upsertTask(meta);
    const snapshot = await this.readCompleteTaskCreation(this.taskFromId(taskId).dir, taskId);
    if (snapshot) {
      await this.index.upsertTurn(taskId, snapshot.turn);
    }
  }

  private async quarantinePendingTaskCreation(pending: PendingTaskCreationDirectory): Promise<boolean> {
    const root = join(sessionsRoot(this.projectRoot, this.dataDir), ".abandoned");
    await ensureDir(root);
    const name = basename(pending.stagingDir);
    const preferred = join(root, name);
    const destination = await pathExists(preferred)
      ? join(root, `${name}.${randomUUID()}`)
      : preferred;
    try {
      await rename(pending.stagingDir, destination);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  private async pendingTurnDirectories(
    task: Pick<TaskSession, "dir">
  ): Promise<PendingTurnDirectory[]> {
    const root = join(task.dir, "turns");
    if (!(await pathExists(root))) {
      return [];
    }
    const entries = await readdir(root, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const match = entry.isDirectory() ? entry.name.match(PENDING_TURN_DIRECTORY) : null;
      return match?.[1]
        ? [{ name: entry.name, turnId: match[1], dir: join(root, entry.name) }]
        : [];
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  private async reconcilePendingTurns(task: TaskSession): Promise<TurnReconciliationSummary> {
    const summary: TurnReconciliationSummary = { published: 0, repaired: 0, abandoned: 0 };
    for (const pending of await this.pendingTurnDirectories(task)) {
      const files = this.turnFiles(task, pending.turnId);
      if (await pathExists(files.dir)) {
        await this.quarantinePendingTurn(task, pending);
        await this.appendEvent(
          task,
          "turn.pending_abandoned",
          `Archived pending turn ${pending.turnId} because the committed turn already exists`
        );
        summary.abandoned += 1;
        continue;
      }

      const request = (await readTextIfExists(join(pending.dir, "user.md"))).trim();
      const pendingRoute = await readRouteDecisionIfValid(join(pending.dir, "route.json"));
      const pendingMeta = await readTurnMetaIfValid(join(pending.dir, "turn.json"));
      const metaMatches = Boolean(
        pendingMeta
        && pendingMeta.task_id === task.id
        && pendingMeta.turn_id === pending.turnId
        && pendingMeta.request_path === `turns/${pending.turnId}/user.md`
      );

      if (request && pendingRoute && pendingMeta && metaMatches) {
        await rename(pending.dir, files.dir);
        await this.index?.upsertTurn(task.id, pendingMeta);
        await this.appendEvent(
          task,
          "turn.recovered_after_restart",
          `Published complete pending turn ${pending.turnId} after restart`
        );
        summary.published += 1;
        continue;
      }

      const fallbackRoute = pendingRoute
        ?? await readRouteDecisionIfValid(join(task.dir, "latest-route.json"))
        ?? await readRouteDecisionIfValid(task.routePath);
      if (request && fallbackRoute) {
        const createdAt = pendingMeta && metaMatches
          ? new Date(pendingMeta.created_at)
          : this.now();
        await this.quarantinePendingTurn(task, pending);
        await this.writeTurn(task, pending.turnId, request, fallbackRoute, createdAt);
        await this.appendEvent(
          task,
          "turn.repaired_after_restart",
          `Rebuilt partial pending turn ${pending.turnId} from its durable request and route evidence`
        );
        summary.repaired += 1;
        continue;
      }

      await this.quarantinePendingTurn(task, pending);
      await this.appendEvent(
        task,
        "turn.pending_abandoned",
        `Archived incomplete pending turn ${pending.turnId}; no durable request and route pair was available`
      );
      summary.abandoned += 1;
    }
    return summary;
  }

  private async quarantinePendingTurn(
    task: Pick<TaskSession, "dir">,
    pending: PendingTurnDirectory
  ): Promise<void> {
    const root = join(task.dir, "turns", ".abandoned");
    await ensureDir(root);
    const preferred = join(root, pending.name);
    const destination = await pathExists(preferred)
      ? join(root, `${pending.name}.${randomUUID()}`)
      : preferred;
    await rename(pending.dir, destination);
  }

  private async backfillInitialTurn(task: TaskSession, fallbackRoute: RouteDecision): Promise<void> {
    const firstTurn = this.turnFiles(task, "0001");
    if (await pathExists(firstTurn.metaPath)) {
      return;
    }

    const userRequestPath = join(task.dir, "user-request.md");
    if (!(await pathExists(userRequestPath))) {
      return;
    }

    const request = (await readTextIfExists(userRequestPath)).trim();
    if (!request) {
      return;
    }

    const route = (await readRouteDecisionIfValid(task.routePath)) ?? fallbackRoute;
    const meta = await readTaskMetaIfValid(task.metaPath);
    await this.writeTurn(task, "0001", request, route, meta ? new Date(meta.created_at) : this.now());
  }

  private async writeTurn(
    task: Pick<TaskSession, "id" | "dir">,
    turnId: string,
    request: string,
    route: RouteDecision,
    createdAt: Date,
    projectIndex = true
  ): Promise<TaskTurn> {
    const files = this.turnFiles(task, turnId);
    const turnMeta = TurnMetaSchema.parse({
      task_id: task.id,
      turn_id: turnId,
      created_at: createdAt.toISOString(),
      request_path: `turns/${turnId}/user.md`
    });
    const parsedRoute = RouteDecisionSchema.parse(route);
    if (await pathExists(files.dir)) {
      throw new Error(`Turn ${turnId} already exists for task ${task.id}.`);
    }

    const pendingDir = join(task.dir, "turns", `.turn-${turnId}-${randomUUID()}.pending`);
    const pendingFiles = this.turnFilesAtDir(turnId, pendingDir);
    let published = false;

    try {
      await ensureDir(pendingDir);
      await writeText(pendingFiles.userPath, `${request.trim()}\n`);
      await writeJson(pendingFiles.routePath, parsedRoute);
      await writeJson(pendingFiles.metaPath, turnMeta);
      await rename(pendingDir, files.dir);
      published = true;
    } finally {
      if (!published) {
        await rm(pendingDir, { recursive: true, force: true });
      }
    }
    if (projectIndex) {
      await this.index?.upsertTurn(task.id, turnMeta);
    }
    return files;
  }

  private turnFiles(task: Pick<TaskSession, "id" | "dir">, turnId: string): TaskTurn {
    const dir = join(task.dir, "turns", turnId);
    return this.turnFilesAtDir(turnId, dir);
  }

  private turnFilesAtDir(turnId: string, dir: string): TaskTurn {
    return {
      turnId,
      dir,
      metaPath: join(dir, "turn.json"),
      userPath: join(dir, "user.md"),
      routePath: join(dir, "route.json")
    };
  }

  private taskIdFromWorkerDir(workerDir: string): string {
    return basename(dirname(workerDir));
  }

  private workerIdFromWorkerDir(workerDir: string): string {
    return basename(workerDir);
  }

  private async finalizeNativeSessionRetirement(
    worker: Pick<WorkerFiles, "dir">,
    sessionId: string
  ): Promise<void> {
    await removeIfExists(join(worker.dir, "native-session.json"));
    await this.clearWorkerStatusNativeSession(worker, sessionId);
    await this.index?.deleteNativeSession(this.taskIdFromWorkerDir(worker.dir), this.workerIdFromWorkerDir(worker.dir));
  }

  private async syncNativeSessionProjection(
    worker: Pick<WorkerFiles, "dir">,
    record: NativeSession
  ): Promise<void> {
    await this.setWorkerStatusNativeSession(worker, record.session_id);
    await this.index?.upsertNativeSession(this.taskIdFromWorkerDir(worker.dir), record);
  }

  private async setWorkerStatusNativeSession(
    worker: Pick<WorkerFiles, "dir">,
    sessionId: string
  ): Promise<void> {
    const statusPath = join(worker.dir, "status.json");
    const status = await readWorkerStatusIfValid(statusPath);
    if (!status) {
      return;
    }
    const nextStatus = status.native_session_id === sessionId
      ? status
      : WorkerStatusSchema.parse({ ...status, native_session_id: sessionId });
    if (nextStatus !== status) {
      await writeJson(statusPath, nextStatus);
    }
    await this.index?.upsertWorker(this.taskIdFromWorkerDir(worker.dir), nextStatus, {
      dir: worker.dir,
      statusPath,
      outputLogPath: join(worker.dir, "output.log")
    });
  }

  private async clearWorkerStatusNativeSession(
    worker: Pick<WorkerFiles, "dir">,
    expectedSessionId?: string
  ): Promise<void> {
    const statusPath = join(worker.dir, "status.json");
    if (!(await pathExists(statusPath))) {
      return;
    }

    const status = await readWorkerStatusIfValid(statusPath);
    if (!status) {
      return;
    }
    if (!status.native_session_id) {
      return;
    }
    if (expectedSessionId && status.native_session_id !== expectedSessionId) {
      return;
    }

    const nextStatus = { ...status };
    delete nextStatus.native_session_id;
    await writeJson(statusPath, WorkerStatusSchema.parse(nextStatus));
    await this.index?.upsertWorker(this.taskIdFromWorkerDir(worker.dir), nextStatus, {
      dir: worker.dir,
      statusPath,
      outputLogPath: join(worker.dir, "output.log")
    });
  }

  private async clearWorkerArtifacts(dir: string, role: WorkerRole): Promise<void> {
    if (role === "judge") {
      for (const file of [
        "requirements.md",
        "plan.md",
        "acceptance.md",
        "actor-brief.md",
        "critic-brief.md",
        "features.json"
      ]) {
        await removeIfExists(join(dir, file));
      }
      return;
    }

    const files =
      role === "actor"
        ? ["worklog.md", "patch.diff"]
        : role === "critic"
          ? ["review.md"]
          : [];

    for (const file of files) {
      await writeText(join(dir, file), "");
    }
  }
}

function titleFromRequest(request: string): string {
  const firstLine = request.trim().split("\n")[0] ?? "Untitled task";
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}

function normalizeTaskTitle(title: string): string {
  const normalized = title
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    throw new Error("Task title cannot be empty.");
  }
  if (Array.from(normalized).length > 160) {
    throw new Error("Task title cannot exceed 160 characters.");
  }
  return normalized;
}

function isTransientTaskLeasePath(taskDir: string, source: string): boolean {
  if (dirname(source) !== taskDir) {
    return false;
  }
  const name = basename(source);
  return name === "run-owner.json" || name.startsWith(".run-owner-claim-");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readTaskMetaIfValid(metaPath: string): Promise<TaskMeta | null> {
  if (!(await pathExists(metaPath))) {
    return null;
  }

  try {
    return await readJson(metaPath, TaskMetaSchema);
  } catch {
    return null;
  }
}

async function readTaskCreationOwnerIfValid(path: string): Promise<TaskCreationOwner | null> {
  if (!(await pathExists(path))) {
    return null;
  }
  try {
    return await readJson(path, TaskCreationOwnerSchema);
  } catch {
    return null;
  }
}

async function taskCreationOwnerIsActive(owner: TaskCreationOwner): Promise<boolean> {
  if (!processIsAlive(owner.pid)) {
    return false;
  }
  if (!owner.process_start_token) {
    return true;
  }
  return (await readProcessStartToken(owner.pid)) === owner.process_start_token;
}

async function writeJsonExclusive(path: string, value: unknown): Promise<boolean> {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

async function readRouteDecisionIfValid(routePath: string): Promise<RouteDecision | null> {
  if (!(await pathExists(routePath))) {
    return null;
  }

  try {
    return await readJson(routePath, RouteDecisionSchema);
  } catch {
    return null;
  }
}

async function readTurnMetaIfValid(metaPath: string): Promise<TurnMeta | null> {
  if (!(await pathExists(metaPath))) {
    return null;
  }

  try {
    return await readJson(metaPath, TurnMetaSchema);
  } catch {
    return null;
  }
}

async function readNativeSessionIfValid(nativeSessionPath: string): Promise<NativeSession | null> {
  if (!(await pathExists(nativeSessionPath))) {
    return null;
  }

  try {
    return await readJson(nativeSessionPath, NativeSessionSchema);
  } catch {
    return null;
  }
}

async function readRetiredNativeSessionIfValid(retiredSessionPath: string) {
  if (!(await pathExists(retiredSessionPath))) {
    return null;
  }

  try {
    return await readJson(retiredSessionPath, RetiredNativeSessionSchema);
  } catch {
    return null;
  }
}

async function readWorkerStatusIfValid(statusPath: string): Promise<WorkerStatus | null> {
  if (!(await pathExists(statusPath))) {
    return null;
  }

  try {
    return await readJson(statusPath, WorkerStatusSchema);
  } catch {
    return null;
  }
}
