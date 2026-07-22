import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { sessionsRoot } from "../core/paths.js";
import type { WorkerLogRef } from "../orchestrator/orchestrator.js";
import {
  createIncrementalTextFileChunkReader,
  type IncrementalTextFileChunkReader
} from "../tui/incremental-text-file.js";
import { supervisorEventPayload, type SupervisorRunEvent } from "./protocol.js";
import {
  listSupervisorRuns,
  readSupervisorEvents,
  readSupervisorRunState,
  type SupervisorRunRecord
} from "./store.js";
import {
  inspectSupervisorRunRecord,
  type SupervisorRunView,
  type SupervisorWaitOutcome,
  type SupervisorWaitResult
} from "./operations.js";

const WATCH_POLL_MS = 100;
const WATCH_LOG_CHUNK_BYTES = 64 * 1024;
const WATCH_LOG_CHUNKS_PER_POLL = 16;

export type SupervisorWatchRecord =
  | {
      version: 1;
      type: "snapshot";
      at: string;
      run: SupervisorRunView;
    }
  | {
      version: 1;
      type: "event";
      at: string;
      run_id: string;
      event: SupervisorRunEvent;
    }
  | {
      version: 1;
      type: "worker-output";
      at: string;
      run_id: string;
      worker: SupervisorWatchWorker;
      reset: boolean;
      text: string;
    }
  | {
      version: 1;
      type: "warning";
      at: string;
      run_id: string;
      worker: SupervisorWatchWorker;
      message: string;
    }
  | {
      version: 1;
      type: "finish";
      at: string;
      result: SupervisorWaitResult;
      summary: string | null;
      error: string | null;
    };

export interface SupervisorWatchWorker {
  id: string;
  feature_id: string | null;
  role: WorkerLogRef["role"];
  engine: WorkerLogRef["engine"];
  label: string;
}

export interface SupervisorWatchOptions {
  timeoutMs?: number | null;
  pollIntervalMs?: number;
  now?: () => Date;
  onRecord: (record: SupervisorWatchRecord) => void | Promise<void>;
}

interface WatchedWorker {
  ref: WorkerLogRef;
  logPath: string;
  reader: IncrementalTextFileChunkReader | null;
  pathWarning: string | null;
  pathWarningEmitted: boolean;
}

export async function watchSupervisorRun(
  workspaceRoot: string,
  dataDir: string,
  runId: string | null | undefined,
  options: SupervisorWatchOptions
): Promise<SupervisorWaitResult> {
  const now = options.now ?? (() => new Date());
  const requestedPollIntervalMs = options.pollIntervalMs ?? WATCH_POLL_MS;
  if (!Number.isFinite(requestedPollIntervalMs) || requestedPollIntervalMs <= 0) {
    throw new Error("Supervisor watch poll interval must be a positive number of milliseconds");
  }
  const pollIntervalMs = Math.max(10, requestedPollIntervalMs);
  const timeoutMs = options.timeoutMs ?? null;
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("Supervisor watch timeout must be a positive number of milliseconds");
  }

  const record = await selectSupervisorRun(workspaceRoot, dataDir, runId, now());
  const sessionLogsRoot = resolve(sessionsRoot(workspaceRoot, dataDir));
  const startedAt = Date.now();
  const workers = new Map<string, WatchedWorker>();
  let nextEventSequence = 0;

  await options.onRecord({
    version: 1,
    type: "snapshot",
    at: now().toISOString(),
    run: await inspectSupervisorRunRecord(record, now())
  });

  while (true) {
    const events = await readSupervisorEvents(record.files);
    for (const event of events) {
      if (event.sequence < nextEventSequence) {
        continue;
      }
      nextEventSequence = event.sequence + 1;
      await options.onRecord({
        version: 1,
        type: "event",
        at: now().toISOString(),
        run_id: record.state.run_id,
        event
      });
      registerWorkerFromEvent(event, workers, sessionLogsRoot);
    }

    record.state = await readSupervisorRunState(record.files);
    for (const worker of record.state.result?.workers ?? []) {
      registerWorker(worker, workers, sessionLogsRoot);
    }
    const workerOutputPending = await emitWorkerOutput(
      record.state.run_id,
      workers,
      sessionLogsRoot,
      now,
      options.onRecord
    );

    const view = await inspectSupervisorRunRecord(record, now());
    const waitedMs = Math.max(0, Date.now() - startedAt);
    const outcome = workerOutputPending && timeoutMs !== null && waitedMs >= timeoutMs
      ? "timeout"
      : watchOutcome(view, waitedMs, timeoutMs);
    if (outcome) {
      if (outcome !== "timeout" && workerOutputPending) {
        await delay(0);
        continue;
      }
      const result: SupervisorWaitResult = {
        version: 1,
        outcome,
        waited_ms: waitedMs,
        run: view
      };
      await options.onRecord({
        version: 1,
        type: "finish",
        at: now().toISOString(),
        result,
        summary: record.state.result?.summary ?? null,
        error: record.state.error ?? null
      });
      return result;
    }

    const remainingTimeoutMs = timeoutMs === null ? pollIntervalMs : Math.max(1, timeoutMs - waitedMs);
    await delay(Math.min(pollIntervalMs, remainingTimeoutMs));
  }
}

