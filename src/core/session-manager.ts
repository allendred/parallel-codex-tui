import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  appendJsonLine,
  appendText,
  ensureDir,
  pathExists,
  readJson,
  readTextIfExists,
  removeIfExists,
  writeJson,
  writeText
} from "./file-store.js";
import { formatTaskTimestamp, taskDir } from "./paths.js";
import { sessionsRoot } from "./paths.js";
import type { SessionIndex } from "./session-index.js";
import { loadCollaborationTimeline, type CollaborationTimeline } from "./collaboration-timeline.js";
import {
  claimTaskRunLease,
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
  type TaskMeta,
  TaskMetaSchema,
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
}

export interface CreateTaskInput {
  request: string;
  cwd: string;
  route: RouteDecision;
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
}

type BlockingProcessTermination = Extract<WorkerProcessTermination, "unverifiable" | "still-running">;

export interface InterruptedTaskRecoveryBlock {
  workerId: string;
  processPath: string;
  reason: BlockingProcessTermination;
}

export class InterruptedTaskRecoveryBlockedError extends Error {
  constructor(
    readonly taskId: string,
    readonly blocks: InterruptedTaskRecoveryBlock[]
  ) {
    const details = blocks
      .map((block) => `${block.workerId} (${block.reason}; ${block.processPath})`)
      .join(", ");
    super(
      `Startup recovery blocked for task ${taskId}: ${details}. `
      + "Task state and checkpoints were left unchanged to prevent concurrent workers. "
      + "Verify or stop each recorded process, then restart parallel-codex-tui."
    );
    this.name = "InterruptedTaskRecoveryBlockedError";
  }
}

const TERMINAL_TASK_STATES = new Set<TaskState>(["done", "failed", "cancelled"]);
const ACTIVE_WORKER_STATES = new Set<WorkerStatus["state"]>(["idle", "starting", "running", "waiting"]);
const ACTIVE_FEATURE_STATES = new Set([
  "actor_running",
  "critic_running",
  "revision_needed",
  "integrating",
  "verifying"
]);

export class SessionManager {
  private readonly projectRoot: string;
  private readonly dataDir: string;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly index?: SessionIndex;

