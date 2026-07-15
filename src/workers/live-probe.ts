import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../core/config.js";
import { ensureDir, readTextIfExists, writeText } from "../core/file-store.js";
import type { NativeSession } from "../domain/schemas.js";
import { createWorkerRegistry, getAdapter, type WorkerRegistry } from "./registry.js";
import type { DiagnosedWorkerEngine } from "./capabilities.js";
import { workerProvider } from "./provider.js";
import type { WorkerResult, WorkerRunSpec } from "./types.js";

export interface LiveAgentProbeResult {
  ok: boolean;
  lines: string[];
}

export interface LiveAgentProbeOptions {
  registry?: WorkerRegistry;
  timeoutMs?: number;
  nonce?: () => string;
}

interface EngineProbeResult {
  ok: boolean;
  line: string;
}

export async function runLiveAgentProbes(
  config: AppConfig,
  workspaceRoot: string,
  engines: DiagnosedWorkerEngine[],
  options: LiveAgentProbeOptions = {}
): Promise<LiveAgentProbeResult> {
  const activeEngines = [...new Set(engines)];
  if (activeEngines.length === 0) {
    return {
      ok: true,
      lines: ["agent live probe: skipped (no process Worker providers active)"]
    };
  }

  const probesRoot = join(workspaceRoot, config.dataDir, "probes");
  await ensureDir(probesRoot);
  const runRoot = await mkdtemp(join(probesRoot, ".agent-"));
  const registry = options.registry ?? createWorkerRegistry(config);
  const nonce = options.nonce ?? (() => randomBytes(4).toString("hex"));
  const results: EngineProbeResult[] = [];

  for (const engine of activeEngines) {
    try {
      results.push(await probeEngine(config, registry, engine, runRoot, nonce(), options.timeoutMs));
    } catch (error) {
      results.push({
        ok: false,
        line: `${engine} live probe: failed (${safeProbeError(error)}; artifacts ${runRoot})`
      });
    }
  }

  const ok = results.every((result) => result.ok);
  if (ok) {
    await rm(runRoot, { force: true, recursive: true });
  }
  return {
    ok,
    lines: results.map((result) => result.line)
  };
}

async function probeEngine(
  config: AppConfig,
  registry: WorkerRegistry,
  engine: DiagnosedWorkerEngine,
  runRoot: string,
  nonce: string,
  timeoutOverride?: number
): Promise<EngineProbeResult> {
  const startedAt = Date.now();
  const worker = workerProvider(config, engine).config;
  const adapter = getAdapter(registry, engine);
  const cwd = join(runRoot, `${engine}-workspace`);
  await mkdir(cwd, { recursive: true });
  const first = probeChallenge(engine, "fresh", nonce);
  let nativeSessionId: string | null = null;
  const firstSpec = await probeSpec({
    config,
    engine,
    cwd,
    dir: join(runRoot, `${engine}-fresh`),
    workerId: `doctor-${engine}-fresh`,
    challenge: first,
    timeoutOverride,
    onNativeSession: (sessionId) => {
      nativeSessionId = sessionId;
    }
  });
  const firstResult = await adapter.run(firstSpec);
  await requireProbeAnswer(firstResult, firstSpec, first.expected);

  if (!worker.nativeSession.enabled || !worker.nativeSession.detectSessionId) {
    return {
      ok: true,
      line: `${engine} live probe: ok (fresh; native resume disabled; ${formatProbeDuration(Date.now() - startedAt)})`
    };
  }
  if (!nativeSessionId) {
    throw new Error("fresh request succeeded but no native session id was detected");
  }

  const second = probeChallenge(engine, "resume", nonce);
  let resumedSessionId: string | null = null;
  const now = new Date().toISOString();
  const nativeSession: NativeSession = {
    engine,
    role: "main",
    worker_id: firstSpec.workerId,
    session_id: nativeSessionId,
    scope: "main",
    cwd,
    created_at: now,
    last_used_at: now,
    source: "manual"
  };
  const resumeSpec = await probeSpec({
    config,
    engine,
    cwd,
    dir: join(runRoot, `${engine}-resume`),
    workerId: `doctor-${engine}-resume`,
    challenge: second,
    timeoutOverride,
    nativeSession,
    onNativeSession: (sessionId) => {
      resumedSessionId = sessionId;
    }
  });
  const resumeResult = await adapter.run(resumeSpec);
  await requireProbeAnswer(resumeResult, resumeSpec, second.expected);
  if (resumedSessionId && resumedSessionId !== nativeSessionId) {
    throw new Error("resume request returned a different native session id");
  }

  return {
    ok: true,
    line: `${engine} live probe: ok (fresh + resume; session ${compactProbeSessionId(nativeSessionId)}; ${formatProbeDuration(Date.now() - startedAt)})`
  };
}

