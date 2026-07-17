import { open, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir, platform, arch } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AppRuntime } from "../bootstrap.js";
import { runDoctor, type DoctorResult } from "../doctor.js";
import type { WorkerLogRef } from "../orchestrator/orchestrator.js";
import { version } from "../version.js";
import { NativeSessionSchema, type NativeSession, type WorkerStatus } from "../domain/schemas.js";
import { ensureDir, pathExists, readJson, writeJson, writeText } from "./file-store.js";
import { readRouterAudit } from "./router-audit.js";
import { sanitizeRouterText } from "./router-redaction.js";

const DIAGNOSTICS_FORMAT = "parallel-codex-diagnostics-v1";
const DEFAULT_TASK_LIMIT = 20;
const DEFAULT_WORKER_LIMIT = 200;
const DEFAULT_ROUTER_RECORD_LIMIT = 100;
const DEFAULT_LOG_BYTES = 64 * 1024;
const DEFAULT_LOG_LINES = 200;

export interface DiagnosticsExportOptions {
  destinationPath?: string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  doctor?: () => Promise<DoctorResult>;
  taskLimit?: number;
  workerLimit?: number;
  routerRecordLimit?: number;
  logBytes?: number;
  logLines?: number;
}

export interface DiagnosticsExportResult {
  path: string;
  createdAt: string;
  taskCount: number;
  workerCount: number;
  logCount: number;
}

interface DiagnosticsWorkerRecord {
  taskId: string;
  id: string;
  featureId?: string;
  role: WorkerLogRef["role"];
  engine: WorkerLogRef["engine"];
  label: string;
  status: WorkerStatus | null;
  nativeSession: NativeSession | null;
  log: {
    path: string;
    sourceBytes: number;
    exportedBytes: number;
    exportedLines: number;
    truncated: boolean;
  } | null;
}

interface DiagnosticsTextContext {
  aliases: Array<{ path: string; alias: string }>;
}

