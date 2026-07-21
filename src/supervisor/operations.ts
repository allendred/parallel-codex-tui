import { randomUUID } from "node:crypto";
import type { SupervisorRunKind, SupervisorRunStatus } from "./protocol.js";
import {
  appendSupervisorCommand,
  listSupervisorRuns,
  readSupervisorController,
  readSupervisorRunState,
  supervisorControllerIsActive,
  supervisorRunIsAcknowledged,
  supervisorRunIsTerminal,
  supervisorRunProcessIsActive,
  type SupervisorRunRecord
} from "./store.js";

const QUEUED_START_GRACE_MS = 5000;

export type SupervisorRunControlState =
  | "controlled"
  | "detached"
  | "settled"
  | "stale"
  | "starting";

export interface SupervisorRunView {
  run_id: string;
  kind: SupervisorRunKind;
  status: SupervisorRunStatus;
  control: SupervisorRunControlState;
  task_id: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  pid: number | null;
  process_active: boolean;
  controller_pid: number | null;
  controller_active: boolean;
  acknowledged: boolean;
}

export interface SupervisorRunsReport {
  version: 1;
  workspace_root: string;
  generated_at: string;
  runs: SupervisorRunView[];
}

export interface SupervisorCancellationResult {
  version: 1;
  command_id: string;
  requested_at: string;
  run: SupervisorRunView;
}

export type SupervisorWaitOutcome = "cancelled" | "completed" | "failed" | "stale" | "timeout";
type SupervisorTerminalStatus = Extract<
  SupervisorRunStatus,
  "cancelled" | "completed" | "failed"
>;

export interface SupervisorWaitResult {
  version: 1;
  outcome: SupervisorWaitOutcome;
  waited_ms: number;
  run: SupervisorRunView;
}

export interface SupervisorWaitOptions {
  timeoutMs?: number | null;
  pollIntervalMs?: number;
  now?: () => Date;
}

export async function inspectSupervisorRuns(
  workspaceRoot: string,
  dataDir: string,
  now = new Date()
): Promise<SupervisorRunsReport> {
  const records = await listSupervisorRuns(workspaceRoot, dataDir);
  const runs = await Promise.all(records.map((record) => inspectSupervisorRun(record, now)));
  return {
    version: 1,
    workspace_root: workspaceRoot,
    generated_at: now.toISOString(),
    runs: runs.reverse()
  };
}

export async function requestSupervisorRunCancellation(
  workspaceRoot: string,
  dataDir: string,
  runId?: string | null,
  now = new Date()
): Promise<SupervisorCancellationResult> {
  const records = await listSupervisorRuns(workspaceRoot, dataDir);
  const inspected = await Promise.all(records.map(async (record) => ({
    record,
    view: await inspectSupervisorRun(record, now)
  })));
  const newestFirst = inspected.reverse();
  const selected = runId
    ? newestFirst.find(({ view }) => view.run_id === runId)
    : newestFirst.find(({ view }) => !isTerminalStatus(view.status) && view.control !== "stale");

  if (!selected) {
    if (runId) {
      throw new Error(`Supervisor run not found: ${runId}`);
    }
    const stale = newestFirst.find(({ view }) => !isTerminalStatus(view.status));
    if (stale) {
      throw new Error(`Supervisor run is not active: ${stale.view.run_id} (${stale.view.status})`);
    }
    throw new Error(`No active Supervisor run in workspace ${workspaceRoot}`);
  }
  if (isTerminalStatus(selected.view.status)) {
    throw new Error(`Supervisor run is already ${selected.view.status}: ${selected.view.run_id}`);
  }
  if (selected.view.control === "stale") {
    throw new Error(`Supervisor run is not active: ${selected.view.run_id} (${selected.view.status})`);
  }

  const requestedAt = now.toISOString();
  const commandId = randomUUID();
  await appendSupervisorCommand(selected.record.files, {
    version: 1,
    id: commandId,
    at: requestedAt,
    type: "cancel-run"
  });
  return {
    version: 1,
    command_id: commandId,
    requested_at: requestedAt,
    run: selected.view
  };
}

