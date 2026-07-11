import { z } from "zod";
import { RouteDecisionSchema, type RouterFailureStage, type RouterTimeoutKind } from "../domain/schemas.js";
import { readTextIfExists } from "./file-store.js";

export const RouterFailureKindSchema = z.enum([
  "timeout",
  "auth",
  "rate-limit",
  "proxy",
  "network",
  "unavailable",
  "invalid-output",
  "exit",
  "input",
  "unknown"
]);

export const RouterAuditRecordSchema = RouteDecisionSchema.extend({
  time: z.string().datetime(),
  request: z.string(),
  workspace: z.string().min(1),
  scope: z.enum(["initial", "follow-up"]).default("initial"),
  router_timeout_ms: z.number().int().positive().optional(),
  router_first_output_timeout_ms: z.number().int().positive().optional(),
  router_idle_timeout_ms: z.number().int().positive().optional(),
  proxy_configured: z.boolean().optional(),
  failure_kind: RouterFailureKindSchema.optional()
});

export type RouterAuditRecord = z.infer<typeof RouterAuditRecordSchema>;
export type RouterFailureKind = z.infer<typeof RouterFailureKindSchema>;

export interface RouterFailureEvidence {
  reason: string;
  failure_kind?: RouterFailureKind;
  proxy_configured?: boolean;
  router_failure_stage?: RouterFailureStage;
  router_timeout_kind?: RouterTimeoutKind;
  router_stdout_bytes?: number;
  router_stderr_bytes?: number;
}

export interface RouterFailureDiagnosis {
  kind: RouterFailureKind;
  summary: string;
  action: string;
}

export function classifyRouterFailure(reason: string): RouterFailureKind | null {
  const timedOut = /\b(?:timed out|timeout|ETIMEDOUT)\b/i.test(reason);
  const proxyMentioned = /\bproxy\b|代理/i.test(reason);
  const proxyFailure = (
    /\bproxy(?:\s+(?:connection|connect|handshake|authentication|request|server|transport|tunnel))?\s+(?:authentication|required|failed|failure|error|refused|unreachable|invalid|closed|reset)\b/i.test(reason)
    || /\b(?:failed|unable|cannot|could not)\s+(?:to\s+)?(?:connect|reach|use|negotiate).{0,30}\bproxy\b/i.test(reason)
    || /代理.{0,20}(?:认证|失败|错误|拒绝|无法|不可达)/i.test(reason)
  );
  if (proxyMentioned && timedOut) {
    return "timeout";
  }
  if (proxyFailure) {
    return "proxy";
  }
  if (/\b(?:401|403)\b|\b(?:unauthori[sz]ed|forbidden|authentication|api[-_\s]?key|login required|not logged in|sign in)\b/i.test(reason)) {
    return "auth";
  }
  if (/\b429\b|\b(?:rate[ -]?limit|too many requests|quota (?:exceeded|exhausted)|usage limit)\b/i.test(reason)) {
    return "rate-limit";
  }
  if (/\b(?:ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|ENOTFOUND|EAI_AGAIN)\b|\b(?:network|websocket|https transport|fetch failed|certificate|tls|ssl)\b/i.test(reason)) {
    return "network";
  }
  if (timedOut) {
    return "timeout";
  }
  if (/\b(?:ENOENT|command not found|spawn error)\b/i.test(reason)) {
    return "unavailable";
  }
  if (/\b(?:no json object|invalid json|invalid codex router (?:mode|response object)|failed to parse json|unexpected token)\b/i.test(reason)) {
    return "invalid-output";
  }
  if (/\b(?:exited with (?:code|signal)|process exited)\b/i.test(reason)) {
    return "exit";
  }
  if (/\b(?:router input failed|stdin|EPIPE)\b/i.test(reason)) {
    return "input";
  }
  return null;
}

