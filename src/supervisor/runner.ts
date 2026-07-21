import { createRuntime, type AppRuntime } from "../bootstrap.js";
import { readProcessStartToken } from "../core/process-identity.js";
import type { HandleRequestResult } from "../orchestrator/orchestrator.js";
import {
  type SupervisorRunEvent,
  type SupervisorRunRequest,
  type SupervisorRunState
} from "./protocol.js";
import {
  appendSupervisorEvent,
  readSupervisorCommands,
  readSupervisorRunRequest,
  readSupervisorRunState,
  supervisorRunFiles,
  writeSupervisorRunState,
  type SupervisorRunFiles
} from "./store.js";

const COMMAND_POLL_MS = 100;

export async function runSupervisorJob(runDir: string): Promise<void> {
  const files = supervisorRunFiles(runDir);
  const request = await readSupervisorRunRequest(files);
  let state = await readSupervisorRunState(files);
  let runtime: AppRuntime | null = null;
  const controller = new AbortController();
  let commandLoopStopped = false;
  let writeQueue = Promise.resolve();
  let eventSequence = 0;

  const enqueue = (operation: () => Promise<void>): void => {
    writeQueue = writeQueue.then(operation, operation);
  };
  const replaceState = (update: (current: SupervisorRunState) => SupervisorRunState): void => {
    state = update(state);
    const snapshot = state;
    enqueue(() => writeSupervisorRunState(files, snapshot));
  };
  const emit = (type: SupervisorRunEvent["type"], payload: unknown): void => {
    const event: SupervisorRunEvent = {
      version: 1,
      sequence: eventSequence,
      at: new Date().toISOString(),
      type,
      payload
    };
    eventSequence += 1;
    enqueue(() => appendSupervisorEvent(files, event));
  };

  const stopFromSignal = (): void => controller.abort();
  process.once("SIGTERM", stopFromSignal);
  process.once("SIGINT", stopFromSignal);

  try {
    const startedAt = new Date().toISOString();
    const processStartToken = await readProcessStartToken(process.pid);
    replaceState((current) => ({
      ...current,
      status: "running",
      updated_at: startedAt,
      started_at: startedAt,
      pid: process.pid,
      ...(processStartToken ? { process_start_token: processStartToken } : {})
    }));
    await writeQueue;

    runtime = await createRuntime(request.app_root, request.workspace_root);
    const commandLoop = consumeCommands(
      files,
      runtime,
      controller,
      () => commandLoopStopped,
      () => {
        replaceState((current) => ({
          ...current,
          status: "cancelling",
          updated_at: new Date().toISOString()
        }));
      }
    );

    try {
      const result = await executeRequest(request, runtime, controller.signal, {
        onRouteStart: (value) => emit("route-start", value),
        onRouteProgress: (value) => emit("route-progress", value),
        onRoute: (value) => emit("route", value),
        onStatus: (value) => {
          emit("status", value);
          if (value.taskId !== "main") {
            replaceState((current) => ({
              ...current,
              task_id: value.taskId,
              updated_at: new Date().toISOString()
            }));
          }
        },
        onWorker: (value) => emit("worker", value)
      });
      await writeQueue;
      await persistRunMessage(runtime, request, result.summary, result.taskId);
      const finishedAt = new Date().toISOString();
      state = {
        ...state,
        status: "completed",
        updated_at: finishedAt,
        finished_at: finishedAt,
        task_id: result.taskId ?? requestedTaskId(request),
        result
      };
      delete state.error;
      await writeSupervisorRunState(files, state);
    } catch (error) {
      await writeQueue;
      const cancelled = controller.signal.aborted || isAbortError(error);
      const summary = cancelled
        ? cancellationSummary(request)
        : error instanceof Error ? error.message : String(error);
      try {
        await persistRunMessage(runtime, request, summary, requestedTaskId(request));
      } catch {
        // The terminal state remains recoverable even when chat persistence fails.
      }
      const finishedAt = new Date().toISOString();
      state = {
        ...state,
        status: cancelled ? "cancelled" : "failed",
        updated_at: finishedAt,
        finished_at: finishedAt,
        task_id: state.task_id ?? requestedTaskId(request),
        error: summary
      };
      delete state.result;
      await writeSupervisorRunState(files, state);
    } finally {
      commandLoopStopped = true;
      await commandLoop;
    }
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const summary = error instanceof Error ? error.message : String(error);
    state = {
      ...state,
      status: controller.signal.aborted ? "cancelled" : "failed",
      updated_at: finishedAt,
      finished_at: finishedAt,
      error: controller.signal.aborted ? cancellationSummary(request) : summary
    };
    delete state.result;
    try {
      await writeQueue;
      await writeSupervisorRunState(files, state);
    } catch {
      // The CLI-level failure handler is the last resort when the run directory is unavailable.
    }
  } finally {
    commandLoopStopped = true;
    process.off("SIGTERM", stopFromSignal);
    process.off("SIGINT", stopFromSignal);
    try {
      runtime?.index.close();
    } catch {
      // Process exit closes a damaged or already-closed SQLite handle.
    }
  }
}