export async function exportDiagnostics(
  appRoot: string,
  runtime: AppRuntime,
  options: DiagnosticsExportOptions = {}
): Promise<DiagnosticsExportResult> {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const context = diagnosticsTextContext(appRoot, runtime.workspaceRoot);
  const taskLimit = boundedLimit(options.taskLimit, DEFAULT_TASK_LIMIT, 100);
  const workerLimit = boundedLimit(options.workerLimit, DEFAULT_WORKER_LIMIT, 1000);
  const routerRecordLimit = boundedLimit(options.routerRecordLimit, DEFAULT_ROUTER_RECORD_LIMIT, 500);
  const logBytes = boundedLimit(options.logBytes, DEFAULT_LOG_BYTES, 1024 * 1024);
  const logLines = boundedLimit(options.logLines, DEFAULT_LOG_LINES, 2000);
  const destination = await diagnosticsDestination(runtime, options.destinationPath ?? null, createdAt);
  const stagingParent = dirname(destination);
  await ensureDir(stagingParent);
  if (await pathExists(destination)) {
    throw new Error(`Diagnostics destination already exists: ${destination}`);
  }
  const staging = await mkdtemp(join(stagingParent, ".parallel-codex-diagnostics-"));

  try {
    const [activeTaskId, tasks, routerAudit, doctor] = await Promise.all([
      runtime.index.activeTaskId(),
      runtime.index.listTasks(taskLimit, { includeArchived: true }),
      readRouterAudit(join(runtime.routerCwd, "routes.jsonl"), routerRecordLimit),
      options.doctor
        ? options.doctor()
        : runDoctor(appRoot, runtime.workspaceRoot, options.env ?? process.env)
    ]);

    const workerRecords: DiagnosticsWorkerRecord[] = [];
    let omittedWorkers = 0;
    for (let taskIndex = 0; taskIndex < tasks.length; taskIndex += 1) {
      const task = tasks[taskIndex];
      if (!task) {
        continue;
      }
      const taskWorkers = await runtime.orchestrator.listTaskWorkers(task.id);
      const remaining = Math.max(0, workerLimit - workerRecords.length);
      const selected = taskWorkers.length <= remaining
        ? taskWorkers
        : latestWorkers(taskWorkers, remaining);
      omittedWorkers += taskWorkers.length - selected.length;
      for (const worker of selected) {
        workerRecords.push(await exportWorkerLog(staging, task.id, worker, context, logBytes, logLines));
      }
      if (workerRecords.length >= workerLimit) {
        omittedWorkers += tasks
          .slice(taskIndex + 1)
          .reduce((total, remainingTask) => total + remainingTask.workerCount, 0);
        break;
      }
    }

    const safeTasks = sanitizeDiagnosticsValue(tasks, context);
    const safeWorkers = sanitizeDiagnosticsValue(workerRecords, context);
    const safeRouterAudit = sanitizeDiagnosticsValue(routerAudit, context);
    const safeDoctorText = sanitizeDiagnosticsText(doctor.text, context);
    const config = diagnosticsConfigSummary(runtime.config, options.env ?? process.env, context);
    const report = {
      format: DIAGNOSTICS_FORMAT,
      createdAt,
      app: {
        name: "parallel-codex-tui",
        version,
        node: process.versions.node,
        platform: platform(),
        arch: arch()
      },
      workspace: "$WORKSPACE",
      appRoot: appRoot === runtime.workspaceRoot ? "$WORKSPACE" : "$APP_ROOT",
      sessionIndex: {
        schemaVersion: runtime.index.schemaVersion(),
        recovery: sanitizeDiagnosticsValue(runtime.index.recovery, context),
        activeTaskId: activeTaskId ?? null
      },
      startupRecovery: sanitizeDiagnosticsValue({
        pendingTaskCreations: runtime.pendingTaskCreations,
        workspaceCommitRecovery: runtime.workspaceCommitRecovery,
        recoveredTasks: runtime.recoveredTasks
      }, context),
      config,
      doctor: {
        ok: doctor.ok,
        path: "doctor.txt"
      },
      tasks: {
        path: "tasks.json",
        exported: tasks.length,
        limit: taskLimit
      },
      workers: {
        path: "workers.json",
        exported: workerRecords.length,
        omitted: omittedWorkers,
        limit: workerLimit
      },
      routerAudit: {
        path: "router-audit.jsonl",
        exported: routerAudit.length,
        limit: routerRecordLimit
      },
      logs: {
        exported: workerRecords.filter((worker) => worker.log).length,
        maxBytesPerWorker: logBytes,
        maxLinesPerWorker: logLines
      }
    };

    await writeJson(join(staging, "report.json"), report);
    await writeJson(join(staging, "tasks.json"), safeTasks);
    await writeJson(join(staging, "workers.json"), safeWorkers);
    await writeText(join(staging, "doctor.txt"), ensureTrailingNewline(safeDoctorText));
    await writeText(
      join(staging, "router-audit.jsonl"),
      safeRouterAudit.map((record) => JSON.stringify(record)).join("\n") + (safeRouterAudit.length > 0 ? "\n" : "")
    );
    await writeText(join(staging, "report.md"), diagnosticsMarkdownReport(report, config));
    await writeJson(join(staging, "manifest.json"), {
      format: DIAGNOSTICS_FORMAT,
      created_at: createdAt,
      report: "report.json",
      redaction: {
        enabled: true,
        pathAliases: ["$WORKSPACE", "$APP_ROOT", "~"],
        secrets: "URL credentials and paths, authorization values, secret assignments, and common raw token formats",
        configValues: "Environment variable values, prompts, role instructions, command arguments, and source files are excluded",
        logs: `Only the latest ${logLines} lines and ${logBytes} bytes per Worker are eligible for export`
      }
    });
    await rename(staging, destination);

    return {
      path: destination,
      createdAt,
      taskCount: tasks.length,
      workerCount: workerRecords.length,
      logCount: workerRecords.filter((worker) => worker.log).length
    };
  } catch (error) {
    await rm(staging, { force: true, recursive: true });
    throw error;
  }
}

async function diagnosticsDestination(
  runtime: AppRuntime,
  requested: string | null,
  createdAt: string
): Promise<string> {
  if (requested) {
    return requested;
  }
  const root = join(runtime.workspaceRoot, runtime.config.dataDir, "diagnostics");
  await ensureDir(root);
  const stamp = createdAt.replace(/[^0-9]/g, "").slice(0, 14);
  let destination = join(root, stamp);
  for (let suffix = 2; await pathExists(destination); suffix += 1) {
    destination = join(root, `${stamp}-${suffix}`);
  }
  return destination;
}

