import { readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  NativeSessionSchema,
  RetiredNativeSessionSchema,
  TurnMetaSchema,
  WorkerStatusSchema,
  type EngineName,
  type NativeSession,
  type WorkerRole,
  type WorkerState
} from "../domain/schemas.js";
import type { TaskIndexSummary } from "./session-index.js";
import { pathExists, readJson, readTextIfExists } from "./file-store.js";

export interface TaskSessionNativeDetail {
  sessionId: string;
  cwd: string;
  writableDirs: string[];
  createdAt: string;
  lastUsedAt: string;
  source: NativeSession["source"];
}

export interface TaskSessionWorkerDetail {
  id: string;
  turnId: string;
  featureId?: string;
  featureTitle?: string;
  role: WorkerRole;
  engine: EngineName;
  model: string;
  modelProvider?: string;
  state: WorkerState;
  phase: string;
  summary: string;
  lastActivityAt: string;
  dir: string;
  statusPath: string;
  outputLogPath: string;
  nativeSession: TaskSessionNativeDetail | null;
}

export interface TaskSessionTurnDetail {
  turnId: string;
  createdAt: string;
  request: string;
  workers: TaskSessionWorkerDetail[];
}

export interface TaskSessionDetails {
  task: TaskIndexSummary;
  projectName: string;
  projectPath: string;
  turns: TaskSessionTurnDetail[];
  workers: TaskSessionWorkerDetail[];
}

export async function loadTaskSessionDetails(input: {
  task: TaskIndexSummary;
  taskDir: string;
  modelNames?: Partial<Record<EngineName, string>>;
}): Promise<TaskSessionDetails> {
  const [turns, workers] = await Promise.all([
    readTaskTurns(input.taskDir),
    readTaskWorkers(input.taskDir, input.modelNames ?? {})
  ]);
  const turnById = new Map(turns.map((turn) => [turn.turnId, turn]));
  for (const worker of workers) {
    let turn = turnById.get(worker.turnId);
    if (!turn) {
      turn = {
        turnId: worker.turnId,
        createdAt: worker.lastActivityAt,
        request: "",
        workers: []
      };
      turnById.set(worker.turnId, turn);
      turns.push(turn);
    }
    turn.workers.push(worker);
  }
  turns.sort((left, right) => left.turnId.localeCompare(right.turnId));
  for (const turn of turns) {
    turn.workers.sort(compareTaskSessionWorkers);
  }
  return {
    task: input.task,
    projectName: basename(input.task.cwd) || input.task.cwd,
    projectPath: input.task.cwd,
    turns,
    workers
  };
}

async function readTaskTurns(taskDir: string): Promise<TaskSessionTurnDetail[]> {
  const turnsDir = join(taskDir, "turns");
  let entries;
  try {
    entries = await readdir(turnsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const turns = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d{4}$/.test(entry.name))
    .map(async (entry): Promise<TaskSessionTurnDetail | null> => {
      const dir = join(turnsDir, entry.name);
      try {
        const meta = await readJson(join(dir, "turn.json"), TurnMetaSchema);
        if (meta.turn_id !== entry.name) {
          return null;
        }
        return {
          turnId: meta.turn_id,
          createdAt: meta.created_at,
          request: compactTaskRequest(await readTextIfExists(join(dir, "user.md"))),
          workers: []
        };
      } catch {
        return null;
      }
    }));
  return turns
    .filter((turn): turn is TaskSessionTurnDetail => turn !== null)
    .sort((left, right) => left.turnId.localeCompare(right.turnId));
}

async function readTaskWorkers(
  taskDir: string,
  modelNames: Partial<Record<EngineName, string>>
): Promise<TaskSessionWorkerDetail[]> {
  let entries;
  try {
    entries = await readdir(taskDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const workers = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<TaskSessionWorkerDetail | null> => {
      const dir = join(taskDir, entry.name);
      const statusPath = join(dir, "status.json");
      if (!(await pathExists(statusPath))) {
        return null;
      }
      try {
        const status = await readJson(statusPath, WorkerStatusSchema);
        const nativeSession = await readActiveNativeSession(dir, status.worker_id);
        return {
          id: status.worker_id,
          turnId: taskSessionWorkerTurnId(status.worker_id, status.feature_id),
          ...(status.feature_id ? { featureId: status.feature_id } : {}),
          ...(status.feature_title ? { featureTitle: status.feature_title } : {}),
          role: status.role,
          engine: status.engine,
          model: status.model_name?.trim() || modelNames[status.engine]?.trim() || "",
          ...(status.model_provider?.trim() ? { modelProvider: status.model_provider.trim() } : {}),
          state: status.state,
          phase: status.phase,
          summary: status.summary,
          lastActivityAt: laterTimestamp(status.last_event_at, nativeSession?.lastUsedAt),
          dir,
          statusPath,
          outputLogPath: join(dir, "output.log"),
          nativeSession
        };
      } catch {
        return null;
      }
    }));
  return workers
    .filter((worker): worker is TaskSessionWorkerDetail => worker !== null)
    .sort((left, right) => (
      left.turnId.localeCompare(right.turnId)
      || compareTaskSessionWorkers(left, right)
    ));
}

async function readActiveNativeSession(
  workerDir: string,
  workerId: string
): Promise<TaskSessionNativeDetail | null> {
  const activePath = join(workerDir, "native-session.json");
  if (!(await pathExists(activePath))) {
    return null;
  }
  try {
    const active = await readJson(activePath, NativeSessionSchema);
    if (active.worker_id !== workerId) {
      return null;
    }
    const retiredPath = join(workerDir, "native-session.retired.json");
    if (await pathExists(retiredPath)) {
      try {
        const retired = await readJson(retiredPath, RetiredNativeSessionSchema);
        if (retired.session_id === active.session_id) {
          return null;
        }
      } catch {
        // A malformed retirement record cannot hide a valid active session.
      }
    }
    return {
      sessionId: active.session_id,
      cwd: active.cwd,
      writableDirs: active.writable_dirs ?? [],
      createdAt: active.created_at,
      lastUsedAt: active.last_used_at,
      source: active.source
    };
  } catch {
    return null;
  }
}

export function taskSessionWorkerTurnId(workerId: string, featureId?: string): string {
  const featureTurn = featureId?.match(/^(\d{4})(?:-|$)/)?.[1];
  const waveTurn = workerId.match(/-wave-(\d{4})-/)?.[1];
  const finalTurn = workerId.match(/-final-(\d{4})$/)?.[1];
  const taskTurn = workerId.match(/-(\d{4})$/)?.[1];
  return featureTurn ?? waveTurn ?? finalTurn ?? taskTurn ?? "0001";
}

function compareTaskSessionWorkers(
  left: TaskSessionWorkerDetail,
  right: TaskSessionWorkerDetail
): number {
  return taskSessionWorkerStage(left) - taskSessionWorkerStage(right)
    || left.id.localeCompare(right.id);
}

function taskSessionWorkerStage(worker: TaskSessionWorkerDetail): number {
  if (worker.role === "judge" && /-final-\d{4}$/.test(worker.id)) {
    return 4;
  }
  return ["main", "judge", "actor", "critic"].indexOf(worker.role);
}

function compactTaskRequest(request: string): string {
  const value = request.replace(/\s+/g, " ").trim();
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function laterTimestamp(left: string, right?: string): string {
  return right && right.localeCompare(left) > 0 ? right : left;
}