  constructor(options: SessionManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.dataDir = options.dataDir;
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => Math.random().toString(16).slice(2, 6));
    this.index = options.index;
  }

  async createTask(input: CreateTaskInput): Promise<TaskSession> {
    const createdAt = this.now();
    const id = `task-${formatTaskTimestamp(createdAt)}-${this.randomId()}`;
    const dir = taskDir(this.projectRoot, this.dataDir, id);
    const meta: TaskMeta = {
      id,
      title: titleFromRequest(input.request),
      created_at: createdAt.toISOString(),
      cwd: input.cwd,
      mode: input.route.mode,
      status: "created"
    };

    await ensureDir(dir);
    await writeJson(join(dir, "meta.json"), TaskMetaSchema.parse(meta));
    await writeText(join(dir, "user-request.md"), `${input.request.trim()}\n`);
    await this.index?.upsertTask(meta);
    await writeJson(join(dir, "route.json"), RouteDecisionSchema.parse(input.route));
    await this.writeTurn({ id, dir }, "0001", input.request, input.route, createdAt);
    await this.appendEvent({ id, dir }, "task.created", "Task session created");
    await this.index?.setActiveTaskId(id);

    return {
      id,
      dir,
      metaPath: join(dir, "meta.json"),
      routePath: join(dir, "route.json"),
      eventsPath: join(dir, "events.jsonl")
    };
  }

  mainSessionDir(): string {
    return join(this.projectRoot, this.dataDir, "sessions", "main");
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
    const text = await readTextIfExists(join(this.mainSessionDir(), "chat.jsonl"));
    const records: ChatRecord[] = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = ChatRecordSchema.safeParse(JSON.parse(line));
        if (parsed.success) {
          records.push(parsed.data);
        }
      } catch {
        // A partial final write must not hide the rest of the workspace history.
      }
    }

    const boundedLimit = Number.isFinite(limit)
      ? Math.min(1000, Math.max(0, Math.trunc(limit)))
      : 200;
    return boundedLimit === 0 ? [] : records.slice(-boundedLimit);
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
    const task = this.taskFromId(taskId);
    return Boolean(await readTaskMetaIfValid(task.metaPath));
  }

  async reconcileInterruptedTasks(): Promise<InterruptedTaskRecovery[]> {
    const root = sessionsRoot(this.projectRoot, this.dataDir);
    if (!(await pathExists(root))) {
      return [];
    }

    const entries = await readdir(root, { withFileTypes: true });
    const recovered: InterruptedTaskRecovery[] = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || !entry.name.startsWith("task-")) {
        continue;
      }
      const task = this.taskFromId(entry.name);
      const meta = await readTaskMetaIfValid(task.metaPath);
      if (!meta) {
        continue;
      }
      const needsTaskRecovery = await this.taskNeedsRecovery(task, meta);
      const needsTransitionRepair = await this.taskStatusTransitionNeedsRepair(task, meta);
      if (!needsTaskRecovery && !needsTransitionRepair) {
        continue;
      }
      let recoveryLease: TaskRunLease;
      try {
        recoveryLease = await claimTaskRunLease(task.dir);
      } catch (error) {
        if (error instanceof TaskRunLeaseConflictError) {
          continue;
        }
        throw error;
      }

      try {
        const claimedMeta = await readTaskMetaIfValid(task.metaPath);
        if (!claimedMeta) {
          continue;
        }
        const claimedNeedsTaskRecovery = await this.taskNeedsRecovery(task, claimedMeta);
        const claimedNeedsTransitionRepair = await this.taskStatusTransitionNeedsRepair(task, claimedMeta);
        if (!claimedNeedsTaskRecovery && !claimedNeedsTransitionRepair) {
          continue;
        }
        if (claimedNeedsTransitionRepair) {
          await this.syncTaskStatusTransition(task, claimedMeta);
        }
        if (!claimedNeedsTaskRecovery) {
          continue;
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
        recovered.push({
          taskId: task.id,
          previousState: claimedMeta.status,
          workersRecovered: workers.recovered,
          featuresRecovered,
          processesTerminated: workers.terminated
        });
      } finally {
        await recoveryLease.release();
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
      if (!entry.isDirectory() || !entry.name.startsWith("task-")) {
        continue;
      }
      const metaPath = join(root, entry.name, "meta.json");
      if (await pathExists(metaPath)) {
        const meta = await readTaskMetaIfValid(metaPath);
        if (!meta) {
          continue;
        }
        if (meta.mode === "complex") {
          tasks.push(meta);
        }
      }
    }

    const latest = tasks.sort((left, right) => left.created_at.localeCompare(right.created_at)).at(-1);
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
    const completeEvidence = status === "done" || meta.status === "done"
      ? await this.hasCompleteTaskEvidence(task)
      : false;
    if (status === "done" && !completeEvidence) {
      throw new Error(`Task ${task.id} cannot move to done before latest-turn completion evidence is published.`);
    }
    if (meta.status === "done" && status !== "done" && completeEvidence) {
      throw new Error(`Task ${task.id} is completely done and cannot move backward to ${status}.`);
    }
    if (meta.status === status) {
      await this.syncTaskStatusTransition(task, meta);
      return;
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
    if (input.preserveOutput && (await pathExists(outputLogPath))) {
      await appendText(outputLogPath, `\n--- retry ${this.now().toISOString()} ---\n`);
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
    if (!(await pathExists(path))) {
      return null;
    }
    try {
      return await readJson(path, NativeSessionSchema);
    } catch {
      await removeIfExists(path);
      await this.clearWorkerStatusNativeSession(worker);
      await this.index?.deleteNativeSession(this.taskIdFromWorkerDir(worker.dir), this.workerIdFromWorkerDir(worker.dir));
      return null;
    }
  }

  async writeNativeSession(worker: Pick<WorkerFiles, "dir">, record: NativeSession): Promise<void> {
    await writeJson(join(worker.dir, "native-session.json"), NativeSessionSchema.parse(record));
    await this.index?.upsertNativeSession(this.taskIdFromWorkerDir(worker.dir), record);
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
    return meta.status === "done"
      && !(await this.hasCompleteTaskEvidence(task))
      && await this.hasIntegratedLatestTurnCheckpoint(task);
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

  private async reconcileTaskWorkers(task: TaskSession): Promise<{ recovered: number; terminated: number }> {
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
        "task.recovery_blocked",
        `Startup recovery blocked by ${blocks.map((block) => `${block.workerId}:${block.reason}`).join(", ")}; task state left unchanged`
      );
      throw new InterruptedTaskRecoveryBlockedError(task.id, blocks);
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
    if (meta) {
      await this.index.upsertTask(meta);
    }
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
    createdAt: Date
  ): Promise<TaskTurn> {
    const files = this.turnFiles(task, turnId);
    const turnMeta: TurnMeta = {
      task_id: task.id,
      turn_id: turnId,
      created_at: createdAt.toISOString(),
      request_path: `turns/${turnId}/user.md`
    };

    await ensureDir(files.dir);
    await writeText(files.userPath, `${request.trim()}\n`);
    await writeJson(files.routePath, RouteDecisionSchema.parse(route));
    await writeJson(files.metaPath, TurnMetaSchema.parse(turnMeta));
    await this.index?.upsertTurn(task.id, turnMeta);
    return files;
  }

  private turnFiles(task: Pick<TaskSession, "id" | "dir">, turnId: string): TaskTurn {
    const dir = join(task.dir, "turns", turnId);
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

  private async clearWorkerStatusNativeSession(worker: Pick<WorkerFiles, "dir">): Promise<void> {
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
