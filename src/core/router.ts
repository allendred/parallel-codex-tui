import { spawn } from "node:child_process";
import type { AppConfig } from "./config.js";
import type { RouteDecision } from "../domain/schemas.js";
import { RouteDecisionSchema } from "../domain/schemas.js";

export type CodexRouteRunner = (prompt: string, config: AppConfig, cwd: string, signal?: AbortSignal) => Promise<string>;

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
    const output = await runner(buildCodexRouterPrompt(request, config), config, cwd, signal);
    const route = parseCodexRoute(output, config);
    return annotateRoute(RouteDecisionSchema.parse(route), "codex", startedAt);
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      throw cancellationError();
    }
    const fallback = annotateRoute(fallbackRoute(config), "fallback", startedAt);
    return {
      ...fallback,
      reason: `Codex router failed: ${summarizeRouterError(error)}. ${fallback.reason}`
    };
  }
}

function annotateRoute(
  route: RouteDecision,
  source: NonNullable<RouteDecision["source"]>,
  startedAt: number
): RouteDecision {
  return {
    ...route,
    source,
    duration_ms: Math.max(0, Date.now() - startedAt)
  };
}

export async function runCodexRouterProcess(
  prompt: string,
  config: AppConfig,
  cwd = config.projectRoot,
  signal?: AbortSignal
): Promise<string> {
  const { command, args, timeoutMs } = config.router.codex;

  if (signal?.aborted) {
    throw cancellationError();
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...routerEnvironment(config.router.codex.env)
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const finish = (error: Error | null, output = stdout): void => {
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
        reject(error);
      } else {
        resolve(output);
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

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        terminate();
        const detail = summarizeRouterProcessDetail(stderr);
        finish(new Error(`Codex router timed out after ${timeoutMs}ms${detail ? `: ${detail}` : ""}`));
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      finish(error);
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
        )
      );
    });

    child.stdin.once("error", (error) => {
      terminate();
      finish(new Error(`Codex router input failed: ${error.message}`));
    });

    child.stdin.end(prompt);
  });
}

function routerEnvironment(configured: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(configured).map(([name, value]) => [
      name,
      value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, variable: string) => process.env[variable] ?? "")
    ])
  );
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
  const parsed = JSON.parse(jsonText) as Partial<RouteDecision>;
  return {
    mode: parsed.mode === "complex" ? "complex" : "simple",
    reason: parsed.reason || "Codex router decision.",
    suggested_roles: parsed.mode === "complex" ? ["judge", "actor", "critic"] : [],
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

  return (meaningful || "unknown router error").replace(/[.。]+$/u, "");
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
  return latest
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^@\s/]+)@/gi, "$1***@")
    .slice(0, 240);
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