export async function waitForSupervisorRun(
  workspaceRoot: string,
  dataDir: string,
  runId?: string | null,
  options: SupervisorWaitOptions = {}
): Promise<SupervisorWaitResult> {
  const startedAt = Date.now();
  const now = options.now ?? (() => new Date());
  const requestedPollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isFinite(requestedPollIntervalMs) || requestedPollIntervalMs <= 0) {
    throw new Error("Supervisor wait poll interval must be a positive number of milliseconds");
  }
  const pollIntervalMs = Math.max(10, requestedPollIntervalMs);
  const timeoutMs = options.timeoutMs ?? null;
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("Supervisor wait timeout must be a positive number of milliseconds");
  }
  const records = await listSupervisorRuns(workspaceRoot, dataDir);
  const inspected = await Promise.all(records.map(async (record) => ({
    record,
    view: await inspectSupervisorRun(record, now())
  })));
  const newestFirst = inspected.reverse();
  const selected = runId
    ? newestFirst.find(({ view }) => view.run_id === runId)
    : newestFirst.find(({ view }) => !isTerminalStatus(view.status)) ?? newestFirst[0];

  if (!selected) {
    throw new Error(runId
      ? `Supervisor run not found: ${runId}`
      : `No Supervisor runs in workspace ${workspaceRoot}`);
  }

  while (true) {
    const view = await inspectSupervisorRun(selected.record, now());
    const waitedMs = Math.max(0, Date.now() - startedAt);
    if (isTerminalStatus(view.status)) {
      return {
        version: 1,
        outcome: view.status,
        waited_ms: waitedMs,
        run: view
      };
    }
    if (view.control === "stale") {
      return {
        version: 1,
        outcome: "stale",
        waited_ms: waitedMs,
        run: view
      };
    }
    if (timeoutMs !== null && waitedMs >= timeoutMs) {
      return {
        version: 1,
        outcome: "timeout",
        waited_ms: waitedMs,
        run: view
      };
    }

    const remainingTimeoutMs = timeoutMs === null ? pollIntervalMs : Math.max(1, timeoutMs - waitedMs);
    await delay(Math.min(pollIntervalMs, remainingTimeoutMs));
    selected.record.state = await readSupervisorRunState(selected.record.files);
  }
}

export function formatSupervisorRuns(report: SupervisorRunsReport): string {
  if (report.runs.length === 0) {
    return `No Supervisor runs in ${report.workspace_root}.`;
  }
  const lines = [`Supervisor runs · ${report.workspace_root}`];
  for (const run of report.runs) {
    const acknowledgement = run.acknowledged ? "seen" : "unread";
    lines.push(`${run.status} · ${run.control} · ${acknowledgement} · ${run.run_id}`);
    lines.push([
      run.task_id ? `task ${run.task_id}` : `kind ${run.kind}`,
      `updated ${run.updated_at}`,
      ...(run.pid ? [`pid ${run.pid}`] : [])
    ].join(" · "));
  }
  return lines.join("\n");
}

export function formatSupervisorCancellation(result: SupervisorCancellationResult): string {
  const target = result.run.task_id ? `task ${result.run.task_id}` : result.run.kind;
  return `Cancellation requested · ${result.run.run_id} · ${target}`;
}

export function formatSupervisorWait(result: SupervisorWaitResult): string {
  const target = result.run.task_id ? `task ${result.run.task_id}` : result.run.kind;
  return `Run ${result.outcome} · ${result.run.run_id} · ${target} · waited ${formatDuration(result.waited_ms)}`;
}

export function supervisorWaitExitCode(outcome: SupervisorWaitOutcome): number {
  switch (outcome) {
    case "completed":
      return 0;
    case "failed":
      return 1;
    case "cancelled":
      return 2;
    case "stale":
      return 3;
    case "timeout":
      return 4;
  }
}

async function inspectSupervisorRun(
  record: SupervisorRunRecord,
  now: Date
): Promise<SupervisorRunView> {
  const controller = await readSupervisorController(record.files);
  const [processActive, controllerActive, acknowledged] = await Promise.all([
    supervisorRunProcessIsActive(record.state),
    controller ? supervisorControllerIsActive(controller) : Promise.resolve(false),
    supervisorRunIsAcknowledged(record.files)
  ]);
  return {
    run_id: record.state.run_id,
    kind: record.state.kind,
    status: record.state.status,
    control: controlState(record, processActive, controllerActive, now),
    task_id: record.state.task_id ?? null,
    created_at: record.state.created_at,
    updated_at: record.state.updated_at,
    finished_at: record.state.finished_at ?? null,
    pid: record.state.pid ?? null,
    process_active: processActive,
    controller_pid: controller?.pid ?? null,
    controller_active: controllerActive,
    acknowledged
  };
}

function controlState(
  record: SupervisorRunRecord,
  processActive: boolean,
  controllerActive: boolean,
  now: Date
): SupervisorRunControlState {
  if (supervisorRunIsTerminal(record.state)) {
    return "settled";
  }
  if (controllerActive) {
    return "controlled";
  }
  if (processActive) {
    return "detached";
  }
  if (
    record.state.status === "queued"
    && now.getTime() - Date.parse(record.state.updated_at) <= QUEUED_START_GRACE_MS
  ) {
    return "starting";
  }
  return "stale";
}

function isTerminalStatus(status: SupervisorRunStatus): status is SupervisorTerminalStatus {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }
  return `${(milliseconds / 1000).toFixed(milliseconds < 10000 ? 1 : 0)}s`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
