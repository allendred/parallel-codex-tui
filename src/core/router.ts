import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";
import type { AppConfig } from "./config.js";
import type { RouteDecision, RouterFailureKind, RouterFailureStage, RouterProxySource, RouterTimeoutKind } from "../domain/schemas.js";
import { RouteDecisionSchema } from "../domain/schemas.js";
import { ProcessTreeCleanupError, terminateProcessTree } from "./process-tree.js";
import { classifyRouterFailure } from "./router-audit.js";
import { sanitizeRouterText } from "./router-redaction.js";

export interface RouterExecutionTelemetry {
  router_dispatch_ms?: number;
  router_spawn_ms?: number;
  router_first_output_ms?: number;
  router_first_stdout_ms?: number;
  router_first_stderr_ms?: number;
  router_process_ms?: number;
  router_parse_ms?: number;
  router_stdout_bytes?: number;
  router_stderr_bytes?: number;
}

export interface CodexRouteRunnerResult {
  output: string;
  telemetry?: RouterExecutionTelemetry;
}

export type RouterExecutionPhase =
  | "dispatching"
  | "starting"
  | "retrying"
  | "waiting-output"
  | "receiving-stderr"
  | "receiving-response"
  | "parsing"
  | "stopping";

export interface RouterExecutionProgress {
  phase: RouterExecutionPhase;
}

export type RouterProgressListener = (progress: RouterExecutionProgress) => void;

export type RouterProxyContext =
  | { configured: false }
  | {
      configured: true;
      source: RouterProxySource;
      variable: string;
      endpoint: string;
    };

export type CodexRouteRunner = (
  prompt: string,
  config: AppConfig,
  cwd: string,
  signal?: AbortSignal,
  onProgress?: RouterProgressListener
) => Promise<string | CodexRouteRunnerResult>;

interface RouterExecutionError extends Error {
  routerTelemetry?: RouterExecutionTelemetry;
  routerFailureStage?: RouterFailureStage;
  routerTimeoutKind?: RouterTimeoutKind;
}

export async function routeRequestWithCodex(
  request: string,
  config: AppConfig,
  runner: CodexRouteRunner = runCodexRouterProcess,
  cwd = config.projectRoot,
  signal?: AbortSignal,
  onProgress?: RouterProgressListener
): Promise<RouteDecision> {
  const startedAt = Date.now();
  const telemetryStartedAt = performance.now();
  let dispatchMs: number | undefined;
  if (signal?.aborted) {
    throw cancellationError();
  }
  if (config.router.defaultMode === "simple") {
    return annotateRoute(simpleRoute("Forced simple mode from config.", config), "forced", startedAt);
  }

  if (config.router.defaultMode === "complex") {
    return annotateRoute(complexRoute("Forced complex mode from config.", config), "forced", startedAt);
  }

  const proxyContext = routerProxyContext(config.router.codex.env);
  const commandLabel = routerCommandLabel(config.router.codex.command);
  const routerName = routerDisplayName(commandLabel);
  try {
    const prompt = buildCodexRouterPrompt(request, config);
    dispatchMs = Math.max(0, performance.now() - telemetryStartedAt);
    emitRouterProgress(onProgress, "dispatching");
    const result = normalizeRouterRunnerResult(
      await runner(prompt, config, cwd, signal, onProgress)
    );
    let route: RouteDecision;
    const parseStartedAt = performance.now();
    emitRouterProgress(onProgress, "parsing");
    try {
      route = RouteDecisionSchema.parse(parseCodexRoute(result.output, config));
    } catch (error) {
      throw routerExecutionError(error, mergeRouterTelemetry(result.telemetry, {
        router_dispatch_ms: dispatchMs,
        router_parse_ms: Math.max(0, performance.now() - parseStartedAt)
      }), "response");
    }
    return annotateRoute(route, "codex", startedAt, mergeRouterTelemetry(result.telemetry, {
      router_dispatch_ms: dispatchMs,
      router_parse_ms: Math.max(0, performance.now() - parseStartedAt)
    }), proxyContext, commandLabel);
  } catch (error) {
    if (error instanceof ProcessTreeCleanupError) {
      throw error;
    }
    if (signal?.aborted || isAbortError(error)) {
      throw cancellationError();
    }
    const context = routerExecutionErrorContext(error);
    const failureSummary = summarizeRouterError(error);
    const fallback = annotateRoute(fallbackRoute(config, routerName), "fallback", startedAt, mergeRouterTelemetry(context.telemetry, {
      router_dispatch_ms: dispatchMs
    }), proxyContext, commandLabel);
    return {
      ...fallback,
      ...(context.stage ? { router_failure_stage: context.stage } : {}),
      router_failure_kind: routerFailureKind(failureSummary, context.stage, context.timeoutKind),
      ...(context.timeoutKind ? { router_timeout_kind: context.timeoutKind } : {}),
      reason: `${routerName} failed: ${failureSummary}. ${fallback.reason}`
    };
  }
}

