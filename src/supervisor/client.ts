import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SessionManager } from "../core/session-manager.js";
import type {
  HandleRequestInput,
  HandleRequestResult,
  HandleTaskQuestionInput,
  HandleTaskTurnInput,
  Orchestrator,
  ResumeFeatureInput,
  RetryTaskInput,
  WorkerLogRef
} from "../orchestrator/orchestrator.js";
import {
  asSupervisorRunResult,
  supervisorEventPayload,
  type SupervisorRunCallbacks,
  type SupervisorRunRequest,
  type SupervisorRunState
} from "./protocol.js";
import {
  acknowledgeSupervisorRun,
  appendSupervisorCommand,
  claimSupervisorController,
  createSupervisorRun,
  createSupervisorRunId,
  listSupervisorRuns,
  readSupervisorEvents,
  readSupervisorRunState,
  supervisorRunIsAcknowledged,
  supervisorRunIsTerminal,
  supervisorRunProcessIsActive,
  writeSupervisorRunState,
  type SupervisorControllerLease,
  type SupervisorRunFiles,
  type SupervisorRunRecord
} from "./store.js";

const RUN_POLL_MS = 100;
const QUEUED_START_GRACE_MS = 3000;

export interface SupervisorOrchestratorOptions {
  delegate: Orchestrator;
  sessions: SessionManager;
  appRoot: string;
  workspaceRoot: string;
  dataDir: string;
  launch?: SupervisorLauncher;
  now?: () => Date;
}

export type SupervisorLauncher = (
  files: SupervisorRunFiles,
  request: SupervisorRunRequest
) => Promise<void>;

interface WatchedRun {
  files: SupervisorRunFiles;
  controller: SupervisorControllerLease | null;
  detached: boolean;
  cancelSent: boolean;
}

type SupervisorRunSubmission = SupervisorRunRequest extends infer Request
  ? Request extends SupervisorRunRequest
    ? Omit<Request, "version" | "run_id" | "app_root" | "workspace_root" | "data_dir" | "created_at">
    : never
  : never;

export class SupervisorDetachedError extends Error {
  constructor(message = "Background run detached") {
    super(message);
    this.name = "SupervisorDetachedError";
  }
}

export function isSupervisorDetachedError(error: unknown): boolean {
  return error instanceof Error && error.name === "SupervisorDetachedError";
}

export class SupervisorOrchestrator {
  readonly persistsRunResults = true;
  private readonly launch: SupervisorLauncher;
  private readonly now: () => Date;
  private recoverableRun: SupervisorRunRecord | null = null;
  private currentRun: WatchedRun | null = null;
  private settledRun: SupervisorRunFiles | null = null;
  private detaching = false;
  private readonly backgroundRunListeners = new Set<() => void>();

  private constructor(private readonly options: SupervisorOrchestratorOptions) {
    this.launch = options.launch ?? launchSupervisorProcess;
    this.now = options.now ?? (() => new Date());
  }

  static async open(options: SupervisorOrchestratorOptions): Promise<SupervisorOrchestrator> {
    const client = new SupervisorOrchestrator(options);
    client.recoverableRun = await client.findRecoverableRun();
    return client;
  }

  async handleRequest(input: HandleRequestInput): Promise<HandleRequestResult> {
    const routed = await this.options.delegate.routeInitialRequest(input);
    return this.startRun({
      kind: "handle-request",
      request: input.request,
      cwd: input.cwd,
      route: routed.route,
      role_selection: routed.roleSelection
    }, input);
  }

  async handleTaskTurn(input: HandleTaskTurnInput): Promise<HandleRequestResult> {
    return this.startRun({
      kind: "handle-task-turn",
      request: input.request,
      cwd: input.cwd,
      task_id: input.taskId,
      ...(input.route ? { route: input.route } : {}),
      ...(input.roleSelection ? { role_selection: input.roleSelection } : {})
    }, input);
  }

  async answerTaskQuestion(input: HandleTaskQuestionInput): Promise<HandleRequestResult> {
    return this.startRun({
      kind: "answer-task-question",
      request: input.request,
      cwd: input.cwd,
      task_id: input.taskId,
      ...(input.route ? { route: input.route } : {}),
      ...(input.roleSelection ? { role_selection: input.roleSelection } : {})
    }, input);
  }

