import { copyFile, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ZodTypeAny, output } from "zod";
import {
  NativeSessionSchema,
  type NativeSession,
  RetiredNativeSessionSchema,
  RouteDecisionSchema,
  TaskIdSchema,
  TaskMetaSchema,
  type TaskMeta,
  TurnMetaSchema,
  type TurnMeta,
  WorkerStatusSchema,
  type WorkerStatus
} from "../domain/schemas.js";
import { ensureDir, pathExists, readJson, readTextIfExists } from "./file-store.js";
import {
  matchTaskSearchDocument,
  parseTaskSearchQuery,
  type TaskSearchDocument,
  type TaskSearchMatch
} from "./task-search.js";

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

export interface ListTaskOptions {
  includeArchived?: boolean;
}

export interface TaskIndexSearchResult extends TaskIndexSummary {
  searchMatch: TaskSearchMatch;
}

export interface SessionIndexRecovery {
  source: "backup" | "empty";
  quarantinedPath: string;
}

const SESSION_INDEX_SCHEMA_VERSION = 3;
const SESSION_INDEX_FILENAME = "session-index.sqlite";

export class SessionIndex {
  private constructor(
    private readonly db: DatabaseSync,
    private readonly projectRoot: string,
    private readonly dataDir: string,
    private readonly databasePath: string,
    readonly recovery: SessionIndexRecovery | null
  ) {}

  static async open(projectRoot: string, dataDir: string): Promise<SessionIndex> {
    const runtimeDir = join(projectRoot, dataDir);
    const databasePath = join(runtimeDir, SESSION_INDEX_FILENAME);
    const recoveryBackupPath = `${databasePath}.backup`;
    await ensureDir(runtimeDir);
    const databaseExisted = await pathExists(databasePath);
    const opened = await openSessionDatabase(databasePath, recoveryBackupPath);
    const index = new SessionIndex(
      opened.db,
      projectRoot,
      dataDir,
      databasePath,
      opened.recovery
    );
    try {
      const previousVersion = index.schemaVersion();
      if (databaseExisted && previousVersion < SESSION_INDEX_SCHEMA_VERSION) {
        await index.writeBackup(`${databasePath}.pre-migration-v${previousVersion}.backup`);
      }
      index.initialize();
      await index.writeBackup(recoveryBackupPath);
      return index;
    } catch (error) {
      try {
        index.close();
      } catch {
        // Preserve the migration or backup failure that prevented startup.
      }
      throw error;
    }
  }