function routerFailureKind(
  summary: string,
  stage: RouterFailureStage | undefined,
  timeoutKind: RouterTimeoutKind | undefined
): RouterFailureKind {
  if (timeoutKind) {
    return "timeout";
  }
  const classified = classifyRouterFailure(summary);
  if (classified) {
    return classified;
  }
  if (stage === "spawn") {
    return "unavailable";
  }
  if (stage === "input") {
    return "input";
  }
  if (stage === "exit") {
    return "exit";
  }
  if (stage === "response") {
    return "invalid-output";
  }
  return "unknown";
}

function annotateRoute(
  route: RouteDecision,
  source: NonNullable<RouteDecision["source"]>,
  startedAt: number,
  telemetry?: RouterExecutionTelemetry,
  proxyContext?: RouterProxyContext,
  routerCommand?: string
): RouteDecision {
  return {
    ...route,
    ...normalizeRouterTelemetry(telemetry),
    ...routerProxyRouteFields(proxyContext),
    ...(routerCommand ? { router_command: routerCommand } : {}),
    source,
    duration_ms: Math.max(0, Date.now() - startedAt)
  };
}

export function routerCommandLabel(command: string): string {
  const executable = command.trim().split(/[\\/]/).filter(Boolean).at(-1) ?? "router";
  const safe = sanitizeRouterText(executable)
    .replace(/[\u0000-\u001f\u007f|·]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return Array.from(safe || "router").slice(0, 80).join("");
}

function routerDisplayName(commandLabel: string): string {
  return /^codex(?:\.exe)?$/i.test(commandLabel) ? "Codex router" : `Router ${commandLabel}`;
}

export async function runCodexRouterProcess(
  prompt: string,
  config: AppConfig,
  cwd = config.projectRoot,
  signal?: AbortSignal,
  onProgress?: RouterProgressListener
): Promise<CodexRouteRunnerResult> {
  const { command, args, timeoutMs, firstOutputTimeoutMs, idleTimeoutMs, maxOutputBytes } = config.router.codex;
  const routerName = routerDisplayName(routerCommandLabel(command));

  if (signal?.aborted) {
    throw cancellationError();
  }

  const configuredEnvironment = routerEnvironment(config.router.codex.env);
  const env = {
    ...process.env,
    ...configuredEnvironment
  };
  const proxyConfigured = hasConfiguredProxy(env);
  let progressPhase: RouterExecutionPhase | undefined;
  const reportProgress = (phase: RouterExecutionPhase): void => {
    if (progressPhase === phase) {
      return;
    }
    progressPhase = phase;
    emitRouterProgress(onProgress, phase);
  };
  reportProgress("starting");

  return new Promise<CodexRouteRunnerResult>((resolve, reject) => {
    const processStartedAt = Date.now();
    const detached = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached
    });
    let stdout = "";
    let stderr = "";
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let spawnMs: number | undefined;
    let firstOutputMs: number | undefined;
    let firstStdoutMs: number | undefined;
    let firstStderrMs: number | undefined;
    let settled = false;
    let terminating = false;
    let totalTimeout: NodeJS.Timeout | undefined;
    let firstOutputTimeout: NodeJS.Timeout | undefined;
    let idleTimeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const clearRunTimers = (): void => {
      if (totalTimeout) {
        clearTimeout(totalTimeout);
        totalTimeout = undefined;
      }
      if (firstOutputTimeout) {
        clearTimeout(firstOutputTimeout);
        firstOutputTimeout = undefined;
      }
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = undefined;
      }
    };

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
      stage?: RouterFailureStage,
      timeoutKind?: RouterTimeoutKind
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearRunTimers();
      if (abortListener) {
        signal?.removeEventListener("abort", abortListener);
      }
      if (error) {
        reject(stage ? routerExecutionError(error, telemetry(), stage, timeoutKind) : error);
      } else {
        resolve({ output, telemetry: telemetry() });
      }
    };

    const terminateThenFinish = (
      error: Error,
      output = stdout,
      stage?: RouterFailureStage,
      timeoutKind?: RouterTimeoutKind
    ): void => {
      if (settled || terminating) {
        return;
      }
      terminating = true;
      reportProgress("stopping");
      clearRunTimers();
      if (abortListener) {
        signal?.removeEventListener("abort", abortListener);
        abortListener = undefined;
      }
      void terminateProcessTree(child, {
        processGroup: detached,
        label: `${routerName} process`,
        termGraceMs: 250,
        killWaitMs: 500,
        pollMs: 20
      }).then(
        () => finish(error, output, stage, timeoutKind),
        (cleanupError: unknown) => finish(
          cleanupError instanceof ProcessTreeCleanupError
            ? cleanupError
            : new ProcessTreeCleanupError(`${routerName} cleanup failed: ${errorMessage(cleanupError)}`)
        )
      );
    };

    const timeoutRouter = (
      kind: RouterTimeoutKind,
      limitMs: number,
      stage: RouterFailureStage
    ): void => {
      if (settled || terminating) {
        return;
      }
      const detail = summarizeRouterProcessDetail(stderr);
      const proxyContext = proxyConfigured && !/\bproxy\b|代理/i.test(detail)
        ? " with proxy configured"
        : "";
      const timeoutLabel = kind === "first-output" ? " first output" : kind === "idle" ? " idle" : "";
      terminateThenFinish(
        new Error(`${routerName}${timeoutLabel} timed out after ${limitMs}ms${proxyContext}${detail ? `: ${detail}` : ""}`),
        stdout,
        stage,
        kind
      );
    };

    const stopIfOutputLimitExceeded = (): boolean => {
      if (stdoutBytes + stderrBytes <= maxOutputBytes) {
        return false;
      }
      terminateThenFinish(
        new Error(`${routerName} output exceeded ${maxOutputBytes} byte limit`),
        stdout,
        "response"
      );
      return true;
    };

    const resetIdleTimeout = (): void => {
      if (idleTimeout) {
        clearTimeout(idleTimeout);
        idleTimeout = undefined;
      }
      if (idleTimeoutMs <= 0 || (timeoutMs > 0 && idleTimeoutMs >= timeoutMs)) {
        return;
      }
      idleTimeout = setTimeout(() => timeoutRouter("idle", idleTimeoutMs, "streaming"), idleTimeoutMs);
    };

    const recordOutputActivity = (): void => {
      if (firstOutputTimeout) {
        clearTimeout(firstOutputTimeout);
        firstOutputTimeout = undefined;
      }
      resetIdleTimeout();
    };

    abortListener = () => {
      terminateThenFinish(cancellationError());
    };
    signal?.addEventListener("abort", abortListener, { once: true });

    child.once("spawn", () => {
      if (terminating) {
        return;
      }
      spawnMs = Math.max(0, Date.now() - processStartedAt);
      reportProgress("waiting-output");
    });

    if (timeoutMs > 0) {
      totalTimeout = setTimeout(() => {
        const stage = stdoutBytes + stderrBytes === 0 ? "waiting-output" : "streaming";
        timeoutRouter("total", timeoutMs, stage);
      }, timeoutMs);
    }
    if (firstOutputTimeoutMs > 0 && (timeoutMs <= 0 || firstOutputTimeoutMs < timeoutMs)) {
      firstOutputTimeout = setTimeout(
        () => timeoutRouter("first-output", firstOutputTimeoutMs, "waiting-output"),
        firstOutputTimeoutMs
      );
    }

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled || terminating) {
        return;
      }
      stdoutBytes += chunk.byteLength;
      firstOutputMs ??= Math.max(0, Date.now() - processStartedAt);
      firstStdoutMs ??= Math.max(0, Date.now() - processStartedAt);
      if (stopIfOutputLimitExceeded()) {
        return;
      }
      stdout += stdoutDecoder.write(chunk);
      recordOutputActivity();
      reportProgress("receiving-response");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (settled || terminating) {
        return;
      }
      stderrBytes += chunk.byteLength;
      firstOutputMs ??= Math.max(0, Date.now() - processStartedAt);
      firstStderrMs ??= Math.max(0, Date.now() - processStartedAt);
      if (stopIfOutputLimitExceeded()) {
        return;
      }
      stderr += stderrDecoder.write(chunk);
      recordOutputActivity();
      if (stdoutBytes === 0) {
        reportProgress("receiving-stderr");
      }
    });

    child.on("error", (error) => {
      if (terminating) {
        return;
      }
      finish(error, stdout, "spawn");
    });

    child.on("close", (code, signal) => {
      if (terminating) {
        return;
      }
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (code === 0) {
        finish(null);
        return;
      }

      const detail = (stderr || stdout).trim();
      finish(
        new Error(
          `${routerName} exited with ${signal ? `signal ${signal}` : `code ${code ?? 1}`}${detail ? `: ${detail}` : ""}`
        ),
        stdout,
        "exit"
      );
    });

    child.stdin.once("error", (error) => {
      terminateThenFinish(new Error(`${routerName} input failed: ${error.message}`), stdout, "input");
    });

    if (signal?.aborted) {
      abortListener();
    } else {
      child.stdin.end(prompt);
    }
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    "router_dispatch_ms",
    "router_spawn_ms",
    "router_first_output_ms",
    "router_first_stdout_ms",
    "router_first_stderr_ms",
    "router_process_ms",
    "router_parse_ms",
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

