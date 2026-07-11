import { spawn } from "node:child_process";
import { appendText, writeJson } from "../core/file-store.js";
import { clearWorkerProcessRecord, writeWorkerProcessRecord } from "../core/process-ownership.js";
import type { EngineName, WorkerStatus } from "../domain/schemas.js";
import { detectNativeSessionId } from "./native-session-detection.js";
import type { WorkerAdapter, WorkerModelRunConfig, WorkerResult, WorkerRunSpec } from "./types.js";

export interface ProcessWorkerDefaults {
  timeoutMs?: number;
  idleTimeoutMs?: number;
  firstOutputTimeoutMs?: number;
  model?: WorkerModelRunConfig;
}

interface ProcessLaunch {
  args: string[];
  isResume: boolean;
  nativeSession: WorkerRunSpec["nativeSession"];
}

interface ProcessAttemptOptions {
  initialNativeSessionId?: string;
  startPhase?: string;
  startSummary?: string;
}

interface ProcessAttemptResult {
  result: WorkerResult;
  output: string;
  launch: ProcessLaunch;
}

export class ProcessWorkerAdapter implements WorkerAdapter {
  readonly name: EngineName;
  private readonly command: string;
  private readonly args: string[];
  private readonly defaults: ProcessWorkerDefaults;

  constructor(command: string, args: string[], name: EngineName = "mock", defaults: ProcessWorkerDefaults = {}) {
    this.command = command;
    this.args = args;
    this.name = name;
    this.defaults = defaults;
  }

  async run(spec: WorkerRunSpec): Promise<WorkerResult> {
    const model = spec.modelConfig ?? this.defaults.model;
    const launch = buildLaunch(
      this.args,
      this.name,
      spec.nativeSession,
      spec.nativeSessionConfig,
      model,
      spec.writableDirs,
      spec.enforceWorkspaceIsolation
    );
    const runSpec = {
      ...spec,
      timeoutMs: spec.timeoutMs ?? this.defaults.timeoutMs,
      idleTimeoutMs: spec.idleTimeoutMs ?? this.defaults.idleTimeoutMs,
      firstOutputTimeoutMs: spec.firstOutputTimeoutMs ?? this.defaults.firstOutputTimeoutMs,
      nativeSession: launch.nativeSession,
      modelConfig: model
    };

    const first = await this.runAttempt(runSpec, launch);
    if (!shouldFallbackToNewNativeSession(first, runSpec.nativeSessionConfig)) {
      return first.result;
    }

    const retiredSessionId = launch.nativeSession?.session_id;
    if (retiredSessionId) {
      await runSpec.onNativeSessionRetired?.(retiredSessionId, first.output);
    }
    await appendText(
      runSpec.outputLogPath,
      `\nNative resume for ${retiredSessionId ?? "unknown session"} is unrecoverable; starting a fresh native session.\n`
    );

    const freshLaunch = buildFreshLaunch(
      this.args,
      this.name,
      model,
      runSpec.writableDirs,
      runSpec.enforceWorkspaceIsolation
    );
    return (await this.runAttempt(
      {
        ...runSpec,
        nativeSession: null
      },
      freshLaunch,
      {
        initialNativeSessionId: undefined,
        startPhase: "native-resume-fallback",
        startSummary: `${this.command} starting fresh session after unrecoverable native resume`
      }
    )).result;
  }

