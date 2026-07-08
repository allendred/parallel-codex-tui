import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  appendJsonLine,
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
import {
  type EngineName,
  type EventRecord,
  type NativeSession,
  NativeSessionSchema,
  type RouteDecision,
  RouteDecisionSchema,
  type TaskMeta,
  TaskMetaSchema,
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
  role: WorkerRole;
  engine: EngineName;
  prompt: string;
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

export interface TaskTurn {
  turnId: string;
  dir: string;
  metaPath: string;
  userPath: string;
  routePath: string;
}

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

  async readMeta(task: TaskSession): Promise<TaskMeta> {
    return readJson(task.metaPath, TaskMetaSchema);
  }

  async updateTaskStatus(task: TaskSession, status: TaskMeta["status"]): Promise<void> {
    const meta = await this.readMeta(task);
    await writeJson(task.metaPath, TaskMetaSchema.parse({ ...meta, status }));
    await this.index?.upsertTask({ ...meta, status });
    await this.appendEvent(task, `task.${status}`, `Task moved to ${status}`);
  }

  async initializeWorker(task: TaskSession, input: InitializeWorkerInput): Promise<WorkerFiles> {
    const dir = join(task.dir, input.workerId);
    const promptPath = join(dir, "prompt.md");
    const outputLogPath = join(dir, "output.log");
    const statusPath = join(dir, "status.json");
    const status: WorkerStatus = {
      worker_id: input.workerId,
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
    await writeText(outputLogPath, "");
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
    return readJson(path, NativeSessionSchema);
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
    const record = await readJson(nativeSessionPath, NativeSessionSchema);
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

  private async nextTurnId(task: Pick<TaskSession, "id" | "dir">): Promise<string> {
    const latest = await this.latestTurn(task);
    if (!latest) {
      return (await pathExists(join(task.dir, "user-request.md"))) ? "0002" : "0001";
    }
    return String(Number(latest.turnId) + 1).padStart(4, "0");
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

  private async clearWorkerStatusNativeSession(worker: Pick<WorkerFiles, "dir">): Promise<void> {
    const statusPath = join(worker.dir, "status.json");
    if (!(await pathExists(statusPath))) {
      return;
    }

    const status = await readJson(statusPath, WorkerStatusSchema);
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