function mergeRouterTelemetry(
  telemetry: RouterExecutionTelemetry | undefined,
  additions: RouterExecutionTelemetry
): RouterExecutionTelemetry | undefined {
  return normalizeRouterTelemetry({
    ...telemetry,
    ...Object.fromEntries(Object.entries(additions).filter(([, value]) => value !== undefined))
  });
}

function routerExecutionError(
  error: unknown,
  telemetry: RouterExecutionTelemetry | undefined,
  stage: RouterFailureStage,
  timeoutKind?: RouterTimeoutKind
): RouterExecutionError {
  const source = error instanceof Error ? error : new Error(String(error));
  const wrapped = new Error(source.message) as RouterExecutionError;
  wrapped.name = source.name;
  wrapped.routerTelemetry = normalizeRouterTelemetry(telemetry);
  wrapped.routerFailureStage = stage;
  wrapped.routerTimeoutKind = timeoutKind;
  return wrapped;
}

function routerExecutionErrorContext(error: unknown): {
  telemetry?: RouterExecutionTelemetry;
  stage?: RouterFailureStage;
  timeoutKind?: RouterTimeoutKind;
} {
  if (!(error instanceof Error)) {
    return {};
  }
  const executionError = error as RouterExecutionError;
  return {
    ...(executionError.routerTelemetry ? { telemetry: executionError.routerTelemetry } : {}),
    ...(executionError.routerFailureStage ? { stage: executionError.routerFailureStage } : {}),
    ...(executionError.routerTimeoutKind ? { timeoutKind: executionError.routerTimeoutKind } : {})
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
  return routerProxyContext(configured, env).configured;
}

export function routerProxyContext(
  configured: Record<string, string>,
  env: NodeJS.ProcessEnv = process.env
): RouterProxyContext {
  const configuredEnvironment = routerEnvironment(configured, env);
  const configuredProxy = preferredProxyEntry(configuredEnvironment);
  if (configuredProxy) {
    return {
      configured: true,
      source: "router-config",
      variable: configuredProxy.name,
      endpoint: safeProxyEndpoint(configuredProxy.value)
    };
  }

  const inheritedProxy = preferredProxyEntry({
    ...env,
    ...configuredEnvironment
  });
  if (!inheritedProxy) {
    return { configured: false };
  }
  return {
    configured: true,
    source: "environment",
    variable: inheritedProxy.name,
    endpoint: safeProxyEndpoint(inheritedProxy.value)
  };
}

function hasConfiguredProxy(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([name, value]) => (
    /^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(name) && Boolean(value?.trim())
  ));
}

