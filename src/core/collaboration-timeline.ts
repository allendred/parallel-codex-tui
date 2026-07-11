import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { EventRecordSchema } from "../domain/schemas.js";
import { readTextIfExists } from "./file-store.js";

const CollaborationFeatureStateSchema = z.enum([
  "created",
  "actor_running",
  "critic_running",
  "revision_needed",
  "integrating",
  "verifying",
  "approved",
  "failed",
  "cancelled"
]);

const FeatureStatusSchema = z.object({
  feature_id: z.string().min(1),
  task_id: z.string().min(1),
  turn_id: z.string().min(1),
  title: z.string().min(1).optional(),
  state: CollaborationFeatureStateSchema,
  updated_at: z.string().datetime()
});

const FeatureDialogueSchema = z.object({
  time: z.string().datetime(),
  feature_id: z.string().min(1),
  turn_id: z.string().min(1),
  type: z.string().min(1),
  role: z.enum(["actor", "critic"]),
  message: z.string().default(""),
  paths: z.record(z.string()).default({})
});

export type CollaborationFeatureState = z.infer<typeof CollaborationFeatureStateSchema>;
export type CollaborationRole = "actor" | "critic" | "supervisor";

export interface CollaborationFeature {
  id: string;
  title: string;
  turnId: string;
  state: CollaborationFeatureState;
  updatedAt: string;
  findings: number;
  replies: number;
  latestFinding?: string;
  latestReply?: string;
}

export interface CollaborationEvent {
  id: string;
  time: string;
  type: string;
  role: CollaborationRole;
  action: string;
  message: string;
  turnId?: string;
  featureId?: string;
  featureTitle?: string;
  findings?: number;
  replies?: number;
  artifacts: string[];
}

export interface CollaborationTimeline {
  taskId: string;
  features: CollaborationFeature[];
  events: CollaborationEvent[];
}

export async function loadCollaborationTimeline(taskId: string, taskDir: string): Promise<CollaborationTimeline> {
  const [features, dialogueText, taskEventsText] = await Promise.all([
    readCollaborationFeatures(taskDir),
    readTextIfExists(join(taskDir, "dialogue", "actor-critic.jsonl")),
    readTextIfExists(join(taskDir, "events.jsonl"))
  ]);
  const featureById = new Map(features.map((feature) => [feature.id, feature]));
  const dialogue = parseJsonLines(dialogueText, FeatureDialogueSchema);
  const taskEvents = parseJsonLines(taskEventsText, EventRecordSchema)
    .filter((event) => event.type.startsWith("feature.wave_"));
  const events: CollaborationEvent[] = [
    ...dialogue.map((event, index): CollaborationEvent => {
      const feature = featureById.get(event.feature_id);
      return {
        id: `dialogue-${index}-${event.time}`,
        time: event.time,
        type: event.type,
        role: event.role,
        action: collaborationDialogueAction(event.type),
        message: event.type === "critic.revision_requested" && feature?.latestFinding
          ? appendCollaborationEvidence(event.message ?? "", feature.latestFinding)
          : event.message ?? "",
        turnId: event.turn_id,
        featureId: event.feature_id,
        featureTitle: feature?.title ?? event.feature_id,
        findings: feature?.findings ?? 0,
        replies: feature?.replies ?? 0,
        artifacts: Object.keys(event.paths ?? {}).sort()
      };
    }),
    ...taskEvents.map((event, index): CollaborationEvent => ({
      id: `task-${index}-${event.time}`,
      time: event.time,
      type: event.type,
      role: "supervisor",
      action: collaborationWaveAction(event.type),
      message: event.message ?? "",
      artifacts: []
    })),
    ...features.map((feature): CollaborationEvent => ({
      id: `state-${feature.id}-${feature.updatedAt}`,
      time: feature.updatedAt,
      type: "feature.state",
      role: "supervisor",
      action: collaborationFeatureStateAction(feature.state),
      message: [
        `${feature.title} · ${humanizeFeatureState(feature.state)}`,
        ...(feature.latestFinding ? [`finding: ${feature.latestFinding}`] : []),
        ...(feature.latestReply ? [`reply: ${feature.latestReply}`] : [])
      ].join(" · "),
      turnId: feature.turnId,
      featureId: feature.id,
      featureTitle: feature.title,
      findings: feature.findings,
      replies: feature.replies,
      artifacts: ["status"]
    }))
  ].sort((left, right) => left.time.localeCompare(right.time) || left.id.localeCompare(right.id));

  return { taskId, features, events };
}