async function executeRequest(
  request: SupervisorRunRequest,
  runtime: AppRuntime,
  signal: AbortSignal,
  callbacks: Pick<
    Parameters<AppRuntime["orchestrator"]["handleRequest"]>[0],
    "onRouteStart" | "onRouteProgress" | "onRoute" | "onStatus" | "onWorker"
  >
): Promise<HandleRequestResult> {
  const common = {
    cwd: request.cwd,
    signal,
    ...callbacks
  };
  switch (request.kind) {
    case "handle-request":
      return runtime.orchestrator.handleRequest({
        ...common,
        request: request.request,
        route: request.route,
        roleSelection: request.role_selection
      });
    case "handle-task-turn":
      return runtime.orchestrator.handleTaskTurn({
        ...common,
        request: request.request,
        taskId: request.task_id,
        route: request.route,
        roleSelection: request.role_selection
      });
    case "answer-task-question":
      return runtime.orchestrator.answerTaskQuestion({
        ...common,
        request: request.request,
        taskId: request.task_id,
        route: request.route,
        roleSelection: request.role_selection
      });
    case "retry-task":
      return runtime.orchestrator.retryTask({
        ...common,
        taskId: request.task_id
      });
    case "resume-feature":
      return runtime.orchestrator.resumeFeature({
        ...common,
        taskId: request.task_id,
        featureId: request.feature_id
      });
  }
}

async function consumeCommands(
  files: SupervisorRunFiles,
  runtime: AppRuntime,
  controller: AbortController,
  stopped: () => boolean,
  onCancelling: () => void
): Promise<void> {
  const handled = new Set<string>();
  while (!stopped()) {
    try {
      const commands = await readSupervisorCommands(files);
      for (const command of commands) {
        if (handled.has(command.id)) {
          continue;
        }
        handled.add(command.id);
        if (command.type === "cancel-run") {
          onCancelling();
          controller.abort();
        } else if (command.type === "cancel-feature") {
          await runtime.orchestrator.cancelFeature(command.task_id, command.feature_id);
        } else {
          await runtime.orchestrator.pauseFeature(command.task_id, command.feature_id);
        }
      }
    } catch {
      // A concurrent append can expose a partial final JSONL row; the next poll retries it.
    }
    await delay(COMMAND_POLL_MS);
  }
}

async function persistRunMessage(
  runtime: AppRuntime,
  request: SupervisorRunRequest,
  text: string,
  resultTaskId: string | null
): Promise<void> {
  await runtime.sessions.appendChatMessage({
    from: "system",
    text,
    taskId: resultTaskId ?? requestedTaskId(request) ?? undefined
  });
}

function requestedTaskId(request: SupervisorRunRequest): string | null {
  return request.kind === "handle-request" ? null : request.task_id;
}

function cancellationSummary(request: SupervisorRunRequest): string {
  return request.kind === "retry-task" || request.kind === "resume-feature"
    ? "cancelled · retry stopped"
    : "cancelled · request stopped";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