function preferredProxyEntry(env: NodeJS.ProcessEnv): { name: string; value: string } | null {
  const candidates = Object.entries(env)
    .filter((entry): entry is [string, string] => (
      /^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(entry[0]) && Boolean(entry[1]?.trim())
    ))
    .sort((left, right) => {
      const priority = proxyVariablePriority(left[0]) - proxyVariablePriority(right[0]);
      return priority || left[0].localeCompare(right[0]);
    });
  const selected = candidates[0];
  return selected ? { name: selected[0], value: selected[1].trim() } : null;
}

function proxyVariablePriority(name: string): number {
  const normalized = name.toUpperCase();
  return normalized === "HTTPS_PROXY" ? 0 : normalized === "ALL_PROXY" ? 1 : 2;
}

function safeProxyEndpoint(value: string): string {
  try {
    const normalized = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)
      ? value
      : `http://${value}`;
    const parsed = new URL(normalized);
    return parsed.host || "custom";
  } catch {
    return "custom";
  }
}

function routerProxyRouteFields(proxyContext: RouterProxyContext | undefined): Partial<RouteDecision> {
  if (!proxyContext) {
    return {};
  }
  if (!proxyContext.configured) {
    return { proxy_configured: false };
  }
  return {
    proxy_configured: true,
    proxy_source: proxyContext.source,
    proxy_variable: proxyContext.variable,
    proxy_endpoint: proxyContext.endpoint
  };
}

