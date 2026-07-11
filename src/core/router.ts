import { spawn } from "node:child_process";
import type { AppConfig } from "./config.js";
import type { RouteDecision, RouterFailureStage } from "../domain/schemas.js";
import { RouteDecisionSchema } from "../domain/schemas.js";

export interface RouterExecutionTelemetry {
  router_spawn_ms?: number;
  router_first_output_ms?: number;
  router_first_stdout_ms?: number;
  router_first_stderr_ms?: number;
  router_process_ms?: number;
  router_stdout_bytes?: number;
  router_stderr_bytes?: number;
}

export interface CodexRouteRunnerResult {
  output: string;
  telemetry?: RouterExecutionTelemetry;
}

export type CodexRouteRunner = (
  prompt: string,
  config: AppConfig,
  cwd: string,
  signal?: AbortSignal
) => Promise<string | CodexRouteRunnerResult>;

interface RouterExecutionError extends Error {
  routerTelemetry?: RouterExecutionTelemetry;
  routerFailureStage?: RouterFailureStage;
}

export async function routeRequestWithCodex(
  request: string,
  config: AppConfig,
  runner: CodexRouteRunner = runCodexRouterProcess,
  cwd = config.projectRoot,
  signal?: AbortSignal
): Promise<RouteDecision> {
  const startedAt = Date.now();
  if (signal?.aborted) {
    throw cancellationError();
  }
  if (config.router.defaultMode === "simple") {
    return annotateRoute(simpleRoute("Forced simple mode from config.", config), "forced", startedAt);
  }

  if (config.router.defaultMode === "complex") {
    return annotateRoute(complexRoute("Forced complex mode from config.", config), "forced", startedAt);
  }

  try {
    const result = normalizeRouterRunnerResult(
      await runner(buildCodexRouterPrompt(request, config), config, cwd, signal)
    );
    let route: RouteDecision;
    try {
      route = parseCodexRoute(result.output, config);
    } catch (error) {
      throw routerExecutionError(error, result.telemetry, "response");
    }
    return annotateRoute(RouteDecisionSchema.parse(route), "codex", startedAt, result.telemetry);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw cancellationError();
    }
    const context = routerExecutionErrorContext(error);
    const fallback = annotateRoute(fallbackRoute(config), "fallback", startedAt, context.telemetry);
    return {
      ...fallback,
      ...(context.stage ? { router_failure_stage: context.stage } : {}),
      reason: `Codex router failed: ${summarizeRouterError(error)}. ${fallback.reason}`
    };
  }
}

function annotateRoute(
  route: RouteDecision,
  source: NonNullable<RouteDecision["source"]>,
  startedAt: number,
  telemetry?: RouterExecutionTelemetry
): RouteDecision {
  return {
    ...route,
    ...normalizeRouterTelemetry(telemetry),
    source,
    duration_ms: Math.max(0, Date.now() - startedAt)
  };
}