interface ProbeSpecInput {
  config: AppConfig;
  engine: DiagnosedWorkerEngine;
  cwd: string;
  dir: string;
  workerId: string;
  challenge: { prompt: string; expected: string };
  timeoutOverride?: number;
  nativeSession?: NativeSession;
  onNativeSession: (sessionId: string) => void;
}

async function probeSpec(input: ProbeSpecInput): Promise<WorkerRunSpec> {
  const worker = workerProvider(input.config, input.engine).config;
  await mkdir(input.dir, { recursive: true });
  const promptPath = join(input.dir, "prompt.md");
  await writeText(promptPath, `${input.challenge.prompt}\n`);
  const maximumTimeout = input.timeoutOverride ?? 120_000;
  const timeoutMs = Math.min(worker.timeoutMs ?? maximumTimeout, maximumTimeout);
  const firstOutputTimeoutMs = Math.min(worker.firstOutputTimeoutMs ?? timeoutMs, timeoutMs);
  const idleTimeoutMs = Math.min(worker.idleTimeoutMs ?? timeoutMs, timeoutMs);

  return {
    workerId: input.workerId,
    role: "main",
    engine: input.engine,
    cwd: input.cwd,
    enforceWorkspaceIsolation: true,
    filesDir: input.dir,
    promptPath,
    outputLogPath: join(input.dir, "output.log"),
    statusPath: join(input.dir, "status.json"),
    prompt: input.challenge.prompt,
    timeoutMs,
    firstOutputTimeoutMs,
    idleTimeoutMs,
    ...(input.nativeSession ? { nativeSession: input.nativeSession } : {}),
    nativeSessionConfig: {
      ...worker.nativeSession,
      fallback: "fail"
    },
    modelConfig: worker.model,
    onNativeSession: input.onNativeSession
  };
}

async function requireProbeAnswer(
  result: WorkerResult,
  spec: WorkerRunSpec,
  expected: string
): Promise<void> {
  const output = await readTextIfExists(spec.outputLogPath);
  if (result.exitCode !== 0 || result.cancelled || result.failure) {
    throw new Error(result.failure?.summary || `worker exited with code ${result.exitCode}`);
  }
  if (!output.includes(expected)) {
    throw new Error(`response did not contain challenge result ${expected}`);
  }
}

function probeChallenge(
  engine: DiagnosedWorkerEngine,
  phase: "fresh" | "resume",
  nonce: string
): { prompt: string; expected: string } {
  const segments = ["PCT", engine.toUpperCase(), phase.toUpperCase(), nonce.toUpperCase()];
  return {
    prompt: [
      "This is a connectivity probe. Do not use tools or modify files.",
      `Join these segments with underscores and reply with only the joined value: ${segments.join(" | ")}`
    ].join("\n"),
    expected: segments.join("_")
  };
}

function compactProbeSessionId(sessionId: string): string {
  return sessionId.length > 12 ? `${sessionId.slice(0, 8)}...` : sessionId;
}

function formatProbeDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(1).replace(/\.0$/, "")}s`;
}

function safeProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300) || "unknown error";
}