  private async runAttempt(
    runSpec: WorkerRunSpec,
    launch: ProcessLaunch,
    options: ProcessAttemptOptions = {}
  ): Promise<ProcessAttemptResult> {
    if (runSpec.signal?.aborted) {
      const result: WorkerResult = {
        workerId: runSpec.workerId,
        exitCode: 130,
        signal: "SIGTERM",
        cancelled: true
      };
      await setStatus(runSpec, "cancelled", "process-cancelled", `${this.command} cancelled before start`);
      await appendText(runSpec.outputLogPath, "Process cancelled by user before start\n");
      return { result, output: "", launch };
    }

    await setStatus(runSpec, "starting", options.startPhase ?? "process-starting", options.startSummary ?? `Starting ${this.command}`);
    await appendText(runSpec.outputLogPath, `$ ${formatShellCommand(this.command, launch.args)}\n`);

    return new Promise<ProcessAttemptResult>((resolve, reject) => {
      const detached = process.platform !== "win32";
      const child = spawn(this.command, launch.args, {
        cwd: runSpec.cwd,
        env: {
          ...process.env,
          ...buildModelEnv(runSpec.modelConfig),
          PARALLEL_CODEX_WORKER_ID: runSpec.workerId,
          PARALLEL_CODEX_ROLE: runSpec.role,
          PARALLEL_CODEX_FILES_DIR: runSpec.filesDir
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached
      });
      let processRecordError: unknown;
      const processRecordReady = typeof child.pid === "number"
        ? writeWorkerProcessRecord(runSpec.filesDir, {
            workerId: runSpec.workerId,
            pid: child.pid,
            command: this.command,
            ...(detached ? { processGroupId: child.pid } : {})
          }).then(() => undefined, (error: unknown) => {
            processRecordError = error;
          })
        : Promise.resolve();

      let settled = false;
      let finishing = false;
      let timeout: NodeJS.Timeout | undefined;
      let idleTimeout: NodeJS.Timeout | undefined;
      let firstOutputTimeout: NodeJS.Timeout | undefined;
      let abortKillTimeout: NodeJS.Timeout | undefined;
      let abortListener: (() => void) | undefined;
      let terminalPhase: string | undefined;
      let terminalSummary: string | undefined;
      let terminalState: WorkerStatus["state"] | undefined;
      let outputWrites = Promise.resolve();
      let detectedNativeSessionId = options.initialNativeSessionId ?? runSpec.nativeSession?.session_id;
      let sessionDetectionTail = "";
      let sawOutput = false;
      const outputChunks: string[] = [];

      const clearRunTimers = (): void => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        if (idleTimeout) {
          clearTimeout(idleTimeout);
          idleTimeout = undefined;
        }
        if (firstOutputTimeout) {
          clearTimeout(firstOutputTimeout);
          firstOutputTimeout = undefined;
        }
        if (abortKillTimeout) {
          clearTimeout(abortKillTimeout);
          abortKillTimeout = undefined;
        }
      };

      const terminateWithFallback = (): void => {
        signalChildProcess(child.pid, "SIGTERM", detached);
        abortKillTimeout = setTimeout(() => {
          if (!settled) {
            signalChildProcess(child.pid, "SIGKILL", detached);
          }
        }, 1500);
        abortKillTimeout.unref();
      };

      const failAndTerminate = (phase: string, summary: string, logLine: string): void => {
        if (settled || terminalState) {
          return;
        }
        terminalState = "failed";
        terminalPhase = phase;
        terminalSummary = summary;
        clearRunTimers();
        outputWrites = outputWrites.then(() => appendText(runSpec.outputLogPath, logLine));
        void setStatus(runSpec, "failed", phase, summary, detectedNativeSessionId);
        terminateWithFallback();
      };

      const failForProcessOwnership = (): void => {
        if (!processRecordError || settled || terminalState) {
          return;
        }
        const detail = processRecordError instanceof Error
          ? processRecordError.message
          : String(processRecordError);
        failAndTerminate(
          "process-ownership-error",
          `${this.command} process ownership could not be recorded: ${detail}`,
          `\nProcess ownership record failed: ${detail}\n`
        );
      };

      const finish = async (result: WorkerResult): Promise<void> => {
        if (settled || finishing) {
          return;
        }
        finishing = true;
        await processRecordReady;
        failForProcessOwnership();
        settled = true;
        clearRunTimers();
        if (abortListener) {
          runSpec.signal?.removeEventListener("abort", abortListener);
        }
        await outputWrites;
        const phase = terminalPhase ?? (launch.isResume && result.exitCode !== 0 ? "native-resume-failed" : "process-exited");
        const summary =
          terminalSummary ??
          (launch.isResume && result.exitCode !== 0
            ? `${this.command} native resume exited with code ${result.exitCode}`
            : `${this.command} exited with code ${result.exitCode}`);
        await setStatus(
          runSpec,
          terminalState ?? (result.exitCode === 0 ? "done" : "failed"),
          phase,
          summary,
          detectedNativeSessionId
        );
        if (!processRecordError) {
          await clearWorkerProcessRecord(runSpec.filesDir);
        }
        const finalResult: WorkerResult = {
          ...result,
          ...(terminalState === "cancelled" ? { cancelled: true } : {}),
          ...(terminalState === "failed"
            ? { failure: { phase, summary } }
            : {})
        };
        resolve({
          result: finalResult,
          output: outputChunks.join(""),
          launch
        });
      };

      const resetIdleTimeout = (): void => {
        if (!runSpec.idleTimeoutMs || runSpec.idleTimeoutMs <= 0 || settled || terminalState) {
          return;
        }
        if (!sawOutput) {
          return;
        }
        if (
          runSpec.timeoutMs
          && runSpec.timeoutMs > 0
          && runSpec.idleTimeoutMs >= runSpec.timeoutMs
        ) {
          return;
        }

        if (idleTimeout) {
          clearTimeout(idleTimeout);
        }

        idleTimeout = setTimeout(() => {
          failAndTerminate(
            "process-idle-timeout",
            `${this.command} produced no output for ${runSpec.idleTimeoutMs}ms`,
            `\nProcess idle timed out after ${runSpec.idleTimeoutMs}ms\n`
          );
        }, runSpec.idleTimeoutMs);
      };

      const recordOutput = (chunk: Buffer): void => {
        sawOutput = true;
        if (firstOutputTimeout) {
          clearTimeout(firstOutputTimeout);
          firstOutputTimeout = undefined;
        }
        const text = chunk.toString("utf8");
        outputChunks.push(text);
        outputWrites = outputWrites.then(async () => {
          await appendText(runSpec.outputLogPath, text);
          if (!detectedNativeSessionId && runSpec.nativeSessionConfig?.detectSessionId !== false) {
            const detectionText = `${sessionDetectionTail}${text}`;
            const sessionId = detectNativeSessionId(detectionText);
            if (sessionId) {
              detectedNativeSessionId = sessionId;
              sessionDetectionTail = "";
              await runSpec.onNativeSession?.(sessionId);
            } else {
              sessionDetectionTail = detectionText.slice(-512);
            }
          }
          if (!settled && !terminalState) {
            await setStatus(runSpec, "running", "process-output", summarizeOutput(text), detectedNativeSessionId);
          }
        });
        resetIdleTimeout();
      };

      child.stdout.on("data", (chunk: Buffer) => {
        recordOutput(chunk);
      });

      child.stderr.on("data", (chunk: Buffer) => {
        recordOutput(chunk);
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        if (terminalState) {
          void finish({
            workerId: runSpec.workerId,
            exitCode: terminalState === "cancelled" ? 130 : 1,
            signal: null,
            ...(terminalState === "cancelled" ? { cancelled: true } : {})
          });
          return;
        }
        if (runSpec.signal?.aborted) {
          terminalState = "cancelled";
          terminalPhase = "process-cancelled";
          terminalSummary = `${this.command} cancelled by user`;
          void finish({
            workerId: runSpec.workerId,
            exitCode: 130,
            signal: "SIGTERM",
            cancelled: true
          });
          return;
        }
        settled = true;
        clearRunTimers();
        if (abortListener) {
          runSpec.signal?.removeEventListener("abort", abortListener);
        }
        void setStatus(runSpec, "failed", "process-error", error.message, detectedNativeSessionId)
          .then(async () => {
            await processRecordReady;
            await clearWorkerProcessRecord(runSpec.filesDir);
          })
          .finally(() => reject(error));
      });

      child.on("close", (code, signal) => {
        void finish({
          workerId: runSpec.workerId,
          exitCode: code ?? 1,
          signal
        });
      });

      child.stdin.once("error", (error) => {
        failAndTerminate(
          "process-input-error",
          `${this.command} input failed: ${error.message}`,
          `\nProcess input failed: ${error.message}\n`
        );
      });

      abortListener = () => {
        if (settled || terminalState) {
          return;
        }
        terminalState = "cancelled";
        terminalPhase = "process-cancelled";
        terminalSummary = `${this.command} cancelled by user`;
        clearRunTimers();
        outputWrites = outputWrites.then(() => appendText(runSpec.outputLogPath, "\nProcess cancelled by user\n"));
        void setStatus(runSpec, "cancelled", terminalPhase, terminalSummary, detectedNativeSessionId);
        terminateWithFallback();
      };
      runSpec.signal?.addEventListener("abort", abortListener, { once: true });

      if (runSpec.timeoutMs && runSpec.timeoutMs > 0) {
        timeout = setTimeout(() => {
          failAndTerminate(
            "process-timeout",
            `${this.command} exceeded ${runSpec.timeoutMs}ms`,
            `\nProcess timed out after ${runSpec.timeoutMs}ms\n`
          );
        }, runSpec.timeoutMs);
      }

      if (
        runSpec.firstOutputTimeoutMs
        && runSpec.firstOutputTimeoutMs > 0
        && (!runSpec.timeoutMs || runSpec.timeoutMs <= 0 || runSpec.firstOutputTimeoutMs < runSpec.timeoutMs)
      ) {
        firstOutputTimeout = setTimeout(() => {
          if (sawOutput || settled) {
            return;
          }
          failAndTerminate(
            "process-first-output-timeout",
            `${this.command} produced no first output for ${runSpec.firstOutputTimeoutMs}ms`,
            `\nProcess produced no first output after ${runSpec.firstOutputTimeoutMs}ms\n`
          );
        }, runSpec.firstOutputTimeoutMs);
      }

      void processRecordReady.then(() => {
        failForProcessOwnership();
        if (processRecordError || settled || finishing || terminalState) {
          return;
        }
        if (runSpec.signal?.aborted) {
          abortListener?.();
        } else {
          child.stdin.end(runSpec.prompt);
        }
      });
    });
  }
}