export function formatSupervisorWatchRecord(record: SupervisorWatchRecord): string {
  switch (record.type) {
    case "snapshot":
      return `Watching · ${record.run.run_id} · ${runTarget(record.run)} · ${record.run.status}`;
    case "worker-output": {
      const reset = record.reset ? " · reset" : "";
      return `log · ${record.worker.role}/${record.worker.engine} · ${record.worker.label}${reset}\n${record.text}`;
    }
    case "warning":
      return `warning · ${record.worker.role}/${record.worker.engine} · ${record.worker.label} · ${record.message}`;
    case "finish": {
      const heading = `Run ${record.result.outcome} · ${record.result.run.run_id} · ${runTarget(record.result.run)} · watched ${formatDuration(record.result.waited_ms)}`;
      const detail = record.summary ?? record.error;
      return detail ? `${heading}\n${detail}` : heading;
    }
    case "event":
      return formatSupervisorEvent(record.event);
  }
}

async function selectSupervisorRun(
  workspaceRoot: string,
  dataDir: string,
  runId: string | null | undefined,
  now: Date
): Promise<SupervisorRunRecord> {
  const records = await listSupervisorRuns(workspaceRoot, dataDir);
  const newestFirst = records.reverse();
  if (runId) {
    const selected = newestFirst.find(({ state }) => state.run_id === runId);
    if (!selected) {
      throw new Error(`Supervisor run not found: ${runId}`);
    }
    return selected;
  }

  for (const candidate of newestFirst) {
    const view = await inspectSupervisorRunRecord(candidate, now);
    if (view.status !== "completed" && view.status !== "failed" && view.status !== "cancelled") {
      return candidate;
    }
  }
  const newest = newestFirst[0];
  if (!newest) {
    throw new Error(`No Supervisor runs in workspace ${workspaceRoot}`);
  }
  return newest;
}

function registerWorkerFromEvent(
  event: SupervisorRunEvent,
  workers: Map<string, WatchedWorker>,
  sessionLogsRoot: string
): void {
  if (event.type !== "worker") {
    return;
  }
  try {
    registerWorker(supervisorEventPayload(event) as WorkerLogRef, workers, sessionLogsRoot);
  } catch {
    // The raw event remains visible even when a damaged Worker payload cannot be followed.
  }
}

function registerWorker(
  worker: WorkerLogRef,
  workers: Map<string, WatchedWorker>,
  sessionLogsRoot: string
): void {
  const current = workers.get(worker.id);
  if (current?.ref.logPath === worker.logPath) {
    current.ref = worker;
    return;
  }
  const logPath = resolve(sessionLogsRoot, worker.logPath);
  const pathWarning = pathIsInside(sessionLogsRoot, logPath)
    ? null
    : "Worker log path is outside the Workspace session root; output was not read";
  workers.set(worker.id, {
    ref: worker,
    logPath,
    reader: pathWarning
      ? null
      : createIncrementalTextFileChunkReader(logPath, { maxBytesPerRead: WATCH_LOG_CHUNK_BYTES }),
    pathWarning,
    pathWarningEmitted: false
  });
}

async function emitWorkerOutput(
  runId: string,
  workers: Map<string, WatchedWorker>,
  sessionLogsRoot: string,
  now: () => Date,
  onRecord: SupervisorWatchOptions["onRecord"]
): Promise<boolean> {
  let pending = false;
  for (const worker of workers.values()) {
    if (!worker.reader) {
      await emitWorkerPathWarning(runId, worker, now, onRecord);
      continue;
    }
    if (!(await logPathIsInside(sessionLogsRoot, worker.logPath))) {
      worker.pathWarning = "Worker log resolves outside the Workspace session root; output was not read";
      await emitWorkerPathWarning(runId, worker, now, onRecord);
      continue;
    }

    let hasMore = false;
    for (let chunkIndex = 0; chunkIndex < WATCH_LOG_CHUNKS_PER_POLL; chunkIndex += 1) {
      const snapshot = await worker.reader.read();
      hasMore = snapshot.hasMore;
      if (snapshot.text || snapshot.reset) {
        await onRecord({
          version: 1,
          type: "worker-output",
          at: now().toISOString(),
          run_id: runId,
          worker: watchWorker(worker.ref),
          reset: snapshot.reset,
          text: snapshot.text
        });
      }
      if (!hasMore) {
        break;
      }
    }
    pending ||= hasMore;
  }
  return pending;
}

