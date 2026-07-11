import { z } from "zod";
import { RouteDecisionSchema } from "../domain/schemas.js";
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
  proxy_configured: z.boolean().optional(),
  failure_kind: RouterFailureKindSchema.optional()
});

export type RouterAuditRecord = z.infer<typeof RouterAuditRecordSchema>;
export type RouterFailureKind = z.infer<typeof RouterFailureKindSchema>;

export function classifyRouterFailure(reason: string): RouterFailureKind | null {
  const timedOut = /\b(?:timed out|timeout|ETIMEDOUT)\b/i.test(reason);
  const proxy = /\bproxy\b|代理/i.test(reason);
  if (proxy && timedOut) {
    return "timeout";
  }
  if (/\b(?:401|403)\b|\b(?:unauthori[sz]ed|forbidden|authentication|api[-_\s]?key|login required|not logged in|sign in)\b/i.test(reason)) {
    return "auth";
  }
  if (/\b429\b|\b(?:rate[ -]?limit|too many requests|quota (?:exceeded|exhausted)|usage limit)\b/i.test(reason)) {
    return "rate-limit";
  }
  if (proxy) {
    return "proxy";
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
