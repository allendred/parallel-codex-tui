import { spawn } from "node:child_process";
import { appendText, writeJson } from "../core/file-store.js";
import type { EngineName, WorkerStatus } from "../domain/schemas.js";
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
    const launch = buildLaunch(this.args, spec.nativeSession, spec.nativeSessionConfig, model);
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

    const freshLaunch = buildFreshLaunch(this.args, model);
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
    await setStatus(runSpec, "starting", options.startPhase ?? "process-starting", options.startSummary ?? `Starting ${this.command}`);
    await appendText(runSpec.outputLogPath, `$ ${this.command} ${launch.args.join(" ")}\n`);

    return new Promise<ProcessAttemptResult>((resolve, reject) => {
      const child = spawn(this.command, launch.args, {
        cwd: runSpec.cwd,
        env: {
          ...process.env,
          ...buildModelEnv(runSpec.modelConfig),
          PARALLEL_CODEX_WORKER_ID: runSpec.workerId,
          PARALLEL_CODEX_ROLE: runSpec.role,
          PARALLEL_CODEX_FILES_DIR: runSpec.filesDir
        },
        stdio: ["pipe", "pipe", "pipe"]
      });

      let settled = false;
      let timeout: NodeJS.Timeout | undefined;
      let idleTimeout: NodeJS.Timeout | undefined;
      let firstOutputTimeout: NodeJS.Timeout | undefined;
      let terminalPhase: string | undefined;
      let terminalSummary: string | undefined;
      let outputWrites = Promise.resolve();
      let detectedNativeSessionId = options.initialNativeSessionId ?? runSpec.nativeSession?.session_id;
      let sawOutput = false;
      const outputChunks: string[] = [];

      const finish = async (result: WorkerResult): Promise<void> => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (idleTimeout) {
          clearTimeout(idleTimeout);
        }
        if (firstOutputTimeout) {
          clearTimeout(firstOutputTimeout);
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
          result.exitCode === 0 ? "done" : "failed",
          phase,
          summary,
          detectedNativeSessionId
        );
        resolve({
          result,
          output: outputChunks.join(""),
          launch
        });
      };

      const resetIdleTimeout = (): void => {
        if (!runSpec.idleTimeoutMs || runSpec.idleTimeoutMs <= 0 || settled) {
          return;
        }

        if (idleTimeout) {
          clearTimeout(idleTimeout);
        }

        idleTimeout = setTimeout(() => {
          terminalPhase = "process-idle-timeout";
          terminalSummary = `${this.command} produced no output for ${runSpec.idleTimeoutMs}ms`;
          void appendText(runSpec.outputLogPath, `\nProcess idle timed out after ${runSpec.idleTimeoutMs}ms\n`);
          void setStatus(runSpec, "failed", terminalPhase, terminalSummary);
          child.kill("SIGTERM");
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
          const sessionId = detectNativeSessionId(text);
          if (sessionId && sessionId !== detectedNativeSessionId && runSpec.nativeSessionConfig?.detectSessionId !== false) {
            detectedNativeSessionId = sessionId;
            await runSpec.onNativeSession?.(sessionId);
          }
          if (!settled) {
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
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (idleTimeout) {
          clearTimeout(idleTimeout);
        }
        if (firstOutputTimeout) {
          clearTimeout(firstOutputTimeout);
        }
        void setStatus(runSpec, "failed", "process-error", error.message, detectedNativeSessionId).finally(() => reject(error));
      });

      child.on("close", (code, signal) => {
        void finish({
          workerId: runSpec.workerId,
          exitCode: code ?? 1,
          signal
        });
      });

      if (runSpec.timeoutMs && runSpec.timeoutMs > 0) {
        timeout = setTimeout(() => {
          terminalPhase = "process-timeout";
          terminalSummary = `${this.command} exceeded ${runSpec.timeoutMs}ms`;
          void setStatus(runSpec, "failed", terminalPhase, terminalSummary, detectedNativeSessionId);
          child.kill("SIGTERM");
          void appendText(runSpec.outputLogPath, `\nProcess timed out after ${runSpec.timeoutMs}ms\n`);
        }, runSpec.timeoutMs);
      }

      if (runSpec.firstOutputTimeoutMs && runSpec.firstOutputTimeoutMs > 0) {
        firstOutputTimeout = setTimeout(() => {
          if (sawOutput || settled) {
            return;
          }
          terminalPhase = "process-first-output-timeout";
          terminalSummary = `${this.command} produced no first output for ${runSpec.firstOutputTimeoutMs}ms`;
          void setStatus(runSpec, "failed", terminalPhase, terminalSummary, detectedNativeSessionId);
          child.kill("SIGTERM");
          void appendText(runSpec.outputLogPath, `\nProcess produced no first output after ${runSpec.firstOutputTimeoutMs}ms\n`);
        }, runSpec.firstOutputTimeoutMs);
      }

      void setStatus(runSpec, "running", "process-running", `${this.command} running`, detectedNativeSessionId);
      resetIdleTimeout();
      child.stdin.write(runSpec.prompt);
      child.stdin.end();
    });
  }
}

function buildLaunch(
  defaultArgs: string[],
  nativeSession: WorkerRunSpec["nativeSession"],
  nativeSessionConfig: WorkerRunSpec["nativeSessionConfig"],
  modelConfig?: WorkerModelRunConfig
): ProcessLaunch {
  const modelArgs = buildModelArgs(modelConfig);
  if (!nativeSession || !nativeSessionConfig?.enabled || nativeSessionConfig.resumeArgs.length === 0) {
    return buildFreshLaunch(defaultArgs, modelConfig);
  }

  return {
    args: [
      ...nativeSessionConfig.resumeArgs.map((arg) => renderTemplate(arg, nativeSession.session_id, modelConfig)),
      ...modelArgs
    ],
    isResume: true,
    nativeSession
  };
}

function buildFreshLaunch(defaultArgs: string[], modelConfig?: WorkerModelRunConfig): ProcessLaunch {
  return {
    args: [...defaultArgs, ...buildModelArgs(modelConfig)],
    isResume: false,
    nativeSession: null
  };
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
    attempt.result.exitCode !== 0 &&
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

function summarizeOutput(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const summary = lines.at(-1) ?? "Worker produced output";
  return summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;
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
    role: spec.role,
    engine: spec.engine,
    state,
    phase,
    last_event_at: new Date().toISOString(),
    summary,
    ...(nativeSessionId ? { native_session_id: nativeSessionId } : {})
  } satisfies WorkerStatus);
}

function detectNativeSessionId(text: string): string | null {
  const match = text.match(/\b(?:session id|session_id|session)\s*[:=]\s*([A-Za-z0-9._:@-]{4,})/i);
  return match?.[1] ?? null;
}