async function exportWorkerLog(
  staging: string,
  taskId: string,
  worker: WorkerLogRef,
  context: DiagnosticsTextContext,
  maxBytes: number,
  maxLines: number
): Promise<DiagnosticsWorkerRecord> {
  const workerSegment = safePathSegment(worker.id);
  const relativeLogPath = join("logs", safePathSegment(taskId), `${workerSegment}.log`);
  const tail = await readBoundedTextTail(worker.logPath, maxBytes, maxLines);
  if (tail) {
    await writeText(join(staging, relativeLogPath), ensureTrailingNewline(sanitizeDiagnosticsText(tail.text, context)));
  }
  return {
    taskId,
    id: worker.id,
    ...(worker.featureId ? { featureId: worker.featureId } : {}),
    role: worker.role,
    engine: worker.engine,
    label: sanitizeDiagnosticsText(worker.label, context),
    status: worker.runtimeStatus
      ? sanitizeDiagnosticsValue(worker.runtimeStatus, context) as WorkerStatus
      : null,
    nativeSession: await readNativeSession(worker),
    log: tail
      ? {
          path: relativeLogPath,
          sourceBytes: tail.sourceBytes,
          exportedBytes: Buffer.byteLength(sanitizeDiagnosticsText(tail.text, context), "utf8"),
          exportedLines: tail.text.split("\n").length,
          truncated: tail.truncated
        }
      : null
  };
}

async function readNativeSession(worker: WorkerLogRef): Promise<NativeSession | null> {
  try {
    return await readJson(join(dirname(worker.statusPath), "native-session.json"), NativeSessionSchema);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function readBoundedTextTail(
  path: string,
  maxBytes: number,
  maxLines: number
): Promise<{ text: string; sourceBytes: number; truncated: boolean } | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    const sourceBytes = (await handle.stat()).size;
    const requested = Math.min(sourceBytes, maxBytes);
    const start = Math.max(0, sourceBytes - requested);
    const buffer = Buffer.alloc(requested);
    const { bytesRead } = await handle.read(buffer, 0, requested, start);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    let truncated = start > 0;
    if (start > 0) {
      const firstNewline = text.indexOf("\n");
      if (firstNewline >= 0) {
        text = text.slice(firstNewline + 1);
      }
    }
    const lines = text.split("\n");
    if (lines.length > maxLines) {
      text = lines.slice(-maxLines).join("\n");
      truncated = true;
    }
    if (truncated) {
      text = `[earlier log content omitted]\n${text}`;
    }
    return { text, sourceBytes, truncated };
  } finally {
    await handle.close();
  }
}

function diagnosticsConfigSummary(
  config: AppRuntime["config"],
  env: NodeJS.ProcessEnv,
  context: DiagnosticsTextContext
): Record<string, unknown> {
  return {
    dataDir: sanitizeDiagnosticsText(config.dataDir, context),
    router: {
      mode: config.router.defaultMode,
      command: commandName(config.router.codex.command),
      argumentCount: config.router.codex.args.length,
      timeoutMs: config.router.codex.timeoutMs,
      firstOutputTimeoutMs: config.router.codex.firstOutputTimeoutMs,
      idleTimeoutMs: config.router.codex.idleTimeoutMs,
      followUpTimeoutMs: config.router.codex.followUpTimeoutMs,
      maxOutputBytes: config.router.codex.maxOutputBytes,
      maxAttempts: config.router.codex.maxAttempts,
      retryDelayMs: config.router.codex.retryDelayMs,
      fallback: config.router.codex.fallback,
      environment: environmentSummary(config.router.codex.env, env),
      proxyVariables: proxyVariableNames(config.router.codex.env)
    },
    orchestration: config.orchestration,
    pairing: config.pairing,
    providers: Object.entries(config.workers).map(([id, worker]) => ({
      id,
      command: commandName(worker.command),
      interactiveCommand: commandName(worker.interactive.command),
      argumentCount: worker.args.length,
      assignable: worker.assignable,
      model: sanitizeDiagnosticsText(worker.model.name || "default", context),
      modelProvider: sanitizeDiagnosticsText(worker.model.provider || "default", context),
      modelArgumentCount: worker.model.args.length,
      environment: environmentSummary(worker.model.env, env),
      proxyVariables: proxyVariableNames(worker.model.env),
      capabilities: {
        profile: worker.capabilities.profile,
        writableDirectoryArguments: worker.capabilities.writableDirArgs.length > 0,
        freshSessionArguments: worker.capabilities.freshSessionArgs.length > 0
      },
      nativeSession: {
        enabled: worker.nativeSession.enabled,
        detectSessionId: worker.nativeSession.detectSessionId,
        fallback: worker.nativeSession.fallback,
        resumeArgumentCount: worker.nativeSession.resumeArgs.length,
        forkSupported: worker.interactive.forkArgs.length > 0
      },
      timeouts: {
        totalMs: worker.timeoutMs ?? null,
        firstOutputMs: worker.firstOutputTimeoutMs ?? null,
        idleMs: worker.idleTimeoutMs ?? null
      }
    })),
    ui: {
      theme: config.ui.theme,
      showStatusBar: config.ui.showStatusBar,
      autoOpenFailedWorker: config.ui.autoOpenFailedWorker,
      colorOverrides: Object.keys(config.ui.colors).sort()
    }
  };
}

