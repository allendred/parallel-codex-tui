#!/usr/bin/env node
import React from "react";
import { join } from "node:path";
import { render } from "ink";
import { ZodError } from "zod";
import { parseCliArgs, validateCliArgs } from "./cli-args.js";
import { selectWorkspaceForCli } from "./cli-workspace.js";
import { commitWorkspaceTransition } from "./cli-workspace-transition.js";
import { WorkspaceSelectionCancelledError } from "./cli-workspace-picker.js";
import { startupRecoveryMessages } from "./cli-startup-recovery.js";
import { startupPreflightMessages } from "./cli-startup-preflight.js";
import { createRuntime } from "./bootstrap.js";
import type { AppRuntime } from "./bootstrap.js";
import { prepareAppRoot } from "./core/app-root.js";
import { formatConfigErrorMessage } from "./core/config-errors.js";
import { configPath, loadConfig, withUiThemeOverride, writeDefaultConfig } from "./core/config.js";
import { pathExists } from "./core/file-store.js";
import { readRouterAudit } from "./core/router-audit.js";
import { loadTaskSessionDetails as loadPersistedTaskSessionDetails } from "./core/task-session-details.js";
import { listWorkspaceChoices } from "./core/workspace.js";
import { runDoctor, runRuntimePreflight } from "./doctor.js";
import { helpText } from "./cli-help.js";
import { App } from "./tui/App.js";
import { formatTuiThemeCatalog } from "./tui/theme-preview.js";
import { configureTuiTheme } from "./tui/theme.js";
import { routerDiagnosticsPolicy } from "./tui/RouterDiagnosticsView.js";
import { version } from "./version.js";