export function diagnoseRouterFailure(evidence: RouterFailureEvidence): RouterFailureDiagnosis {
  const kind = evidence.failure_kind ?? classifyRouterFailure(evidence.reason) ?? "unknown";
  if (kind === "auth") {
    return diagnosis(kind, "Codex authentication failed", "run codex login, then retry Router");
  }
  if (kind === "rate-limit") {
    return diagnosis(kind, "The provider rate limit blocked routing", "wait for quota or change the Router model/provider");
  }
  if (kind === "proxy") {
    return diagnosis(
      kind,
      "Router reported a proxy-path failure",
      "run parallel-codex-tui --doctor --probe-router and verify the proxy upstream"
    );
  }
  if (kind === "network") {
    return diagnosis(
      kind,
      "Router reported a network-path failure",
      "run parallel-codex-tui --doctor --probe-router and verify DNS, TLS, and API reachability"
    );
  }
  if (kind === "unavailable") {
    return diagnosis(
      kind,
      evidence.router_failure_stage === "spawn" ? "Router process could not start" : "Router command is unavailable",
      "run parallel-codex-tui --doctor and fix router.codex.command"
    );
  }
  if (kind === "invalid-output") {
    return diagnosis(
      kind,
      "Router returned output that was not valid route JSON",
      "retry Router; if it repeats, inspect the Router model/provider output"
    );
  }
  if (kind === "input") {
    return diagnosis(
      kind,
      "Router process rejected the request input",
      "check that router.codex.args accepts a prompt on stdin"
    );
  }
  if (kind === "timeout") {
    return diagnoseRouterTimeout(evidence);
  }
  if (kind === "exit") {
    return diagnosis(
      kind,
      "Router process exited before a valid route response",
      "run the configured Codex command directly and inspect its exit output"
    );
  }
  return diagnosis(
    "unknown",
    "Router failed before a valid route response",
    "run parallel-codex-tui --doctor --probe-router and inspect the recorded reason"
  );
}

function diagnoseRouterTimeout(evidence: RouterFailureEvidence): RouterFailureDiagnosis {
  if (evidence.router_timeout_kind === "first-output") {
    return diagnosis(
      "timeout",
      "Router produced no output before the first-output deadline",
      evidence.proxy_configured
        ? "run parallel-codex-tui --doctor --probe-router; verify Codex login and proxy upstream, or raise router.codex.firstOutputTimeoutMs"
        : "run parallel-codex-tui --doctor --probe-router; verify Codex login and API network path, or raise router.codex.firstOutputTimeoutMs"
    );
  }
  if (evidence.router_timeout_kind === "idle") {
    return diagnosis(
      "timeout",
      (evidence.router_stdout_bytes ?? 0) > 0
        ? "Router response stopped before valid route JSON completed"
        : "Router diagnostics stopped before a route response",
      "inspect the reason; retry Router or raise router.codex.idleTimeoutMs"
    );
  }
  if ((evidence.router_stdout_bytes ?? 0) > 0) {
    return diagnosis(
      "timeout",
      "Router began a route response but did not finish",
      "retry Router or raise router.codex.timeoutMs"
    );
  }
  if ((evidence.router_stderr_bytes ?? 0) > 0) {
    return diagnosis(
      "timeout",
      "Router emitted diagnostics but no route response",
      "inspect the reason, then run parallel-codex-tui --doctor --probe-router"
    );
  }
  if (evidence.router_failure_stage === "waiting-output") {
    return diagnosis(
      "timeout",
      "Router produced no output before the timeout",
      evidence.proxy_configured
        ? "run parallel-codex-tui --doctor --probe-router; verify Codex login and proxy upstream"
        : "run parallel-codex-tui --doctor --probe-router; verify Codex login and API network path"
    );
  }
  return diagnosis(
    "timeout",
    "Router timed out before a valid route response",
    evidence.proxy_configured
      ? "run parallel-codex-tui --doctor --probe-router; verify Codex login and proxy upstream"
      : "run parallel-codex-tui --doctor --probe-router; verify Codex login and API network path"
  );
}

function diagnosis(kind: RouterFailureKind, summary: string, action: string): RouterFailureDiagnosis {
  return { kind, summary, action };
}

export async function readRouterAudit(path: string, limit = 100): Promise<RouterAuditRecord[]> {
  const boundedLimit = Number.isFinite(limit)
    ? Math.min(500, Math.max(0, Math.trunc(limit)))
    : 100;
  if (boundedLimit === 0) {
    return [];
  }

  const records: RouterAuditRecord[] = [];
  for (const line of (await readTextIfExists(path)).split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = RouterAuditRecordSchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        records.push(parsed.data);
      }
    } catch {
      // A partial final write must not hide earlier Router evidence.
    }
  }
  return records.slice(-boundedLimit);
}
