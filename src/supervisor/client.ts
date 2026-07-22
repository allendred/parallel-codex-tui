import { randomUUID } from "node:crypto";
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
import {
  launchSupervisorProcess,
  runWithSupervisorSubmissionTurn,
  supervisorSubmissionLockWarning,
  type SupervisorLauncher,
  type SupervisorSubmissionTurnAcquirer
} from "./launcher.js";

export type { SupervisorLauncher } from "./launcher.js";

const RUN_POLL_MS = 100;
const QUEUED_START_GRACE_MS = 3000;

export interface SupervisorOrchestratorOptions {
  delegate: Orchestrator;
  sessions: SessionManager;
  appRoot: string;
  workspaceRoot: string;
  dataDir: string;
  acquireSubmissionTurn?: SupervisorSubmissionTurnAcquirer;
  launch?: SupervisorLauncher;
  now?: () => Date;
}

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

  taskState(taskId: string) {
    return this.options.delegate.taskState(taskId);
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
    const inputTaskId = "task_id" in input ? input.task_id : null;
    const startup: {
      files: SupervisorRunFiles | null;
      controller: SupervisorControllerLease | null;
    } = { files: null, controller: null };
    let watched: WatchedRun | null = null;
    try {
      const completed = await runWithSupervisorSubmissionTurn(
        this.options.workspaceRoot,
        this.options.dataDir,
        async () => {
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
          startup.files = await createSupervisorRun(
            this.options.workspaceRoot,
            this.options.dataDir,
            request
          );
          startup.controller = await claimSupervisorController(startup.files);
          if (!startup.controller) {
            throw new Error("The new Supervisor run was claimed by another TUI before it could start.");
          }
          const submitted = {
            files: startup.files,
            controller: startup.controller,
            detached: false,
            cancelSent: false
          } satisfies WatchedRun;
          await this.launch(startup.files, request);
          return submitted;
        },
        this.options.acquireSubmissionTurn
      );
      watched = completed.value;
      watched.detached = this.detaching;
      this.currentRun = watched;
      this.notifyBackgroundRunState();
      if (completed.releaseError) {
        const warning = supervisorSubmissionLockWarning(completed.releaseError);
        await Promise.resolve()
          .then(() => this.options.sessions.appendChatMessage({
            from: "system",
            text: warning,
            ...(inputTaskId ? { taskId: inputTaskId } : {})
          }))
          .catch(() => undefined);
      }
    } catch (error) {
      await startup.controller?.release().catch(() => undefined);
      if (startup.files) {
        const message = error instanceof Error ? error.message : String(error);
        const failedAt = this.now().toISOString();
        const state = await readSupervisorRunState(startup.files);
        if (!supervisorRunIsTerminal(state)) {
          await writeSupervisorRunState(startup.files, {
            ...state,
            status: "failed",
            updated_at: failedAt,
            finished_at: failedAt,
            error: message
          });
        }
        await this.options.sessions.appendChatMessage({
          from: "system",
          text: message,
          ...(inputTaskId ? { taskId: inputTaskId } : {})
        });
        this.settledRun = startup.files;
      }
      throw error;
    }
    if (!watched) {
      throw new Error("Supervisor run submission completed without a run.");
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
        nextEventSequence = await dispatchUnreadSupervisorEvents(
          watched.files,
          callbacks,
          nextEventSequence
        );

        const state = await readSupervisorRunState(watched.files);
        if (supervisorRunIsTerminal(state)) {
          // The first read can observe a partial final JSONL record immediately
          // before the runner publishes terminal state. Once terminal is visible,
          // the runner has flushed its event queue, so drain once more.
          nextEventSequence = await dispatchUnreadSupervisorEvents(
            watched.files,
            callbacks,
            nextEventSequence
          );
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

async function dispatchUnreadSupervisorEvents(
  files: SupervisorRunFiles,
  callbacks: SupervisorRunCallbacks,
  nextEventSequence: number
): Promise<number> {
  const events = await readSupervisorEvents(files);
  let nextSequence = nextEventSequence;
  for (const event of events) {
    if (event.sequence < nextSequence) {
      continue;
    }
    nextSequence = event.sequence + 1;
    dispatchSupervisorEvent(event, callbacks);
  }
  return nextSequence;
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