function buildLaunch(
  defaultArgs: string[],
  engine: EngineName,
  nativeSession: WorkerRunSpec["nativeSession"],
  nativeSessionConfig: WorkerRunSpec["nativeSessionConfig"],
  modelConfig?: WorkerModelRunConfig,
  writableDirs?: string[],
  enforceWorkspaceIsolation = false
): ProcessLaunch {
  const modelArgs = buildModelArgs(modelConfig);
  if (!nativeSession || !nativeSessionConfig?.enabled || nativeSessionConfig.resumeArgs.length === 0) {
    return buildFreshLaunch(defaultArgs, engine, modelConfig, writableDirs, enforceWorkspaceIsolation);
  }

  return {
    args: withWritableDirectoryArgs(
      enforceWorkerIsolationArgs([
        ...nativeSessionConfig.resumeArgs.map((arg) => renderTemplate(arg, nativeSession.session_id, modelConfig)),
        ...modelArgs
      ], engine, enforceWorkspaceIsolation),
      engine,
      true,
      writableDirs
    ),
    isResume: true,
    nativeSession
  };
}

function buildFreshLaunch(
  defaultArgs: string[],
  engine: EngineName,
  modelConfig?: WorkerModelRunConfig,
  writableDirs?: string[],
  enforceWorkspaceIsolation = false
): ProcessLaunch {
  return {
    args: withWritableDirectoryArgs(
      enforceWorkerIsolationArgs(
        [...defaultArgs, ...buildModelArgs(modelConfig)],
        engine,
        enforceWorkspaceIsolation
      ),
      engine,
      false,
      writableDirs
    ),
    isResume: false,
    nativeSession: null
  };
}