  initialize(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const currentVersion = this.schemaVersion();
      if (currentVersion > SESSION_INDEX_SCHEMA_VERSION) {
        throw new Error(
          `Session index schema v${currentVersion} is newer than supported v${SESSION_INDEX_SCHEMA_VERSION}`
        );
      }
      for (let targetVersion = currentVersion + 1; targetVersion <= SESSION_INDEX_SCHEMA_VERSION; targetVersion += 1) {
        this.applyMigration(targetVersion);
        this.db.exec(`PRAGMA user_version = ${targetVersion}`);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the migration failure if SQLite already rolled the transaction back.
      }
      throw error;
    }
    assertHealthyDatabase(this.db);
  }

  schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
    return Number(row?.user_version) || 0;
  }

  async upsertTask(task: TaskMeta): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO tasks (id, title, created_at, cwd, mode, status, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title,
           created_at=excluded.created_at,
           cwd=excluded.cwd,
           mode=excluded.mode,
           status=excluded.status,
           archived_at=excluded.archived_at`
      )
      .run(task.id, task.title, task.created_at, task.cwd, task.mode, task.status, task.archived_at ?? null);
  }

  async upsertTurn(taskId: string, turn: TurnMeta, request = ""): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO turns (task_id, turn_id, created_at, request_path, request_text)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(task_id, turn_id) DO UPDATE SET
           created_at=excluded.created_at,
           request_path=excluded.request_path,
           request_text=CASE
             WHEN excluded.request_text <> '' THEN excluded.request_text
             ELSE turns.request_text
           END`
      )
      .run(taskId, turn.turn_id, turn.created_at, turn.request_path, indexedRequestText(request));
  }

  async upsertWorker(taskId: string, status: WorkerStatus, paths: WorkerIndexPaths): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO workers (
          task_id, worker_id, feature_id, feature_title, role, engine, model_name, model_provider,
          state, phase, summary, status_path, output_log_path, dir, native_session_id
        )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, worker_id) DO UPDATE SET
           feature_id=excluded.feature_id,
           feature_title=excluded.feature_title,
           role=excluded.role,
           engine=excluded.engine,
           model_name=excluded.model_name,
           model_provider=excluded.model_provider,
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
        status.feature_id ?? null,
        status.feature_title ?? null,
        status.role,
        status.engine,
        status.model_name ?? null,
        status.model_provider ?? null,
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

  async deleteTask(taskId: string): Promise<void> {
    const id = TaskIdSchema.parse(taskId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM native_sessions WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM workers WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM turns WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      this.db.prepare(
        "UPDATE workspace_state SET value = '' WHERE key = 'active_task_id' AND value = ?"
      ).run(id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async countRows(table: "tasks" | "turns" | "workers" | "native_sessions"): Promise<number> {
    const row = this.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
    return row.count;
  }

  async listTasks(limit = 50, options: ListTaskOptions = {}): Promise<TaskIndexSummary[]> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(500, Math.max(0, Math.trunc(limit)))
      : 50;
    if (boundedLimit === 0) {
      return [];
    }
    const archivedFilter = options.includeArchived ? "" : "WHERE tasks.archived_at IS NULL";
    const rows = this.db.prepare(
      `SELECT
         tasks.id,
         tasks.title,
         tasks.created_at,
         tasks.cwd,
         tasks.mode,
         tasks.status,
         tasks.archived_at,
         (SELECT COUNT(*) FROM turns WHERE turns.task_id = tasks.id) AS turn_count,
         (SELECT COUNT(*) FROM workers WHERE workers.task_id = tasks.id) AS worker_count,
         (SELECT COUNT(DISTINCT engine || char(31) || session_id)
           FROM native_sessions
           WHERE native_sessions.task_id = tasks.id) AS native_session_count
       FROM tasks
       ${archivedFilter}
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
        status: row.status,
        archived_at: row.archived_at ?? undefined
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

  async searchTasks(
    query: string,
    limit = 100,
    options: ListTaskOptions = {}
  ): Promise<TaskIndexSearchResult[]> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.min(500, Math.max(0, Math.trunc(limit)))
      : 100;
    if (boundedLimit === 0) {
      return [];
    }
    const terms = parseTaskSearchQuery(query);
    const tasks = await this.listTasks(500, options);
    if (terms.length === 0) {
      return tasks.slice(0, boundedLimit).map((task) => ({
        ...task,
        searchMatch: { fields: [], summary: "" }
      }));
    }

    const documents = new Map<string, TaskSearchDocument>(tasks.map((task) => [task.id, {
      task: {
        id: task.id,
        title: task.title,
        cwd: task.cwd,
        mode: task.mode,
        state: task.status
      },
      turns: [],
      workers: [],
      nativeSessions: []
    }]));
    const archivedFilter = options.includeArchived ? "" : "WHERE tasks.archived_at IS NULL";

    const turns = this.db.prepare(
      `SELECT turns.task_id, turns.turn_id, turns.request_text
       FROM turns
       INNER JOIN tasks ON tasks.id = turns.task_id
       ${archivedFilter}`
    ).all() as Array<{ task_id: string; turn_id: string; request_text: string }>;
    for (const turn of turns) {
      documents.get(turn.task_id)?.turns.push({
        turnId: turn.turn_id,
        request: turn.request_text
      });
    }

    const workers = this.db.prepare(
      `SELECT
         workers.task_id,
         workers.worker_id,
         workers.feature_id,
         workers.feature_title,
         workers.role,
         workers.engine,
         workers.model_name,
         workers.model_provider,
         workers.state,
         workers.phase,
         workers.summary
       FROM workers
       INNER JOIN tasks ON tasks.id = workers.task_id
       ${archivedFilter}`
    ).all() as Array<{
      task_id: string;
      worker_id: string;
      feature_id: string | null;
      feature_title: string | null;
      role: string;
      engine: string;
      model_name: string | null;
      model_provider: string | null;
      state: string;
      phase: string;
      summary: string;
    }>;
    for (const worker of workers) {
      documents.get(worker.task_id)?.workers.push({
        id: worker.worker_id,
        featureId: worker.feature_id ?? "",
        featureTitle: worker.feature_title ?? "",
        role: worker.role,
        provider: worker.engine,
        model: worker.model_name ?? "",
        modelProvider: worker.model_provider ?? "",
        state: worker.state,
        phase: worker.phase,
        summary: worker.summary
      });
    }

    const nativeSessions = this.db.prepare(
      `SELECT native_sessions.task_id, native_sessions.session_id, native_sessions.engine
       FROM native_sessions
       INNER JOIN tasks ON tasks.id = native_sessions.task_id
       ${archivedFilter}`
    ).all() as Array<{ task_id: string; session_id: string; engine: string }>;
    for (const session of nativeSessions) {
      documents.get(session.task_id)?.nativeSessions.push({
        sessionId: session.session_id,
        provider: session.engine
      });
    }

    return tasks.flatMap((task): TaskIndexSearchResult[] => {
      const document = documents.get(task.id);
      const searchMatch = document ? matchTaskSearchDocument(terms, document) : null;
      return searchMatch ? [{ ...task, searchMatch }] : [];
    }).slice(0, boundedLimit);
  }

  async activeTaskId(): Promise<string | null | undefined> {
    const row = this.db
      .prepare("SELECT value FROM workspace_state WHERE key = 'active_task_id'")
      .get() as { value: string } | undefined;
    if (!row) {
      return undefined;
    }
    const value = row.value.trim();
    if (!value) {
      return null;
    }
    return TaskIdSchema.safeParse(value).success ? value : undefined;
  }

  async setActiveTaskId(taskId: string | null): Promise<void> {
    const value = taskId?.trim() ?? "";
    if (value && !TaskIdSchema.safeParse(value).success) {
      throw new Error(`Invalid active task id: ${JSON.stringify(taskId)}`);
    }
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
          if (!TaskIdSchema.safeParse(taskEntry.name).success) {
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
    await this.writeBackup(`${this.databasePath}.backup`);
  }

  close(): void {
    this.db.close();
  }

  private ensureColumn(table: string, column: string, declaration: string): void {
    if (this.tableHasColumn(table, column)) {
      return;
    }
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`);
    } catch (error) {
      if (!this.tableHasColumn(table, column)) {
        throw error;
      }
    }
  }

  private applyMigration(targetVersion: number): void {
    if (targetVersion === 1) {
      this.db.exec(`
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
          request_text TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (task_id, turn_id)
        );

        CREATE TABLE IF NOT EXISTS workers (
          task_id TEXT NOT NULL,
          worker_id TEXT NOT NULL,
          feature_id TEXT,
          feature_title TEXT,
          role TEXT NOT NULL,
          engine TEXT NOT NULL,
          model_name TEXT,
          model_provider TEXT,
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
      return;
    }
    if (targetVersion === 2) {
      this.ensureColumn("tasks", "archived_at", "TEXT");
      return;
    }
    if (targetVersion === 3) {
      this.ensureColumn("turns", "request_text", "TEXT NOT NULL DEFAULT ''");
      this.ensureColumn("workers", "feature_id", "TEXT");
      this.ensureColumn("workers", "feature_title", "TEXT");
      this.ensureColumn("workers", "model_name", "TEXT");
      this.ensureColumn("workers", "model_provider", "TEXT");
      return;
    }
    throw new Error(`Missing session index migration for schema v${targetVersion}`);
  }

  private async writeBackup(targetPath: string): Promise<void> {
    const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      this.db.prepare("VACUUM INTO ?").run(tempPath);
      await replaceFile(tempPath, targetPath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private tableHasColumn(table: string, column: string): boolean {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
    return columns.some((entry) => entry.name === column);
  }

  private async rebuildTask(taskDir: string, taskId: string): Promise<void> {
    const metaPath = join(taskDir, "meta.json");
    const meta = await pathExists(metaPath)
      ? await readJsonIfValid(metaPath, TaskMetaSchema)
      : null;
    if (!meta || meta.id !== taskId) {
      return;
    }
    await this.upsertTask(meta);

    const turnsDir = join(taskDir, "turns");
    if (await pathExists(turnsDir)) {
      const turnEntries = await readdir(turnsDir, { withFileTypes: true });
      for (const turnEntry of turnEntries) {
        if (!turnEntry.isDirectory() || !/^\d{4}$/.test(turnEntry.name)) {
          continue;
        }
        const turnPath = join(turnsDir, turnEntry.name, "turn.json");
        const [turn, route, request] = await Promise.all([
          readJsonIfValid(turnPath, TurnMetaSchema),
          readJsonIfValid(join(turnsDir, turnEntry.name, "route.json"), RouteDecisionSchema),
          readTextIfExists(join(turnsDir, turnEntry.name, "user.md"))
        ]);
        if (
          turn
          && route
          && request.trim()
          && turn.task_id === taskId
          && turn.turn_id === turnEntry.name
          && turn.request_path === `turns/${turnEntry.name}/user.md`
        ) {
          await this.upsertTurn(taskId, turn, request);
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
      const retiredNativePath = join(workerDir, "native-session.retired.json");
      const nativeSession = await this.readRebuildNativeSession(nativePath, retiredNativePath);
      if (await pathExists(statusPath)) {
        const status = await this.readRebuildWorkerStatus(statusPath, nativeSession);
        if (status) {
          await this.upsertWorker(sessionId, status, {
            dir: workerDir,
            statusPath,
            outputLogPath: join(workerDir, "output.log")
          });
        }
      }

      if (nativeSession) {
        await this.upsertNativeSession(sessionId, nativeSession);
      }
    }
  }

  private async readRebuildWorkerStatus(
    statusPath: string,
    nativeSession: NativeSession | null
  ): Promise<WorkerStatus | null> {
    const status = await readJsonIfValid(statusPath, WorkerStatusSchema);
    if (!status) {
      return null;
    }
    if (status.native_session_id && status.native_session_id !== nativeSession?.session_id) {
      const nextStatus = { ...status };
      delete nextStatus.native_session_id;
      return WorkerStatusSchema.parse(nextStatus);
    }
    return status;
  }

  private async readRebuildNativeSession(
    nativePath: string,
    retiredNativePath: string
  ): Promise<NativeSession | null> {
    const active = await readJsonIfValid(nativePath, NativeSessionSchema);
    if (!active) {
      return null;
    }
    const retired = await readJsonIfValid(retiredNativePath, RetiredNativeSessionSchema);
    return retired?.session_id === active.session_id ? null : active;
  }
}

async function openSessionDatabase(
  databasePath: string,
  backupPath: string
): Promise<{ db: DatabaseSync; recovery: SessionIndexRecovery | null }> {
  let db: DatabaseSync | null = null;
  try {
    db = openCheckedDatabase(databasePath);
    return { db, recovery: null };
  } catch (primaryError) {
    try {
      db?.close();
    } catch {
      // Continue into file-backed recovery.
    }

    const backupIsHealthy = await isHealthyDatabaseFile(backupPath);
    const quarantinedPath = await quarantineDatabase(databasePath);
    await Promise.all([
      rm(`${databasePath}-wal`, { force: true }),
      rm(`${databasePath}-shm`, { force: true })
    ]);
    if (backupIsHealthy) {
      await copyFile(backupPath, databasePath);
    }

    try {
      return {
        db: openCheckedDatabase(databasePath),
        recovery: {
          source: backupIsHealthy ? "backup" : "empty",
          quarantinedPath
        }
      };
    } catch (recoveryError) {
      throw new AggregateError(
        [primaryError, recoveryError],
        `Unable to open or recover session index: ${databasePath}`
      );
    }
  }
}

function openCheckedDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    assertHealthyDatabase(db);
    return db;
  } catch (error) {
    try {
      db.close();
    } catch {
      // Preserve the database validation failure.
    }
    throw error;
  }
}

function assertHealthyDatabase(db: DatabaseSync): void {
  const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, unknown>>;
  if (
    rows.length !== 1
    || Object.values(rows[0] ?? {}).length !== 1
    || Object.values(rows[0] ?? {})[0] !== "ok"
  ) {
    throw new Error(`Session index integrity check failed: ${JSON.stringify(rows)}`);
  }
}

async function isHealthyDatabaseFile(path: string): Promise<boolean> {
  if (!(await pathExists(path))) {
    return false;
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(path);
    assertHealthyDatabase(db);
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // A failed validation can leave no open handle to close.
    }
  }
}

async function quarantineDatabase(path: string): Promise<string> {
  const quarantinedPath = `${path}.corrupt-${Date.now()}-${process.pid}`;
  if (await pathExists(path)) {
    await rename(path, quarantinedPath);
  }
  return quarantinedPath;
}

async function replaceFile(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" && (error as NodeJS.ErrnoException).code !== "EPERM") {
      throw error;
    }
    await rm(target, { force: true });
    await rename(source, target);
  }
}

function indexedRequestText(request: string): string {
  const clean = request
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  const points = Array.from(clean);
  return points.length > 32768 ? points.slice(0, 32768).join("") : clean;
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