  async retryTask(input: RetryTaskInput): Promise<HandleRequestResult> {
    return this.startRun({
      kind: "retry-task",
      cwd: input.cwd,
      task_id: input.taskId
    }, input);
  }

  async resumeFeature(input: ResumeFeatureInput): Promise<HandleRequestResult> {
    return this.startRun({
      kind: "resume-feature",
      cwd: input.cwd,
      task_id: input.taskId,
      feature_id: input.featureId
    }, input);
  }

  async restorePendingRun(
    input: Omit<HandleRequestInput, "request">
  ): Promise<HandleRequestResult | null> {
    this.detaching = input.signal?.aborted ? this.detaching : false;
    const pending = this.recoverableRun ?? await this.findRecoverableRun();
    this.recoverableRun = null;
    if (!pending) {
      return null;
    }
    const controller = await claimSupervisorController(pending.files);
    return this.watchRun({
      files: pending.files,
      controller,
      detached: this.detaching,
      cancelSent: false
    }, input);
  }

  detachBackgroundRuns(): void {
    this.detaching = true;
    const current = this.currentRun;
    if (!current) {
      return;
    }
    current.detached = true;
    void current.controller?.release();
    current.controller = null;
    this.notifyBackgroundRunState();
  }

  backgroundRunAttached(): boolean {
    return this.currentRun !== null;
  }

  backgroundRunControllable(): boolean {
    return this.currentRun?.controller !== null && this.currentRun?.controller !== undefined;
  }

  subscribeBackgroundRunState(listener: () => void): () => void {
    this.backgroundRunListeners.add(listener);
    return () => this.backgroundRunListeners.delete(listener);
  }

  async acknowledgeBackgroundRun(): Promise<void> {
    if (!this.settledRun) {
      return;
    }
    const files = this.settledRun;
    this.settledRun = null;
    await acknowledgeSupervisorRun(files);
  }

  async cancelFeature(taskId: string, featureId: string) {
    if (!this.currentRun) {
      return this.options.delegate.cancelFeature(taskId, featureId);
    }
    if (!this.currentRun.controller) {
      return { requested: false, featureId };
    }
    await appendSupervisorCommand(this.currentRun.files, {
      version: 1,
      id: randomUUID(),
      at: this.now().toISOString(),
      type: "cancel-feature",
      task_id: taskId,
      feature_id: featureId
    });
    return { requested: true, featureId };
  }

  async pauseFeature(taskId: string, featureId: string) {
    if (!this.currentRun) {
      return this.options.delegate.pauseFeature(taskId, featureId);
    }
    if (!this.currentRun.controller) {
      return { requested: false, featureId };
    }
    await appendSupervisorCommand(this.currentRun.files, {
      version: 1,
      id: randomUUID(),
      at: this.now().toISOString(),
      type: "pause-feature",
      task_id: taskId,
      feature_id: featureId
    });
    return { requested: true, featureId };
  }

  routeTaskFollowUp(input: Parameters<Orchestrator["routeTaskFollowUp"]>[0]) {
    return this.options.delegate.routeTaskFollowUp(input);
  }

  canRetryTask(taskId: string) {
    return this.options.delegate.canRetryTask(taskId);
  }

  listTaskWorkers(taskId: string): Promise<WorkerLogRef[]> {
    return this.options.delegate.listTaskWorkers(taskId);
  }

  reassignFeature(input: Parameters<Orchestrator["reassignFeature"]>[0]) {
    return this.options.delegate.reassignFeature(input);
  }

  roleConfigurationSnapshot(taskId?: string | null) {
    return this.options.delegate.roleConfigurationSnapshot(taskId);
  }

  updateRoleConfiguration(input: Parameters<Orchestrator["updateRoleConfiguration"]>[0]) {
    return this.options.delegate.updateRoleConfiguration(input);
  }

  clearRoleConfiguration(scope: Parameters<Orchestrator["clearRoleConfiguration"]>[0], taskId?: string | null) {
    return this.options.delegate.clearRoleConfiguration(scope, taskId);
  }

  validateRoleConfiguration(roles: Parameters<Orchestrator["validateRoleConfiguration"]>[0]) {
    return this.options.delegate.validateRoleConfiguration(roles);
  }