main().catch((error) => {
  if (error instanceof WorkspaceSelectionCancelledError) {
    return;
  }
  process.stderr.write(`${formatStartupError(error)}\n`);
  process.exit(1);
});

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  const cliArgErrors = validateCliArgs(rawArgs);
  if (cliArgErrors.length > 0) {
    process.stderr.write(`${cliArgErrors.join("\n")}\n`);
    process.exit(1);
  }

  const cliArgs = parseCliArgs(rawArgs, process.cwd());
  if (!cliArgs.help && !cliArgs.themes && !cliArgs.version) {
    await prepareAppRoot(cliArgs.appRoot);
  }
  const localConfigPath = configPath(cliArgs.appRoot);

  if (cliArgs.help) {
    console.log(helpText);
  } else if (cliArgs.version) {
    console.log(`parallel-codex-tui ${version}`);
  } else if (cliArgs.themes) {
    console.log(formatTuiThemeCatalog(cliArgs.theme ? [cliArgs.theme] : undefined).join("\n"));
  } else if (cliArgs.doctor) {
    const workspaceRoot = await selectWorkspaceForCli({
      appRoot: cliArgs.appRoot,
      cwd: process.cwd(),
      explicitWorkspace: cliArgs.explicitWorkspace,
      interactive: false
    });
    const result = await runDoctor(cliArgs.appRoot, workspaceRoot, process.env, {
      probeAgents: cliArgs.probeAgents,
      probeRouter: cliArgs.probeRouter,
      theme: cliArgs.theme
    });
    process.stdout.write(result.text);
    process.exitCode = result.ok ? 0 : 1;
  } else if (cliArgs.init) {
    if (await pathExists(localConfigPath)) {
      console.log(`Config already exists: ${localConfigPath}`);
    } else {
      await writeDefaultConfig(cliArgs.appRoot);
      console.log(`Wrote ${localConfigPath}`);
    }
  } else {
    const startupConfig = await loadConfig(cliArgs.appRoot);
    configureTuiTheme({
      theme: cliArgs.theme ?? startupConfig.ui.theme,
      colors: startupConfig.ui.colors
    });
    const workspaceRoot = await selectWorkspaceForCli({
      appRoot: cliArgs.appRoot,
      cwd: process.cwd(),
      explicitWorkspace: cliArgs.explicitWorkspace
    });
    let current = await loadInteractiveWorkspace(cliArgs.appRoot, workspaceRoot, cliArgs.taskId);
    if (!canRenderInteractiveTui()) {
      current.runtime.index.close();
      throw new Error("parallel-codex-tui requires an interactive terminal. Use --help, --version, --init, or --doctor for non-interactive command modes.");
    }
    let instance: ReturnType<typeof render> | null = null;
    const shutdownController = new AbortController();
    const deferredWorkspaceClosures = new Set<InteractiveWorkspaceState>();

    const appElement = (state: InteractiveWorkspaceState) => (
      <App
        key={state.runtime.workspaceRoot}
        config={withUiThemeOverride(state.runtime.config, cliArgs.theme)}
        orchestrator={state.runtime.orchestrator}
        cwd={state.runtime.workspaceRoot}
        initialTaskId={state.initialTaskId}
        initialRoute={state.initialRoute}
        initialWorkers={state.initialWorkers}
        initialCanRetryTask={state.initialCanRetryTask}
        initialMessages={state.initialMessages}
        workspaceChoices={state.workspaceChoices}
        shutdownSignal={shutdownController.signal}
        loadRouterDiagnostics={async () => {
          const [records, latestConfig] = await Promise.all([
            readRouterAudit(join(state.runtime.routerCwd, "routes.jsonl"), 100),
            loadConfig(cliArgs.appRoot)
          ]);
          return {
            records,
            policy: routerDiagnosticsPolicy(latestConfig.router)
          };
        }}
        loadTaskSessions={(options) => state.runtime.index.listTasks(100, options)}
        loadTaskSessionDetails={(task) => loadPersistedTaskSessionDetails({
          task,
          taskDir: state.runtime.sessions.taskFromId(task.id).dir,
          modelNames: {
            codex: state.runtime.config.workers.codex.model.name,
            claude: state.runtime.config.workers.claude.model.name,
            mock: state.runtime.config.workers.mock.model.name
          }
        })}
        renameTaskSession={async (taskId, title) => {
          await state.runtime.sessions.renameTask(taskId, title);
        }}
        setTaskSessionArchived={async (taskId, archived) => {
          await state.runtime.sessions.setTaskArchived(taskId, archived);
        }}
        deleteTaskSession={async (taskId) => {
          await state.runtime.sessions.deleteTask(taskId);
        }}
        exportTaskSession={async (taskId) => (
          await state.runtime.sessions.exportTask(taskId)
        ).path}
        loadCollaborationTimeline={(taskId) => state.runtime.sessions.readCollaborationTimeline(taskId)}
        activateTaskSession={async (taskId) => {
          if (!taskId) {
            await state.runtime.index.setActiveTaskId(null);
            return null;
          }
          if (!(await state.runtime.sessions.hasTask(taskId))) {
            throw new Error(`Task session not found in workspace ${state.runtime.workspaceRoot}: ${taskId}`);
          }
          const task = state.runtime.sessions.taskFromId(taskId);
          const meta = await state.runtime.sessions.readMeta(task);
          if (meta.archived_at) {
            throw new Error(`Task session is archived: ${taskId}`);
          }
          const [route, workers, canRetry] = await Promise.all([
            state.runtime.sessions.readLatestRoute(task),
            state.runtime.orchestrator.listTaskWorkers(taskId),
            state.runtime.orchestrator.canRetryTask(taskId)
          ]);
          await state.runtime.index.setActiveTaskId(taskId);
          return { taskId, route, workers, canRetry };
        }}
        switchWorkspace={async (workspace) => {
          if (workspace === current.runtime.workspaceRoot) {
            return;
          }
          retryDeferredWorkspaceClosures(deferredWorkspaceClosures);
          const next = await loadInteractiveWorkspace(cliArgs.appRoot, workspace, null);
          const previous = current;
          current = commitWorkspaceTransition({
            previous,
            next,
            render: (state) => {
              if (!instance) {
                throw new Error("Interactive TUI is not ready to switch workspaces.");
              }
              instance.rerender(appElement(state));
            },
            close: closeInteractiveWorkspace,
            deferClose: (state) => deferredWorkspaceClosures.add(state)
          });
        }}
        persistChatMessage={(message, taskId) => state.runtime.sessions.appendChatMessage({
          ...message,
          taskId
        })}
      />
    );

    const removeSigintHandler = installInteractiveSigintExitHandler(() => shutdownController.abort());
    try {
      instance = render(appElement(current), { exitOnCtrlC: false });
      await instance.waitUntilExit();
    } finally {
      removeSigintHandler();
      retryDeferredWorkspaceClosures(deferredWorkspaceClosures);
    }
  }
}

interface InteractiveWorkspaceState {
  runtime: AppRuntime;
  initialTaskId: string | null;
  initialRoute: Awaited<ReturnType<AppRuntime["sessions"]["readLatestRoute"]>>;
  initialWorkers: Awaited<ReturnType<AppRuntime["orchestrator"]["listTaskWorkers"]>>;
  initialCanRetryTask: boolean;
  initialMessages: Array<{ from: "user" | "system"; text: string }>;
  workspaceChoices: Awaited<ReturnType<typeof listWorkspaceChoices>>;
}