function emitRouterProgress(listener: RouterProgressListener | undefined, phase: RouterExecutionPhase): void {
  try {
    listener?.({ phase });
  } catch {
    // UI progress listeners must never change Router execution semantics.
  }
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
  const routerName = routerDisplayName(routerCommandLabel(config.router.codex.command));
  const jsonText = extractJsonObject(output);
  const parsed: unknown = JSON.parse(jsonText);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${routerName} response object`);
  }
  const record = parsed as Record<string, unknown>;
  const mode = typeof record.mode === "string" ? record.mode.trim().toLowerCase() : "";
  if (mode !== "simple" && mode !== "complex") {
    throw new Error(`Invalid ${routerName} mode`);
  }
  const reason = typeof record.reason === "string" ? record.reason.trim() : "";
  return {
    mode,
    reason: reason ? sanitizeRouterText(reason) : `${routerName} decision.`,
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

function fallbackRoute(config: AppConfig, routerName: string): RouteDecision {
  if (config.router.codex.fallback === "simple") {
    return simpleRoute(`${routerName} fallback forced simple.`, config);
  }

  if (config.router.codex.fallback === "complex") {
    return complexRoute(`${routerName} fallback forced complex.`, config);
  }

  return complexRoute(`${routerName} fallback forced complex.`, config);
}

function summarizeRouterError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const meaningful = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.toLowerCase().startsWith("tip:") && !line.toLowerCase().startsWith("usage:"));

  return sanitizeRouterText(meaningful || "unknown router error").replace(/[.。]+$/u, "");
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
  return sanitizeRouterText(latest).slice(0, 240);
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