  private async startRun(
    input: SupervisorRunSubmission,
    callbacks: SupervisorRunCallbacks & { signal?: AbortSignal }
  ): Promise<HandleRequestResult> {
    this.detaching = callbacks.signal?.aborted ? this.detaching : false;
    if (this.currentRun) {
      throw new Error("A Supervisor run is already attached in this TUI.");
    }
    const active = (await this.reconcileRuns()).filter(({ state }) => !supervisorRunIsTerminal(state));
    if (active.length > 0) {
      throw new Error("A background run is already active in this workspace. Reopen the TUI to attach to it.");
    }

    const createdAt = this.now().toISOString();
    const request = {
      ...input,
      version: 1 as const,
      run_id: createSupervisorRunId(this.now()),
      app_root: this.options.appRoot,
      workspace_root: this.options.workspaceRoot,
      data_dir: this.options.dataDir,
      created_at: createdAt
    } as SupervisorRunRequest;
    const files = await createSupervisorRun(
      this.options.workspaceRoot,
      this.options.dataDir,
      request
    );
    const controller = await claimSupervisorController(files);
    if (!controller) {
      throw new Error("The new Supervisor run was claimed by another TUI before it could start.");
    }
    const watched: WatchedRun = {
      files,
      controller,
      detached: this.detaching,
      cancelSent: false
    };
    this.currentRun = watched;
    this.notifyBackgroundRunState();
    try {
      await this.launch(files, request);
    } catch (error) {
      if (this.currentRun === watched) {
        this.currentRun = null;
        this.notifyBackgroundRunState();
      }
      await controller.release();
      const message = error instanceof Error ? error.message : String(error);
      const failedAt = this.now().toISOString();
      const state = await readSupervisorRunState(files);
      await writeSupervisorRunState(files, {
        ...state,
        status: "failed",
        updated_at: failedAt,
        finished_at: failedAt,
        error: message
      });
      await this.options.sessions.appendChatMessage({ from: "system", text: message });
      this.settledRun = files;
      throw error;
    }
    return this.watchRun(watched, callbacks);
  }

  private async watchRun(
    watched: WatchedRun,
    callbacks: SupervisorRunCallbacks & { signal?: AbortSignal }
  ): Promise<HandleRequestResult> {
    this.currentRun = watched;
    this.notifyBackgroundRunState();
    let nextEventSequence = 0;
    try {
      while (true) {
        if (watched.detached) {
          throw new SupervisorDetachedError();
        }
        if (!watched.controller) {
          watched.controller = await claimSupervisorController(watched.files);
          if (watched.controller) {
            this.notifyBackgroundRunState();
          }
        }
        const events = await readSupervisorEvents(watched.files);
        for (const event of events) {
          if (event.sequence < nextEventSequence) {
            continue;
          }
          nextEventSequence = event.sequence + 1;
          dispatchSupervisorEvent(event, callbacks);
        }

        const state = await readSupervisorRunState(watched.files);
        if (supervisorRunIsTerminal(state)) {
          this.settledRun = watched.files;
          if (state.status === "completed" && state.result) {
            return asSupervisorRunResult(state.result);
          }
          const error = new Error(state.error || `Supervisor run ${state.status}`);
          if (state.status === "cancelled") {
            error.name = "AbortError";
          }
          throw error;
        }

        if (watched.controller && !(await supervisorRunProcessIsActive(state))) {
          const ageMs = this.now().getTime() - Date.parse(state.created_at);
          if (state.status !== "queued" || ageMs >= QUEUED_START_GRACE_MS) {
            const failedAt = this.now().toISOString();
            const summary = `Supervisor exited unexpectedly while ${state.kind} was running.`;
            await writeSupervisorRunState(watched.files, {
              ...state,
              status: "failed",
              updated_at: failedAt,
              finished_at: failedAt,
              error: summary
            });
            await this.options.sessions.appendChatMessage({
              from: "system",
              text: summary,
              taskId: state.task_id ?? undefined
            });
            continue;
          }
        }

        if (callbacks.signal?.aborted && !watched.cancelSent) {
          if (!watched.controller) {
            throw new SupervisorDetachedError("Observer detached; the background run is still active");
          }
          watched.cancelSent = true;
          await appendSupervisorCommand(watched.files, {
            version: 1,
            id: randomUUID(),
            at: this.now().toISOString(),
            type: "cancel-run"
          });
        }
        await delay(RUN_POLL_MS);
      }
    } finally {
      if (this.currentRun === watched) {
        this.currentRun = null;
      }
      await watched.controller?.release();
      watched.controller = null;
      this.notifyBackgroundRunState();
    }
  }