async function emitWorkerPathWarning(
  runId: string,
  worker: WatchedWorker,
  now: () => Date,
  onRecord: SupervisorWatchOptions["onRecord"]
): Promise<void> {
  if (!worker.pathWarning || worker.pathWarningEmitted) {
    return;
  }
  worker.pathWarningEmitted = true;
  await onRecord({
    version: 1,
    type: "warning",
    at: now().toISOString(),
    run_id: runId,
    worker: watchWorker(worker.ref),
    message: worker.pathWarning
  });
}

function watchWorker(worker: WorkerLogRef): SupervisorWatchWorker {
  return {
    id: worker.id,
    feature_id: worker.featureId ?? null,
    role: worker.role,
    engine: worker.engine,
    label: worker.label
  };
}

async function logPathIsInside(root: string, path: string): Promise<boolean> {
  if (!pathIsInside(root, path)) {
    return false;
  }
  try {
    const canonicalRoot = await realpath(root);
    const canonicalPath = await realpath(path);
    return pathIsInside(canonicalRoot, canonicalPath);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function pathIsInside(root: string, path: string): boolean {
  const fromRoot = relative(resolve(root), resolve(path));
  return fromRoot !== ""
    && fromRoot !== ".."
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot);
}

function watchOutcome(
  run: SupervisorRunView,
  waitedMs: number,
  timeoutMs: number | null
): SupervisorWaitOutcome | null {
  if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
    return run.status;
  }
  if (run.control === "stale") {
    return "stale";
  }
  if (timeoutMs !== null && waitedMs >= timeoutMs) {
    return "timeout";
  }
  return null;
}

function formatSupervisorEvent(event: SupervisorRunEvent): string {
  const stamp = event.at.slice(11, 19);
  if (event.type === "route-start" && isRecord(event.payload)) {
    const scope = stringValue(event.payload.scope) || "route";
    const phase = stringValue(event.payload.phase) || "starting";
    const attempt = numberValue(event.payload.attempt);
    const maxAttempts = numberValue(event.payload.maxAttempts);
    const attempts = attempt && maxAttempts ? ` · attempt ${attempt}/${maxAttempts}` : "";
    return `${stamp} · router ${scope} · ${phase}${attempts}`;
  }
  if (event.type === "route-progress" && isRecord(event.payload)) {
    return `${stamp} · router · ${stringValue(event.payload.phase) || "progress"}`;
  }
  if (event.type === "route" && isRecord(event.payload)) {
    const mode = stringValue(event.payload.mode) || "resolved";
    const reason = stringValue(event.payload.reason);
    return `${stamp} · route ${mode}${reason ? ` · ${singleLine(reason)}` : ""}`;
  }
  if (event.type === "worker" && isRecord(event.payload)) {
    const role = stringValue(event.payload.role) || "worker";
    const engine = stringValue(event.payload.engine) || "unknown";
    const label = stringValue(event.payload.label);
    return `${stamp} · worker ${role}/${engine}${label ? ` · ${singleLine(label)}` : ""}`;
  }
  if (event.type === "status" && isRecord(event.payload)) {
    return `${stamp} · ${formatWorkerStatus(event.payload)}`;
  }
  return `${stamp} · ${event.type}`;
}

function formatWorkerStatus(status: Record<string, unknown>): string {
  const roles = (["main", "judge", "actor", "critic"] as const)
    .flatMap((role) => stringValue(status[role]) ? [`${role} ${stringValue(status[role])}`] : []);
  const featureProgress = isRecord(status.featureProgress) ? status.featureProgress : null;
  const phase = featureProgress ? stringValue(featureProgress.phase) : "";
  const completed = featureProgress ? numberValue(featureProgress.completed) : null;
  const total = featureProgress ? numberValue(featureProgress.total) : null;
  const wave = featureProgress ? numberValue(featureProgress.wave) : null;
  const waves = featureProgress ? numberValue(featureProgress.waves) : null;
  const progress = phase && completed !== null && total !== null && wave !== null && waves !== null
    ? `${phase} ${completed}/${total} · wave ${wave}/${waves}`
    : null;
  const taskId = stringValue(status.taskId);
  return [taskId ? `task ${taskId}` : "status", ...roles, ...(progress ? [progress] : [])].join(" · ");
}

function runTarget(run: SupervisorRunView): string {
  return run.task_id ? `task ${run.task_id}` : run.kind;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }
  return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