async function loadInteractiveWorkspace(
  appRoot: string,
  workspaceRoot: string,
  requestedTaskId: string | null
): Promise<InteractiveWorkspaceState> {
  const runtime = await createRuntime(appRoot, workspaceRoot);
  try {
    const preflightPromise = runRuntimePreflight(
      runtime.config,
      runtime.workspaceRoot,
      process.env
    ).catch((error): Awaited<ReturnType<typeof runRuntimePreflight>> => ({
      ok: false,
      lines: [`preflight: failed (${error instanceof Error ? error.message : String(error)})`]
    }));
    if (requestedTaskId) {
      if (!(await runtime.sessions.hasTask(requestedTaskId))) {
        throw new Error(`Task session not found in workspace ${runtime.workspaceRoot}: ${requestedTaskId}`);
      }
      const requestedMeta = await runtime.sessions.readMeta(runtime.sessions.taskFromId(requestedTaskId));
      if (requestedMeta.archived_at) {
        throw new Error(`Task session is archived in workspace ${runtime.workspaceRoot}: ${requestedTaskId}`);
      }
    }
    const [latestTask, rememberedTaskId] = await Promise.all([
      runtime.sessions.latestTask(),
      runtime.index.activeTaskId()
    ]);
    const rememberedTaskIsRestorable = typeof rememberedTaskId === "string"
      && await runtime.sessions.hasTask(rememberedTaskId)
      && !(await runtime.sessions.readMeta(runtime.sessions.taskFromId(rememberedTaskId))).archived_at;
    let initialTaskId: string | null;
    if (requestedTaskId) {
      initialTaskId = requestedTaskId;
    } else if (rememberedTaskId === null) {
      initialTaskId = null;
    } else if (rememberedTaskId && rememberedTaskIsRestorable) {
      initialTaskId = rememberedTaskId;
    } else {
      initialTaskId = latestTask?.id ?? null;
    }
    if (initialTaskId && initialTaskId !== rememberedTaskId) {
      await runtime.index.setActiveTaskId(initialTaskId);
    } else if (!initialTaskId && typeof rememberedTaskId === "string") {
      await runtime.index.setActiveTaskId(null);
    }
    const [initialRoute, initialWorkers, initialCanRetryTask, initialHistory, workspaceChoices, preflight] = await Promise.all([
      initialTaskId
        ? runtime.sessions.readLatestRoute(runtime.sessions.taskFromId(initialTaskId))
        : null,
      initialTaskId ? runtime.orchestrator.listTaskWorkers(initialTaskId) : [],
      initialTaskId ? runtime.orchestrator.canRetryTask(initialTaskId) : false,
      runtime.sessions.readChatHistory(),
      listWorkspaceChoices(appRoot),
      preflightPromise
    ]);
    const recoveryMessages = startupRecoveryMessages(
      runtime.recoveredTasks,
      initialTaskId,
      runtime.pendingTaskCreations,
      runtime.index.recovery
    );

    return {
      runtime,
      initialTaskId,
      initialRoute,
      initialWorkers,
      initialCanRetryTask,
      initialMessages: [
        ...initialHistory.map(({ from, text, task_id }) => ({
          from,
          text,
          ...(task_id ? { taskId: task_id } : {})
        })),
        ...recoveryMessages,
        ...startupPreflightMessages(preflight)
      ],
      workspaceChoices
    };
  } catch (error) {
    runtime.index.close();
    throw error;
  }
}

function closeInteractiveWorkspace(state: InteractiveWorkspaceState): void {
  state.runtime.index.close();
}

function retryDeferredWorkspaceClosures(states: Set<InteractiveWorkspaceState>): void {
  for (const state of states) {
    try {
      closeInteractiveWorkspace(state);
      states.delete(state);
    } catch {
      // Process exit remains the final cleanup boundary if an index cannot be closed yet.
    }
  }
}

function canRenderInteractiveTui(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function installInteractiveSigintExitHandler(requestGracefulExit: () => void): () => void {
  let interrupted = false;
  const onSigint = () => {
    if (!interrupted) {
      interrupted = true;
      try {
        requestGracefulExit();
        return;
      } catch {
        // Fall through to the force-exit path when graceful shutdown cannot start.
      }
    }
    restoreInteractiveTerminal();
    process.exit(0);
  };
  process.on("SIGINT", onSigint);
  return () => process.off("SIGINT", onSigint);
}

function restoreInteractiveTerminal(): void {
  if (process.stdin.isTTY && process.stdin.isRaw && typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(false);
    } catch {
      // The active view may already be releasing raw mode.
    }
  }
  process.stdin.pause();
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?2004l\x1b[?25h");
  }
}

function formatStartupError(error: unknown): string {
  const message = isConfigStartupError(error)
    ? formatConfigErrorMessage(error)
    : error instanceof Error ? error.message : String(error);
  if (isConfigStartupError(error)) {
    return `Config error: ${message}\nRun parallel-codex-tui --doctor for details.`;
  }
  return `Startup error: ${message}`;
}

function isConfigStartupError(error: unknown): boolean {
  if (error instanceof ZodError) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.startsWith("Invalid config section ") ||
    error.name.toLowerCase().includes("toml") ||
    error.message.toLowerCase().includes("toml")
  );
}