export async function runCodexRouterProcess(
  prompt: string,
  config: AppConfig,
  cwd = config.projectRoot,
  signal?: AbortSignal
): Promise<CodexRouteRunnerResult> {
  const { command, args, timeoutMs } = config.router.codex;

  if (signal?.aborted) {
    throw cancellationError();
  }

  const configuredEnvironment = routerEnvironment(config.router.codex.env);
  const env = {
    ...process.env,
    ...configuredEnvironment
  };
  const proxyConfigured = hasConfiguredProxy(env);

  return new Promise<CodexRouteRunnerResult>((resolve, reject) => {
    const processStartedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let spawnMs: number | undefined;
    let firstOutputMs: number | undefined;
    let firstStdoutMs: number | undefined;
    let firstStderrMs: number | undefined;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const telemetry = (): RouterExecutionTelemetry => ({
      ...(typeof spawnMs === "number" ? { router_spawn_ms: spawnMs } : {}),
      ...(typeof firstOutputMs === "number" ? { router_first_output_ms: firstOutputMs } : {}),
      ...(typeof firstStdoutMs === "number" ? { router_first_stdout_ms: firstStdoutMs } : {}),
      ...(typeof firstStderrMs === "number" ? { router_first_stderr_ms: firstStderrMs } : {}),
      router_process_ms: Math.max(0, Date.now() - processStartedAt),
      router_stdout_bytes: stdoutBytes,
      router_stderr_bytes: stderrBytes
    });

    const finish = (
      error: Error | null,
      output = stdout,
      stage?: RouterFailureStage
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (abortListener) {
        signal?.removeEventListener("abort", abortListener);
      }
      if (error) {
        reject(stage ? routerExecutionError(error, telemetry(), stage) : error);
      } else {
        resolve({ output, telemetry: telemetry() });
      }
    };

    const terminate = (): void => {
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => child.kill("SIGKILL"), 1500);
      forceKill.unref();
      child.once("close", () => clearTimeout(forceKill));
    };

    abortListener = () => {
      terminate();
      finish(cancellationError());
    };
    signal?.addEventListener("abort", abortListener, { once: true });

    child.once("spawn", () => {
      spawnMs = Math.max(0, Date.now() - processStartedAt);
    });

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        terminate();
        const detail = summarizeRouterProcessDetail(stderr);
        const proxyContext = proxyConfigured && !/\bproxy\b|代理/i.test(detail)
          ? " with proxy configured"
          : "";
        const stage = stdoutBytes + stderrBytes === 0 ? "waiting-output" : "streaming";
        finish(
          new Error(`Codex router timed out after ${timeoutMs}ms${proxyContext}${detail ? `: ${detail}` : ""}`),
          stdout,
          stage
        );
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      firstOutputMs ??= Math.max(0, Date.now() - processStartedAt);
      firstStdoutMs ??= Math.max(0, Date.now() - processStartedAt);
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      firstOutputMs ??= Math.max(0, Date.now() - processStartedAt);
      firstStderrMs ??= Math.max(0, Date.now() - processStartedAt);
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish(error, stdout, "spawn");
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(null);
        return;
      }

      const detail = (stderr || stdout).trim();
      finish(
        new Error(
          `Codex router exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}${detail ? `: ${detail}` : ""}`
        ),
        stdout,
        "exit"
      );
    });

    child.stdin.once("error", (error) => {
      terminate();
      finish(new Error(`Codex router input failed: ${error.message}`), stdout, "input");
    });

    child.stdin.end(prompt);
  });
}

function normalizeRouterRunnerResult(result: string | CodexRouteRunnerResult): CodexRouteRunnerResult {
  return typeof result === "string"
    ? { output: result }
    : { output: result.output, telemetry: normalizeRouterTelemetry(result.telemetry) };
}

function normalizeRouterTelemetry(
  telemetry: RouterExecutionTelemetry | undefined
): RouterExecutionTelemetry | undefined {
  if (!telemetry) {
    return undefined;
  }
  const normalized: RouterExecutionTelemetry = {};
  for (const key of [
    "router_spawn_ms",
    "router_first_output_ms",
    "router_first_stdout_ms",
    "router_first_stderr_ms",
    "router_process_ms",
    "router_stdout_bytes",
    "router_stderr_bytes"
  ] as const) {
    const value = telemetry[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      continue;
    }
    normalized[key] = key.endsWith("_bytes") ? Math.trunc(value) : value;
  }
  return normalized;
}

function routerExecutionError(
  error: unknown,
  telemetry: RouterExecutionTelemetry | undefined,
  stage: RouterFailureStage
): RouterExecutionError {
  const source = error instanceof Error ? error : new Error(String(error));
  const wrapped = new Error(source.message) as RouterExecutionError;
  wrapped.name = source.name;
  wrapped.routerTelemetry = normalizeRouterTelemetry(telemetry);
  wrapped.routerFailureStage = stage;
  return wrapped;
}