function diagnosticsMarkdownReport(
  report: {
    createdAt: string;
    app: { version: string; node: string; platform: string; arch: string };
    workspace: string;
    sessionIndex: { activeTaskId: string | null };
    doctor: { ok: boolean };
    tasks: { exported: number };
    workers: { exported: number; omitted: number };
    logs: { exported: number };
    routerAudit: { exported: number };
  },
  config: Record<string, unknown>
): string {
  const providers = (config.providers as Array<{ id: string; command: string; model: string; modelProvider: string }>)
    .map((provider) => `- ${provider.id}: ${provider.command} · ${provider.modelProvider}/${provider.model}`)
    .join("\n");
  return `# parallel-codex-tui diagnostics

- Created: ${report.createdAt}
- Version: ${report.app.version}
- Runtime: Node ${report.app.node} · ${report.app.platform}/${report.app.arch}
- Workspace: ${report.workspace}
- Active task: ${report.sessionIndex.activeTaskId ?? "none"}
- Doctor: ${report.doctor.ok ? "ok" : "needs attention"}
- Tasks: ${report.tasks.exported}
- Workers: ${report.workers.exported}${report.workers.omitted ? ` (${report.workers.omitted} omitted by limit)` : ""}
- Logs: ${report.logs.exported} bounded tails
- Router audit rows: ${report.routerAudit.exported}

## Providers

${providers || "- none"}

## Privacy

This bundle is sanitized. It excludes environment values, prompts, role instructions, command arguments, source files, and complete lifetime logs. Review the bundle before sharing it.
`;
}

function diagnosticsTextContext(appRoot: string, workspaceRoot: string): DiagnosticsTextContext {
  return {
    aliases: [
      { path: workspaceRoot, alias: "$WORKSPACE" },
      { path: appRoot, alias: "$APP_ROOT" },
      { path: homedir(), alias: "~" }
    ]
      .filter(({ path }) => path.length > 1)
      .sort((left, right) => right.path.length - left.path.length)
  };
}

export function sanitizeDiagnosticsText(value: string, context: DiagnosticsTextContext): string {
  let sanitized = sanitizeRouterText(value);
  for (const entry of context.aliases) {
    sanitized = sanitized.split(entry.path).join(entry.alias);
  }
  return sanitized;
}

function sanitizeDiagnosticsValue<Value>(value: Value, context: DiagnosticsTextContext): Value {
  if (typeof value === "string") {
    return sanitizeDiagnosticsText(value, context) as Value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDiagnosticsValue(entry, context)) as Value;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      sanitizeDiagnosticsValue(entry, context)
    ])) as Value;
  }
  return value;
}

function environmentSummary(values: Record<string, string>, env: NodeJS.ProcessEnv): Array<{
  name: string;
  configured: boolean;
  referencedVariables: Array<{ name: string; present: boolean }>;
}> {
  return Object.entries(values).map(([name, value]) => ({
    name,
    configured: true,
    referencedVariables: [...value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/gi)].map((match) => ({
      name: match[1] ?? "",
      present: Boolean(env[match[1] ?? ""])
    }))
  }));
}

function proxyVariableNames(values: Record<string, string>): string[] {
  return Object.keys(values).filter((name) => /^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(name)).sort();
}

function commandName(command: string): string {
  return basename(command) || command;
}

function latestWorkers(workers: WorkerLogRef[], limit: number): WorkerLogRef[] {
  if (limit <= 0) {
    return [];
  }
  return [...workers]
    .sort((left, right) => (
      (right.runtimeStatus?.last_event_at ?? "").localeCompare(left.runtimeStatus?.last_event_at ?? "")
      || right.id.localeCompare(left.id)
    ))
    .slice(0, limit);
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 180) || "unknown";
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(1, Math.trunc(value ?? fallback)));
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
