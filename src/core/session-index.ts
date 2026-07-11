import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ZodTypeAny, output } from "zod";
import {
  NativeSessionSchema,
  type NativeSession,
  TaskMetaSchema,
  type TaskMeta,
  TurnMetaSchema,
  type TurnMeta,
  WorkerStatusSchema,
  type WorkerStatus
} from "../domain/schemas.js";
import { ensureDir, pathExists, readJson } from "./file-store.js";

export interface WorkerIndexPaths {
  dir: string;
  statusPath: string;
  outputLogPath: string;
}

export interface TaskIndexSummary extends TaskMeta {
  turnCount: number;
  workerCount: number;
  nativeSessionCount: number;
}

export class SessionIndex {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly projectRoot: string,
    private readonly dataDir: string
  ) {}

  static async open(projectRoot: string, dataDir: string): Promise<SessionIndex> {
    await ensureDir(join(projectRoot, dataDir));
    const index = new SessionIndex(new DatabaseSync(join(projectRoot, dataDir, "session-index.sqlite")), projectRoot, dataDir);
    index.initialize();
    return index;
  }

  initialize(): void {
    this.db.exec(`
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        cwd TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS turns (
        task_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        request_path TEXT NOT NULL,
        PRIMARY KEY (task_id, turn_id)
      );

      CREATE TABLE IF NOT EXISTS workers (
        task_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        role TEXT NOT NULL,
        engine TEXT NOT NULL,
        state TEXT NOT NULL,
        phase TEXT NOT NULL,
        summary TEXT NOT NULL,
        status_path TEXT NOT NULL,
        output_log_path TEXT NOT NULL,
        dir TEXT NOT NULL,
        native_session_id TEXT,
        PRIMARY KEY (task_id, worker_id)
      );

      CREATE TABLE IF NOT EXISTS native_sessions (
        task_id TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        role TEXT NOT NULL,
        session_id TEXT NOT NULL,
        cwd TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT NOT NULL,
        source TEXT NOT NULL,
        PRIMARY KEY (task_id, worker_id)
      );

      CREATE TABLE IF NOT EXISTS workspace_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async upsertTask(task: TaskMeta): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, created_at, cwd, mode, status)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title,
           created_at=excluded.created_at,
           cwd=excluded.cwd,
           mode=excluded.mode,
           status=excluded.status`
      )
      .run(task.id, task.title, task.created_at, task.cwd, task.mode, task.status);
  }

  async upsertTurn(taskId: string, turn: TurnMeta): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO turns (task_id, turn_id, created_at, request_path)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id, turn_id) DO UPDATE SET
           created_at=excluded.created_at,
           request_path=excluded.request_path`
      )
      .run(taskId, turn.turn_id, turn.created_at, turn.request_path);
  }

  async upsertWorker(taskId: string, status: WorkerStatus, paths: WorkerIndexPaths): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO workers (
          task_id, worker_id, role, engine, state, phase, summary, status_path, output_log_path, dir, native_session_id
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, worker_id) DO UPDATE SET
           role=excluded.role,
           engine=excluded.engine,
           state=excluded.state,
           phase=excluded.phase,
           summary=excluded.summary,
           status_path=excluded.status_path,
           output_log_path=excluded.output_log_path,
           dir=excluded.dir,
           native_session_id=excluded.native_session_id`
      )
      .run(
        taskId,
        status.worker_id,
        status.role,
        status.engine,
        status.state,
        status.phase,
        status.summary,
        paths.statusPath,
        paths.outputLogPath,
        paths.dir,
        status.native_session_id ?? null
      );
  }

  async upsertNativeSession(taskId: string, record: NativeSession): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO native_sessions (
          task_id, worker_id, engine, role, session_id, cwd, created_at, last_used_at, source
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, worker_id) DO UPDATE SET
           engine=excluded.engine,
           role=excluded.role,
           session_id=excluded.session_id,
           cwd=excluded.cwd,
           created_at=excluded.created_at,
           last_used_at=excluded.last_used_at,
           source=excluded.source`
      )
      .run(
        taskId,
        record.worker_id,
        record.engine,
        record.role,
        record.session_id,
        record.cwd,
        record.created_at,
        record.last_used_at,
        record.source
      );
  }

  async deleteNativeSession(taskId: string, workerId: string): Promise<void> {
    this.db.prepare("DELETE FROM native_sessions WHERE task_id = ? AND worker_id = ?").run(taskId, workerId);
  }

  async countRows(table: "tasks" | "turns" | "workers" | "native_sessions"): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  }

  async listTasks(limit = 50): Promise<TaskIndexSummary[]> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(500, Math.max(0, Math.trunc(limit)))
      : 50;
    if (boundedLimit === 0) {
      return [];
    }
    const rows = this.db.prepare(
      `SELECT
         tasks.id,
         tasks.title,
         tasks.created_at,
         tasks.cwd,
         tasks.mode,
         tasks.status,
         (SELECT COUNT(*) FROM turns WHERE turns.task_id = tasks.id) AS turn_count,
         (SELECT COUNT(*) FROM workers WHERE workers.task_id = tasks.id) AS worker_count,
         (SELECT COUNT(*) FROM native_sessions WHERE native_sessions.task_id = tasks.id) AS native_session_count
       FROM tasks
       ORDER BY tasks.created_at DESC, tasks.id DESC
       LIMIT ?`
    ).all(boundedLimit) as Array<Record<string, unknown>>;

    return rows.flatMap((row) => {
      const task = TaskMetaSchema.safeParse({
        id: row.id,
        title: row.title,
        created_at: row.created_at,
        cwd: row.cwd,
        mode: row.mode,
        status: row.status
      });
      if (!task.success) {
        return [];
      }
      return [{
        ...task.data,
        turnCount: Number(row.turn_count) || 0,
        workerCount: Number(row.worker_count) || 0,
        nativeSessionCount: Number(row.native_session_count) || 0
      }];
    });
  }

  async activeTaskId(): Promise<string | null | undefined> {
    const row = this.db
      .prepare("SELECT value FROM workspace_state WHERE key = 'active_task_id'")
      .get() as { value: string } | undefined;
    if (!row) {
      return undefined;
    }
    return row.value.trim() || null;
  }

  async setActiveTaskId(taskId: string | null): Promise<void> {
    const value = taskId?.trim() ?? "";
    this.db.prepare(
      `INSERT INTO workspace_state (key, value)
       VALUES ('active_task_id', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(value);
  }

  async workerNativeSessionId(taskId: string, workerId: string): Promise<string | null> {
    const row = this.db
      .prepare("SELECT native_session_id FROM workers WHERE task_id = ? AND worker_id = ?")
      .get(taskId, workerId) as { native_session_id: string | null } | undefined;
    return row?.native_session_id ?? null;
  }

  async rebuildFromFiles(): Promise<void> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM native_sessions; DELETE FROM workers; DELETE FROM turns; DELETE FROM tasks;");
      const sessions = join(this.projectRoot, this.dataDir, "sessions");
      if (await pathExists(sessions)) {
        const taskEntries = await readdir(sessions, { withFileTypes: true });
        for (const taskEntry of taskEntries) {
          if (!taskEntry.isDirectory()) {
            continue;
          }
          if (taskEntry.name === "main") {
            await this.rebuildWorkers(join(sessions, taskEntry.name), "main");
            continue;
          }
          if (!taskEntry.name.startsWith("task-")) {
            continue;
          }
          await this.rebuildTask(join(sessions, taskEntry.name), taskEntry.name);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the filesystem or SQLite failure that interrupted rebuilding.
      }
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private async rebuildTask(taskDir: string, taskId: string): Promise<void> {
    const metaPath = join(taskDir, "meta.json");
    if (await pathExists(metaPath)) {
      const meta = await readJsonIfValid(metaPath, TaskMetaSchema);
      if (meta) {
        await this.upsertTask(meta);
      }
    }

    const turnsDir = join(taskDir, "turns");
    if (await pathExists(turnsDir)) {
      const turnEntries = await readdir(turnsDir, { withFileTypes: true });
      for (const turnEntry of turnEntries) {
        const turnPath = join(turnsDir, turnEntry.name, "turn.json");
        if (turnEntry.isDirectory() && (await pathExists(turnPath))) {
          const turn = await readJsonIfValid(turnPath, TurnMetaSchema);
          if (turn) {
            await this.upsertTurn(taskId, turn);
          }
        }
      }
    }

    await this.rebuildWorkers(taskDir, taskId);
  }

  private async rebuildWorkers(sessionDir: string, sessionId: string): Promise<void> {
    const entries = await readdir(sessionDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "turns") {
        continue;
      }

      const workerDir = join(sessionDir, entry.name);
      const statusPath = join(workerDir, "status.json");
      const nativePath = join(workerDir, "native-session.json");
      if (await pathExists(statusPath)) {
        const status = await this.readRebuildWorkerStatus(statusPath, nativePath);
        if (status) {
          await this.upsertWorker(sessionId, status, {
            dir: workerDir,
            statusPath,
            outputLogPath: join(workerDir, "output.log")
          });
        }
      }

      if (await pathExists(nativePath)) {
        const nativeSession = await readJsonIfValid(nativePath, NativeSessionSchema);
        if (nativeSession) {
          await this.upsertNativeSession(sessionId, nativeSession);
        }
      }
    }
  }

  private async readRebuildWorkerStatus(statusPath: string, nativePath: string): Promise<WorkerStatus | null> {
    const status = await readJsonIfValid(statusPath, WorkerStatusSchema);
    if (!status) {
      return null;
    }
    if (status.native_session_id && !(await readJsonIfValid(nativePath, NativeSessionSchema))) {
      const nextStatus = { ...status };
      delete nextStatus.native_session_id;
      return WorkerStatusSchema.parse(nextStatus);
    }
    return status;
  }
}

async function readJsonIfValid<TSchema extends ZodTypeAny>(
  path: string,
  schema: TSchema
): Promise<output<TSchema> | null> {
  if (!(await pathExists(path))) {
    return null;
  }

  try {
    return await readJson(path, schema);
  } catch {
    return null;
  }
}