function routerExecutionErrorContext(error: unknown): {
  telemetry?: RouterExecutionTelemetry;
  stage?: RouterFailureStage;
} {
  if (!(error instanceof Error)) {
    return {};
  }
  const executionError = error as RouterExecutionError;
  return {
    ...(executionError.routerTelemetry ? { telemetry: executionError.routerTelemetry } : {}),
    ...(executionError.routerFailureStage ? { stage: executionError.routerFailureStage } : {})
  };
}

function routerEnvironment(
  configured: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(configured).map(([name, value]) => [
      name,
      value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => env[variable] ?? "")
    ])
  );
}

export function routerProxyConfigured(
  configured: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return hasConfiguredProxy({
    ...env,
    ...routerEnvironment(configured, env)
  });
}

function hasConfiguredProxy(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([name, value]) => (
    /^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(name) && Boolean(value?.trim())
  ));
}

function cancellationError(): Error {
  const error = new Error("Request cancelled.");
  error.name = "AbortError";
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function buildCodexRouterPrompt(request: string, config: AppConfig): string {
  return [
    "You are a routing classifier for parallel-codex-tui.",
    "Return only one JSON object. No markdown. No commentary.",
    "",
    "Choose mode:",
    '- "simple": short chat, explanation, status question, no code or project action.',
    '- "complex": implementation, modification, optimization, debugging, testing, strategy, scoring, experiments, or project work.',
    "",
    "JSON schema:",
    JSON.stringify({
      mode: "simple|complex",
      reason: "short explanation"
    }),
    "",
    "User request:",
    request
  ].join("\n");
}

function parseCodexRoute(output: string, config: AppConfig): RouteDecision {
  const jsonText = extractJsonObject(output);
  const parsed: unknown = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid Codex router response object");
  }
  const record = parsed as Record<string, unknown>;
  const mode = typeof record.mode === "string" ? record.mode.trim().toLowerCase() : "";
  if (mode !== "simple" && mode !== "complex") {
    throw new Error("Invalid Codex router mode");
  }
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  return {
    mode,
    reason: reason ? redactRouterSecrets(reason) : "Codex router decision.",
    suggested_roles: mode === "complex" ? ["judge", "actor", "critic"] : [],
    judge_engine: config.pairing.judge,
    actor_engine: config.pairing.actor,
    critic_engine: config.pairing.critic
  };
}

function extractJsonObject(output: string): string {
  const trimmed = output.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("No JSON object in Codex router output");
  }
  return match[0];
}

function fallbackRoute(config: AppConfig): RouteDecision {
  if (config.router.codex.fallback === "simple") {
    return simpleRoute("Codex router fallback forced simple.", config);
  }

  if (config.router.codex.fallback === "complex") {
    return complexRoute("Codex router fallback forced complex.", config);
  }

  return complexRoute("Codex router fallback forced complex.", config);
}

function summarizeRouterError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const meaningful = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.toLowerCase().startsWith("tip:") && !line.toLowerCase().startsWith("usage:"));

  return redactRouterSecrets(meaningful || "unknown router error").replace(/[.。]+$/u, "");
}

function summarizeRouterProcessDetail(output: string): string {
  const lines = output
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const latest = lines.at(-1) ?? "";
  return redactRouterSecrets(latest).slice(0, 240);
}

function redactRouterSecrets(value: string): string {
  return value.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi, "$1***@");
}

function simpleRoute(reason: string, config: AppConfig): RouteDecision {
  return {
    mode: "simple",
    reason,
    suggested_roles: [],
    judge_engine: config.pairing.judge,
    actor_engine: config.pairing.actor,
    critic_engine: config.pairing.critic
  };
}

function complexRoute(reason: string, config: AppConfig): RouteDecision {
  return {
    mode: "complex",
    reason,
    suggested_roles: ["judge", "actor", "critic"],
    judge_engine: config.pairing.judge,
    actor_engine: config.pairing.actor,
    critic_engine: config.pairing.critic
  };
}