function enforceWorkerIsolationArgs(args: string[], engine: EngineName, enforce: boolean): string[] {
  if (!enforce) {
    return args;
  }
  if (engine === "codex") {
    return enforceCodexWorkspaceSandbox(args);
  }
  if (engine === "claude") {
    return enforceClaudeEditPermissions(args);
  }
  return args;
}

function enforceCodexWorkspaceSandbox(args: string[]): string[] {
  const result: string[] = [];
  let hasSandbox = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--dangerously-bypass-approvals-and-sandbox") {
      continue;
    }
    if (arg === "--sandbox" || arg === "-s") {
      result.push(arg, "workspace-write");
      hasSandbox = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--sandbox=") || arg.startsWith("-s=")) {
      result.push(arg.startsWith("-s=") ? "-s=workspace-write" : "--sandbox=workspace-write");
      hasSandbox = true;
      continue;
    }
    result.push(arg);
  }

  if (!hasSandbox) {
    const execIndex = result.indexOf("exec");
    const promptIndex = result.lastIndexOf("-");
    const insertAt = execIndex >= 0 ? execIndex + 1 : promptIndex >= 0 ? promptIndex : result.length;
    result.splice(insertAt, 0, "--sandbox", "workspace-write");
  }
  return result;
}

function enforceClaudeEditPermissions(args: string[]): string[] {
  const result: string[] = [];
  let hasPermissionMode = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--dangerously-skip-permissions") {
      continue;
    }
    if (arg === "--permission-mode") {
      result.push(arg, "acceptEdits");
      hasPermissionMode = true;
      index += 1;
      continue;
    }
    if (arg.startsWith("--permission-mode=")) {
      result.push("--permission-mode=acceptEdits");
      hasPermissionMode = true;
      continue;
    }
    result.push(arg);
  }
  if (!hasPermissionMode) {
    result.push("--permission-mode", "acceptEdits");
  }
  return result;
}

