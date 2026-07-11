import { z } from "zod";
import { RouteDecisionSchema } from "../domain/schemas.js";
import { readTextIfExists } from "./file-store.js";

export const RouterAuditRecordSchema = RouteDecisionSchema.extend({
  time: z.string().datetime(),
  request: z.string(),
  workspace: z.string().min(1),
  scope: z.enum(["initial", "follow-up"]).default("initial")
});

export type RouterAuditRecord = z.infer<typeof RouterAuditRecordSchema>;

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
