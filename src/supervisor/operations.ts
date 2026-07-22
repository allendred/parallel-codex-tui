import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { RoleExecutionSelection } from "../core/role-configuration.js";
import { TaskIdSchema } from "../domain/schemas.js";
import type {
  SupervisorRunKind,
  SupervisorRunRequest,
  SupervisorRunStatus
} from "./protocol.js";
import {
  launchSupervisorProcess,
  runWithSupervisorSubmissionTurn,
  supervisorSubmissionLockWarning,
  type SupervisorLauncher,
  type SupervisorSubmissionTurnAcquirer
} from "./launcher.js";
import {
  appendSupervisorCommand,
  createSupervisorRun,
  createSupervisorRunId,
  listSupervisorRuns,
  readSupervisorController,
  readSupervisorRunRequest,
  readSupervisorRunState,
  supervisorControllerIsActive,
  supervisorRunIsAcknowledged,
  supervisorRunIsTerminal,
  supervisorRunProcessIsActive,
  writeSupervisorRunState,
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

export interface SupervisorSubmissionInput {
  appRoot: string;
  workspaceRoot: string;
  dataDir: string;
  cwd: string;
  request: string;
  taskId?: string | null;
  roleSelection?: RoleExecutionSelection;
  idempotencyKey?: string | null;
}

export interface SupervisorSubmissionOptions {
  acquireSubmissionTurn?: SupervisorSubmissionTurnAcquirer;
  launch?: SupervisorLauncher;
  now?: () => Date;
}

export interface SupervisorTaskOperationInput {
  appRoot: string;
  workspaceRoot: string;
  dataDir: string;
  cwd: string;
  kind: "retry-task" | "resume-feature";
  taskId: string;
  featureId?: string | null;
  idempotencyKey?: string | null;
}

export type SupervisorFeatureCommandAction = "cancel" | "pause";

export interface SupervisorFeatureCommandInput {
  action: SupervisorFeatureCommandAction;
  taskId: string;
  featureId: string;
}

export interface SupervisorFeatureCommandResult {
  version: 1;
  command_id: string;
  requested_at: string;
  action: SupervisorFeatureCommandAction;
  task_id: string;
  feature_id: string;
  run: SupervisorRunView;
}

export interface SupervisorSubmissionResult {
  version: 1;
  reused: boolean;
  run: SupervisorRunView;
  warnings?: string[];
}

export interface SupervisorSubmitAndWaitResult {
  version: 1;
  submission: SupervisorSubmissionResult;
  wait: SupervisorWaitResult;
}

export async function submitSupervisorRun(
  input: SupervisorSubmissionInput,
  options: SupervisorSubmissionOptions = {}
): Promise<SupervisorSubmissionResult> {
  const requestText = input.request.trim();
  if (!requestText) {
    throw new Error("Supervisor submission request cannot be empty");
  }
  return submitPreparedSupervisorRun(
    input,
    (runId, createdAt) => submissionRequest(input, requestText, runId, createdAt),
    options
  );
}

export async function submitSupervisorTaskOperation(
  input: SupervisorTaskOperationInput,
  options: SupervisorSubmissionOptions = {}
): Promise<SupervisorSubmissionResult> {
  if (!TaskIdSchema.safeParse(input.taskId).success) {
    throw new Error("Invalid task id for Supervisor operation");
  }
  const featureId = input.featureId?.trim() || null;
  if (input.kind === "resume-feature" && !featureId) {
    throw new Error("Supervisor resume-feature requires a feature id");
  }
  if (featureId && !featureIdIsSafe(featureId)) {
    throw new Error(`Unsafe feature id: ${featureId}`);
  }
  return submitPreparedSupervisorRun(
    input,
    (runId, createdAt) => taskOperationRequest(input, featureId, runId, createdAt),
    options
  );
}

async function submitPreparedSupervisorRun(
  input: Pick<SupervisorSubmissionInput, "workspaceRoot" | "dataDir" | "idempotencyKey">,
  createRequest: (runId: string, createdAt: string) => SupervisorRunRequest,
  options: SupervisorSubmissionOptions
): Promise<SupervisorSubmissionResult> {
  const idempotencyKey = normalizedIdempotencyKey(input.idempotencyKey);
  const now = options.now ?? (() => new Date());
  const launch = options.launch ?? launchSupervisorProcess;
  const createdAt = now().toISOString();
  const runId = idempotencyKey
    ? idempotentRunId(input.workspaceRoot, idempotencyKey)
    : createSupervisorRunId(now());
  const request = createRequest(runId, createdAt);
  const completed = await runWithSupervisorSubmissionTurn(
    input.workspaceRoot,
    input.dataDir,
    async () => {
      const records = await listSupervisorRuns(input.workspaceRoot, input.dataDir);
      const existing = records.find((record) => record.state.run_id === runId);
      if (existing) {
        const persistedRequest = await readSupervisorRunRequest(existing.files);
        if (!sameSubmission(persistedRequest, request)) {
          throw new Error("Idempotency key is already associated with a different Supervisor request");
        }
        if (existing.state.status === "queued" && !(await supervisorRunProcessIsActive(existing.state))) {
          await launchOrFail(existing.files, persistedRequest, launch, now);
          existing.state = await readSupervisorRunState(existing.files);
        }
        return {
          version: 1,
          reused: true,
          run: await inspectSupervisorRunRecord(existing, now())
        } satisfies SupervisorSubmissionResult;
      }

      await reconcileStaleRuns(records, now());
      const active = records.find(({ state }) => !isTerminalStatus(state.status));
      if (active) {
        throw new Error(`A background run is already active in this workspace: ${active.state.run_id}`);
      }

      const files = await createSupervisorRun(input.workspaceRoot, input.dataDir, request);
      await launchOrFail(files, request, launch, now);
      const state = await readSupervisorRunState(files);
      return {
        version: 1,
        reused: false,
        run: await inspectSupervisorRunRecord({ files, state }, now())
      } satisfies SupervisorSubmissionResult;
    },
    options.acquireSubmissionTurn
  );
  if (!completed.releaseError) {
    return completed.value;
  }
  return {
    ...completed.value,
    warnings: [supervisorSubmissionLockWarning(completed.releaseError)]
  };
}

export async function inspectSupervisorRuns(
  workspaceRoot: string,
  dataDir: string,
  now = new Date()
): Promise<SupervisorRunsReport> {
  const records = await listSupervisorRuns(workspaceRoot, dataDir);
  const runs = await Promise.all(records.map((record) => inspectSupervisorRunRecord(record, now)));
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
    view: await inspectSupervisorRunRecord(record, now)
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

export async function requestSupervisorFeatureCommand(
  workspaceRoot: string,
  dataDir: string,
  input: SupervisorFeatureCommandInput,
  now = new Date()
): Promise<SupervisorFeatureCommandResult> {
  if (!TaskIdSchema.safeParse(input.taskId).success) {
    throw new Error("Invalid task id for Supervisor feature command");
  }
  if (!featureIdIsSafe(input.featureId)) {
    throw new Error(`Unsafe feature id: ${input.featureId}`);
  }
  const records = await listSupervisorRuns(workspaceRoot, dataDir);
  const inspected = await Promise.all(records.map(async (record) => ({
    record,
    view: await inspectSupervisorRunRecord(record, now)
  })));
  const newestFirst = inspected.reverse();
  const selected = newestFirst.find(({ view }) => (
    view.task_id === input.taskId
    && !isTerminalStatus(view.status)
    && view.control !== "stale"
  ));
  if (!selected) {
    const matching = newestFirst.find(({ view }) => view.task_id === input.taskId);
    if (matching) {
      throw new Error(
        `No active Supervisor run for task ${input.taskId}: ${matching.view.run_id} is ${matching.view.status}`
      );
    }
    throw new Error(`No Supervisor run found for task ${input.taskId}`);
  }

  const requestedAt = now.toISOString();
  const commandId = randomUUID();
  await appendSupervisorCommand(selected.record.files, {
    version: 1,
    id: commandId,
    at: requestedAt,
    type: input.action === "pause" ? "pause-feature" : "cancel-feature",
    task_id: input.taskId,
    feature_id: input.featureId
  });
  return {
    version: 1,
    command_id: commandId,
    requested_at: requestedAt,
    action: input.action,
    task_id: input.taskId,
    feature_id: input.featureId,
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
    view: await inspectSupervisorRunRecord(record, now())
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
    const view = await inspectSupervisorRunRecord(selected.record, now());
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

export function formatSupervisorSubmission(result: SupervisorSubmissionResult): string {
  const action = result.reused ? "Run reused" : "Run submitted";
  const target = result.run.task_id ? `task ${result.run.task_id}` : result.run.kind;
  return [
    `${action} · ${result.run.run_id} · ${target} · ${result.run.status}`,
    ...(result.warnings ?? []).map((warning) => `Warning: ${warning}`)
  ].join("\n");
}

export function formatSupervisorCancellation(result: SupervisorCancellationResult): string {
  const target = result.run.task_id ? `task ${result.run.task_id}` : result.run.kind;
  return `Cancellation requested · ${result.run.run_id} · ${target}`;
}

export function formatSupervisorFeatureCommand(result: SupervisorFeatureCommandResult): string {
  const action = result.action === "pause" ? "Pause" : "Cancellation";
  return `${action} requested · ${result.feature_id} · task ${result.task_id} · ${result.run.run_id}`;
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

export async function inspectSupervisorRunRecord(
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

function submissionRequest(
  input: SupervisorSubmissionInput,
  request: string,
  runId: string,
  createdAt: string
): SupervisorRunRequest {
  const base = {
    version: 1 as const,
    run_id: runId,
    app_root: input.appRoot,
    workspace_root: input.workspaceRoot,
    data_dir: input.dataDir,
    created_at: createdAt,
    request,
    cwd: input.cwd,
    ...(input.roleSelection ? { role_selection: input.roleSelection } : {})
  };
  return input.taskId
    ? { ...base, kind: "handle-task-turn", task_id: input.taskId }
    : { ...base, kind: "handle-request" };
}

function taskOperationRequest(
  input: SupervisorTaskOperationInput,
  featureId: string | null,
  runId: string,
  createdAt: string
): SupervisorRunRequest {
  const base = {
    version: 1 as const,
    run_id: runId,
    app_root: input.appRoot,
    workspace_root: input.workspaceRoot,
    data_dir: input.dataDir,
    created_at: createdAt,
    cwd: input.cwd,
    task_id: input.taskId
  };
  return input.kind === "resume-feature"
    ? { ...base, kind: "resume-feature", feature_id: featureId! }
    : { ...base, kind: "retry-task" };
}

function normalizedIdempotencyKey(value: string | null | undefined): string | null {
  const key = value?.trim() || null;
  if (key && !/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw new Error("Invalid idempotency key: expected 1-128 letters, numbers, dot, underscore, colon, or hyphen");
  }
  return key;
}

function idempotentRunId(workspaceRoot: string, key: string): string {
  const digest = createHash("sha256")
    .update(workspaceRoot)
    .update("\0")
    .update(key)
    .digest("hex")
    .slice(0, 24);
  return `run-idem-${digest}`;
}

function featureIdIsSafe(featureId: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,95}$/.test(featureId);
}

function sameSubmission(left: SupervisorRunRequest, right: SupervisorRunRequest): boolean {
  return isDeepStrictEqual(submissionIdentity(left), submissionIdentity(right));
}

function submissionIdentity(request: SupervisorRunRequest): Omit<SupervisorRunRequest, "run_id" | "created_at"> {
  const { run_id: _runId, created_at: _createdAt, ...identity } = request;
  return identity;
}

async function reconcileStaleRuns(records: SupervisorRunRecord[], now: Date): Promise<void> {
  for (const record of records) {
    if (isTerminalStatus(record.state.status) || await supervisorRunProcessIsActive(record.state)) {
      continue;
    }
    const ageMs = now.getTime() - Date.parse(record.state.created_at);
    if (record.state.status === "queued" && ageMs < QUEUED_START_GRACE_MS) {
      continue;
    }
    const failedAt = now.toISOString();
    record.state = {
      ...record.state,
      status: "failed",
      updated_at: failedAt,
      finished_at: failedAt,
      error: `Supervisor exited unexpectedly while ${record.state.kind} was running.`
    };
    await writeSupervisorRunState(record.files, record.state);
  }
}

async function launchOrFail(
  files: SupervisorRunRecord["files"],
  request: SupervisorRunRequest,
  launch: SupervisorLauncher,
  now: () => Date
): Promise<void> {
  try {
    await launch(files, request);
  } catch (error) {
    const current = await readSupervisorRunState(files);
    if (!isTerminalStatus(current.status)) {
      const failedAt = now().toISOString();
      await writeSupervisorRunState(files, {
        ...current,
        status: "failed",
        updated_at: failedAt,
        finished_at: failedAt,
        error: error instanceof Error ? error.message : String(error)
      });
    }
    throw error;
  }
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