function withWritableDirectoryArgs(
  args: string[],
  engine: EngineName,
  isResume: boolean,
  writableDirs: string[] | undefined
): string[] {
  const directories = [...new Set((writableDirs ?? []).filter(Boolean))];
  if (directories.length === 0 || engine === "mock") {
    return args;
  }

  const directoryArgs = directories.flatMap((directory) => ["--add-dir", directory]);
  if (engine === "claude") {
    return [...args, ...directoryArgs];
  }

  if (isResume) {
    const resumeIndex = args.indexOf("resume");
    const execIndex = args.lastIndexOf("exec", resumeIndex);
    if (resumeIndex < 0 || execIndex < 0) {
      return args;
    }
    return [
      ...args.slice(0, resumeIndex),
      ...directoryArgs,
      ...args.slice(resumeIndex)
    ];
  }

  const promptIndex = args.lastIndexOf("-");
  if (promptIndex < 0) {
    return [...args, ...directoryArgs];
  }
  return [
    ...args.slice(0, promptIndex),
    ...directoryArgs,
    ...args.slice(promptIndex)
  ];
}

function buildModelArgs(modelConfig: WorkerModelRunConfig | undefined): string[] {
  if (!modelConfig || modelConfig.args.length === 0) {
    return [];
  }

  return modelConfig.args.map((arg) => renderTemplate(arg, undefined, modelConfig));
}

function buildModelEnv(modelConfig: WorkerModelRunConfig | undefined): Record<string, string> {
  if (!modelConfig?.env) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(modelConfig.env).map(([key, value]) => [key, renderTemplate(value, undefined, modelConfig)])
  );
}

function shouldFallbackToNewNativeSession(
  attempt: ProcessAttemptResult,
  nativeSessionConfig: WorkerRunSpec["nativeSessionConfig"]
): boolean {
  return (
    attempt.launch.isResume &&
    !attempt.result.cancelled &&
    (Boolean(attempt.result.failure) || attempt.result.exitCode !== 0) &&
    nativeSessionConfig?.fallback === "new" &&
    isUnrecoverableNativeResumeOutput(attempt.output)
  );
}

function isUnrecoverableNativeResumeOutput(output: string): boolean {
  const normalized = output.toLowerCase();
  return (
    normalized.includes("context window") ||
    normalized.includes("ran out of room") ||
    normalized.includes("clear earlier history") ||
    normalized.includes("start a new thread")
  );
}

function renderTemplate(value: string, sessionId: string | undefined, modelConfig: WorkerModelRunConfig | undefined): string {
  return value
    .replaceAll("{sessionId}", sessionId ?? "")
    .replaceAll("{model}", modelConfig?.name ?? "")
    .replaceAll("{provider}", modelConfig?.provider ?? "")
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "");
}

function formatShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_./:=@%+,-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function summarizeOutput(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = lines.at(-1) ?? "Worker produced output";
  return summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;
}

function signalChildProcess(pid: number | undefined, signal: NodeJS.Signals, processGroup: boolean): void {
  if (!pid) {
    return;
  }
  try {
    process.kill(processGroup ? -pid : pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      throw error;
    }
    if (processGroup) {
      try {
        process.kill(pid, signal);
      } catch (fallbackError) {
        if ((fallbackError as NodeJS.ErrnoException).code !== "ESRCH") {
          throw fallbackError;
        }
      }
    }
  }
}

async function setStatus(
  spec: WorkerRunSpec,
  state: WorkerStatus["state"],
  phase: string,
  summary: string,
  nativeSessionId?: string
): Promise<void> {
  await writeJson(spec.statusPath, {
    worker_id: spec.workerId,
    ...(spec.featureId ? { feature_id: spec.featureId } : {}),
    ...(spec.featureTitle ? { feature_title: spec.featureTitle } : {}),
    role: spec.role,
    engine: spec.engine,
    state,
    phase,
    last_event_at: new Date().toISOString(),
    summary,
    ...(nativeSessionId ? { native_session_id: nativeSessionId } : {})
  } satisfies WorkerStatus);
}
