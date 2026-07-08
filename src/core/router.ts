import { spawn } from "node:child_process";
import type { AppConfig } from "./config.js";
import type { RouteDecision } from "../domain/schemas.js";
import { RouteDecisionSchema } from "../domain/schemas.js";

export type CodexRouteRunner = (prompt: string, config: AppConfig, cwd: string) => Promise<string>;

export async function routeRequestWithCodex(
  request: string,
  config: AppConfig,
  runner: CodexRouteRunner = runCodexRouterProcess,
  cwd = config.projectRoot
): Promise<RouteDecision> {
  if (config.router.defaultMode === "simple") {
    return simpleRoute("Forced simple mode from config.", config);
  }

  if (config.router.defaultMode === "complex") {
    return complexRoute("Forced complex mode from config.", config);
  }

  try {
    const output = await runner(buildCodexRouterPrompt(request, config), config, cwd);
    const route = parseCodexRoute(output, config);
    return RouteDecisionSchema.parse(route);
  } catch (error) {
    const fallback = fallbackRoute(config);
    return {
      ...fallback,
      reason: `Codex router failed: ${error instanceof Error ? error.message : String(error)}. ${fallback.reason}`
    };
  }
}

export async function runCodexRouterProcess(prompt: string, config: AppConfig, cwd = config.projectRoot): Promise<string> {
  const { command, args, timeoutMs } = config.router.codex;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const finish = (error: Error | null, output = stdout): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (error) {
        reject(error);
      } else {
        resolve(output);
      }
    };

    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new Error(`Codex router timed out after ${timeoutMs}ms`));
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

    child.stdin.write(prompt);
    child.stdin.end();
  });
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