  private notifyBackgroundRunState(): void {
    for (const listener of this.backgroundRunListeners) {
      listener();
    }
  }

  private async findRecoverableRun(): Promise<SupervisorRunRecord | null> {
    const runs = await this.reconcileRuns();
    const active = runs.filter(({ state }) => !supervisorRunIsTerminal(state));
    if (active.length > 0) {
      return active.at(-1) ?? null;
    }
    const unacknowledged: SupervisorRunRecord[] = [];
    for (const run of runs) {
      if (supervisorRunIsTerminal(run.state) && !(await supervisorRunIsAcknowledged(run.files))) {
        unacknowledged.push(run);
      }
    }
    return unacknowledged.at(-1) ?? null;
  }

  private async reconcileRuns(): Promise<SupervisorRunRecord[]> {
    const runs = await listSupervisorRuns(this.options.workspaceRoot, this.options.dataDir);
    for (const run of runs) {
      if (supervisorRunIsTerminal(run.state) || await supervisorRunProcessIsActive(run.state)) {
        continue;
      }
      const ageMs = this.now().getTime() - Date.parse(run.state.created_at);
      if (run.state.status === "queued" && ageMs < QUEUED_START_GRACE_MS) {
        continue;
      }
      const failedAt = this.now().toISOString();
      const summary = `Supervisor exited unexpectedly while ${run.state.kind} was running.`;
      run.state = {
        ...run.state,
        status: "failed",
        updated_at: failedAt,
        finished_at: failedAt,
        error: summary
      };
      await writeSupervisorRunState(run.files, run.state);
      await this.options.sessions.appendChatMessage({
        from: "system",
        text: summary,
        taskId: run.state.task_id ?? undefined
      });
    }
    return runs;
  }
}

function dispatchSupervisorEvent(
  event: Awaited<ReturnType<typeof readSupervisorEvents>>[number],
  callbacks: SupervisorRunCallbacks
): void {
  const payload = supervisorEventPayload(event);
  switch (event.type) {
    case "route-start":
      callbacks.onRouteStart?.(payload as Parameters<NonNullable<SupervisorRunCallbacks["onRouteStart"]>>[0]);
      break;
    case "route-progress":
      callbacks.onRouteProgress?.(payload as Parameters<NonNullable<SupervisorRunCallbacks["onRouteProgress"]>>[0]);
      break;
    case "route":
      callbacks.onRoute?.(payload as Parameters<NonNullable<SupervisorRunCallbacks["onRoute"]>>[0]);
      break;
    case "status":
      callbacks.onStatus?.(payload as Parameters<NonNullable<SupervisorRunCallbacks["onStatus"]>>[0]);
      break;
    case "worker":
      callbacks.onWorker?.(payload as Parameters<NonNullable<SupervisorRunCallbacks["onWorker"]>>[0]);
      break;
  }
}

async function launchSupervisorProcess(
  files: SupervisorRunFiles,
  request: SupervisorRunRequest
): Promise<void> {
  const entrypoint = process.argv[1] ? resolve(process.argv[1]) : "";
  if (!entrypoint) {
    throw new Error("Cannot locate the parallel-codex-tui CLI entrypoint for Supervisor launch.");
  }
  const errorLog = openSync(join(files.dir, "supervisor.log"), "a");
  const child = spawn(process.execPath, [...process.execArgv, entrypoint], {
    cwd: process.cwd(),
    detached: true,
    env: {
      ...process.env,
      PCT_SUPERVISOR_RUN_DIR: files.dir
    },
    stdio: ["ignore", "ignore", errorLog]
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  } finally {
    closeSync(errorLog);
  }
  let exitCode: number | null | undefined;
  const onExit = (code: number | null) => {
    exitCode = code;
  };
  child.once("exit", onExit);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await readSupervisorRunState(files);
    if (state.status !== "queued") {
      child.off("exit", onExit);
      child.unref();
      return;
    }
    if (exitCode !== undefined) {
      throw new Error(`Supervisor process exited before startup (code ${exitCode ?? "signal"}).`);
    }
    await delay(25);
  }
  child.off("exit", onExit);
  try {
    child.kill("SIGTERM");
  } catch {
    // The startup failure below remains the useful error when the child already exited.
  }
  throw new Error("Supervisor process did not publish startup state within 5s.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