async function readCollaborationFeatures(taskDir: string): Promise<CollaborationFeature[]> {
  const root = join(taskDir, "features");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const features = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry): Promise<CollaborationFeature | null> => {
      const dir = join(root, entry.name);
      const [statusText, spec, findings, replies] = await Promise.all([
        readTextIfExists(join(dir, "status.json")),
        readTextIfExists(join(dir, "spec.md")),
        readTextIfExists(join(dir, "critic-findings.jsonl")),
        readTextIfExists(join(dir, "actor-replies.jsonl"))
      ]);
      const status = parseJsonValue(statusText, FeatureStatusSchema);
      if (!status) {
        return null;
      }
      const findingEvidence = readMailboxEvidence(findings);
      const replyEvidence = readMailboxEvidence(replies);
      return {
        id: status.feature_id,
        title: status.title?.trim() || featureSpecTitle(spec) || status.feature_id,
        turnId: status.turn_id,
        state: status.state,
        updatedAt: status.updated_at,
        findings: findingEvidence.count,
        replies: replyEvidence.count,
        ...(findingEvidence.latest ? { latestFinding: findingEvidence.latest } : {}),
        ...(replyEvidence.latest ? { latestReply: replyEvidence.latest } : {})
      };
    }));
  return features
    .filter((feature): feature is CollaborationFeature => feature !== null)
    .sort((left, right) => left.turnId.localeCompare(right.turnId) || left.id.localeCompare(right.id));
}

function parseJsonLines<T>(text: string, schema: z.ZodType<T>): T[] {
  const records: T[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) {
        records.push(parsed.data);
      }
    } catch {
      // A partial mailbox write must not hide earlier collaboration evidence.
    }
  }
  return records;
}

function parseJsonValue<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readMailboxEvidence(text: string): { count: number; latest: string | null } {
  let count = 0;
  let latest: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) {
        count += 1;
        latest = mailboxRecordSummary(value as Record<string, unknown>) || latest;
      }
    } catch {
      // Ignore partial or malformed mailbox rows.
    }
  }
  return { count, latest };
}

function mailboxRecordSummary(value: Record<string, unknown>): string {
  for (const key of ["message", "summary", "notes", "resolution", "title", "description", "issue", "status"]) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) {
      return field.replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

function appendCollaborationEvidence(message: string, evidence: string): string {
  const base = message.trim();
  if (!base || base.includes(evidence)) {
    return base || evidence;
  }
  return `${base} · ${evidence}`;
}

function featureSpecTitle(spec: string): string | null {
  const title = spec.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
  return title || null;
}

function collaborationDialogueAction(type: string): string {
  if (type === "feature.created") {
    return "mailbox created";
  }
  if (type === "actor.completed") {
    return "implementation completed";
  }
  if (type === "critic.completed") {
    return "review completed";
  }
  if (type === "critic.revision_requested") {
    return "revision requested";
  }
  return humanizeCollaborationType(type);
}

function collaborationWaveAction(type: string): string {
  const action = type.replace(/^feature\.wave_/, "wave ");
  return humanizeCollaborationType(action);
}

function collaborationFeatureStateAction(state: CollaborationFeatureState): string {
  if (state === "approved") {
    return "feature approved";
  }
  if (state === "revision_needed") {
    return "revision pending";
  }
  return `feature ${humanizeFeatureState(state)}`;
}

function humanizeFeatureState(state: CollaborationFeatureState): string {
  return state.replaceAll("_", " ");
}

function humanizeCollaborationType(type: string): string {
  return type.replace(/[._-]+/g, " ").replace(/\s+/g, " ").trim();
}
